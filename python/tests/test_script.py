import os
import threading
import time

import pytest

from duckexplorer_kernel import script


def test_the_last_statement_returns_rows(kernel):
    reply = kernel.run_statements(
        ["CREATE TABLE t AS SELECT range AS n FROM range(10)", "INSERT INTO t VALUES (10)", "SELECT n, n * 2 AS d FROM t"]
    )
    assert reply["completed"] == 3
    assert "error" not in reply and "message" not in reply
    table = reply["table"]
    assert table["rowCount"] == 11
    assert table["columns"] == [{"name": "n", "type": "BIGINT"}, {"name": "d", "type": "BIGINT"}]
    assert table["rows"][10] == ["10", "20"]
    assert table["elapsedMs"] == reply["elapsedMs"]
    # Rows are a stored result, like a SQL cell's: the grid pages, sorts and filters them.
    assert kernel.fetch_page(table["id"], 9, 5, sort={"column": 0, "descending": True})["rows"] == [["1", "2"], ["0", "0"]]


@pytest.mark.parametrize(
    ("statement", "message"),
    [
        ("INSERT INTO t VALUES (1), (2)", "2 rows inserted"),
        ("INSERT INTO t VALUES (3)", "1 row inserted"),
        ("UPDATE t SET n = n + 1", "3 rows updated"),
        ("DELETE FROM t WHERE n >= 0", "3 rows deleted"),
        ("CREATE TABLE u AS SELECT * FROM range(1500)", "1,500 rows inserted"),
        (f"COPY t TO '{os.devnull}' (FORMAT csv)", "3 rows copied"),
        ("CREATE VIEW v AS SELECT 1", ""),
        ("SET threads = 2", ""),
        ("USE memory", ""),
    ],
)
def test_statements_without_rows_say_what_they_did(kernel, statement, message):
    kernel.run_statements(["CREATE TABLE t (n INTEGER)", "INSERT INTO t VALUES (0)"])
    if not statement.startswith(("INSERT", "CREATE")):
        kernel.run_statements(["INSERT INTO t VALUES (1), (2)"])
    reply = kernel.run_statements([statement])
    assert "error" not in reply, reply
    assert reply == {"completed": 1, "elapsedMs": reply["elapsedMs"], "message": message}


def test_only_the_last_statements_rows_are_kept(kernel):
    reply = kernel.run_statements(["SELECT 1 AS a", "CREATE TABLE t AS SELECT 2 AS b", "SELECT 3 AS c"])
    assert reply["table"]["rows"] == [["3"]]
    assert len(kernel.results._results) == 1
    # A query before a statement without rows: the run ends with that statement's outcome.
    reply = kernel.run_statements(["SELECT 1 AS a", "SET threads = 2"])
    assert (reply["completed"], reply["message"], "table" in reply) == (2, "", False)


def test_queries_of_every_kind_return_rows(kernel):
    kernel.run_statements(["CREATE TABLE t (n INTEGER)"])
    for statement in ["INSERT INTO t VALUES (7) RETURNING n", "DESCRIBE t", "EXPLAIN SELECT 1", "CALL pragma_version()", "SELECT count(*) AS Count FROM t"]:
        reply = kernel.run_statements([statement])
        assert "table" in reply, (statement, reply)
    assert reply["table"]["rows"] == [["1"]]


def test_statements_share_the_session_with_notebooks(kernel):
    kernel.run_statements(["CREATE TEMP TABLE scratch AS SELECT 42 AS answer"])
    response = kernel.execute_sql("nb", "SELECT answer FROM scratch")
    assert response["error"] is None
    assert [t["name"] for t in kernel.session.temp_relations] == ["scratch"]


def test_an_error_stops_the_run_and_says_where(kernel):
    reply = kernel.run_statements(["CREATE TABLE t (a INTEGER)", "SELECT a,\n  missing\nFROM t", "DROP TABLE t"])
    assert reply["completed"] == 1
    assert "table" not in reply and "message" not in reply
    error = reply["error"]
    assert error["statement"] == 1
    assert error["ename"] == "BinderException"
    assert error["message"] == 'Binder Error: Referenced column "missing" not found in FROM clause!\nCandidate bindings: "a"'
    assert "LINE 2:" in error["evalue"]
    assert error["position"] == len("SELECT a,\n  ")
    # The run stopped: t was not dropped.
    assert "table" in kernel.run_statements(["SELECT * FROM t"])


def test_parser_and_catalog_errors_have_positions(kernel):
    error = kernel.run_statements(["SELECT * FORM range(3)"])["error"]
    assert error["ename"] == "ParserException"
    assert error["position"] == len("SELECT * FORM ")
    error = kernel.run_statements(["SELECT 1 FROM nowhere"])["error"]
    assert error["ename"] == "CatalogException"
    assert error["position"] == len("SELECT 1 FROM ")


def test_errors_without_a_position(kernel):
    reply = kernel.run_statements(["CREATE TABLE t (id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (1), (1)"])
    error = reply["error"]
    assert error["ename"] == "ConstraintException"
    assert "position" not in error
    assert error["message"] == error["evalue"]


def test_interrupt_stops_the_run(kernel):
    def stop_soon():
        time.sleep(0.5)
        assert kernel.interrupt()

    threading.Thread(target=stop_soon).start()
    reply = kernel.run_statements(
        ["CREATE TABLE t AS SELECT 1", "SELECT count(*) FROM range(10_000_000_000) a, range(10) b", "DROP TABLE t"]
    )
    assert (reply["error"]["ename"], reply["error"]["statement"], reply["completed"]) == ("KeyboardInterrupt", 1, 1)
    assert "table" in kernel.run_statements(["SELECT * FROM t"])


def test_relative_paths_resolve_against_cwd(kernel, tmp_path):
    (tmp_path / "data.csv").write_text("x\n1\n2\n")
    reply = kernel.run_statements(["SELECT sum(x) AS s FROM 'data.csv'"], cwd=str(tmp_path))
    assert reply["table"]["rows"] == [["3"]]


EXCERPT = "Binder Error: no\n\nLINE {line}: {shown}\n{caret}^"


def excerpt(line, shown, column):
    return EXCERPT.format(line=line, shown=shown, caret=" " * (len(f"LINE {line}: ") + column))


@pytest.mark.parametrize(
    ("statement", "message", "position"),
    [
        # CRLF counts as one line break, as DuckDB counts it.
        ("SELECT 1,\r\n  zz", excerpt(2, "  zz", 2), len("SELECT 1,\r\n  ")),
        # Wide characters take two columns before the caret.
        ("SELECT '日本', zz", excerpt(1, "SELECT '日本', zz", 15), len("SELECT '日本', ")),
        # UTF-16 offsets: an emoji is two code units.
        ("SELECT '😀', zz", excerpt(1, "SELECT '😀', zz", 13), 13),
        # Long lines are cut down around the error, with `...` at either end.
        ("SELECT " + "a, " * 30 + "zz FROM t", excerpt(1, "...a, a, a, zz FROM t", 3 + 9), len("SELECT " + "a, " * 30)),
        ("SELECT zz, " + "a, " * 30, excerpt(1, "SELECT zz, a, a...", 7), len("SELECT ")),
    ],
)
def test_locate_follows_duckdbs_excerpt(statement, message, position):
    text, found = script.locate(statement, message)
    assert text == "Binder Error: no"
    assert found == position


def test_locate_with_a_live_error_on_a_long_line(kernel):
    columns = ", ".join(f"column_number_{i}" for i in range(12))
    kernel.run_statements([f"CREATE TABLE t ({', '.join(f'column_number_{i} INTEGER' for i in range(12))})"])
    statement = f"SELECT {columns}, missing, {columns} FROM t"
    error = kernel.run_statements([statement])["error"]
    assert "..." in error["evalue"]
    assert statement[error["position"] :].startswith("missing")


def test_locate_without_an_excerpt():
    assert script.locate("SELECT 1", "IO Error: nope") == ("IO Error: nope", None)
    # An excerpt from some other text than the statement.
    assert script.locate("SELECT 1", excerpt(1, "DROP x", 5)) == ("Binder Error: no", None)
    assert script.locate("SELECT 1", excerpt(4, "x", 0)) == ("Binder Error: no", None)
