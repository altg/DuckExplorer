"""Exports: a result's rows, filtered and sorted like the grid, or a whole relation, written to a file."""

import pytest

from duckexplorer_kernel import kernel as kernel_module
from duckexplorer_kernel.export import EXCEL_MAX_ROWS, ExportFailed
from duckexplorer_kernel.results import ResultExpired

ORDERS = """
SELECT range AS n,
       CASE WHEN range % 7 = 0 THEN NULL ELSE ['open', 'it''s shipped', 'returned'][range % 3 + 1] END AS status,
       DATE '2024-01-01' + range::INTEGER AS day,
       range * 1.5 AS amount
FROM range(60)
"""
FILTER = {"conditions": [{"column": 1, "op": "ne", "value": "returned"}], "where": "n < 30"}
SORT = {"column": 0, "descending": True}
# The rows the grid shows for FILTER and SORT: status IS DISTINCT FROM 'returned' keeps the NULLs.
EXPECTED_N = [n for n in range(29, -1, -1) if n % 7 == 0 or n % 3 != 2]
# read_xlsx guesses a column's type from its first cell, which may be empty (NULL).
READERS = {
    "csv": "read_csv({})",
    "parquet": "read_parquet({})",
    "xlsx": "read_xlsx({}, header = true, empty_as_varchar = true)",
}


def run(kernel, sql):
    response = kernel.execute_sql("nb", sql)
    assert response["error"] is None, response["error"]
    return response["outputs"][0]["table"]["id"]


def export(kernel, *args, **kwargs):
    """Like kernel.export_result, but skips Excel when DuckDB's excel extension can't be installed (offline)."""
    try:
        return kernel.export_result(*args, **kwargs)
    except ExportFailed as exc:
        if "could not be installed" in str(exc):
            pytest.skip(str(exc))
        raise


def read_back(kernel, path, file_format, columns="*", describe=False):
    reader = READERS[file_format].format("'" + str(path).replace("'", "''") + "'")
    return kernel.session.side.execute(f"{'DESCRIBE ' if describe else ''}SELECT {columns} FROM {reader}").fetchall()


@pytest.mark.parametrize("file_format", ["csv", "parquet", "xlsx"])
def test_exports_the_rows_as_the_grid_shows_them(kernel, tmp_path, file_format):
    result_id = run(kernel, ORDERS)
    path = tmp_path / f"orders.{file_format}"
    assert export(kernel, result_id, str(path), file_format, FILTER, SORT) == {"rowCount": len(EXPECTED_N)}
    rows = read_back(kernel, path, file_format, "n::BIGINT, status, day::DATE::VARCHAR, amount::DOUBLE")
    assert [row[0] for row in rows] == EXPECTED_N
    grid = kernel.fetch_page(result_id, 0, 100, SORT, FILTER)["rows"]
    assert [[str(row[0]), row[1], row[2], float(row[3])] for row in rows] == [
        [n, status, day, float(amount)] for n, status, day, amount in grid
    ]
    # The header is the result's column names.
    assert [name for name, *_ in read_back(kernel, path, file_format, describe=True)] == ["n", "status", "day", "amount"]


def test_parquet_keeps_the_types(kernel, tmp_path):
    result_id = run(kernel, ORDERS)
    path = tmp_path / "typed.parquet"
    kernel.export_result(result_id, str(path), "parquet")
    types = [t for _, t, *_ in read_back(kernel, path, "parquet", describe=True)]
    assert types == ["BIGINT", "VARCHAR", "DATE", "DECIMAL(21,1)"]
    assert read_back(kernel, path, "parquet", "count(*), count(status)") == [(60, 51)]


def test_unfiltered_export_keeps_the_query_order_and_every_row(kernel, tmp_path):
    result_id = run(kernel, "SELECT range AS n FROM range(100000) ORDER BY hash(range)")
    path = tmp_path / "all.csv"
    assert kernel.export_result(result_id, str(path), "csv") == {"rowCount": 100_000}
    exported = [row[0] for row in read_back(kernel, path, "csv")]
    assert exported == [n for (n,) in kernel.session.con.sql("SELECT range FROM range(100000) ORDER BY hash(range)").fetchall()]
    # Sorted: ties stay in the query's order, NULLs go last, as in the grid.
    result_id = run(kernel, "SELECT * FROM (VALUES (2, 'a'), (NULL, 'b'), (1, 'c'), (2, 'd')) t(k, v)")
    kernel.export_result(result_id, str(path), "csv", None, {"column": 0, "descending": False})
    assert read_back(kernel, path, "csv", "v") == [("c",), ("a",), ("d",), ("b",)]


def test_duplicate_column_names_are_made_unique(kernel, tmp_path):
    # By COPY, as in a DuckDB query.
    result_id = run(kernel, "SELECT 1 AS a, 2 AS a, 'x,y' AS \"b c\"")
    path = tmp_path / "dup.csv"
    kernel.export_result(result_id, str(path), "csv")
    assert path.read_text().splitlines() == ["a,a_1,b c", '1,2,"x,y"']


def test_an_expired_result_cannot_be_exported(kernel, tmp_path):
    with pytest.raises(ResultExpired):
        kernel.export_result("r999", str(tmp_path / "gone.csv"), "csv")
    assert not (tmp_path / "gone.csv").exists()


def test_a_file_that_cannot_be_written(kernel, tmp_path):
    result_id = run(kernel, "SELECT 1 AS a")
    with pytest.raises(ExportFailed, match="IO Error"):
        kernel.export_result(result_id, str(tmp_path / "no such folder" / "x.parquet"), "parquet")
    with pytest.raises(ValueError, match="Unknown export format"):
        kernel.export_result(result_id, str(tmp_path / "x.json"), "json")


def test_excel_sheets_have_a_row_limit(kernel, tmp_path):
    # Checked before anything is written, or the extension is needed.
    result_id = run(kernel, f"SELECT range AS n FROM range({EXCEL_MAX_ROWS + 1})")
    path = tmp_path / "big.xlsx"
    with pytest.raises(ExportFailed, match="at most 1,048,575 rows below its header, and these are 1,048,576"):
        kernel.export_result(result_id, str(path), "xlsx")
    assert not path.exists()
    # A filter that keeps few enough rows is fine.
    small = export(kernel, result_id, str(path), "xlsx", {"conditions": [], "where": "n < 3"})
    assert small == {"rowCount": 3}


def test_excel_without_its_extension_says_so(tmp_path):
    # A kernel of its own: DuckDB loads extensions per database. Its repository can't be reached.
    offline = kernel_module.Kernel()
    side = offline.session.side
    side.execute(f"SET extension_directory = '{tmp_path / 'extensions'}'")
    side.execute("SET custom_extension_repository = 'http://127.0.0.1:9'")
    result_id = run(offline, "SELECT 1 AS a")
    with pytest.raises(ExportFailed, match="excel extension, and it could not be installed: are you offline?") as caught:
        offline.export_result(result_id, str(tmp_path / "x.xlsx"), "xlsx")
    assert "Failed to download extension" in str(caught.value)
    assert not (tmp_path / "x.xlsx").exists()


def test_a_sampled_summary_exports_every_row_of_its_table(kernel, tmp_path, monkeypatch, sample_db):
    monkeypatch.setattr(kernel_module, "SUMMARY_ROWS", 100)
    alias = kernel.session.attach(str(sample_db))
    summary = kernel.summarize(alias, "main", "orders")
    assert (summary["rowCount"], summary["sampledFrom"]) == (100, 1000)
    spec = {"conditions": [{"column": 1, "op": "eq", "value": "c2"}], "where": "id < 500"}
    path = tmp_path / "orders.csv"
    assert kernel.export_result(summary["id"], str(path), "csv", spec, {"column": 0, "descending": True}) == {"rowCount": 100}
    ids = [row[0] for row in read_back(kernel, path, "csv", "id")]
    assert ids == list(range(497, -1, -5))


def test_export_a_relation(kernel, tmp_path, sample_db):
    alias = kernel.session.attach(str(sample_db))
    path = tmp_path / "big orders.parquet"
    assert kernel.export_relation(alias, "main", "big_orders", str(path), "parquet") == {"rowCount": 333}
    assert read_back(kernel, path, "parquet", "min(amount) > 1000, count(*)") == [(True, 333)]
