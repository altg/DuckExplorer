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
