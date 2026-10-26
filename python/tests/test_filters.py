"""Filtered (and sorted) views of stored results, and Column Explorer statistics of filtered rows."""

import pytest

from duckexplorer_kernel.filters import InvalidFilter

SHOP = """
SELECT range AS id,
       CASE WHEN range % 10 = 0 THEN NULL ELSE ['open', 'shipped', 'returned'][range % 3 + 1] END AS status,
       (range * 1.5)::DOUBLE AS amount,
       DATE '2024-01-01' + (range % 60)::INTEGER AS day
FROM range(300)
"""


def run(kernel, sql):
    response = kernel.execute_sql("nb", sql)
    assert response["error"] is None, response["error"]
    return response["outputs"][0]["table"]["id"]


def view(kernel, result_id, conditions=(), where="", sort=None, offset=0, limit=1000):
    return kernel.fetch_page(result_id, offset, limit, sort, {"conditions": list(conditions), "where": where})


def ids(page):
    return [int(row[0]) for row in page["rows"]]


def test_value_conditions(kernel):
    result_id = run(kernel, SHOP)
    shipped = view(kernel, result_id, [{"column": 1, "op": "eq", "value": "shipped"}])
    assert shipped["rowCount"] == len(shipped["rows"]) == sum(1 for i in range(300) if i % 10 and i % 3 == 1)
    assert {row[1] for row in shipped["rows"]} == {"shipped"}
    assert ids(shipped) == sorted(ids(shipped))  # query order is kept

    # Excluding a value keeps the NULL rows.
    others = view(kernel, result_id, [{"column": 1, "op": "ne", "value": "shipped"}])
    assert others["rowCount"] == 300 - shipped["rowCount"]
    assert sum(1 for row in others["rows"] if row[1] is None) == 30

    assert view(kernel, result_id, [{"column": 1, "op": "null"}])["rowCount"] == 30
    assert view(kernel, result_id, [{"column": 1, "op": "notNull"}])["rowCount"] == 270


def test_ordering_conditions_compare_typed_values(kernel):
    result_id = run(kernel, SHOP)
    # As the grid shows them: '30.0' for a DOUBLE and an ISO date.
    page = view(
        kernel,
        result_id,
        [
            {"column": 2, "op": "ge", "value": "30.0"},
            {"column": 2, "op": "le", "value": "60.0"},
            {"column": 3, "op": "le", "value": "2024-01-25"},
        ],
    )
    assert ids(page) == [i for i in range(20, 41) if i % 60 <= 24]
    with pytest.raises(InvalidFilter, match="Conversion Error"):
        view(kernel, result_id, [{"column": 2, "op": "ge", "value": "lots"}])


def test_equality_matches_the_displayed_text(kernel):
    result_id = run(
        kernel,
        "SELECT range AS i, [range % 2] AS l, (range / 3)::DOUBLE AS f, "
        "TIMESTAMPTZ '2024-01-01 00:00:00+00' + to_hours(range % 2) AS t FROM range(6)",
    )
    first = kernel.fetch_page(result_id, 0, 6)["rows"]
    for column in (1, 2, 3):
        value = first[1][column]
        page = view(kernel, result_id, [{"column": column, "op": "eq", "value": value}])
        assert page["rows"] and all(row[column] == value for row in page["rows"]), column


def test_where_uses_column_names(kernel):
    result_id = run(kernel, 'SELECT range AS "order id", range % 7 AS bucket FROM range(100)')
    page = view(kernel, result_id, where='bucket = 3 AND "order id" > 50')
    assert ids(page) == [i for i in range(51, 100) if i % 7 == 3]
    # Conditions and the WHERE text combine.
    page = view(kernel, result_id, [{"column": 0, "op": "le", "value": "80"}], where="bucket = 3")
    assert ids(page) == [i for i in range(81) if i % 7 == 3]


def test_sorted_and_filtered_paging(kernel):
    result_id = run(kernel, SHOP)
    sort = {"column": 2, "descending": True}
    first = view(kernel, result_id, where="status = 'open'", sort=sort, limit=5)
    rest = view(kernel, result_id, where="status = 'open'", sort=sort, offset=5, limit=1000)
    expected = sorted((i for i in range(300) if i % 10 and i % 3 == 0), reverse=True)
    assert ids(first) + ids(rest) == expected
    assert first["rowCount"] == rest["rowCount"] == len(expected)
    # The unfiltered, unsorted result is unchanged.
    assert kernel.fetch_page(result_id, 0, 2) == {"rows": [["0", None, "0.0", "2024-01-01"], ["1", "shipped", "1.5", "2024-01-02"]], "rowCount": 300}


def test_empty_spec_and_no_matches(kernel):
    result_id = run(kernel, SHOP)
    assert view(kernel, result_id, where="  ")["rowCount"] == 300
    nothing = view(kernel, result_id, where="amount < 0")
    assert nothing == {"rows": [], "rowCount": 0}
    profile = kernel.profile_result(result_id, {"conditions": [], "where": "amount < 0"})
    assert profile["rowCount"] == 0


def test_duplicate_and_internal_column_names(kernel):
    result_id = run(kernel, "SELECT range AS a, 100 - range AS a, range % 2 AS __dx_row FROM range(10)")
    # Positional conditions tell duplicate names apart; the WHERE text sees the first one.
    assert ids(view(kernel, result_id, [{"column": 1, "op": "ge", "value": "95"}])) == [0, 1, 2, 3, 4, 5]
    assert ids(view(kernel, result_id, where="a >= 8")) == [8, 9]
    page = view(kernel, result_id, [{"column": 2, "op": "eq", "value": "1"}], sort={"column": 1, "descending": False})
    assert ids(page) == [9, 7, 5, 3, 1]


def test_invalid_filters(kernel):
    result_id = run(kernel, SHOP)
    with pytest.raises(InvalidFilter, match='"nosuch"'):
        view(kernel, result_id, where="nosuch > 1")
    with pytest.raises(InvalidFilter, match="Parser Error"):
        view(kernel, result_id, where="amount > 1) OR (1 = 1")
    with pytest.raises(InvalidFilter, match="Unknown filter operator"):
        view(kernel, result_id, [{"column": 0, "op": "like", "value": "x"}])
    with pytest.raises(InvalidFilter, match="No column 9"):
        view(kernel, result_id, [{"column": 9, "op": "null"}])
    with pytest.raises(InvalidFilter):
        view(kernel, result_id, [{"column": 1, "op": "bin", "bins": {"low": 0, "width": 1, "count": 2}, "index": 0}])


def test_histogram_bar_filter_matches_the_bar(kernel):
    result_id = run(
        kernel,
        "SELECT range AS n, (range * 0.37)::DOUBLE AS f, DATE '2024-01-01' + range::INTEGER AS d, "
        "TIMESTAMP '2024-01-01' + to_minutes(range * 7) AS ts FROM range(997)",
    )
    columns = kernel.profile_result(result_id)["columns"]
    for column, profile in enumerate(columns):
        for index, bar in enumerate(profile["histogram"]):
            condition = {"column": column, "op": "bin", "bins": profile["bins"], "index": index}
            assert view(kernel, result_id, [condition])["rowCount"] == bar["count"], (profile["name"], index)


def test_profile_of_filtered_rows(kernel):
    result_id = run(kernel, SHOP)
    spec = {"conditions": [{"column": 1, "op": "eq", "value": "open", "label": "ignored"}], "where": "amount < 300"}
    profile = kernel.profile_result(result_id, spec)
    expected = [i for i in range(200) if i % 10 and i % 3 == 0]
    assert profile["rowCount"] == len(expected)
    status, amount = profile["columns"][1], profile["columns"][2]
    assert status["top"] == [{"value": "open", "count": len(expected)}]
    assert (amount["min"], amount["max"]) == (str(expected[0] * 1.5), str(expected[-1] * 1.5))
    # Drilling into a bar of the filtered histogram narrows further.
    bar = amount["histogram"][0]
    narrowed = dict(spec, conditions=spec["conditions"] + [{"column": 2, "op": "bin", "bins": amount["bins"], "index": 0}])
    assert kernel.profile_result(result_id, narrowed)["rowCount"] == bar["count"]
    # Profiles are cached per filter (labels don't count), next to the unfiltered one.
    assert kernel.profile_result(result_id, dict(spec, conditions=[{"column": 1, "op": "eq", "value": "open"}])) is profile
    assert kernel.profile_result(result_id)["rowCount"] == 300
