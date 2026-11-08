"""Running the statements of .sql files: each statement's outcome as a notebook cell would show it,
and the place in the statement that DuckDB's error message points at."""

from __future__ import annotations

import re
import unicodedata
import warnings

import duckdb
import pyarrow as pa

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


def run(con: duckdb.DuckDBPyConnection, statement: str, rows: bool = True) -> tuple[pa.Table, list[str]] | str:
    """Runs one statement. Rows come back with DuckDB's names for their types (unless `rows` is
    false: nobody will see them); a statement without rows as a message such as "3 rows inserted"
    (empty when there is nothing to say).

    Uses execute() rather than sql(): the relation API drops the error's position for binder errors.
    """
    kind = statement_kind(con, statement)
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
    with warnings.catch_warnings():
        # duckdb 2 copies a DB-API result's rows once more to make them Arrow. What it suggests instead,
        # con.sql(statement), would lose the position of binder errors.
        warnings.filterwarnings("ignore", "Arrow output on a DB-API result", UserWarning)
        return con.to_arrow_table(), [type_name for _, type_name in shape]


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
