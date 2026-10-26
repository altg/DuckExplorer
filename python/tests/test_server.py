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

        unknown = request(7, "nope")
        assert unknown["error"]["code"] == "unknown-method"

        assert request(8, "shutdown") == {"id": 8, "result": {}}
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        stderr = proc.stderr.read().decode("utf-8", "replace")
    assert "noise" in stderr
