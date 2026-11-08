def test_attach_sets_default_database_and_builds_tree(kernel, sample_db):
    alias = kernel.session.attach(str(sample_db))
    assert alias == "shop"
    assert kernel.session.current_database == "shop"

    tree = kernel.session.schema()
    assert tree["current"] == "shop"
    names = [db["name"] for db in tree["databases"]]
    assert names == ["memory", "shop"]

    shop = next(db for db in tree["databases"] if db["name"] == "shop")
    schemas = {s["name"]: s for s in shop["schemas"]}
    assert set(schemas) == {"main", "staging"}
    relations = {r["name"]: r for r in schemas["main"]["relations"]}
    assert relations["orders"]["kind"] == "table"
    assert relations["big_orders"]["kind"] == "view"
    assert [c["name"] for c in relations["orders"]["columns"]] == ["id", "customer", "amount"]
    assert relations["orders"]["columns"][2]["type"] == "DOUBLE"


def test_attach_same_file_twice_reuses_alias(kernel, sample_db):
    first = kernel.session.attach(str(sample_db))
    second = kernel.session.attach(str(sample_db))
    assert first == second
    assert len([db for db in kernel.session.schema()["databases"] if db["name"] == "shop"]) == 1


def test_attach_read_only_and_detach(kernel, sample_db):
    alias = kernel.session.attach(str(sample_db), read_only=True)
    shop = next(db for db in kernel.session.schema()["databases"] if db["name"] == alias)
    assert shop["readOnly"] is True

    kernel.session.detach(alias)
    assert kernel.session.current_database == "memory"
    assert [db["name"] for db in kernel.session.schema()["databases"]] == ["memory"]


def test_result_views_are_hidden_from_tree(kernel):
    kernel.execute_sql("nb", "SELECT 1 AS x")
    tree = kernel.session.schema()
    all_relations = [r["name"] for db in tree["databases"] for s in db["schemas"] for r in s["relations"]]
    assert all_relations == []


def _write(con, query, path, options):
    con.execute(f"COPY ({query}) TO '{str(path).replace(chr(39), chr(39) * 2)}' ({options})")


def test_open_data_files_as_views(kernel, tmp_path, sample_db):
    import duckdb

    con = duckdb.connect()
    rows = "SELECT range AS id, 'n' || range AS name FROM range(10)"
    _write(con, rows, tmp_path / "Sales 2024.csv", "FORMAT csv")
    _write(con, rows, tmp_path / "it's.parquet", "FORMAT parquet")
    _write(con, rows, tmp_path / "events.jsonl.gz", "FORMAT json, COMPRESSION gzip")
    _write(con, rows, tmp_path / "2024.csv", "FORMAT csv")
    alias = kernel.session.attach(str(sample_db))

    names = [kernel.session.open_file(str(tmp_path / f)) for f in ("Sales 2024.csv", "it's.parquet", "events.jsonl.gz", "2024.csv")]
    assert names == ["sales_2024", "it_s", "events", "file_2024"]
    # Opening a file again keeps its view; another file with the same name gets a new one.
    assert kernel.session.open_file(str(tmp_path / "Sales 2024.csv")) == "sales_2024"
    (tmp_path / "other").mkdir()
    _write(con, rows, tmp_path / "other" / "events.jsonl.gz", "FORMAT json, COMPRESSION gzip")
    assert kernel.session.open_file(str(tmp_path / "other" / "events.jsonl.gz")) == "events_2"

    # The attached file stays the default database; opened files are listed last, as views.
    tree = kernel.session.schema()
    assert tree["current"] == alias
    assert [db["name"] for db in tree["databases"]] == ["memory", alias, "files"]
    files = tree["databases"][-1]
    assert files["path"] is None
    views = {r["name"]: r for r in files["schemas"][0]["relations"]}
    assert set(views) == {"sales_2024", "it_s", "events", "file_2024", "events_2"}
    assert views["it_s"]["kind"] == "view"
    assert views["it_s"]["comment"] == str(tmp_path / "it's.parquet")
    assert [c["name"] for c in views["events"]["columns"]] == ["id", "name"]

    # Queries, summaries and the side cursor read them like any view.
    assert kernel.session.con.execute("SELECT count(*) FROM files.sales_2024").fetchone() == (10,)
    assert kernel.summarize("files", "main", "it_s")["rowCount"] == 10

    kernel.session.close_file("it_s")
    assert "it_s" not in {r["name"] for r in kernel.session.schema()["databases"][-1]["schemas"][0]["relations"]}


def test_open_file_after_a_restart_keeps_its_name(kernel, tmp_path):
    import duckdb

    _write(duckdb.connect(), "SELECT 1 AS x", tmp_path / "a.csv", "FORMAT csv")
    assert kernel.session.open_file(str(tmp_path / "a.csv"), "renamed") == "renamed"


def test_open_a_missing_or_unreadable_file(kernel, tmp_path):
    import duckdb
    import pytest

    with pytest.raises(FileNotFoundError):
        kernel.session.open_file(str(tmp_path / "gone.csv"))
    (tmp_path / "notes.txt").write_text("hello")
    with pytest.raises(duckdb.Error):
        kernel.session.open_file(str(tmp_path / "notes.txt"))


def test_a_database_attached_as_files_is_not_written_to(kernel, tmp_path, sample_db):
    import pytest

    kernel.session.attach(str(sample_db), alias="files")
    (tmp_path / "a.csv").write_text("x\n1\n")
    with pytest.raises(ValueError, match="in the way"):
        kernel.session.open_file(str(tmp_path / "a.csv"))


def test_view_sql(kernel, sample_db):
    alias = kernel.session.attach(str(sample_db))
    assert kernel.session.view_sql(alias, "main", "big_orders") == (
        "CREATE VIEW big_orders AS SELECT * FROM orders WHERE (amount > 1000);"
    )
    kernel.execute_sql("nb", '''CREATE VIEW memory.main."it's ""odd""" AS SELECT 42 AS answer -- a comment''')
    assert kernel.session.view_sql("memory", "main", "it's \"odd\"") == (
        "CREATE VIEW \"it's \"\"odd\"\"\" AS SELECT 42 AS answer;"
    )
    # Tables, and views that are gone, have none.
    assert kernel.session.view_sql(alias, "main", "orders") is None
    assert kernel.session.view_sql(alias, "staging", "big_orders") is None
