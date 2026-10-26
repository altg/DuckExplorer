"""Result store: keeps recent query results as Arrow tables and serves them page by page."""

from __future__ import annotations

import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import duckdb
import pyarrow as pa

from . import filters
from . import profile as column_profile
from .session import Session, quote_ident

MAX_RESULTS = 20
# Sorted/filtered views and filtered profiles kept per result; the grid only shows one at a time.
MAX_VIEWS = 3
MAX_PROFILES = 2

SortKey = tuple[int, bool]  # (column, descending)


class ResultExpired(Exception):
    """The requested result was evicted or belongs to a previous kernel process."""


@dataclass
class StoredResult:
    id: str
    table: pa.Table  # original column names (may contain duplicates)
    scan: pa.Table  # same data with unique positional names, safe for DuckDB scans
    columns: list[dict]
    # filter key ('' = every row) -> Column Explorer statistics.
    profiles: OrderedDict[str, dict] = field(default_factory=OrderedDict)
    # (filter key, sort) -> row numbers of that view, in display order.
    views: OrderedDict[tuple[str, SortKey | None], pa.ChunkedArray] = field(default_factory=OrderedDict)

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
        self,
        result_id: str,
        offset: int,
        limit: int,
        sort: dict | None = None,
        filter_spec: dict | None = None,
    ) -> tuple[list[list[str | None]], int]:
        """Rows [offset, offset+limit) of a view, rendered by DuckDB's own VARCHAR casts (as the CLI
        shows them), and the number of rows in the view.

        `sort` ({"column": index, "descending": bool}) and `filter_spec` (see filters.py) select the
        view; without them the rows are the result's own, in query order.
        """
        stored = self.get(result_id)
        offset = max(0, int(offset))
        limit = max(0, int(limit))
        if not stored.columns:
            return [], stored.row_count
        spec = filters.normalize(filter_spec)
        with self._session.side_lock:
            rows = self._view(stored, _sort_key(sort, stored), spec)
            count = stored.row_count if rows is None else len(rows)
            if offset >= count or limit == 0:
                return [], count
            if rows is None:
                page = stored.scan.slice(offset, limit)
            else:
                page = stored.scan.take(rows.slice(offset, limit))
            values = self._session.side.from_arrow(page).project("COLUMNS(*)::VARCHAR").fetchall()
        return [list(row) for row in values], count

    def profile(self, result_id: str, filter_spec: dict | None = None) -> dict:
        """Column Explorer statistics of the rows a filter keeps, computed on first request and cached."""
        stored = self.get(result_id)
        spec = filters.normalize(filter_spec)
        key = filters.cache_key(spec)
        with self._session.side_lock:
            cached = stored.profiles.get(key)
            if cached is None:
                rows = self._matching_rows(stored, spec)
                scan = stored.scan if rows is None else stored.scan.take(rows)
                cached = column_profile.profile(self._session.side, scan, stored.columns)
                stored.profiles[key] = cached
                while len(stored.profiles) > MAX_PROFILES:
                    stored.profiles.popitem(last=False)
            else:
                stored.profiles.move_to_end(key)
        return cached

    def filter_sql(self, result_id: str, filter_spec: dict | None) -> str:
        """The filter as one SQL condition over the result's column names (see filters.to_sql)."""
        stored = self.get(result_id)
        spec = filters.normalize(filter_spec)
        with self._session.side_lock:
            return filters.to_sql(spec, stored.columns, self._session.side)

    def filtered_query(self, result_id: str, code: str, filter_spec: dict | None, sort: dict | None) -> str:
        """The SQL cell `code` that made the result, rewritten to return the grid's filtered, sorted view."""
        stored = self.get(result_id)
        spec = filters.normalize(filter_spec)
        with self._session.side_lock:
            where = filters.to_sql(spec, stored.columns, self._session.side)
            sort_key = _sort_key(sort, stored)
            order_by = "" if sort_key is None else filters.order_sql(sort_key, stored.columns, self._session.side)
        return filters.filtered_query(code, where, order_by)

    def describe(self, stored: StoredResult, page_size: int, **extra) -> dict:
        """The table payload sent to the notebook renderer: metadata plus the first page."""
        return {
            "id": stored.id,
            "columns": stored.columns,
            "rowCount": stored.row_count,
            "rows": self.page(stored.id, 0, page_size)[0],
            "pageSize": page_size,
            **extra,
        }

    # -- views (call with the side lock held) -------------------------------------------

    def _view(self, stored: StoredResult, sort: SortKey | None, spec: dict | None) -> pa.ChunkedArray | None:
        """Row numbers of a sorted and/or filtered view; None for the result as it is."""
        if sort is None and spec is None:
            return None
        key = (filters.cache_key(spec), sort)
        rows = stored.views.get(key)
        if rows is None:
            rows = self._compute_view(stored, sort, spec)
            stored.views[key] = rows
            while len(stored.views) > MAX_VIEWS:
                stored.views.popitem(last=False)
        else:
            stored.views.move_to_end(key)
        return rows

    def _matching_rows(self, stored: StoredResult, spec: dict | None) -> pa.ChunkedArray | None:
        """The rows a filter keeps, in any order (reuses a sorted view with the same filter)."""
        if spec is None:
            return None
        key = filters.cache_key(spec)
        for (filter_key, _), rows in stored.views.items():
            if filter_key == key:
                return rows
        return self._view(stored, None, spec)

    def _compute_view(self, stored: StoredResult, sort: SortKey | None, spec: dict | None) -> pa.ChunkedArray:
        """Sorts with DuckDB's ordering: NULLs last, ties (and unsorted views) in the query's order."""
        side = self._session.side
        row_numbers = side.sql(f"SELECT range FROM range({stored.row_count})").to_arrow_table().column(0)
        rel = side.from_arrow(stored.scan.append_column("__dx_row", row_numbers))
        sort_by = None if sort is None else f"c{sort[0]}"
        try:
            if spec and spec["conditions"]:
                predicates = [filters.condition_sql(c, stored.columns) for c in spec["conditions"]]
                rel = rel.filter(" AND ".join(f"({p})" for p in predicates))
            if spec and spec["where"]:
                # The WHERE text sees the result's own column names. Internal columns come first, so
                # they win over a user column of the same name.
                internal = ['"__dx_row"'] + ([] if sort_by is None else [f'{sort_by} AS "__dx_sort"'])
                named = [f"c{i} AS {quote_ident(c['name'])}" for i, c in enumerate(stored.columns)]
                rel = rel.project(", ".join(internal + named)).filter(spec["where"])
                sort_by = None if sort_by is None else '"__dx_sort"'
            order = '"__dx_row"'
            if sort is not None:
                order = f"{sort_by} {'DESC' if sort[1] else 'ASC'} NULLS LAST, {order}"
            return rel.order(order).project('"__dx_row"').to_arrow_table().column(0)
        except duckdb.Error as exc:
            if spec is None:
                raise
            raise filters.InvalidFilter(str(exc).strip()) from None


def _sort_key(sort: dict | None, stored: StoredResult) -> SortKey | None:
    if sort is None:
        return None
    column = int(sort["column"])
    if not 0 <= column < len(stored.columns):
        raise ValueError(f"No column {column}")
    return column, bool(sort.get("descending", False))
