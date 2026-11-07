"""Live previews of queries as they are written (Kernel.preview_sql, and the previewSql request)."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from duckexplorer_kernel import kernel as kernel_module
from duckexplorer_kernel.results import MAX_RESULTS

PYTHON_DIR = Path(__file__).resolve().parents[1]
LONG_QUERY = "SELECT count(*) FROM range(10000000000) a, range(10) b WHERE a.range % 7 = b.range"


def test_first_rows_of_a_query(kernel):
    kernel.page_size = 50
    table = kernel.preview_sql("SELECT range AS n FROM range(1000) ORDER BY n DESC", limit=100)["table"]
    assert table["rowCount"] == 100 and table["truncated"] is True
    assert table["rows"][:2] == [["999"], ["998"]] and len(table["rows"]) == 50
    assert table["columns"] == [{"name": "n", "type": "BIGINT"}]
    # The grid pages, sorts and filters it like any result.
    assert kernel.fetch_page(table["id"], 95, 10)["rows"] == [[str(n)] for n in range(904, 899, -1)]
    assert kernel.fetch_page(table["id"], 0, 1, {"column": 0, "descending": False})["rows"] == [["900"]]
    # All of a short result: nothing more to say.
    short = kernel.preview_sql("WITH a AS (SELECT 1 AS x) FROM a")["table"]
    assert short["rows"] == [["1"]] and "truncated" not in short
    assert kernel.preview_sql("DESCRIBE SELECT 1 AS x")["table"]["rows"][0][:2] == ["x", "INTEGER"]


def test_previews_leave_cells_alone(kernel):
    cell = kernel.execute_sql("nb", "SELECT 42 AS answer")["outputs"][0]["table"]
    for _ in range(MAX_RESULTS + 5):
        kernel.preview_sql("SELECT 1 AS other", "nb")
    # The cell's result is still there, and `df` is still the cell's.
    assert kernel.fetch_page(cell["id"], 0, 10)["rows"] == [["42"]]
    assert kernel.notebook("nb").namespace["df"].column_names == ["answer"]


def test_only_queries_run(kernel):
    kernel.execute_sql("nb", "CREATE TABLE t AS SELECT 1 AS x; CREATE SEQUENCE s")
    for code in [
        "INSERT INTO t VALUES (2)",
        "DELETE FROM t",
        "CREATE TABLE u AS SELECT 1",
        "SELECT 1; DROP TABLE t",
        "UPDATE t SET x = 5",
        "COPY t TO 'out.csv'",
        "EXPLAIN SELECT 1",
        "SELECT nextval('s')",
        "PIVOT t ON x USING count(*)",  # makes an ENUM type first
    ]:
        assert kernel.preview_sql(code)["skipped"], code
    assert kernel.execute_sql("nb", "SELECT x, nextval('s') AS n FROM t")["outputs"][0]["table"]["rows"] == [["1", "1"]]
    assert not os.path.exists("out.csv")


def test_errors_as_the_query_is_written(kernel):
    assert kernel.preview_sql("SELECT * FROM t WHERE")["error"]["ename"] == "ParserException"
    assert kernel.preview_sql("SELECT * FROM nowhere")["error"]["ename"] == "CatalogException"


def test_the_notebooks_dataframes(kernel):
    kernel.execute_python("nb", "import pandas as pd\nframe = pd.DataFrame({'a': [3, 1, 2]})")
    assert kernel.preview_sql("SELECT sum(a) AS s FROM frame", "nb")["table"]["rows"] == [["6"]]
    # A .sql file's preview (no notebook) doesn't see them.
    assert kernel.preview_sql("SELECT sum(a) AS s FROM frame")["error"]["ename"] == "CatalogException"


def test_a_slow_preview_is_stopped(kernel, monkeypatch):
    monkeypatch.setattr(kernel_module, "PREVIEW_SECONDS", 0.5)
    started = time.perf_counter()
    error = kernel.preview_sql(LONG_QUERY)["error"]
    assert error["ename"] == "Timeout" and "0.5 s" in error["evalue"]
    assert time.perf_counter() - started < 10
    assert kernel.execute_sql("nb", "SELECT 1 AS ok")["outputs"][0]["table"]["rows"] == [["1"]]


def test_other_work_stops_a_preview(kernel):
    threading.Timer(0.5, kernel.stop_preview, ("superseded",)).start()
    assert kernel.preview_sql(LONG_QUERY) == {"skipped": "superseded"}
    # Once it's done, stopping does nothing.
    kernel.stop_preview("superseded")
    assert kernel.preview_sql("SELECT 2 AS two")["table"]["rows"] == [["2"]]


def test_newer_requests_go_first(tmp_path):
    """Over the protocol: a newer preview stops the running one, and a preview arriving while a cell runs
    is skipped rather than kept waiting."""
    env = {**os.environ, "PYTHONPATH": str(PYTHON_DIR), "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "duckexplorer_kernel"],
        cwd=tmp_path,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    replies: dict = {}

    def send(msg_id, method, params):
        proc.stdin.write((json.dumps({"id": msg_id, "method": method, "params": params}) + "\n").encode())
        proc.stdin.flush()

    def reply(msg_id):
        while msg_id not in replies:
            message = json.loads(proc.stdout.readline())
            if "id" in message:
                replies[message["id"]] = message
        return replies.pop(msg_id)

    try:
        assert json.loads(proc.stdout.readline())["method"] == "ready"
        send(1, "previewSql", {"code": LONG_QUERY})
        time.sleep(0.5)
        send(2, "previewSql", {"code": "SELECT 7 AS seven"})
        assert reply(1)["result"] == {"skipped": "superseded"}
        assert reply(2)["result"]["table"]["rows"] == [["7"]]

        send(3, "executeSql", {"notebook": "nb", "code": LONG_QUERY})
        time.sleep(0.5)
        send(4, "previewSql", {"code": "SELECT 8 AS eight"})
        assert reply(4)["result"] == {"skipped": "busy"}
        send(5, "interrupt", {})
        reply(5)
        reply(3)

        send(6, "shutdown", {})
        assert reply(6) == {"id": 6, "result": {}}
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
