"""The Chart view of a result (chart.py): the chart chosen, its data and spec, and the code that keeps it."""

import json

import pytest

from duckexplorer_kernel.filters import InvalidFilter

MONTHLY = """-- name: monthly
SELECT DATE '2024-01-01' + INTERVAL (m) MONTH AS month, category, (m + 1) * length(category) AS revenue
FROM range(12) r(m), (VALUES ('Books'), ('Toys'), ('Garden')) c(category)
ORDER BY month, category;"""

DAILY = "SELECT DATE '2022-01-01' + INTERVAL (d) DAY AS day, d * 1.5 AS amount, d % 7 AS weekday FROM range(1100) r(d)"


def run(kernel, code):
    response = kernel.execute_sql("nb", code)
    assert response["error"] is None, response["error"]
    return response["outputs"][0]["table"]


def values(result):
    return result["spec"]["data"]["values"]


def test_a_line_over_time_colored_by_a_category(kernel):
    table = run(kernel, MONTHLY)
    result = kernel.chart_spec(table["id"])
    assert result["chart"] == {"mark": "line", "x": 0, "y": 2, "aggregate": "sum", "color": 1, "timeUnit": "month"}
    assert result["kinds"] == ["temporal", "text", "numeric"]
    assert result["rows"] == 36 and "note" not in result
    spec = result["spec"]
    assert spec["mark"] == {"type": "line", "tooltip": True, "point": True}
    assert spec["encoding"]["x"] == {"field": "month", "type": "temporal", "title": "month"}
    assert spec["encoding"]["y"]["title"] == "Sum of revenue"
    assert spec["encoding"]["color"]["field"] == "category"
    # Times without a zone, so the chart reads them as local times.
    assert values(result)[0] == {"month": "2024-01-01T00:00:00", "category": "Books", "revenue": 5}


def test_the_code_reruns_the_cells_query_and_draws_the_same_values(kernel):
    pytest.importorskip("altair")
    table = run(kernel, MONTHLY)
    preview = kernel.chart_spec(table["id"])
    reply = kernel.chart_code(table["id"], MONTHLY, preview["chart"])
    assert reply["library"] == "altair"
    code = reply["code"]
    # The months are already on the unit: no date_trunc needed.
    assert "date_trunc" not in code
    assert "SELECT month, category, sum(revenue) AS revenue\nFROM (\nSELECT DATE '2024-01-01'" in code
    assert "-- name:" not in code and "category;" not in code
    [output] = kernel.execute_python("nb", code)["outputs"]
    assert output["type"] == "vegalite"
    spec = json.loads(output["json"])
    [data] = spec["datasets"].values()
    assert data == values(preview)
    assert spec["mark"] == {"type": "line", "point": True, "tooltip": True}
    assert spec["encoding"]["y"]["title"] == "Sum of revenue"


def strict_json(text):
    """JSON as a browser parses it: no NaN or Infinity."""

    def reject(constant):
        raise AssertionError(f"{constant} is not JSON")

    return json.loads(text, parse_constant=reject)


def test_nulls_in_the_chart_cell_are_json_nulls(kernel):
    pytest.importorskip("altair")
    # NULL text becomes NaN in pandas' string columns, which Altair would write as a bare NaN.
    code = (
        "SELECT DATE '2024-01-01' + INTERVAL (range % 3) YEAR AS approved, "
        "CASE WHEN range % 4 = 0 THEN NULL ELSE 'sector ' || (range % 2) END AS sector, "
        "CASE WHEN range = 5 THEN 'nan'::DOUBLE ELSE range END AS amount FROM range(12)"
    )
    table = run(kernel, code)
    preview = kernel.chart_spec(table["id"], {"mark": "bar", "x": 0, "y": 2, "aggregate": "sum", "color": 1})
    assert {v["sector"] for v in values(preview)} == {None, "sector 0", "sector 1"}
    [output] = kernel.execute_python("nb", kernel.chart_code(table["id"], code, preview["chart"])["code"])["outputs"]
    spec = strict_json(output["json"])
    [data] = spec["datasets"].values()
    assert sorted(data, key=str) == sorted(values(preview), key=str)


def test_plotly_code(kernel):
    pytest.importorskip("plotly")
    table = run(kernel, MONTHLY)
    chart = {**kernel.chart_spec(table["id"])["chart"], "mark": "bar"}
    code = kernel.results.chart_code(table["id"], MONTHLY, chart, None, "plotly")
    assert code.endswith(
        'px.bar(chart_data, x="month", y="revenue", color="category", labels={"revenue": "Sum of revenue"})'
    )
    [output] = kernel.execute_python("nb", code)["outputs"]
    assert output["type"] == "plotly"


def test_many_days_are_summed_by_week(kernel):
    table = run(kernel, DAILY)
    result = kernel.chart_spec(table["id"])
    chart = result["chart"]
    assert (chart["mark"], chart["x"], chart["y"], chart["timeUnit"]) == ("line", 0, 1, "week")
    assert result["rows"] == 158  # Monday weeks from Monday 2021-12-27
    assert "point" not in result["spec"]["mark"]  # too many points for markers
    code = kernel.chart_code(table["id"], DAILY, chart)["code"]
    assert "SELECT date_trunc('week', day) AS day, sum(amount) AS amount" in code
    # Bars over time get a width from their time unit; "auto" aims for fewer of them.
    bars = kernel.chart_spec(table["id"], {**chart, "mark": "bar", "timeUnit": "auto"})
    assert bars["chart"]["timeUnit"] == "month"
    assert bars["spec"]["encoding"]["x"]["timeUnit"] == "yearmonth"
    assert bars["rows"] == 37


def test_exact_times_and_no_aggregate(kernel):
    table = run(kernel, DAILY)
    result = kernel.chart_spec(table["id"], {"mark": "line", "x": 0, "y": 1, "aggregate": "none", "timeUnit": "auto"})
    assert result["chart"]["timeUnit"] == "none"  # values that aren't aggregated keep their times
    assert result["rows"] == 1100
    assert result["spec"]["encoding"]["y"]["title"] == "amount"


def test_bars_of_categories_show_the_largest(kernel):
    table = run(kernel, "SELECT 'item ' || range AS item, range AS sold FROM range(500)")
    result = kernel.chart_spec(table["id"])
    assert result["chart"]["mark"] == "bar" and result["chart"]["x"] == 0
    assert result["rows"] == 100
    assert result["note"] == "The 100 largest of 500 item values"
    assert values(result)[0] == {"item": "item 499", "sold": 499}
    assert result["spec"]["encoding"]["x"]["sort"] == "-y"
    code = kernel.chart_code(table["id"], "SELECT 'item ' || range AS item, range AS sold FROM range(500)", result["chart"])
    assert code["code"].count("LIMIT 100") == 1


def test_counting_rows(kernel):
    table = run(kernel, "SELECT CASE WHEN range % 3 = 0 THEN 'a' ELSE 'b' END AS kind FROM range(9)")
    result = kernel.chart_spec(table["id"])
    assert result["chart"]["y"] is None
    assert values(result) == [{"kind": "b", "count": 6}, {"kind": "a", "count": 3}]
    assert result["spec"]["encoding"]["y"]["title"] == "Count of rows"


def test_a_scatter_of_many_rows_is_sampled(kernel):
    code = "SELECT range AS x, range * 2 AS y FROM range(20000)"
    table = run(kernel, code)
    result = kernel.chart_spec(table["id"])
    assert result["chart"] == {"mark": "point", "x": 0, "y": 1, "aggregate": "none", "color": None, "timeUnit": "none"}
    assert result["rows"] == 5000
    assert result["note"] == "5,000 rows sampled from 20,000"
    # With a filter, the sample is taken of the rows the filter keeps.
    where = {"conditions": [], "where": "x < 10000"}
    filtered = kernel.chart_spec(table["id"], result["chart"], where)
    assert max(v["x"] for v in values(filtered)) < 10000
    text = kernel.chart_code(table["id"], code, result["chart"], where)["code"]
    assert "WHERE x < 10000\n)\nUSING SAMPLE reservoir(5000 ROWS) REPEATABLE (42)" in text


def test_the_grids_filter_applies_to_the_chart_and_its_code(kernel):
    table = run(kernel, MONTHLY)
    where = {"conditions": [{"column": 1, "op": "eq", "value": "Toys"}]}
    result = kernel.chart_spec(table["id"], None, where)
    # One category left: nothing to color by.
    assert result["chart"]["color"] is None
    assert values(result)[:2] == [
        {"month": "2024-01-01T00:00:00", "revenue": 4},
        {"month": "2024-02-01T00:00:00", "revenue": 8},
    ]
    code = kernel.chart_code(table["id"], MONTHLY, result["chart"], where)["code"]
    assert "\n)\nWHERE category = 'Toys'\nGROUP BY ALL" in code


def test_names_that_need_quoting_and_escaping(kernel):
    pytest.importorskip("altair")
    code = 'SELECT \'x\' AS "a.b", 1 AS "select", 2 AS "count"'
    table = run(kernel, code)
    result = kernel.chart_spec(table["id"], {"mark": "bar", "x": 0, "y": 1, "aggregate": "sum", "color": None})
    assert result["spec"]["encoding"]["x"]["field"] == "a\\.b"
    assert values(result) == [{"a.b": "x", "select": 1}]
    text = kernel.chart_code(table["id"], code, result["chart"])["code"]
    assert 'SELECT "a.b", sum("select") AS "select"' in text
    assert 'alt.X(field="a\\\\.b", type="nominal"' in text
    # Counting rows next to a column named count.
    counted = kernel.chart_spec(table["id"], {"mark": "bar", "x": 2, "y": None})
    assert values(counted) == [{"count": 2, "count_2": 1}]
    [output] = kernel.execute_python("nb", text)["outputs"]
    assert output["type"] == "vegalite"


def test_invalid_charts(kernel):
    table = run(kernel, "SELECT 'a' AS name, 1 AS n, [1, 2] AS list")
    with pytest.raises(InvalidFilter, match="name can't be charted on y"):
        kernel.chart_spec(table["id"], {"y": 0})
    with pytest.raises(InvalidFilter, match="list can't be charted on x"):
        kernel.chart_spec(table["id"], {"x": 2})
    with pytest.raises(InvalidFilter, match="Unknown chart mark"):
        kernel.chart_spec(table["id"], {"mark": "pie"})
    assert kernel.chart_spec(table["id"])["kinds"] == ["text", "numeric", "other"]
    nothing = run(kernel, "SELECT [1] AS list")
    with pytest.raises(InvalidFilter, match="Nothing to chart"):
        kernel.chart_spec(nothing["id"])


def test_duplicate_names_and_empty_results(kernel):
    table = run(kernel, "SELECT 1 AS a, 'x' AS b, 2 AS a WHERE false")
    result = kernel.chart_spec(table["id"])
    assert result["kinds"] == ["numeric", "text", "other"]
    assert result["rows"] == 0 and result["note"] == "No rows to chart"


def test_time_zones_and_decimals(kernel):
    table = run(
        kernel,
        "SELECT TIMESTAMPTZ '2024-03-01 10:30:00+00' + INTERVAL (range) HOUR AS at, 1.25::DECIMAL(5, 2) AS price "
        "FROM range(3)",
    )
    kernel.session.side.execute("SET TimeZone = 'UTC'")
    result = kernel.chart_spec(table["id"], {"aggregate": "none"})
    assert values(result)[0] == {"at": "2024-03-01T10:30:00", "price": 1.25}
