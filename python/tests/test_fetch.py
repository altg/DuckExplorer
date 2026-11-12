"""Reading results with a memory limit (fetch.py), and the DuckDB behaviour it relies on.

Each test of DuckDB itself pins a row of the design's table on duckdb 1.x and 2.x, so that a release
that behaves differently fails here rather than in a user's notebook.
"""

import threading
import time

import duckdb
import pyarrow as pa
import pytest

from duckexplorer_kernel import fetch

# About 52 bytes a row: 8 for the id, 36 for the hash (with its offset), 8 for the random value.
WIDE = "SELECT range AS id, md5(range::VARCHAR) AS h, random() AS r FROM range({n})"
HUGE = 10_000_000_000
MB = 1024**2


@pytest.fixture
def con():
    connection = duckdb.connect()
    yield connection
    connection.close()


def test_rows_under_the_limit_are_all_kept(con):
    fetched = fetch.read(fetch.arrow_reader(con.sql(WIDE.format(n=50_000))), 64 * MB, stop_early=True)
    assert (fetched.table.num_rows, fetched.truncated) == (50_000, False)
    assert fetched.table.column_names == ["id", "h", "r"]
    assert fetched.table.column("id").to_pylist()[:3] == [0, 1, 2]


def test_a_query_stops_at_the_limit(con):
    started = time.perf_counter()
    fetched = fetch.read(fetch.arrow_reader(con.sql(WIDE.format(n=HUGE))), 2 * MB, stop_early=True)
    assert time.perf_counter() - started < 5
    assert fetched.truncated
    rows = fetched.table.num_rows
    assert rows % fetch.BATCH_ROWS == 0
    # Past the limit by at most one batch.
    assert fetched.table.nbytes <= 2 * MB + fetched.table.nbytes // (rows // fetch.BATCH_ROWS)
    assert fetched.table.column("id").to_pylist()[:3] == [0, 1, 2]


def test_no_limit_keeps_every_row(con):
    fetched = fetch.read(fetch.arrow_reader(con.sql(WIDE.format(n=100_000))), 0, stop_early=True)
    assert (fetched.table.num_rows, fetched.truncated) == (100_000, False)


def test_an_empty_result_keeps_its_columns(con):
    fetched = fetch.read(fetch.arrow_reader(con.sql("SELECT 1 AS a, 'x' AS b WHERE false")), MB, stop_early=True)
    assert fetched.table.num_rows == 0
    assert fetched.table.column_names == ["a", "b"]
    assert not fetched.truncated


def test_the_connection_is_free_after_stopping_early(con):
    # duckdb 2 refuses the next statement while a result is open; read() closes the reader.
    fetch.read(fetch.arrow_reader(con.sql(WIDE.format(n=HUGE))), MB, stop_early=True)
    assert con.execute("SELECT 42").fetchall() == [(42,)]
    fetch.first_batch(fetch.arrow_reader(con.sql(WIDE.format(n=HUGE))))
    assert con.sql("SELECT 43").fetchall() == [(43,)]


def test_draining_completes_a_statement_that_changes_data(con):
    con.execute("CREATE TABLE t(x BIGINT)")
    rel = con.sql("INSERT INTO t SELECT range FROM range(1000000) RETURNING x, md5(x::VARCHAR)")
    fetched = fetch.read(fetch.arrow_reader(rel), MB, stop_early=False)
    assert fetched.truncated
    assert fetched.table.nbytes < 4 * MB
    assert con.sql("SELECT count(*) FROM t").fetchall() == [(1_000_000,)]


def test_a_returning_statement_inserts_every_row_even_when_stopped(con):
    # The design's table: DuckDB inserts every row before the first one is returned.
    con.execute("CREATE TABLE t(x BIGINT)")
    rel = con.sql("INSERT INTO t SELECT range FROM range(1000000) RETURNING x")
    fetch.first_batch(fetch.arrow_reader(rel))
    assert con.sql("SELECT count(*) FROM t").fetchall() == [(1_000_000,)]


def test_a_connection_result_after_execute_has_a_reader(con):
    con.execute("SELECT range AS n FROM range(50000)")
    fetched = fetch.read(fetch.arrow_reader(con), MB, stop_early=False)
    assert (fetched.table.num_rows, fetched.truncated) == (50_000, False)
    assert con.execute("SELECT 1").fetchall() == [(1,)]


def test_a_runtime_error_while_reading_is_a_duckdb_error(con):
    query = "SELECT CASE WHEN range = 2500000 THEN CAST('x' AS INTEGER) ELSE range END AS v FROM range(3000000)"
    with pytest.raises(duckdb.ConversionException, match="Conversion Error"):
        fetch.read(fetch.arrow_reader(con.sql(query)), 0, stop_early=True)
    assert con.sql("SELECT 1").fetchall() == [(1,)]


def test_an_interrupt_while_rows_stream_is_an_interrupt(con):
    reader = fetch.arrow_reader(con.sql(WIDE.format(n=HUGE)))
    timer = threading.Timer(0.3, con.interrupt)
    timer.start()
    try:
        with pytest.raises(duckdb.InterruptException):
            fetch.read(reader, 0, stop_early=True)
    finally:
        timer.cancel()
    assert con.sql("SELECT 1").fetchall() == [(1,)]


@pytest.mark.parametrize(
    "message, kind",
    [
        ("Conversion Error: Could not convert string 'x' to INT32", duckdb.ConversionException),
        ("INTERRUPT Error: Interrupted!", duckdb.InterruptException),
        ("Invalid Input Error: nope", duckdb.InvalidInputException),
        ("Out of Memory Error: failed to allocate", duckdb.OutOfMemoryException),
        ("Some New Error: unknown to this duckdb", duckdb.Error),
    ],
)
def test_reader_errors_become_duckdb_errors(message, kind):
    error = fetch.as_duckdb_error(OSError(message))
    assert type(error) is kind
    assert str(error) == message


def test_other_reader_errors_stay_as_they_are():
    error = OSError("disk full")
    assert fetch.as_duckdb_error(error) is error


def test_binder_errors_have_a_position_only_from_execute(con):
    # Why .sql files run execute() again after sql() fails to compile a SELECT.
    with pytest.raises(duckdb.BinderException) as from_sql:
        con.sql("SELECT nope FROM range(3)")
    assert "LINE 1:" not in str(from_sql.value)
    with pytest.raises(duckdb.BinderException) as from_execute:
        con.execute("SELECT nope FROM range(3)")
    assert "LINE 1:" in str(from_execute.value)


def test_the_side_cursor_answers_while_a_reader_is_open(con):
    reader = fetch.arrow_reader(con.sql(WIDE.format(n=HUGE)))
    try:
        next(iter(reader))
        assert con.cursor().sql("SELECT 7").fetchall() == [(7,)]
    finally:
        reader.close()


def test_cap_table_cuts_a_table_to_the_limit():
    table = pa.table({"n": pa.array(range(100_000), pa.int64())})  # 800,000 bytes
    kept = fetch.cap_table(table, 200_000)
    assert (kept.table.num_rows, kept.truncated) == (25_000, True)
    assert kept.table.column("n").to_pylist()[:2] == [0, 1]
    assert fetch.cap_table(table, 0) == fetch.Fetched(table, False)
    assert fetch.cap_table(table, 800_000) == fetch.Fetched(table, False)
