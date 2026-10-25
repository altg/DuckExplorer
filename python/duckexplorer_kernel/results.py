"""Result store: keeps recent query results as Arrow tables and serves them page by page."""

from __future__ import annotations

import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass

import pyarrow as pa

from .session import Session

MAX_RESULTS = 20


class ResultExpired(Exception):
    """The requested result was evicted or belongs to a previous kernel process."""


@dataclass
class StoredResult:
    id: str
    table: pa.Table  # original column names (may contain duplicates)
    scan: pa.Table  # same data with unique positional names, safe for DuckDB scans
    columns: list[dict]

    @property
    def row_count(self) -> int:
        return self.table.num_rows


class ResultStore:
    def __init__(self, session: Session, capacity: int = MAX_RESULTS) -> None:
        self._session = session
        self._capacity = capacity
        self._results: OrderedDict[str, StoredResult] = OrderedDict()
        self._lock = threading.Lock()
        # Ids are unique per kernel process, so a restarted kernel can't serve another run's rows.
        self._prefix = secrets.token_hex(3)
        self._next_id = 1

    def add(self, table: pa.Table, types: list[str] | None = None) -> StoredResult:
        scan = table.rename_columns([f"c{i}" for i in range(table.num_columns)])
        if types is None:
            with self._session.side_lock:
                types = [str(t) for t in self._session.side.from_arrow(scan.slice(0, 0)).types]
        columns = [{"name": name, "type": str(t)} for name, t in zip(table.column_names, types)]
        with self._lock:
            result_id = f"{self._prefix}-{self._next_id}"
            self._next_id += 1
            stored = StoredResult(result_id, table, scan, columns)
            self._results[result_id] = stored
            while len(self._results) > self._capacity:
                self._results.popitem(last=False)
        return stored

    def get(self, result_id: str) -> StoredResult:
        with self._lock:
            stored = self._results.get(result_id)
        if stored is None:
            raise ResultExpired(result_id)
        return stored

    def page(self, result_id: str, offset: int, limit: int) -> list[list[str | None]]:
        """Rows [offset, offset+limit) rendered by DuckDB's own VARCHAR casts (as the CLI shows them)."""
        stored = self.get(result_id)
        offset = max(0, int(offset))
        limit = max(0, int(limit))
        if offset >= stored.row_count or limit == 0 or not stored.columns:
            return []
        page = stored.scan.slice(offset, limit)
        with self._session.side_lock:
            rows = self._session.side.from_arrow(page).project("COLUMNS(*)::VARCHAR").fetchall()
        return [list(row) for row in rows]

    def describe(self, stored: StoredResult, page_size: int, **extra) -> dict:
        """The table payload sent to the notebook renderer: metadata plus the first page."""
        return {
            "id": stored.id,
            "columns": stored.columns,
            "rowCount": stored.row_count,
            "rows": self.page(stored.id, 0, page_size),
            "pageSize": page_size,
            **extra,
        }
