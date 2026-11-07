"""Outputs of a running cell, sent as `output` notifications (pyexec.Capture with emit)."""

import threading
import time

import pytest

from duckexplorer_kernel import pyexec


class Listener:
    """Collects a stream's notifications and rebuilds the outputs from them, as the extension does."""

    def __init__(self, kernel, stream=7):
        self.stream = stream
        self.updates = []
        self.outputs = []
        self.lock = threading.Lock()
        self.on_update = None
        kernel.notify = self.notify

    def notify(self, method, params):
        assert method == "output"
        assert params["stream"] == self.stream
        with self.lock:
            self.updates.append(params)
            index = params["index"]
            if "output" in params:
                assert index == len(self.outputs), "outputs come in order, once each"
                self.outputs.append(dict(params["output"]))
            else:
                assert self.outputs[index]["type"] == "stream"
                self.outputs[index]["text"] += params["text"]
        if self.on_update:
            self.on_update(self)

    def text(self):
        return "".join(o.get("text", "") for o in self.outputs if o["type"] == "stream")


def test_streamed_outputs_match_the_reply_without_streaming(kernel):
    code = "print('a')\nprint('b')\ndisplay(42)\nprint('c', file=sys.stderr)\n'last'"
    kernel.execute_python("nb", "import sys")
    expected = kernel.execute_python("nb", code)["outputs"]

    listener = Listener(kernel)
    reply = kernel.execute_python("nb", code, stream=listener.stream)
    assert reply == {"streamed": len(expected), "error": None}
    assert listener.outputs == expected


def test_output_arrives_while_the_cell_runs(kernel):
    listener = Listener(kernel)
    started = threading.Event()
    listener.on_update = lambda l: "started" in l.text() and started.set()
    kernel.execute_python("nb", "")
    kernel.notebook("nb").namespace["started"] = started
    # The cell waits until the extension has seen its first line.
    reply = kernel.execute_python("nb", "print('started')\nassert started.wait(5)\nprint('done')", stream=listener.stream)
    assert reply["error"] is None
    assert listener.text() == "started\ndone\n"


def test_text_written_in_a_burst_is_batched_and_sent_soon(kernel):
    listener = Listener(kernel)
    seen = threading.Event()
    listener.on_update = lambda l: "line 999\n" in l.text() and seen.set()
    kernel.execute_python("nb", "")
    kernel.notebook("nb").namespace["seen"] = seen
    # The last lines come within the batching interval: a timer sends them while the cell still waits.
    code = "for i in range(1000):\n    print('line', i)\nassert seen.wait(5)"
    reply = kernel.execute_python("nb", code, stream=listener.stream)
    assert reply["error"] is None
    assert listener.text() == "".join(f"line {i}\n" for i in range(1000))
    assert len(listener.updates) < 20


def test_figures_and_errors_are_streamed_in_order(kernel):
    listener = Listener(kernel)
    code = "import matplotlib.pyplot as plt\nprint('before')\nplt.plot([1, 2])\nplt.show()\nraise ValueError('boom')"
    reply = kernel.execute_python("nb", code, stream=listener.stream)
    assert reply["error"]["evalue"] == "boom"
    assert [o["type"] for o in listener.outputs] == ["stream", "png"]
    assert reply["streamed"] == 2


def test_sql_cell_result_is_streamed(kernel):
    listener = Listener(kernel)
    reply = kernel.execute_sql("nb", "SELECT 42 AS answer", stream=listener.stream)
    assert reply == {"streamed": 1, "error": None}
    [output] = listener.outputs
    assert output["type"] == "table" and output["table"]["rows"] == [["42"]]


def test_nothing_is_sent_after_the_cell_ends(kernel):
    listener = Listener(kernel)
    # A thread that keeps the cell's stdout and writes to it later.
    code = "import sys, threading\nout = sys.stdout\nprint('in the cell')"
    kernel.execute_python("nb", code, stream=listener.stream)
    count = len(listener.updates)
    kernel.execute_python("nb", "out.write('late\\n')")
    assert len(listener.updates) == count


@pytest.mark.parametrize("streamed", [False, True])
def test_many_small_prints_take_time_in_proportion(kernel, streamed):
    # 400,000 prints are 800,000 writes. Adding each to the text copied it every time: about a minute.
    listener = Listener(kernel) if streamed else None
    started = time.perf_counter()
    reply = kernel.execute_python("nb", "for i in range(400_000):\n    print('x')", stream=listener and listener.stream)
    assert time.perf_counter() - started < 10
    assert reply["error"] is None
    text = listener.text() if listener else reply["outputs"][0]["text"]
    assert text == "x\n" * 400_000


def test_printed_text_stops_at_the_limit(kernel, monkeypatch):
    monkeypatch.setattr(pyexec, "MAX_STREAM_TEXT", 1000)
    listener = Listener(kernel)
    code = "import sys\nfor i in range(1000):\n    print('line', i)\nprint('more', file=sys.stderr)\ndisplay(42)"
    reply = kernel.execute_python("nb", code, stream=listener.stream)
    assert reply == {"streamed": 2, "error": None}
    stdout, shown = listener.outputs
    kept, note = stdout["text"][:1000], stdout["text"][1000:]
    assert kept == "".join(f"line {i}\n" for i in range(1000))[:1000]
    assert note == "\n… printed output stops here: the cell printed more than 1,000 characters.\n"
    assert shown == {"type": "text", "text": "42"}  # outputs other than text still show


@pytest.mark.parametrize("stream", [None, 3])
def test_without_notifications_the_outputs_are_in_the_reply(kernel, stream):
    kernel.notify = None
    reply = kernel.execute_python("nb", "print('x')", stream=stream)
    assert reply == {"outputs": [{"type": "stream", "name": "stdout", "text": "x\n"}], "error": None}
