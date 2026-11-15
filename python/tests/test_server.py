"""End-to-end check of the stdio protocol against a real kernel process."""

import json
import os
import subprocess
import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]


def test_protocol_round_trip(tmp_path, sample_db):
    env = {**os.environ, "PYTHONPATH": str(PYTHON_DIR), "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "duckexplorer_kernel"],
        cwd=tmp_path,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def request(msg_id, method, params=None):
        proc.stdin.write((json.dumps({"id": msg_id, "method": method, "params": params or {}}) + "\n").encode())
        proc.stdin.flush()
        while True:
            message = json.loads(proc.stdout.readline())
            if message.get("id") == msg_id:
                return message

    try:
        ready = json.loads(proc.stdout.readline())
        assert ready["method"] == "ready"
        assert ready["params"]["duckdb"]

        assert request(1, "attach", {"path": str(sample_db)})["result"] == {"alias": "shop"}
        schema = request(2, "schema")["result"]
        assert [db["name"] for db in schema["databases"]] == ["memory", "shop"]

        # A print inside a cell is captured, and a stray C-level write can't corrupt the protocol.
        response = request(3, "executePython", {"notebook": "nb", "code": "print('héllo ✓')\nimport os\nos.write(1, b'noise\\n')"})
        assert response["result"]["outputs"][0]["text"] == "héllo ✓\n"

        sql = request(4, "executeSql", {"notebook": "nb", "code": "SELECT count(*) AS n FROM orders"})
        table = sql["result"]["outputs"][0]["table"]
        assert table["rows"] == [["1000"]]

        page = request(5, "fetchPage", {"resultId": table["id"], "offset": 0, "limit": 10})
        assert page["result"]["rows"] == [["1000"]]

        expired = request(6, "fetchPage", {"resultId": "r999", "offset": 0, "limit": 10})
        assert expired["error"]["code"] == "expired"

        filtered = {"resultId": table["id"], "offset": 0, "limit": 10, "filter": {"conditions": [], "where": "n > 5"}}
        assert request(61, "fetchPage", filtered)["result"] == {"rows": [["1000"]], "rowCount": 1}
        filtered["filter"]["where"] = "nope > 5"
        invalid = request(62, "fetchPage", filtered)["error"]
        assert invalid["code"] == "invalid" and "traceback" not in invalid
        assert invalid["message"].startswith("Binder Error")

        # Exports run beside cells too; a file that can't be written is the user's to fix (no traceback).
        exported = tmp_path / "n.csv"
        export = {"resultId": table["id"], "path": str(exported), "format": "csv", "filter": {"conditions": [], "where": "n > 5"}}
        assert request(63, "exportResult", export)["result"] == {"rowCount": 1, "truncated": False}
        assert exported.read_text().splitlines() == ["n", "1000"]
        unwritable = request(64, "exportResult", {**export, "path": str(tmp_path / "missing" / "n.csv")})["error"]
        assert unwritable["code"] == "invalid" and "traceback" not in unwritable
        assert request(65, "exportResult", {**export, "resultId": "r999"})["error"]["code"] == "expired"

        unknown = request(7, "nope")
        assert unknown["error"]["code"] == "unknown-method"

        assert request(8, "shutdown") == {"id": 8, "result": {}}
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        stderr = proc.stderr.read().decode("utf-8", "replace")
    assert "noise" in stderr


def test_kernel_exits_when_the_extension_goes_away_mid_cell(tmp_path):
    """stdin closes while a cell streams output into a pipe that is still open but no longer read: the
    writes block, and the kernel exits anyway rather than staying behind with the files it opened."""
    env = {**os.environ, "PYTHONPATH": str(PYTHON_DIR), "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "duckexplorer_kernel"],
        cwd=tmp_path,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert json.loads(proc.stdout.readline())["method"] == "ready"
        code = "import time\nfor i in range(10_000):\n    print('line', i, 'x' * 2000)\n    time.sleep(0.01)"
        cell = {"id": 1, "method": "executePython", "params": {"notebook": "nb", "code": code, "stream": 1}}
        proc.stdin.write((json.dumps(cell) + "\n").encode())
        proc.stdin.close()
        # stdout stays open and unread from here on.
        assert proc.wait(timeout=15) == 0
    finally:
        if proc.poll() is None:
            proc.kill()


def test_memory_info_is_answered_while_a_cell_runs(tmp_path):
    env = {**os.environ, "PYTHONPATH": str(PYTHON_DIR), "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "duckexplorer_kernel"],
        cwd=tmp_path,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def send(msg_id, method, params=None):
        proc.stdin.write((json.dumps({"id": msg_id, "method": method, "params": params or {}}) + "\n").encode())
        proc.stdin.flush()

    def replies():
        while True:
            message = json.loads(proc.stdout.readline())
            if "id" in message:
                yield message

    try:
        assert json.loads(proc.stdout.readline())["method"] == "ready"
        send(1, "executeSql", {"notebook": "nb", "code": "SELECT range AS n FROM range(100000)"})
        received = replies()
        assert next(received)["id"] == 1
        send(2, "executePython", {"notebook": "nb", "code": "import time\ntime.sleep(3)"})
        send(3, "memoryInfo")
        # The memory reply comes first, while the cell still sleeps.
        info = next(received)
        assert info["id"] == 3, info
        memory = info["result"]
        assert memory["results"]["count"] == 1
        assert memory["results"]["bytes"] == memory["results"]["largestBytes"]
        assert 800_000 <= memory["results"]["bytes"] < 900_000  # 8 bytes a row, and a validity bitmap
        assert memory["results"]["limitBytes"] == 1024 * 1024**2
        assert memory["processBytes"] > 10 * 1024**2
        assert memory["duckdbBytes"] >= 0 and memory["duckdbLimit"]
        send(4, "clearResults")
        assert next(received) == {"id": 4, "result": {"dropped": 1}}
        assert next(received)["id"] == 2
        send(5, "shutdown")
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
