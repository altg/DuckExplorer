"""Reading a statement's rows with a limit on the memory they may take."""

from __future__ import annotations

import re
import warnings
from dataclasses import dataclass
from typing import Any, Callable

import duckdb
import pyarrow as pa

# Rows per Arrow batch. A result may pass its limit by at most one batch, so this stays small.
BATCH_ROWS = 20_000
_READERS = ("to_arrow_reader", "fetch_arrow_reader", "fetch_record_batch")
_ERROR_KIND = re.compile(r"\A((?:[A-Za-z]+ )+)Error: ")
_ERRORS = {
    name.lower(): cls
    for name, cls in vars(duckdb).items()
    if isinstance(cls, type) and issubclass(cls, duckdb.Error)
}


@dataclass
class Fetched:
    table: pa.Table
    # The statement returned more rows than were kept.
    truncated: bool


def arrow_reader(source: Any, batch_rows: int = BATCH_ROWS) -> pa.RecordBatchReader:
    """A reader over a relation's rows, or over a connection's result after execute()."""
    for name in _READERS:
        method = getattr(source, name, None)
        if method is not None:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                warnings.filterwarnings("ignore", "Arrow output on a DB-API result", UserWarning)
                return method(batch_rows)
    raise RuntimeError("This duckdb has no Arrow reader")


def read(
    reader: pa.RecordBatchReader,
    max_bytes: int,
    stop_early: bool,
    on_grow: Callable[[int], None] | None = None,
) -> Fetched:
    """Reads a result, keeping rows until they take `max_bytes` (0: all of them).

    With `stop_early` the statement is abandoned once the limit is reached; without it the reader is
    read to its end and the further rows are dropped, so the statement completes. `on_grow` is told
    the bytes kept so far after each batch (the result store makes room for them).
    Always closes the reader: duckdb 2 refuses the next statement on a connection with an open result.
    """
    schema = reader.schema
    batches: list[pa.RecordBatch] = []
    size = 0
    full = truncated = False
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", "Arrow output on a DB-API result", UserWarning)
            for batch in reader:
                if batch.num_rows == 0:
                    continue
                if full:
                    truncated = True
                    if stop_early:
                        break
                    continue
                batches.append(batch)
                size += batch.nbytes
                full = max_bytes > 0 and size >= max_bytes
                if on_grow is not None:
                    on_grow(size)
    except (OSError, pa.ArrowException) as exc:
        raise as_duckdb_error(exc) from None
    finally:
        reader.close()
    return Fetched(pa.Table.from_batches(batches, schema=schema), truncated)


def first_batch(reader: pa.RecordBatchReader) -> None:
    """Starts a statement whose rows nobody will see, reading one batch, and closes it."""
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", "Arrow output on a DB-API result", UserWarning)
            for _ in reader:
                break
    except (OSError, pa.ArrowException) as exc:
        raise as_duckdb_error(exc) from None
    finally:
        reader.close()


def cap_table(table: pa.Table, max_bytes: int) -> Fetched:
    """An Arrow table that already exists, cut to the rows that fit `max_bytes` (0: all of them)."""
    nbytes = table.nbytes
    if max_bytes <= 0 or nbytes <= max_bytes or table.num_rows == 0:
        return Fetched(table, False)
    return Fetched(table.slice(0, table.num_rows * max_bytes // nbytes), True)


def as_duckdb_error(exc: BaseException) -> BaseException:
    """An error raised while a reader is iterated arrives from pyarrow as OSError with DuckDB's
    message ("Conversion Error: ...", "INTERRUPT Error: Interrupted!"): the DuckDB exception it was."""
    message = str(exc)
    match = _ERROR_KIND.match(message)
    if not match:
        return exc
    cls = _ERRORS.get(match.group(1).replace(" ", "").lower() + "exception", duckdb.Error)
    return cls(message)
