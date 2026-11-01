"""Exports: the rows of a query written to a CSV, Parquet or Excel file with DuckDB's COPY … TO.

Excel files are written by DuckDB's excel extension, which is installed from DuckDB's extension
repository the first time it is needed.
"""

from __future__ import annotations

import duckdb

from .session import quote_literal

_OPTIONS = {"csv": "FORMAT csv, HEADER true", "parquet": "FORMAT parquet", "xlsx": "FORMAT xlsx, HEADER true"}
# A sheet has 1,048,576 rows, and the header takes one.
EXCEL_MAX_ROWS = 1_048_575


class ExportFailed(Exception):
    """The file can't be written: too many rows for Excel, no excel extension, a folder that can't be written, …"""


def check_format(file_format: str, row_count: int | None = None) -> None:
    """Fails before anything is written: an unknown format, or more rows than an Excel sheet holds."""
    if file_format not in _OPTIONS:
        raise ValueError(f"Unknown export format {file_format!r}")
    if file_format == "xlsx" and row_count is not None and row_count > EXCEL_MAX_ROWS:
        raise ExportFailed(_too_many_rows(f"these are {row_count:,}"))


def copy(cursor: duckdb.DuckDBPyConnection, query: str, path: str, file_format: str) -> int:
    """Writes the rows of `query` to `path`, replacing the file; returns how many. Call with the side lock held."""
    check_format(file_format)
    if file_format == "xlsx":
        _load_excel(cursor)
    try:
        (count,) = cursor.execute(f"COPY ({query}) TO {quote_literal(path)} ({_OPTIONS[file_format]})").fetchone()
    except duckdb.Error as exc:
        if file_format == "xlsx" and "row limit" in str(exc):
            raise ExportFailed(_too_many_rows("there are more")) from None
        raise ExportFailed(str(exc).strip()) from None
    return int(count)


def _load_excel(cursor: duckdb.DuckDBPyConnection) -> None:
    try:
        cursor.execute("LOAD excel")
        return
    except duckdb.Error:
        pass  # not installed yet
    try:
        cursor.execute("INSTALL excel")
        cursor.execute("LOAD excel")
    except duckdb.Error as exc:
        reason = str(exc).strip().splitlines()[0]
        raise ExportFailed(
            "Excel export needs DuckDB's excel extension, and it could not be installed: are you offline? "
            f"Export to CSV or Parquet instead, or try again once you are online. ({reason})"
        ) from None


def _too_many_rows(actual: str) -> str:
    return (
        f"An Excel sheet holds at most {EXCEL_MAX_ROWS:,} rows below its header, and {actual}. "
        "Export to CSV or Parquet instead."
    )
