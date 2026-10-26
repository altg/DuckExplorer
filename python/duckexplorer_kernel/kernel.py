"""Kernel state shared by all notebooks: one DuckDB session, per-notebook Python namespaces."""

from __future__ import annotations

import builtins
import contextlib
import ctypes
import importlib.util
import os
import platform
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import duckdb
import pyarrow as pa

from . import pyexec
from .results import ResultStore, StoredResult
from .session import Session

# `-- name: sales` on the first non-blank line of a SQL cell binds the result to `sales`.
_NAME_DIRECTIVE = re.compile(r"\A\s*--\s*name\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$", re.IGNORECASE | re.MULTILINE)
_SQL_STUB = compile("rel = con.sql(query)", "<sql>", "exec")


@dataclass
class NotebookState:
    namespace: dict
    # name -> Arrow table bound by a SQL cell; turned into pandas when a Python cell next runs.
    pending: dict[str, pa.Table] = field(default_factory=dict)


class Kernel:
    def __init__(self) -> None:
        self.session = Session()
        self.results = ResultStore(self.session)
        self.notebooks: dict[str, NotebookState] = {}
        self.page_size = 200
        self.max_pandas_rows = 1_000_000
        self._busy: str | None = None
        self._busy_lock = threading.Lock()
        self._thread_id = threading.get_ident()
        pyexec.install_hooks()

    # -- info / configuration ------------------------------------------------------

    def info(self) -> dict:
        def version_of(module: str) -> str | None:
            if importlib.util.find_spec(module) is None:
                return None
            try:
                from importlib.metadata import version

                return version(module)
            except Exception:
                return "unknown"

        return {
            "python": platform.python_version(),
            "executable": sys.executable,
            "duckdb": duckdb.__version__,
            "pyarrow": pa.__version__,
            "pandas": version_of("pandas"),
            "matplotlib": version_of("matplotlib"),
            "plotly": version_of("plotly"),
        }

    def configure(self, params: dict) -> None:
        if "pageSize" in params:
            self.page_size = int(params["pageSize"])
        if "maxPandasRows" in params:
            self.max_pandas_rows = int(params["maxPandasRows"])
        if "theme" in params:
            pyexec.plotly_theme = "plotly_dark" if params["theme"] == "dark" else "plotly"

    # -- notebooks -----------------------------------------------------------------

    def notebook(self, uri: str) -> NotebookState:
        state = self.notebooks.get(uri)
        if state is None:
            namespace: dict[str, Any] = {
                "__name__": "__main__",
                "__builtins__": builtins,
                "con": self.session.con,
                "duckdb": duckdb,
                "sql": self._sql_helper,
                "display": pyexec.display,
            }
            if importlib.util.find_spec("pandas") is not None:
                import pandas as pd

                namespace["pd"] = pd
            state = self.notebooks[uri] = NotebookState(namespace)
        return state

    def forget_notebook(self, uri: str) -> None:
        self.notebooks.pop(uri, None)

    def _sql_helper(self, query: str) -> Any:
        """sql("SELECT …") -> pandas DataFrame (None for statements without a result)."""
        rel = self.session.con.sql(query)
        return None if rel is None else rel.df()

    # -- execution -----------------------------------------------------------------

    @contextlib.contextmanager
    def _running(self, mode: str, cwd: str | None) -> Iterator[pyexec.Capture]:
        if cwd and os.path.isdir(cwd):
            # Relative paths in SQL and Python resolve against the notebook's folder, as in Jupyter.
            os.chdir(cwd)
        capture = pyexec.Capture(self._table_output)
        saved = sys.stdout, sys.stderr
        sys.stdout = pyexec.StreamWriter(capture, "stdout")
        sys.stderr = pyexec.StreamWriter(capture, "stderr")
        pyexec.current = capture
        with self._busy_lock:
            self._busy = mode
        try:
            yield capture
        finally:
            with self._busy_lock:
                self._busy = None
                # Drop an interrupt that arrived after the user code had already finished.
                ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(self._thread_id), None)
            pyexec.current = None
            sys.stdout, sys.stderr = saved
            with contextlib.suppress(duckdb.Error):
                self.session.refresh_current_database()

    def interrupt(self) -> bool:
        """Called from the reader thread. Stops a running query and, for Python cells, raises KeyboardInterrupt."""
        with self._busy_lock:
            if self._busy is None:
                return False
            self.session.con.interrupt()
            if self._busy == "python":
                ctypes.pythonapi.PyThreadState_SetAsyncExc(
                    ctypes.c_ulong(self._thread_id), ctypes.py_object(KeyboardInterrupt)
                )
            return True

    def execute_sql(self, notebook: str, code: str, cwd: str | None = None) -> dict:
        state = self.notebook(notebook)
        error = None
        with self._running("sql", cwd) as capture:
            started = time.perf_counter()
            try:
                local_vars = {"con": self.session.con, "query": code}
                # Run with the notebook namespace as globals so SQL can scan its DataFrames.
                exec(_SQL_STUB, state.namespace, local_vars)
                rel = local_vars["rel"]
                if rel is None:
                    elapsed = _ms_since(started)
                    capture.add({"type": "text", "text": f"Statement executed in {elapsed:,.0f} ms"})
                else:
                    table = rel.to_arrow_table()
                    elapsed = _ms_since(started)
                    stored = self.results.add(table, [str(t) for t in rel.types])
                    bound = self._bind_result(state, code, stored)
                    capture.add(
                        {
                            "type": "table",
                            "table": self.results.describe(
                                stored, self.page_size, elapsedMs=round(elapsed, 1), boundTo=bound
                            ),
                        }
                    )
            except KeyboardInterrupt:
                error = _interrupted()
            except duckdb.InterruptException:
                error = _interrupted()
            except Exception as exc:
                error = {"ename": type(exc).__name__, "evalue": str(exc), "traceback": ""}
        return {"outputs": capture.outputs, "error": error}

    def execute_python(self, notebook: str, code: str, cwd: str | None = None) -> dict:
        state = self.notebook(notebook)
        error = None
        with self._running("python", cwd) as capture:
            try:
                self._materialize_pending(state)
                pyexec.run_cell(code, state.namespace)
            except KeyboardInterrupt:
                error = _interrupted()
            except duckdb.InterruptException:
                error = _interrupted()
            except BaseException as exc:  # includes SystemExit from exit() in a cell
                error = pyexec.format_error(exc)
            finally:
                try:
                    pyexec.flush_figures()
                except Exception as exc:
                    capture.stream("stderr", f"Could not render figure: {exc}\n")
        return {"outputs": capture.outputs, "error": error}

    def fetch_page(
        self, result_id: str, offset: int, limit: int, sort: dict | None = None, filter_spec: dict | None = None
    ) -> dict:
        rows, count = self.results.page(result_id, offset, limit, sort, filter_spec)
        return {"rows": rows, "rowCount": count}

    def profile_result(self, result_id: str, filter_spec: dict | None = None) -> dict:
        return self.results.profile(result_id, filter_spec)

    # -- helpers -------------------------------------------------------------------

    def _bind_result(self, state: NotebookState, code: str, stored: StoredResult) -> list[str]:
        names = ["df"]
        match = _NAME_DIRECTIVE.match(code)
        if match:
            names.append(match.group(1))
        for name in names:
            # Bound as Arrow right away (SQL cells can scan it); pandas conversion is deferred.
            state.namespace[name] = stored.table
            state.pending[name] = stored.table
        return names

    def _materialize_pending(self, state: NotebookState) -> None:
        pending, state.pending = state.pending, {}
        if not pending or importlib.util.find_spec("pandas") is None:
            return
        converted: dict[int, Any] = {}
        for name, table in pending.items():
            if state.namespace.get(name) is not table:
                continue  # user rebound the name since
            key = id(table)
            if key not in converted:
                limit = self.max_pandas_rows
                if limit <= 0:
                    continue
                if table.num_rows > limit:
                    print(
                        f"Note: `{name}` holds the first {limit:,} of {table.num_rows:,} rows "
                        "(setting duckexplorer.maxPandasRows).",
                        file=sys.stderr,
                    )
                    table = table.slice(0, limit)
                converted[key] = self._to_pandas(table)
            state.namespace[name] = converted[key]

    def _to_pandas(self, table: pa.Table) -> Any:
        """Same conversion as con.sql(...).df(): DECIMAL becomes float64, timestamps datetime64."""
        scan = table.rename_columns([f"c{i}" for i in range(table.num_columns)])  # duplicate names are allowed
        with self.session.side_lock:
            frame = self.session.side.from_arrow(scan).df()
        frame.columns = table.column_names
        return frame

    def _table_output(self, obj: Any) -> dict | None:
        """Table output for DataFrame-like values displayed from Python cells, else None."""
        table = _as_arrow(obj)
        if table is None:
            return None
        types = [str(t) for t in obj.types] if isinstance(obj, duckdb.DuckDBPyRelation) else None
        stored = self.results.add(table, types)
        return {"type": "table", "table": self.results.describe(stored, self.page_size)}


def _as_arrow(obj: Any) -> pa.Table | None:
    if isinstance(obj, pa.Table):
        return obj
    if isinstance(obj, pa.RecordBatch):
        return pa.Table.from_batches([obj])
    if isinstance(obj, duckdb.DuckDBPyRelation):
        return obj.to_arrow_table()
    pd = sys.modules.get("pandas")
    if pd is not None:
        if isinstance(obj, pd.Series):
            obj = obj.to_frame()
        if isinstance(obj, pd.DataFrame):
            frame = obj
            if not isinstance(frame.index, pd.RangeIndex) or frame.index.name is not None:
                frame = frame.reset_index()
            else:
                frame = frame.copy(deep=False)  # never rename the user's own DataFrame
            frame.columns = [str(c) for c in frame.columns]
            return pa.Table.from_pandas(frame, preserve_index=False)
    if hasattr(obj, "__arrow_c_stream__") and not isinstance(obj, type):
        try:
            return pa.table(obj)
        except Exception:
            return None
    return None


def _ms_since(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def _interrupted() -> dict:
    return {"ename": "KeyboardInterrupt", "evalue": "Execution interrupted", "traceback": ""}
