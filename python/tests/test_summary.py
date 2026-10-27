"""Table and view summaries: a relation loaded as a stored result for the summary panel."""

import duckdb
import pytest

import duckexplorer_kernel.kernel as kernel_module


def test_summarize_table_and_view(kernel, sample_db):
    alias = kernel.session.attach(str(sample_db), read_only=True)
    table = kernel.summarize(alias, "main", "orders")
    assert table["rowCount"] == 1000
    assert "sampledFrom" not in table
    assert [(c["name"], c["type"]) for c in table["columns"]] == [
        ("id", "BIGINT"),
        ("customer", "VARCHAR"),
        ("amount", "DOUBLE"),
    ]
    assert table["rows"][:2] == [["0", "c0", "0.0"], ["1", "c1", "1.5"]]
    customer = kernel.profile_result(table["id"])["columns"][1]
    assert customer["top"][0] == {"value": "c0", "count": 200}

    # A view runs its query; the summary is a result like any other, so filters and sorting work.
    view = kernel.summarize(alias, "main", "big_orders")
    assert view["rowCount"] == 333
    page = kernel.fetch_page(view["id"], 0, 3, {"column": 2, "descending": True}, {"conditions": [], "where": "customer = 'c1'"})
    assert page["rowCount"] == 66  # ids 671, 676, … 996
    assert [row[0] for row in page["rows"]] == ["996", "991", "986"]


def test_large_relations_are_sampled(kernel, monkeypatch):
    monkeypatch.setattr(kernel_module, "SUMMARY_ROWS", 100)
    kernel.execute_sql("nb", "CREATE TABLE big AS SELECT range AS n FROM range(1000)")
    first = kernel.summarize("memory", "main", "big")
    assert (first["rowCount"], first["sampledFrom"]) == (100, 1000)
    assert len({row[0] for row in first["rows"]}) == 100
    # The sample is repeatable, so a refreshed summary shows the same rows.
    assert kernel.summarize("memory", "main", "big")["rows"] == first["rows"]


def test_names_are_quoted(kernel):
    kernel.execute_sql("nb", 'CREATE SCHEMA "my schema"; CREATE TABLE "my schema"."odd ""name""" AS SELECT 1 AS x')
    assert kernel.summarize("memory", "my schema", 'odd "name"')["rows"] == [["1"]]


def test_missing_relation(kernel):
    with pytest.raises(duckdb.CatalogException):
        kernel.summarize("memory", "main", "nope")
