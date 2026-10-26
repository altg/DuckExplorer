"""Column Explorer profiles and sorted paging of stored results."""

import pytest

from duckexplorer_kernel.results import ResultExpired


def run(kernel, sql):
    response = kernel.execute_sql("nb", sql)
    assert response["error"] is None, response["error"]
    return response["outputs"][0]["table"]["id"]


def columns_by_name(kernel, sql):
    profile = kernel.profile_result(run(kernel, sql))
    return profile, {c["name"]: c for c in profile["columns"]}


def test_numeric_histogram_covers_every_value(kernel):
    profile, cols = columns_by_name(
        kernel, "SELECT CASE WHEN range % 10 = 0 THEN NULL ELSE range * 0.5 END AS x FROM range(1000)"
    )
    x = cols["x"]
    assert profile["rowCount"] == 1000
    assert x["kind"] == "numeric"
    assert x["nulls"] == 100
    assert x["distinct"] == 900
    assert (x["min"], x["max"]) == ("0.5", "499.5")
    assert len(x["histogram"]) == 20
    assert sum(b["count"] for b in x["histogram"]) == 900
    assert x["histogram"][0]["start"] == "0.5"
    assert x["histogram"][-1]["end"] == "499.5"


def test_integer_bins_are_whole_inclusive_ranges(kernel):
    _, cols = columns_by_name(kernel, "SELECT range + 1 AS id, range % 4 AS small FROM range(120000)")
    bars = cols["id"]["histogram"]
    assert [(b["start"], b["end"]) for b in bars[:2]] == [("1", "6000"), ("6001", "12000")]
    assert bars[-1]["end"] == "120000"
    assert all(b["count"] == 6000 for b in bars)
    # A small range gets one bar per value.
    small = cols["small"]["histogram"]
    assert [(b["start"], b["end"], b["count"]) for b in small] == [(str(v), str(v), 30000) for v in range(4)]


def test_constant_and_non_finite_columns(kernel):
    _, cols = columns_by_name(
        kernel,
        "SELECT 7 AS seven, CASE WHEN range < 3 THEN 'nan'::DOUBLE ELSE 1.5 END AS f, NULL::INTEGER AS nothing "
        "FROM range(10)",
    )
    assert cols["seven"]["histogram"] == [{"start": "7", "end": "7", "count": 10}]
    # NaN is counted as a value but can't be placed in a bar.
    assert cols["f"]["histogram"] == [{"start": "1.5", "end": "1.5", "count": 7}]
    assert cols["nothing"]["nulls"] == 10
    assert "histogram" not in cols["nothing"]


def test_dates_and_timestamps(kernel):
    _, cols = columns_by_name(
        kernel,
        "SELECT DATE '2024-01-01' + range::INTEGER AS d, TIMESTAMP '2024-01-01' + to_minutes(range) AS ts "
        "FROM range(366)",
    )
    d = cols["d"]
    assert d["kind"] == "temporal"
    assert (d["min"], d["max"]) == ("2024-01-01", "2024-12-31")
    assert d["histogram"][0] == {"start": "2024-01-01", "end": "2024-01-19", "count": 19}
    assert sum(b["count"] for b in d["histogram"]) == 366
    ts = cols["ts"]["histogram"]
    assert ts[0]["start"] == "2024-01-01 00:00:00"
    assert ts[-1]["end"] == "2024-01-01 06:05:00"
    assert sum(b["count"] for b in ts) == 366


def test_text_top_values(kernel):
    _, cols = columns_by_name(
        kernel,
        "SELECT CASE WHEN range < 50 THEN 'a' WHEN range < 80 THEN 'b' WHEN range < 90 THEN NULL "
        "ELSE 'v' || range END AS s, range % 2 = 0 AS even FROM range(100)",
    )
    s = cols["s"]
    assert s["kind"] == "text"
    assert s["nulls"] == 10
    assert s["distinct"] == 12
    assert s["top"][:2] == [{"value": "a", "count": 50}, {"value": "b", "count": 30}]
    assert len(s["top"]) == 10
    assert s["otherCount"] == 2
    assert cols["even"]["kind"] == "boolean"
    assert {t["value"]: t["count"] for t in cols["even"]["top"]} == {"true": 50, "false": 50}


def test_unique_and_nested_columns(kernel):
    _, cols = columns_by_name(kernel, "SELECT 'id' || range AS id, [range % 2] AS l FROM range(50)")
    assert cols["id"]["unique"] is True
    assert "top" not in cols["id"]
    assert cols["l"]["kind"] == "other"
    assert cols["l"]["top"] == [{"value": "[0]", "count": 25}, {"value": "[1]", "count": 25}]


def test_profile_of_empty_result_and_duplicate_names(kernel):
    profile = kernel.profile_result(run(kernel, "SELECT 1 AS a, 'x' AS a WHERE false"))
    assert profile["rowCount"] == 0
    assert [(c["name"], c["type"]) for c in profile["columns"]] == [("a", "INTEGER"), ("a", "VARCHAR")]
    profile = kernel.profile_result(run(kernel, "SELECT 1 AS a, 'x' AS a"))
    assert [c["kind"] for c in profile["columns"]] == ["numeric", "text"]


def test_wide_numbers_and_time_zones(kernel):
    kernel.session.side.execute("SET TimeZone = 'America/New_York'")
    _, cols = columns_by_name(
        kernel,
        "SELECT range::HUGEINT * 170141183460469231731687303715884105 AS huge, "
        "TIMESTAMPTZ '2024-03-10 00:00:00+00' + to_hours(range) AS t FROM range(50)",
    )
    # avg() of these HUGEINTs overflows an exact sum; the mean is computed as DOUBLE.
    assert cols["huge"]["mean"] == "4.16846e+36"
    # Bars of a TIMESTAMPTZ column are labelled in the session time zone, like min and max.
    t = cols["t"]
    assert t["histogram"][0]["start"] == t["min"] == "2024-03-09 19:00:00-05"
    assert t["histogram"][-1]["end"] == t["max"] == "2024-03-11 21:00:00-04"


def test_few_distinct_values_are_listed(kernel):
    _, cols = columns_by_name(kernel, "SELECT 'only' AS one, range = 0 AS b FROM range(1)")
    assert cols["one"]["top"] == [{"value": "only", "count": 1}]
    assert "unique" not in cols["one"]


def test_profile_is_cached(kernel):
    result_id = run(kernel, "SELECT range AS n FROM range(10)")
    assert kernel.profile_result(result_id) is kernel.profile_result(result_id)


def test_profile_of_python_dataframe(kernel):
    pytest.importorskip("pandas")
    response = kernel.execute_python("nb", "import pandas as pd\npd.DataFrame({'x': [1.0, 2.0, None], 'y': ['a', 'a', 'b']})")
    assert response["error"] is None, response["error"]
    result_id = response["outputs"][0]["table"]["id"]
    cols = {c["name"]: c for c in kernel.profile_result(result_id)["columns"]}
    assert cols["x"]["nulls"] == 1
    assert cols["y"]["top"][0] == {"value": "a", "count": 2}


def test_sorted_pages(kernel):
    kernel.page_size = 10
    result_id = run(
        kernel, "SELECT range AS i, CASE WHEN range % 5 = 0 THEN NULL ELSE range % 3 END AS k FROM range(30)"
    )
    asc = kernel.fetch_page(result_id, 0, 30, {"column": 1, "descending": False})["rows"]
    keys = [row[1] for row in asc]
    assert keys == ["0"] * 8 + ["1"] * 8 + ["2"] * 8 + [None] * 6  # NULLs last
    ties = [int(row[0]) for row in asc[:8]]
    assert ties == sorted(ties)  # ties keep their original order
    desc = kernel.fetch_page(result_id, 0, 30, {"column": 1, "descending": True})["rows"]
    assert [row[1] for row in desc] == ["2"] * 8 + ["1"] * 8 + ["0"] * 8 + [None] * 6
    # Paging through a sorted view.
    page = kernel.fetch_page(result_id, 20, 10, {"column": 0, "descending": True})["rows"]
    assert [row[0] for row in page] == [str(i) for i in range(9, -1, -1)]
    # Without a sort the original order is unchanged.
    assert kernel.fetch_page(result_id, 0, 3)["rows"] == [["0", None], ["1", "1"], ["2", "2"]]


def test_sort_by_nested_and_duplicate_columns(kernel):
    result_id = run(kernel, "SELECT [3 - range] AS a, range AS a FROM range(3)")
    rows = kernel.fetch_page(result_id, 0, 3, {"column": 0, "descending": False})["rows"]
    assert rows == [["[1]", "2"], ["[2]", "1"], ["[3]", "0"]]


def test_sort_errors(kernel):
    result_id = run(kernel, "SELECT 1 AS a")
    with pytest.raises(ValueError):
        kernel.fetch_page(result_id, 0, 10, {"column": 5, "descending": False})
    with pytest.raises(ResultExpired):
        kernel.fetch_page("gone-1", 0, 10, {"column": 0, "descending": False})
    with pytest.raises(ResultExpired):
        kernel.profile_result("gone-1")
