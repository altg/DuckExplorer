"""Result store: keeps recent query results as Arrow tables and serves them page by page."""

from __future__ import annotations

import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import pyarrow as pa

from . import profile as column_profile
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
    profile: dict | None = None
    # (column, descending) -> row numbers in that order; only the latest sort is kept.
    orders: dict[tuple[int, bool], pa.ChunkedArray] = field(default_factory=dict)

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

    def page(
        self, result_id: str, offset: int, limit: int, sort: dict | None = None
    ) -> list[list[str | None]]:
        """Rows [offset, offset+limit) rendered by DuckDB's own VARCHAR casts (as the CLI shows them).

        `sort` ({"column": index, "descending": bool}) pages through the rows in that order instead.
        """
        stored = self.get(result_id)
        offset = max(0, int(offset))
        limit = max(0, int(limit))
        if offset >= stored.row_count or limit == 0 or not stored.columns:
            return []
        with self._session.side_lock:
            if sort is None:
                page = stored.scan.slice(offset, limit)
            else:
                order = self._order(stored, int(sort["column"]), bool(sort.get("descending", False)))
                page = stored.scan.take(order.slice(offset, limit))
            rows = self._session.side.from_arrow(page).project("COLUMNS(*)::VARCHAR").fetchall()
        return [list(row) for row in rows]

    def _order(self, stored: StoredResult, column: int, descending: bool) -> pa.ChunkedArray:
        """Row numbers sorted by one column, with DuckDB's ordering; NULLs last, ties in original order."""
        if not 0 <= column < len(stored.columns):
            raise ValueError(f"No column {column}")
        key = (column, descending)
        order = stored.orders.get(key)
        if order is None:
            side = self._session.side
            row_numbers = side.sql(f"SELECT range FROM range({stored.row_count})").to_arrow_table().column(0)
            numbered = stored.scan.append_column("__row", row_numbers)
            direction = "DESC" if descending else "ASC"
            sorted_rows = side.from_arrow(numbered).order(f"c{column} {direction} NULLS LAST, __row").project("__row")
            order = sorted_rows.to_arrow_table().column(0)
            stored.orders = {key: order}
        return order

    def profile(self, result_id: str) -> dict:
        """Column Explorer statistics, computed on first request and then cached with the result."""
        stored = self.get(result_id)
        if stored.profile is None:
            with self._session.side_lock:
                stored.profile = column_profile.profile(self._session.side, stored.scan, stored.columns)
        return stored.profile

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
