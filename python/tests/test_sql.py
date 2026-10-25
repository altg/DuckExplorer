import threading
import time

import pytest

from duckexplorer_kernel.results import MAX_RESULTS, ResultExpired


def only_table(response):
    assert response["error"] is None, response["error"]
    [output] = response["outputs"]
    assert output["type"] == "table"
    return output["table"]


def test_select_returns_first_page_and_metadata(kernel):
    kernel.page_size = 50
    table = only_table(kernel.execute_sql("nb", "SELECT range AS n, range * 2 AS doubled FROM range(1234)"))
    assert table["rowCount"] == 1234
    assert table["columns"] == [{"name": "n", "type": "BIGINT"}, {"name": "doubled", "type": "BIGINT"}]
    assert len(table["rows"]) == 50
    assert table["rows"][3] == ["3", "6"]
    assert table["boundTo"] == ["df"]
    assert table["elapsedMs"] >= 0


def test_paging(kernel):
    table = only_table(kernel.execute_sql("nb", "SELECT range AS n FROM range(1000)"))
    page = kernel.fetch_page(table["id"], 990, 50)["rows"]
    assert page == [[str(i)] for i in range(990, 1000)]
    assert kernel.fetch_page(table["id"], 5000, 10)["rows"] == []


def test_every_type_renders_as_duckdb_text(kernel):
    table = only_table(
        kernel.execute_sql(
            "nb",
            r"""
            SELECT 1.50::DECIMAL(10,2) AS dec, [1, 2] AS list, {'a': 1, 'b': 'x'} AS struct,
                   MAP([1], ['one']) AS map, 'ab'::BLOB AS blob, DATE '2024-02-29' AS date,
                   TIMESTAMP '2024-01-02 03:04:05' AS ts, INTERVAL 3 DAY AS iv, 'NaN'::DOUBLE AS nan,
                   170141183460469231731687303715884105727::HUGEINT AS huge, NULL::INTEGER AS nothing,
                   TRUE AS flag, '00000000-0000-0000-0000-000000000001'::UUID AS id, TIME '12:30:00' AS t
            """,
        )
    )
    row = dict(zip([c["name"] for c in table["columns"]], table["rows"][0]))
    assert row == {
        "dec": "1.50",
        "list": "[1, 2]",
        "struct": "{'a': 1, 'b': x}",
        "map": "{1=one}",
        "blob": "ab",
        "date": "2024-02-29",
        "ts": "2024-01-02 03:04:05",
        "iv": "3 days",
        "nan": "nan",
        "huge": "170141183460469231731687303715884105727",
        "nothing": None,
        "flag": "true",
        "id": "00000000-0000-0000-0000-000000000001",
        "t": "12:30:00",
    }
    types = {c["name"]: c["type"] for c in table["columns"]}
    assert types["dec"] == "DECIMAL(10,2)"
    assert types["struct"] == "STRUCT(a INTEGER, b VARCHAR)"


def test_duplicate_column_names(kernel):
    table = only_table(kernel.execute_sql("nb", "SELECT 1 AS a, 2 AS a"))
    assert [c["name"] for c in table["columns"]] == ["a", "a"]
    assert table["rows"] == [["1", "2"]]


def test_statement_without_result(kernel):
    response = kernel.execute_sql("nb", "CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1), (2)")
    assert response["error"] is None
    [output] = response["outputs"]
    assert output["type"] == "text" and output["text"].startswith("Statement executed")


def test_multiple_statements_return_last_result(kernel):
    table = only_table(kernel.execute_sql("nb", "CREATE TABLE t AS SELECT 42 AS x; SELECT x + 1 AS y FROM t"))
    assert table["rows"] == [["43"]]


def test_sql_error(kernel):
    response = kernel.execute_sql("nb", "SELECT * FROM does_not_exist")
    assert response["outputs"] == []
    assert response["error"]["ename"] == "CatalogException"
    assert "does_not_exist" in response["error"]["evalue"]


def test_results_expire(kernel):
    first = only_table(kernel.execute_sql("nb", "SELECT 1"))
    for _ in range(MAX_RESULTS):
        kernel.execute_sql("nb", "SELECT 2")
    with pytest.raises(ResultExpired):
        kernel.fetch_page(first["id"], 0, 10)


def test_interrupt_long_query(kernel):
    def stop_soon():
        time.sleep(0.5)
        assert kernel.interrupt()

    threading.Thread(target=stop_soon).start()
    started = time.perf_counter()
    response = kernel.execute_sql(
        "nb", "SELECT count(*) FROM range(10000000000) a, range(10) b WHERE a.range % 7 = b.range"
    )
    assert response["error"]["ename"] == "KeyboardInterrupt"
    assert time.perf_counter() - started < 10
    # The connection is still usable afterwards.
    assert only_table(kernel.execute_sql("nb", "SELECT 1 AS ok"))["rows"] == [["1"]]


def test_interrupt_when_idle_is_noop(kernel):
    assert kernel.interrupt() is False


def test_relative_paths_resolve_against_cwd(kernel, sample_db, tmp_path):
    response = kernel.execute_sql(
        "nb", "ATTACH IF NOT EXISTS 'shop.duckdb' AS s (READ_ONLY); SELECT count(*) AS n FROM s.orders",
        cwd=str(sample_db.parent),
    )
    assert response["outputs"][0]["table"]["rows"] == [["1000"]]
