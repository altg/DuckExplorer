"""Names for SQL completions: functions, types, temp tables, the default schema and notebook DataFrames."""

import pytest


def test_functions_have_signatures_descriptions_and_named_parameters(kernel):
    functions = kernel.sql_catalog()["functions"]
    by_name = {(f["name"], f["kind"]): f for f in functions["functions"]}

    date_trunc = by_name[("date_trunc", "scalar")]
    assert date_trunc["description"] == "Truncate to specified precision"
    assert date_trunc["example"].startswith("date_trunc(")
    assert {"params": [{"name": "part", "type": "VARCHAR"}, {"name": "timestamp", "type": "TIMESTAMP"}], "returns": "TIMESTAMP"} in date_trunc["signatures"]

    read_csv = by_name[("read_csv", "table")]
    assert read_csv["signatures"][0]["params"] == [{"name": "", "type": "VARCHAR"}]
    assert {"name": "header", "type": "BOOLEAN"} in read_csv["signatures"][0]["named"]

    assert by_name[("sum", "aggregate")]
    assert all(f["name"].isidentifier() and not f["name"].startswith("__") for f in functions["functions"])
    assert not any("database" in f for f in functions["functions"])  # built-ins aren't anyone's macros
    assert {"INTEGER", "VARCHAR", "TIMESTAMP WITH TIME ZONE"} <= set(functions["types"])


def test_functions_are_sent_again_only_when_they_change(kernel):
    version = kernel.sql_catalog()["functions"]["version"]
    assert "functions" not in kernel.sql_catalog(functions_version=version)

    kernel.execute_sql("nb", "CREATE MACRO add_tax(x) AS x * 1.2")
    functions = kernel.sql_catalog(functions_version=version)["functions"]
    assert functions["version"] != version
    macro = next(f for f in functions["functions"] if f["name"] == "add_tax")
    assert macro == {"name": "add_tax", "kind": "macro", "signatures": [{"params": [{"name": "x"}]}], "database": "memory", "schema": "main"}


def test_schema_includes_temp_tables_and_the_default_schema(kernel, sample_db):
    kernel.session.attach(str(sample_db))
    kernel.execute_sql("nb", "CREATE TEMP TABLE scratch AS SELECT 1 AS x; USE shop.staging")
    schema = kernel.sql_catalog()["schema"]
    assert (schema["current"], schema["currentSchema"]) == ("shop", "staging")
    temp = next(db for db in schema["databases"] if db["name"] == "temp")
    assert [r["name"] for s in temp["schemas"] for r in s["relations"]] == ["scratch"]
    # The tree view still leaves temp out.
    assert "temp" not in [db["name"] for db in kernel.session.schema()["databases"]]


def test_frames_are_the_notebooks_dataframes_and_tables(kernel):
    pytest.importorskip("pandas")
    kernel.execute_sql("nb", "-- name: totals\nSELECT 1 AS id, 'a' AS label")
    kernel.execute_python(
        "nb",
        "import pandas as pd\n"
        "targets = pd.DataFrame({'category': ['x'], 'goal': [1.5], 'when': pd.to_datetime(['2024-01-01'])})\n"
        "rel = con.sql('SELECT 42::BIGINT AS answer')\n"
        "_private = targets\n"
        "not_a_frame = [1, 2]\n",
    )
    frames = {f["name"]: f["columns"] for f in kernel.sql_catalog("nb")["frames"]}
    assert set(frames) == {"df", "totals", "targets", "rel"}
    assert frames["totals"] == [{"name": "id", "type": "INTEGER"}, {"name": "label", "type": "VARCHAR"}]
    assert frames["targets"] == [
        {"name": "category", "type": "VARCHAR"},
        {"name": "goal", "type": "DOUBLE"},
        {"name": "when", "type": "TIMESTAMP"},
    ]
    assert frames["rel"] == [{"name": "answer", "type": "BIGINT"}]
    # Other notebooks have their own namespaces.
    assert kernel.sql_catalog("other")["frames"] == []
    assert kernel.sql_catalog()["frames"] == []
