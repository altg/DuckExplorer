"""Running the statements of .sql files: each statement's outcome as a notebook cell would show it,
and the place in the statement that DuckDB's error message points at."""

from __future__ import annotations

import re
import unicodedata

import duckdb
import pyarrow as pa

# DuckDB ends the message of an error at a known place with an excerpt of that line and a caret.
_EXCERPT = re.compile(r"\n+LINE (\d+): ([^\r\n]*)\n( *)\^[ \t]*\Z")
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
    parsed = con.extract_statements(statement)
    kind = parsed[-1].type.name if parsed else ""
    con.execute(statement)
    description = con.description
    if description is None:
        return ""
    shape = [(column[0], str(column[1])) for column in description]
    if kind not in _QUERIES:
        if shape == _COUNT:
            row = con.fetchone()
            return _changed(kind, row[0]) if row else ""
        if shape == _SUCCESS:
            return ""
    if not rows:
        return ""
    return con.to_arrow_table(), [type_name for _, type_name in shape]


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
