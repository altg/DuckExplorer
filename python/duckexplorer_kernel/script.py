"""Running the statements of .sql files: each statement's outcome as a notebook cell would show it,
and the place in the statement that DuckDB's error message points at."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

import duckdb
import pyarrow as pa

from . import fetch

# DuckDB ends the message of an error at a known place with an excerpt of that line and a caret
# (duckdb 2 underlines the whole token: ^^^^).
_EXCERPT = re.compile(r"\n+LINE (\d+): ([^\r\n]*)\n( *)\^+[ \t]*\Z")
_NEWLINE = re.compile(r"\r\n|\r|\n")
_ELLIPSIS = "..."
# Statement types that return rows; others return a row count or nothing (unless RETURNING).
_QUERIES = {"SELECT", "EXPLAIN", "CALL"}
_CHANGED = {"INSERT": "inserted", "CREATE": "inserted", "UPDATE": "updated", "DELETE": "deleted", "COPY": "copied"}
_COUNT = [("Count", "BIGINT")]
_SUCCESS = [("Success", "BOOLEAN")]


@dataclass
class Rows:
    """A statement's rows, with DuckDB's names for their types."""

    table: pa.Table
    types: list[str]
    # The statement returned more rows than fit the memory limit; `table` holds the first of them.
    truncated: bool = False


def run(con: duckdb.DuckDBPyConnection, statement: str, rows: bool = True, max_bytes: int = 0) -> Rows | str:
    """Runs one statement. Rows come back as far as they fit in `max_bytes` (0: all of them), unless
    `rows` is false: nobody will see them. A statement without rows comes back as a message such as
    "3 rows inserted" (empty when there is nothing to say).
    """
    kind = statement_kind(con, statement)
    if kind == "SELECT":
        return _query(con, statement, rows, max_bytes)
    # Not a query: execute(), which keeps the error's position, and the statement runs to its end.
    con.execute(statement)
    description = con.description
    if description is None:
        return ""
    shape = [(column[0], str(column[1])) for column in description]
    if is_report(kind, shape) and shape == _COUNT:
        counted = con.fetchall()
        return _changed(kind, counted[0][0]) if counted else ""
    if is_report(kind, shape) or not rows:
        _finish(con)
        return ""
    fetched = fetch.read(fetch.arrow_reader(con), max_bytes, stop_early=False)
    return Rows(fetched.table, [type_name for _, type_name in shape], fetched.truncated)


def _query(con: duckdb.DuckDBPyConnection, statement: str, rows: bool, max_bytes: int) -> Rows | str:
    """A SELECT runs through sql(), whose reader can stop it at the limit: duckdb 2's execute() loads
    the whole result before anything can read it."""
    try:
        rel = con.sql(statement)
    except (duckdb.BinderException, duckdb.ParserException, duckdb.CatalogException) as exc:
        # sql() drops the error's position; execute() fails the same way, with it, before running anything.
        con.execute(statement)
        # It did not fail after all: leave the connection free (duckdb 2 refuses the next statement
        # while a result is open) and report the first error.
        fetch.first_batch(fetch.arrow_reader(con))
        raise exc
    if rel is None:
        return ""
    types = [str(t) for t in rel.types]
    reader = fetch.arrow_reader(rel)
    if not rows:
        fetch.first_batch(reader)  # as far as duckdb 1.x's execute() ran an unread result
        return ""
    fetched = fetch.read(reader, max_bytes, stop_early=True)
    return Rows(fetched.table, types, fetched.truncated)


def statement_kind(con: duckdb.DuckDBPyConnection, sql: str) -> str:
    """The type of the last statement in `sql` ("SELECT", "INSERT", …), or "" when there is none."""
    parsed = con.extract_statements(sql)
    return parsed[-1].type.name if parsed else ""


def is_report(kind: str, shape: list[tuple[str, str]]) -> bool:
    """Whether a statement's result only reports what it did (how many rows it changed, or that it
    succeeded) rather than being rows of its own, from the statement's type and the result's columns
    as (name, type). duckdb 1.x's sql() returns None for most such statements, 2.x a relation of the report.
    """
    return kind not in _QUERIES and shape in (_COUNT, _SUCCESS)


def _finish(con: duckdb.DuckDBPyConnection) -> None:
    """Runs an unread result to its end: duckdb 2 keeps it open, which blocks the connection (1.x has
    read it already)."""
    complete = getattr(con, "complete", None)
    if complete is not None:
        complete()


def _changed(kind: str, count: int) -> str:
    rows = "1 row" if count == 1 else f"{count:,} rows"
    return f"{rows} {_CHANGED.get(kind, 'changed')}"


def locate(statement: str, message: str) -> tuple[str, int | None]:
    """DuckDB's error message without its `LINE n: … ^` excerpt, and the place in `statement` the
    excerpt's caret points at, as a UTF-16 offset (the extension's strings). The offset is None when
    the message has no excerpt or the excerpt isn't from this statement."""
    match = _EXCERPT.search(message)
    if not match:
        return message, None
    text = message[: match.start()]
    number, shown, caret = int(match[1]), match[2], len(match[3])
    starts = [0] + [newline.end() for newline in _NEWLINE.finditer(statement)]
    if number > len(starts):
        return text, None
    start = starts[number - 1]
    end = _NEWLINE.search(statement, start)
    line = statement[start : end.start() if end else len(statement)]
    found = _excerpt_start(line, shown)
    if found is None:
        return text, None
    column, lead = found
    # The caret is indented by render width: CJK characters and emoji take two columns.
    width = caret - len(f"LINE {number}: ") - lead
    while column < len(line) and width > 0:
        width -= _render_width(line[column])
        column += 1
    return text, len(statement[: start + column].encode("utf-16-le")) // 2


def _excerpt_start(line: str, shown: str) -> tuple[int, int] | None:
    """Where DuckDB's excerpt of a long line starts in it, and the width of the `...` shown before it."""
    texts = [shown, shown[: -len(_ELLIPSIS)]] if shown.endswith(_ELLIPSIS) else [shown]
    if any(line.startswith(text) for text in texts):
        return 0, 0
    if shown.startswith(_ELLIPSIS):
        for text in texts:
            core = text[len(_ELLIPSIS) :]
            index = line.find(core) if core else -1
            if index >= 0:
                return index, len(_ELLIPSIS)
    return None


def _render_width(char: str) -> int:
    if unicodedata.combining(char) or char == "‍":
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
