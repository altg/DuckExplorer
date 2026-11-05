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
from typing import Any, Callable, Iterator

import duckdb
import pyarrow as pa

from . import catalog, export, pyexec, script
from .results import ResultStore, StoredResult
from .session import Session, quote_ident

# Larger tables and views are summarized from a random sample of this many rows.
SUMMARY_ROWS = 1_000_000

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
        # Sends a notification to the extension (set by the server): outputs of a running cell.
        self.notify: Callable[[str, dict], None] | None = None
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
            "altair": version_of("altair"),
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
    def _running(self, mode: str, cwd: str | None, stream: Any = None) -> Iterator[pyexec.Capture]:
        """While a cell runs: its folder, its output capture and the busy state for interrupts.

        With `stream` (a token from the extension), outputs are sent as `output` notifications as they
        are made, rather than only in the reply.
        """
        if cwd and os.path.isdir(cwd):
            # Relative paths in SQL and Python resolve against the notebook's folder, as in Jupyter.
            os.chdir(cwd)
        emit = None
        notify = self.notify
        if stream is not None and notify is not None:
            emit = lambda update: notify("output", {"stream": stream, **update})  # noqa: E731
        capture = pyexec.Capture(self._table_output, emit)
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
            capture.finish()  # before the reply, which says the cell is done
            with contextlib.suppress(duckdb.Error):
                self.session.refresh_current_database()

    @staticmethod
    def _reply(capture: pyexec.Capture, error: dict | None) -> dict:
        """A cell's reply: its outputs, or how many there were when they were streamed."""
        if capture.streamed:
            return {"streamed": len(capture.outputs), "error": error}
        return {"outputs": capture.outputs, "error": error}

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

    def execute_sql(self, notebook: str, code: str, cwd: str | None = None, stream: Any = None) -> dict:
        state = self.notebook(notebook)
        error = None
        with self._running("sql", cwd, stream) as capture:
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
        return self._reply(capture, error)

    def execute_python(self, notebook: str, code: str, cwd: str | None = None, stream: Any = None) -> dict:
        state = self.notebook(notebook)
        error = None
        with self._running("python", cwd, stream) as capture:
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
        return self._reply(capture, error)

    def run_statements(self, statements: list[str], cwd: str | None = None) -> dict:
        """Runs the statements of a .sql file (or of the selection in one) in order on the main
        connection, stopping at the first error. The last statement's rows come back as a stored
        result, as a SQL cell's do; a statement without rows as a message ("3 rows inserted").

        An error says which statement failed and, when DuckDB says, where in it (a UTF-16 offset).
        """
        reply: dict[str, Any] = {"completed": 0}
        outcome: tuple[pa.Table, list[str]] | str = ""
        with self._running("sql", cwd):
            started = time.perf_counter()
            for index, statement in enumerate(statements):
                try:
                    outcome = script.run(self.session.con, statement, rows=index == len(statements) - 1)
                except (KeyboardInterrupt, duckdb.InterruptException):
                    interrupted = _interrupted()
                    reply["error"] = {**interrupted, "message": interrupted["evalue"], "statement": index}
                    break
                except Exception as exc:
                    message, position = script.locate(statement, str(exc))
                    error = {"ename": type(exc).__name__, "evalue": str(exc), "message": message, "statement": index}
                    if position is not None:
                        error["position"] = position
                    reply["error"] = error
                    break
                reply["completed"] = index + 1
            elapsed = round(_ms_since(started), 1)
        reply["elapsedMs"] = elapsed
        if "error" not in reply:
            if isinstance(outcome, tuple):
                stored = self.results.add(*outcome)
                reply["table"] = self.results.describe(stored, self.page_size, elapsedMs=elapsed)
            else:
                reply["message"] = outcome
        return reply

    def fetch_page(
        self, result_id: str, offset: int, limit: int, sort: dict | None = None, filter_spec: dict | None = None
    ) -> dict:
        rows, count = self.results.page(result_id, offset, limit, sort, filter_spec)
        return {"rows": rows, "rowCount": count}

    def profile_result(self, result_id: str, filter_spec: dict | None = None) -> dict:
        return self.results.profile(result_id, filter_spec)

    def summarize(self, database: str, schema: str, name: str) -> dict:
        """A table or view as a stored result, for the summary panel (Column Explorer, rows, filters).

        Holds every row, or a reservoir sample of SUMMARY_ROWS rows when there are more; then the
        payload's `sampledFrom` is the full row count, and exports read the relation instead. Runs on the
        side cursor, beside a running cell.
        """
        qualified = ".".join(quote_ident(part) for part in (database, schema, name))
        started = time.perf_counter()
        with self.session.side_lock:
            side = self.session.side
            count = side.execute(f"SELECT count(*) FROM {qualified}").fetchone()[0]
            sample = f" USING SAMPLE reservoir({SUMMARY_ROWS} ROWS) REPEATABLE (42)" if count > SUMMARY_ROWS else ""
            rel = side.sql(f"SELECT * FROM {qualified}{sample}")
            table = rel.to_arrow_table()
            types = [str(t) for t in rel.types]
        stored = self.results.add(table, types)
        extra: dict[str, Any] = {"elapsedMs": round(_ms_since(started), 1)}
        if sample:
            stored.sample_of = qualified
            extra["sampledFrom"] = count
        return self.results.describe(stored, self.page_size, **extra)

    def sql_catalog(self, notebook: str | None = None, functions_version: str | None = None) -> dict:
        """Names for SQL completions: the schema (with temp tables), the notebook's DataFrames, and the
        function catalog unless the caller's copy (functions_version) is still current."""
        result: dict[str, Any] = {"schema": self.session.schema(include_temp=True), "frames": []}
        state = self.notebooks.get(notebook) if notebook else None
        with self.session.side_lock:
            side = self.session.side
            if state is not None:
                result["frames"] = catalog.notebook_frames(state.namespace, side)
            if functions_version is None or functions_version != catalog.functions_version(side):
                result["functions"] = catalog.function_catalog(side)
        return result

    def filter_sql(self, result_id: str, filter_spec: dict | None) -> dict:
        return {"where": self.results.filter_sql(result_id, filter_spec)}

    def filtered_query(self, result_id: str, code: str, filter_spec: dict | None, sort: dict | None) -> dict:
        return {"code": self.results.filtered_query(result_id, code, filter_spec, sort)}

    def export_result(
        self, result_id: str, path: str, file_format: str, filter_spec: dict | None = None, sort: dict | None = None
    ) -> dict:
        return {"rowCount": self.results.export(result_id, path, file_format, filter_spec, sort)}

    def export_relation(self, database: str, schema: str, name: str, path: str, file_format: str) -> dict:
        """Every row of a table or view, written to a file (Export in the Databases view)."""
        qualified = ".".join(quote_ident(part) for part in (database, schema, name))
        with self.session.side_lock:
            return {"rowCount": export.copy(self.session.side, f"SELECT * FROM {qualified}", path, file_format)}

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
