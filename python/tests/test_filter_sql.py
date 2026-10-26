"""Grid filters written as SQL: for the WHERE box, and for a new cell that reruns the query filtered."""

import pytest

from duckexplorer_kernel.filters import InvalidFilter

MIXED = """
SELECT range AS id,
       CASE WHEN range % 9 = 0 THEN NULL ELSE ['open', 'it''s shipped', 'returned'][range % 3 + 1] END AS "order status",
       (range * 0.37)::DOUBLE AS score,
       (range * 1.25)::DECIMAL(10, 2) AS amount,
       DATE '2024-01-01' + (range % 50)::INTEGER AS "order",
       TIMESTAMP '2024-01-01' + to_minutes(range * 7) AS ts,
       TIMESTAMPTZ '2024-03-09 12:00:00+00' + to_hours(range) AS tz,
       range % 4 = 0 AS flag,
       [range % 3] AS l,
       (range / 3.0)::FLOAT AS f
FROM range(240)
"""


def run(kernel, sql):
    response = kernel.execute_sql("nb", sql)
    assert response["error"] is None, response["error"]
    return response["outputs"][0]["table"]["id"]


def ids(kernel, result_id, spec, sort=None):
    return [row[0] for row in kernel.fetch_page(result_id, 0, 100_000, sort, spec)["rows"]]


def sql_for(kernel, result_id, *conditions, where=""):
    return kernel.filter_sql(result_id, {"conditions": list(conditions), "where": where})["where"]


def test_sql_selects_the_same_rows_as_the_conditions(kernel):
    kernel.session.side.execute("SET TimeZone = 'America/New_York'")  # the tz column crosses a DST change
    result_id = run(kernel, MIXED)
    page = kernel.fetch_page(result_id, 0, 240)["rows"]
    conditions = []
    for col, column in enumerate(kernel.profile_result(result_id)["columns"]):
        for value in {row[col] for row in page[::37]}:
            if value is None:
                conditions += [{"column": col, "op": "null"}, {"column": col, "op": "notNull"}]
                continue
            ops = ["eq", "ne"] + (["ge", "le"] if column["kind"] in ("numeric", "temporal") else [])
            conditions += [{"column": col, "op": op, "value": value} for op in ops]
        for index in range(len(column.get("histogram", []))):
            conditions.append({"column": col, "op": "bin", "bins": column["bins"], "index": index})
    assert len(conditions) > 250
    for condition in conditions:
        spec = {"conditions": [condition], "where": ""}
        sql = kernel.filter_sql(result_id, spec)["where"]
        assert ids(kernel, result_id, {"conditions": [], "where": sql}) == ids(kernel, result_id, spec), (condition, sql)


def test_sql_is_readable(kernel):
    result_id = run(kernel, MIXED)
    assert sql_for(kernel, result_id, {"column": 1, "op": "eq", "value": "it's shipped"}) == "\"order status\" = 'it''s shipped'"
    assert sql_for(kernel, result_id, {"column": 1, "op": "ne", "value": "open"}) == "\"order status\" IS DISTINCT FROM 'open'"
    assert sql_for(kernel, result_id, {"column": 3, "op": "ge", "value": "12.50"}) == "amount >= 12.50"
    assert sql_for(kernel, result_id, {"column": 2, "op": "le", "value": "3.7"}) == "score <= '3.7'"
    assert sql_for(kernel, result_id, {"column": 7, "op": "eq", "value": "true"}) == "flag = true"
    assert sql_for(kernel, result_id, {"column": 8, "op": "eq", "value": "[1]"}) == "l::VARCHAR = '[1]'"
    assert sql_for(kernel, result_id, {"column": 5, "op": "null"}) == "ts IS NULL"
    days = kernel.profile_result(result_id)["columns"][4]
    bar = {"column": 4, "op": "bin", "bins": days["bins"], "index": 0}
    assert sql_for(kernel, result_id, bar) == "\"order\" BETWEEN '2024-01-01' AND '2024-01-03'"
    # Conditions and WHERE text combine; the WHERE text keeps its own precedence.
    assert (
        sql_for(kernel, result_id, {"column": 0, "op": "ge", "value": "10"}, where="flag OR id = 3")
        == "id >= 10 AND (flag OR id = 3)"
    )
    assert sql_for(kernel, result_id, where="  id < 5 ") == "id < 5"
    assert sql_for(kernel, result_id) == ""


def test_bar_filter_is_limited_to_its_range(kernel):
    # A bar of a histogram made under another filter keeps only its own range once that filter goes.
    result_id = run(kernel, "SELECT range AS n FROM range(1000)")
    narrow = {"conditions": [{"column": 0, "op": "ge", "value": "500"}], "where": ""}
    column = kernel.profile_result(result_id, narrow)["columns"][0]
    first, last = column["histogram"][0], column["histogram"][-1]
    for index, bar in ((0, first), (len(column["histogram"]) - 1, last)):
        alone = {"conditions": [{"column": 0, "op": "bin", "bins": column["bins"], "index": index}], "where": ""}
        assert kernel.fetch_page(result_id, 0, 1, None, alone)["rowCount"] == bar["count"]
    # 500 … 999 in 20 bars of 25: the first bar is exactly 500 … 524.
    assert (first["start"], first["end"], first["count"]) == ("500", "524", 25)


def test_duplicate_column_names(kernel):
    result_id = run(kernel, "SELECT 1 AS a, 2 AS A")
    assert sql_for(kernel, result_id, {"column": 0, "op": "eq", "value": "1"}) == "a = 1"
    with pytest.raises(InvalidFilter, match='more than one column named "A"'):
        sql_for(kernel, result_id, {"column": 1, "op": "eq", "value": "2"})


CELL = """-- name: shop
CREATE OR REPLACE TEMP TABLE t AS SELECT range AS n, range % 3 AS k FROM range(30);
SELECT n, k -- the columns
FROM t
ORDER BY n DESC; -- newest first
"""


def test_filtered_query_reruns_as_the_grid_shows_it(kernel):
    result_id = run(kernel, CELL)
    spec = {"conditions": [{"column": 1, "op": "eq", "value": "2"}], "where": "n > 10"}
    sort = {"column": 0, "descending": False}
    code = kernel.filtered_query(result_id, CELL, spec, sort)["code"]
    assert code == (
        "SELECT *\nFROM (\nSELECT n, k -- the columns\nFROM t\nORDER BY n DESC\n)\n"
        "WHERE k = 2 AND (n > 10)\nORDER BY n ASC NULLS LAST"
    )
    rerun = kernel.execute_sql("nb", code)["outputs"][0]["table"]
    assert rerun["rows"] == kernel.fetch_page(result_id, 0, 100, sort, spec)["rows"]
    # Without a filter or sort it is just the query.
    assert kernel.filtered_query(result_id, CELL, None, None)["code"].endswith("ORDER BY n DESC\n)")


def test_filtered_query_needs_a_query_to_wrap(kernel):
    result_id = run(kernel, "SELECT 1 AS a")
    with pytest.raises(InvalidFilter, match="no SQL statement"):
        kernel.filtered_query(result_id, "-- nothing here", None, None)
    with pytest.raises(InvalidFilter, match="subquery"):
        kernel.filtered_query(result_id, "EXPLAIN SELECT 1", None, None)
    # DuckDB rewrites some PRAGMAs into queries, which wrap fine.
    assert "pragma_version()" in kernel.filtered_query(result_id, "PRAGMA version", None, None)["code"]
    with pytest.raises(InvalidFilter, match="doesn't parse"):
        kernel.filtered_query(result_id, "SELEC 1", None, None)
