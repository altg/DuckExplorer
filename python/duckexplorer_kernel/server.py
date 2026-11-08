"""JSON-RPC style protocol over stdio: one JSON object per line in each direction.

Requests:      {"id": 1, "method": "executeSql", "params": {...}}
Responses:     {"id": 1, "result": {...}}  or  {"id": 1, "error": {"code": "...", "message": "..."}}
Notifications: {"method": "ready", "params": {...}}  (kernel -> extension)
               {"method": "output", "params": {"stream": …, "index": 0, "output": {...}}}  (a running cell's
               outputs, when its request has a `stream` token; see pyexec.Capture)
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .export import ExportFailed
from .filters import InvalidFilter
from .kernel import PREVIEW_ROWS, Kernel
from .results import ResultExpired

# Once the extension has gone (stdin closed), the kernel exits within this many seconds, even while a
# cell runs or a write blocks on a pipe that nobody reads any more.
EXIT_GRACE = 3.0

# Served on a side thread (with the side cursor) so they don't wait for a running cell.
_SIDE_METHODS = {
    "schema",
    "viewSql",
    "sqlCatalog",
    "fetchPage",
    "profileResult",
    "filterSql",
    "filteredQuery",
    "summarize",
    "exportResult",
    "exportRelation",
    "chartSpec",
    "chartCode",
}


class Server:
    def __init__(self) -> None:
        # Protocol messages go to a private duplicate of the original stdout. Anything else that
        # writes to fd 1 (C extensions, prints outside a cell) is redirected to stderr.
        self._out = os.fdopen(os.dup(1), "wb", buffering=0)
        os.dup2(2, 1)
        for stream in (sys.stdout, sys.stderr):
            reconfigure = getattr(stream, "reconfigure", None)
            if reconfigure:
                reconfigure(encoding="utf-8", errors="replace")
        self._write_lock = threading.Lock()
        self._queue: queue.Queue[dict | None] = queue.Queue()
        self._side = ThreadPoolExecutor(max_workers=1, thread_name_prefix="duckexplorer-side")
        # The id of the newest previewSql request: an older one still queued is not run.
        self._latest_preview: Any = None
        self._current: dict | None = None
        # Requests other than previews queued or running on the main thread: previews don't wait for them.
        self._work = 0
        self._work_lock = threading.Lock()
        self.kernel = Kernel()
        k = self.kernel
        k.notify = lambda method, params: self.send({"method": method, "params": params})
        self._handlers: dict[str, Callable[[dict], Any]] = {
            "info": lambda p: k.info(),
            "configure": lambda p: k.configure(p),
            "attach": lambda p: {
                "alias": k.session.attach(p["path"], p.get("alias"), bool(p.get("readOnly", False)))
            },
            "detach": lambda p: k.session.detach(p["alias"]),
            "openFile": lambda p: {"name": k.session.open_file(p["path"], p.get("name"))},
            "closeFile": lambda p: k.session.close_file(p["name"]),
            "schema": lambda p: k.session.schema(),
            "viewSql": lambda p: {"sql": k.session.view_sql(p["database"], p["schema"], p["name"])},
            "sqlCatalog": lambda p: k.sql_catalog(p.get("notebook"), p.get("functionsVersion")),
            "summarize": lambda p: k.summarize(p["database"], p["schema"], p["name"]),
            "executeSql": lambda p: k.execute_sql(p["notebook"], p["code"], p.get("cwd"), p.get("stream")),
            "executePython": lambda p: k.execute_python(p["notebook"], p["code"], p.get("cwd"), p.get("stream")),
            "runStatements": lambda p: k.run_statements(p["statements"], p.get("cwd")),
            "previewSql": self._preview,
            "fetchPage": lambda p: k.fetch_page(p["resultId"], p["offset"], p["limit"], p.get("sort"), p.get("filter")),
            "profileResult": lambda p: k.profile_result(p["resultId"], p.get("filter")),
            "filterSql": lambda p: k.filter_sql(p["resultId"], p.get("filter")),
            "chartSpec": lambda p: k.chart_spec(p["resultId"], p.get("chart"), p.get("filter")),
            "chartCode": lambda p: k.chart_code(p["resultId"], p["code"], p["chart"], p.get("filter")),
            "filteredQuery": lambda p: k.filtered_query(p["resultId"], p["code"], p.get("filter"), p.get("sort")),
            "exportResult": lambda p: k.export_result(p["resultId"], p["path"], p["format"], p.get("filter"), p.get("sort")),
            "exportRelation": lambda p: k.export_relation(p["database"], p["schema"], p["name"], p["path"], p["format"]),
            "forgetNotebook": lambda p: k.forget_notebook(p["notebook"]),
        }

    def _preview(self, params: dict) -> dict:
        if self._current is None or self._current.get("id") != self._latest_preview:
            return {"skipped": "superseded"}
        return self.kernel.preview_sql(params["code"], params.get("notebook"), params.get("cwd"), params.get("limit", PREVIEW_ROWS))

    def send(self, message: dict) -> None:
        data = json.dumps(message, ensure_ascii=False, default=str).encode("utf-8") + b"\n"
        with self._write_lock:
            self._out.write(data)

    def _reply(self, msg_id: Any, result: Any = None, error: dict | None = None) -> None:
        if msg_id is None:
            return
        if error is not None:
            self.send({"id": msg_id, "error": error})
        else:
            self.send({"id": msg_id, "result": result})

    def _reader(self) -> None:
        for raw in sys.stdin.buffer:
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                print(f"duckexplorer: ignoring malformed message: {line[:200]!r}", file=sys.stderr)
                continue
            method = message.get("method")
            if method == "interrupt":
                self._reply(message.get("id"), {"interrupted": self.kernel.interrupt()})
            elif method in _SIDE_METHODS:
                self._side.submit(self._handle, message)
            elif method == "previewSql" and self._work:
                # A preview never waits for a cell: the extension asks again later.
                self._reply(message.get("id"), {"skipped": "busy"})
            else:
                if method == "previewSql":
                    self._latest_preview = message.get("id")
                else:
                    with self._work_lock:
                        self._work += 1
                # Anything else to run, or a newer preview, goes first.
                self.kernel.stop_preview("superseded")
                self._queue.put(message)
        self._queue.put(None)  # stdin closed: the extension went away
        # The main loop normally ends now. But a cell may still be running, or the main thread may be
        # blocked writing outputs to the extension's end of a pipe that is still open but no longer read
        # (it never errors then): nothing reaches the extension any more either way, so exit regardless.
        time.sleep(EXIT_GRACE)
        os._exit(0)

    def _handle(self, message: dict) -> None:
        msg_id = message.get("id")
        method = message.get("method", "")
        try:
            handler = self._handlers.get(method)
            if handler is None:
                self._reply(msg_id, error={"code": "unknown-method", "message": f"Unknown method {method!r}"})
                return
            self._reply(msg_id, handler(message.get("params") or {}))
        except ResultExpired:
            self._reply(msg_id, error={"code": "expired", "message": "Result is no longer available; re-run the cell."})
        except (InvalidFilter, ExportFailed) as exc:
            # The user's own doing (the grid's WHERE text, a file that can't be written): no traceback for the log.
            self._reply(msg_id, error={"code": "invalid", "message": str(exc)})
        except BaseException as exc:  # never let one request take the kernel down
            self._reply(
                msg_id,
                error={"code": "error", "message": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()},
            )

    def serve(self) -> None:
        threading.Thread(target=self._reader, name="duckexplorer-reader", daemon=True).start()
        self.send({"method": "ready", "params": self.kernel.info()})
        while True:
            message = self._queue.get()
            if message is None:
                break
            if message.get("method") == "shutdown":
                self._reply(message.get("id"), {})
                break
            self._current = message
            try:
                self._handle(message)
            finally:
                self._current = None
                if message.get("method") != "previewSql":
                    with self._work_lock:
                        self._work -= 1
        self._side.shutdown(wait=False)


def main() -> None:
    code = 0
    try:
        Server().serve()
    except BaseException:  # e.g. the pipe to the extension broke
        code = 1
        with contextlib.suppress(Exception):
            traceback.print_exc()
    # Skip interpreter teardown: user code may have left non-daemon threads behind, and its flushes
    # could block on pipes to an extension that went away.
    with contextlib.suppress(Exception):
        sys.stderr.flush()
    os._exit(code)
