"""JSON-RPC style protocol over stdio: one JSON object per line in each direction.

Requests:      {"id": 1, "method": "executeSql", "params": {...}}
Responses:     {"id": 1, "result": {...}}  or  {"id": 1, "error": {"code": "...", "message": "..."}}
Notifications: {"method": "ready", "params": {...}}  (kernel -> extension)
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .filters import InvalidFilter
from .kernel import Kernel
from .results import ResultExpired

# Served on a side thread (with the side cursor) so they don't wait for a running cell.
_SIDE_METHODS = {"schema", "fetchPage", "profileResult", "filterSql", "filteredQuery", "summarize"}


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
        self.kernel = Kernel()
        k = self.kernel
        self._handlers: dict[str, Callable[[dict], Any]] = {
            "info": lambda p: k.info(),
            "configure": lambda p: k.configure(p),
            "attach": lambda p: {
                "alias": k.session.attach(p["path"], p.get("alias"), bool(p.get("readOnly", False)))
            },
            "detach": lambda p: k.session.detach(p["alias"]),
            "schema": lambda p: k.session.schema(),
            "summarize": lambda p: k.summarize(p["database"], p["schema"], p["name"]),
            "executeSql": lambda p: k.execute_sql(p["notebook"], p["code"], p.get("cwd")),
            "executePython": lambda p: k.execute_python(p["notebook"], p["code"], p.get("cwd")),
            "fetchPage": lambda p: k.fetch_page(p["resultId"], p["offset"], p["limit"], p.get("sort"), p.get("filter")),
            "profileResult": lambda p: k.profile_result(p["resultId"], p.get("filter")),
            "filterSql": lambda p: k.filter_sql(p["resultId"], p.get("filter")),
            "filteredQuery": lambda p: k.filtered_query(p["resultId"], p["code"], p.get("filter"), p.get("sort")),
            "forgetNotebook": lambda p: k.forget_notebook(p["notebook"]),
        }

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
            else:
                self._queue.put(message)
        self._queue.put(None)  # stdin closed: the extension went away

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
        except InvalidFilter as exc:
            # The user's own input (e.g. the grid's WHERE text): no traceback for the log.
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
            self._handle(message)
        self._side.shutdown(wait=False)


def main() -> None:
    Server().serve()
    # Skip interpreter teardown: user code may have left non-daemon threads behind.
    sys.stderr.flush()
    os._exit(0)
