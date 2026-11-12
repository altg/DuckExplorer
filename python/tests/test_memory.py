"""The memory limit for query results (setting duckexplorer.maxResultMemory): results are cut off at
their share of it, flagged as such, and evicted by total size."""

import threading
import time

import duckdb
import pyarrow as pa
import pytest

import duckexplorer_kernel.kernel as kernel_module
from duckexplorer_kernel import fetch
from duckexplorer_kernel.results import ResultExpired

# About 52 bytes a row: 8 for the id, 36 for the hash (with its offset), 8 for the random value.
WIDE = "SELECT range AS id, md5(range::VARCHAR) AS h, random() AS r FROM range({n})"
HUGE = 10_000_000_000
MB = 1024**2
# The limit tests use: 4 MB for stored results, 2 MB for one of them.
LIMIT_MB = 4


@pytest.fixture
def small(kernel):
    kernel.configure({"maxResultMemory": LIMIT_MB})
    return kernel


def only_table(response):
    assert response["error"] is None, response["error"]
    [output] = response["outputs"]
    assert output["type"] == "table"
    return output["table"]


def within_one_batch(kernel, table):
    """The stored rows take at most the limit for one result, plus one batch."""
    stored = kernel.results.get(table["id"])
    batches = max(1, stored.row_count // fetch.BATCH_ROWS)
    return stored.nbytes <= kernel.max_result_bytes + stored.nbytes // batches


def test_configure_sets_both_limits(kernel):
    assert (kernel.results.max_bytes, kernel.max_result_bytes) == (1024 * MB, 512 * MB)
    kernel.configure({"maxResultMemory": 100})
    assert (kernel.results.max_bytes, kernel.max_result_bytes) == (100 * MB, 50 * MB)
    kernel.configure({"maxResultMemory": 0})
    assert (kernel.results.max_bytes, kernel.max_result_bytes) == (0, 0)


def test_a_result_under_the_limit_is_unchanged(small):
    table = only_table(small.execute_sql("nb", WIDE.format(n=10_000)))
    assert table["rowCount"] == 10_000
    assert "truncated" not in table
    assert "memoryLimitMb" not in table
    assert sorted(table) == ["boundTo", "columns", "elapsedMs", "id", "pageSize", "rowCount", "rows"]


def test_a_large_query_is_cut_off_early(small):
    started = time.perf_counter()
    table = only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    assert time.perf_counter() - started < 5
    assert table["truncated"] is True
    assert table["memoryLimitMb"] == LIMIT_MB / 2
    assert table["rowCount"] % fetch.BATCH_ROWS == 0
    assert [row[0] for row in table["rows"][:3]] == ["0", "1", "2"]
    assert within_one_batch(small, table)


def test_the_connection_is_free_after_a_cut_off_result(small):
    only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    assert only_table(small.execute_sql("nb", "SELECT 1 AS ok"))["rows"] == [["1"]]
    reply = small.run_statements(["SELECT 2 AS ok"])
    assert reply["table"]["rows"] == [["2"]]
    only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    reply = small.run_statements([WIDE.format(n=HUGE)])
    assert reply["table"]["truncated"] is True
    assert only_table(small.execute_sql("nb", "SELECT 3 AS ok"))["rows"] == [["3"]]


def test_no_limit_keeps_every_row(kernel):
    kernel.configure({"maxResultMemory": 1})
    query = WIDE.format(n=100_000)  # about 5 MB
    assert only_table(kernel.execute_sql("nb", query))["truncated"] is True
    kernel.configure({"maxResultMemory": 0})
    table = only_table(kernel.execute_sql("nb", query))
    assert table["rowCount"] == 100_000
    assert "truncated" not in table


def test_statements_that_change_data_complete(small):
    small.execute_sql("nb", "CREATE TABLE t(x BIGINT)")
    table = only_table(
        small.execute_sql("nb", "INSERT INTO t SELECT range FROM range(2000000) RETURNING x, md5(x::VARCHAR)")
    )
    assert table["truncated"] is True
    assert within_one_batch(small, table)
    assert only_table(small.execute_sql("nb", "SELECT count(*) FROM t"))["rows"] == [["2000000"]]


def test_a_runtime_error_keeps_its_type(kernel):
    query = "SELECT CASE WHEN range = 2500000 THEN CAST('x' AS INTEGER) ELSE range END AS v FROM range(3000000)"
    error = kernel.execute_sql("nb", query)["error"]
    assert error["ename"] == "ConversionException"
    assert "Conversion Error" in error["evalue"]
    assert only_table(kernel.execute_sql("nb", "SELECT 1 AS ok"))["rows"] == [["1"]]


def test_an_interrupt_while_rows_stream(kernel):
    # The default limit, which these rows take seconds to reach: the interrupt comes first.
    def stop_soon():
        time.sleep(0.5)
        assert kernel.interrupt()

    threading.Thread(target=stop_soon).start()
    started = time.perf_counter()
    response = kernel.execute_sql("nb", WIDE.format(n=HUGE) + " WHERE md5(range::VARCHAR) > ''")
    assert response["error"]["ename"] == "KeyboardInterrupt"
    assert time.perf_counter() - started < 10
    assert only_table(kernel.execute_sql("nb", "SELECT 1 AS ok"))["rows"] == [["1"]]


def test_results_are_evicted_by_size(small):
    # Three results of about 40% of the limit each: the first one goes.
    query = WIDE.format(n=30_000)
    first, second, third = (only_table(small.execute_sql("nb", query)) for _ in range(3))
    share = small.results.get(third["id"]).nbytes / small.results.max_bytes
    assert 0.35 < share < 0.45, share
    with pytest.raises(ResultExpired):
        small.fetch_page(first["id"], 0, 10)
    for table in (second, third):
        assert small.fetch_page(table["id"], 100, 10)["rows"][0][0] == "100"


def test_the_newest_result_is_never_evicted(small):
    # Two cut-off results take more than the limit together, but the newest one stays.
    first = only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    first_bytes = small.results.get(first["id"]).nbytes
    second = only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    assert first_bytes + small.results.get(second["id"]).nbytes > small.results.max_bytes
    with pytest.raises(ResultExpired):
        small.fetch_page(first["id"], 0, 10)
    assert small.fetch_page(second["id"], 0, 1)["rows"] == [second["rows"][0]]
    # A single result larger than the whole limit (set lower after it was read) stays too.
    small.results.max_bytes = 1000
    stored = small.results.add(pa.table({"n": pa.array(range(10_000), pa.int64())}))
    assert small.results.get(stored.id) is stored


def test_live_previews_do_not_count(small):
    table = only_table(small.execute_sql("nb", WIDE.format(n=30_000)))
    for n in range(10):
        assert small.preview_sql(WIDE.format(n=1000 + n))["table"]["rowCount"] == 100
    assert small.fetch_page(table["id"], 0, 1)["rowCount"] == 30_000


def test_df_says_the_result_was_cut_off(small):
    table = only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    response = small.execute_python("nb", "print(len(df))")
    assert response["error"] is None
    notes = [o["text"] for o in response["outputs"] if o.get("name") == "stderr"]
    assert len(notes) == 1
    assert notes[0].count("Note:") == 1
    assert f"holds the first {table['rowCount']:,} rows" in notes[0]
    assert "duckexplorer.maxResultMemory" in notes[0]
    assert [o["text"] for o in response["outputs"] if o.get("name") == "stdout"] == [f"{table['rowCount']}\n"]


def test_df_note_with_both_limits(small):
    small.configure({"maxPandasRows": 1000})
    small.execute_sql("nb", WIDE.format(n=HUGE))
    response = small.execute_python("nb", "print(len(df))")
    [note] = [o["text"] for o in response["outputs"] if o.get("name") == "stderr"]
    assert note.count("Note:") == 1
    assert "holds the first 1,000 rows" in note
    assert "duckexplorer.maxResultMemory and duckexplorer.maxPandasRows" in note


def test_sql_file_rows_are_limited(small):
    started = time.perf_counter()
    reply = small.run_statements(["SELECT 1", WIDE.format(n=HUGE)])
    assert time.perf_counter() - started < 5
    assert "error" not in reply, reply
    assert reply["table"]["truncated"] is True
    assert reply["table"]["memoryLimitMb"] == LIMIT_MB / 2
    assert within_one_batch(small, reply["table"])


def test_sql_file_unread_select_is_cheap(small):
    # Rows nobody sees: duckdb 2's execute() would load all of them before returning.
    started = time.perf_counter()
    reply = small.run_statements(["SELECT range FROM range(10000000000)", "SELECT 2 AS x"])
    assert time.perf_counter() - started < 5
    assert reply["table"]["rows"] == [["2"]]


def test_sql_file_statements_that_are_not_queries_are_limited(small):
    small.run_statements(["CREATE TABLE t(x BIGINT)"])
    reply = small.run_statements(["INSERT INTO t SELECT range FROM range(1000000) RETURNING x, md5(x::VARCHAR)"])
    assert reply["table"]["truncated"] is True
    assert small.run_statements(["SELECT count(*) AS n FROM t"])["table"]["rows"] == [["1000000"]]


def test_sql_file_binder_error_on_a_later_line_has_its_position(kernel):
    statement = "SELECT 1 AS a,\n  nope AS b\nFROM range(3)"
    error = kernel.run_statements(["SELECT 1", statement])["error"]
    assert error["ename"] == "BinderException"
    assert error["statement"] == 1
    assert error["position"] == statement.index("nope")
    assert "LINE" not in error["message"]


def test_sql_file_runtime_error_runs_once(kernel):
    failing = (
        "SELECT nextval('{seq}') AS v, CAST(CASE WHEN range = 1 THEN 'x' ELSE '1' END AS INTEGER) AS bad "
        "FROM range(2)"
    )
    # What one run of the statement does to a sequence.
    con = kernel.session.con
    con.execute("CREATE SEQUENCE once; CREATE SEQUENCE s")
    with pytest.raises(duckdb.ConversionException):
        con.execute(failing.format(seq="once")).fetchall()
    [(expected,)] = con.execute("SELECT nextval('once')").fetchall()

    error = kernel.run_statements([failing.format(seq="s")])["error"]
    assert error["ename"] == "ConversionException"
    assert kernel.run_statements(["SELECT nextval('s') AS v"])["table"]["rows"] == [[str(expected)]]


def test_export_of_a_cut_off_result(small, tmp_path):
    table = only_table(small.execute_sql("nb", WIDE.format(n=HUGE)))
    path = tmp_path / "cut.csv"
    reply = small.export_result(table["id"], str(path), "csv")
    assert reply == {"rowCount": table["rowCount"], "truncated": True}
    [(rows,)] = duckdb.sql(f"SELECT count(*) FROM read_csv('{path.as_posix()}')").fetchall()
    assert rows == table["rowCount"]


def test_summary_of_a_wide_table_fits_the_limit(small):
    small.execute_sql("nb", "CREATE TABLE wide AS SELECT range AS id, repeat('x', 500) AS pad FROM range(200000)")
    table = small.summarize("memory", "main", "wide")
    assert table["sampledFrom"] == 200_000
    assert table["rowCount"] < 200_000
    assert within_one_batch(small, table)


def test_python_display_of_a_large_relation(small):
    started = time.perf_counter()
    response = small.execute_python("nb", f"con.sql('{WIDE.format(n=HUGE)}')")
    assert time.perf_counter() - started < 5
    assert response["error"] is None, response["error"]
    [output] = response["outputs"]
    assert output["table"]["truncated"] is True
    assert within_one_batch(small, output["table"])


def test_python_display_of_a_large_dataframe(small, monkeypatch):
    converted = []
    to_arrow = kernel_module._frame_to_arrow

    def counting(frame, pd):
        converted.append(len(frame))
        return to_arrow(frame, pd)

    small.execute_python("nb", "import pandas as pd\nframe = pd.DataFrame({'n': range(1_000_000)})")
    monkeypatch.setattr(kernel_module, "_frame_to_arrow", counting)
    response = small.execute_python("nb", "frame")
    assert response["error"] is None, response["error"]
    [output] = response["outputs"]
    assert output["table"]["truncated"] is True
    assert output["table"]["rowCount"] == 2 * MB // 8
    # Never the whole frame: a probe of its first rows, then the rows that fit.
    assert max(converted) < 1_000_000


def test_python_display_of_a_large_arrow_table(small):
    small.execute_python("nb", "import pyarrow as pa\nt = pa.table({'n': pa.array(range(1_000_000), pa.int64())})")
    [output] = small.execute_python("nb", "t")["outputs"]
    assert output["table"]["truncated"] is True
    assert output["table"]["rowCount"] == 2 * MB // 8
