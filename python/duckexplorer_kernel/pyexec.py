"""Python cell execution: output capture, rich display and chart output."""

from __future__ import annotations

import ast
import base64
import importlib.abc
import importlib.machinery
import io
import json
import linecache
import math
import re
import sys
import threading
import time
import traceback
from typing import Any, Callable

MAX_TEXT_OUTPUT = 200_000
# A cell's printed text (stdout and stderr together) is kept up to this many characters.
MAX_STREAM_TEXT = 1_000_000
# Stream text written in a burst is sent at most this often while a cell runs.
STREAM_INTERVAL = 0.1


class Capture:
    """Ordered outputs of one cell. Consecutive writes to the same stream are merged.

    With `emit`, the outputs are also sent while the cell runs: a new output as soon as it is added
    (`{"index": i, "output": …}`), and text written to a stream output after that
    (`{"index": i, "text": …}`), batched so a loop of prints sends a few messages a second. finish()
    sends what is still waiting; nothing is sent after it. Writes may come from other threads.

    Writes to the last output, a stream, are collected as pieces and joined when the outputs are sent or
    read, so a loop of many small prints costs time in proportion to what it prints (adding each piece to
    the text would copy the text every time). Printed text stops at MAX_STREAM_TEXT characters, with a
    line that says so; outputs other than text still show after that.
    """

    def __init__(self, table_output: Callable[[Any], dict | None], emit: Callable[[dict], None] | None = None) -> None:
        self._outputs: list[dict] = []
        self._table_output = table_output
        self._emit = emit
        self.streamed = emit is not None
        self._lock = threading.RLock()
        # Text written to the last output (a stream) that isn't in its "text" yet.
        self._pieces: list[str] = []
        # Characters of printed text kept so far; once the limit is reached, later text is left out.
        self._stream_chars = 0
        self._truncated = False
        # outputs[:_sent] have been sent; of the last of them, a stream, _sent_text characters.
        self._sent = 0
        self._sent_text = 0
        self._last_flush = 0.0
        self._timer: threading.Timer | None = None

    @property
    def outputs(self) -> list[dict]:
        with self._lock:
            self._join()
            return self._outputs

    def stream(self, name: str, text: str) -> None:
        if not text:
            return
        with self._lock:
            if self._truncated:
                return
            room = MAX_STREAM_TEXT - self._stream_chars
            if len(text) > room:
                self._truncated = True
                text = text[:room] + f"\n… printed output stops here: the cell printed more than {MAX_STREAM_TEXT:,} characters.\n"
            self._stream_chars += len(text)
            last = self._outputs[-1] if self._outputs else None
            if last and last["type"] == "stream" and last["name"] == name:
                self._pieces.append(text)
            else:
                self._join()
                self._outputs.append({"type": "stream", "name": name, "text": text})
            if self._emit is None or self._timer is not None:
                return
            wait = self._last_flush + STREAM_INTERVAL - time.monotonic()
            if wait <= 0:
                self._flush()  # the first write after a quiet spell shows at once
            else:
                self._timer = threading.Timer(wait, self._flush_later)
                self._timer.daemon = True
                self._timer.start()

    def add(self, output: dict) -> None:
        with self._lock:
            self._join()
            self._outputs.append(output)
            if self._emit is not None:
                self._flush()

    def display(self, obj: Any) -> None:
        output = to_output(obj, self._table_output)
        if output is not None:
            self.add(output)

    def finish(self) -> None:
        """Sends what hasn't been sent yet, and stops sending."""
        with self._lock:
            if self._emit is not None:
                self._flush()
                self._emit = None

    def _flush_later(self) -> None:
        with self._lock:
            self._timer = None
            if self._emit is not None:
                self._flush()

    def _flush(self) -> None:
        """Call with the lock held and emit set."""
        emit = self._emit
        assert emit is not None
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        self._last_flush = time.monotonic()
        self._join()
        outputs = self._outputs
        if self._sent:
            last = outputs[self._sent - 1]
            if last["type"] == "stream" and len(last["text"]) > self._sent_text:
                emit({"index": self._sent - 1, "text": last["text"][self._sent_text :]})
                self._sent_text = len(last["text"])
        while self._sent < len(outputs):
            output = outputs[self._sent]
            # A copy: a stream's text grows after it is sent.
            emit({"index": self._sent, "output": dict(output)})
            self._sent += 1
            self._sent_text = len(output["text"]) if output["type"] == "stream" else 0

    def _join(self) -> None:
        """Adds the pieces written to the last output to its text. Call with the lock held."""
        if self._pieces:
            self._outputs[-1]["text"] += "".join(self._pieces)
            self._pieces.clear()


class StreamWriter(io.TextIOBase):
    """Stand-in for sys.stdout/sys.stderr while user code runs."""

    def __init__(self, capture: Capture, name: str) -> None:
        self._capture = capture
        self._name = name

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, text: str) -> int:
        self._capture.stream(self._name, text)
        return len(text)


# The capture of the cell currently executing; plt.show() and fig.show() emit into it.
current: Capture | None = None


def display(*objs: Any) -> None:
    """Show objects in the running cell's output (DataFrames, figures, anything with a repr)."""
    if current is None:
        return
    for obj in objs:
        current.display(obj)


def to_output(obj: Any, table_output: Callable[[Any], dict | None]) -> dict | None:
    if obj is None:
        return None
    module = type(obj).__module__ or ""

    table = table_output(obj)
    if table is not None:
        return table
    if module.startswith("plotly") and hasattr(obj, "to_plotly_json"):
        return {"type": "plotly", "json": obj.to_json()}
    if module.startswith("altair") and hasattr(obj, "to_json") and hasattr(obj, "to_dict"):
        # Every top-level chart (Chart, LayerChart, HConcatChart, …); to_dict() validates it.
        return vegalite_output(obj.to_dict())
    if module.startswith("matplotlib"):
        figure = obj if type(obj).__name__ == "Figure" else None
        if figure is not None:
            output = _figure_png(figure)
            _close_figure(figure)
            return output
        # Axes, Line2D, …: the figure itself is emitted when the cell finishes.
        return None
    spec = _vegalite_bundle(obj)
    if spec is not None:
        return vegalite_output(spec)
    repr_html = getattr(obj, "_repr_html_", None)
    if callable(repr_html) and not isinstance(obj, type):
        try:
            html = repr_html()
        except Exception:
            html = None
        if html:
            return {"type": "html", "html": html}
    text = repr(obj)
    if len(text) > MAX_TEXT_OUTPUT:
        text = text[:MAX_TEXT_OUTPUT] + f"\n… ({len(text) - MAX_TEXT_OUTPUT} more characters)"
    return {"type": "text", "text": text}


def vegalite_output(spec: dict) -> dict:
    """A Vega-Lite spec as an output, in strict JSON: NaN and ±inf, which Python's json writes as bare
    NaN/Infinity, become null (Altair leaves the NaN of NULLs in pandas' string columns in its data)."""
    return {"type": "vegalite", "json": json.dumps(_finite(spec), allow_nan=False, default=str)}


def _finite(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def _vegalite_bundle(obj: Any) -> dict | None:
    """The Vega-Lite spec in an object's rich display bundle (as Jupyter shows it), if it has one."""
    repr_bundle = getattr(obj, "_repr_mimebundle_", None)
    if not callable(repr_bundle) or isinstance(obj, type):
        return None
    try:
        bundle = repr_bundle()
    except Exception:
        return None
    if isinstance(bundle, tuple):  # (data, metadata)
        bundle = bundle[0] if bundle else None
    if not isinstance(bundle, dict):
        return None
    for mime, spec in bundle.items():
        if isinstance(mime, str) and _VEGALITE_MIME.match(mime) and isinstance(spec, dict):
            return spec
    return None


_VEGALITE_MIME = re.compile(r"^application/vnd\.vegalite\.v\d+\+json$")


# -- matplotlib --------------------------------------------------------------------


def _figure_png(figure: Any) -> dict | None:
    if not figure.axes and not figure.texts and not figure.images:
        return None
    buffer = io.BytesIO()
    figure.savefig(buffer, format="png", bbox_inches="tight", dpi=100)
    return {"type": "png", "data": base64.b64encode(buffer.getvalue()).decode("ascii")}


def _close_figure(figure: Any) -> None:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        plt.close(figure)


def flush_figures() -> None:
    """Emit every open pyplot figure into the running cell, then close them."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        if current is not None:
            for num in plt.get_fignums():
                output = _figure_png(plt.figure(num))
                if output is not None:
                    current.add(output)
    finally:
        plt.close("all")


# -- plotly ------------------------------------------------------------------------

plotly_theme = "plotly"
_template_we_set: str | None = None


def _apply_plotly_theme() -> None:
    """Follow the VS Code theme, unless the user picked a plotly template themselves."""
    global _template_we_set
    pio = sys.modules.get("plotly.io")
    if pio is None:
        return
    default = pio.templates.default
    if _template_we_set is None and default != "plotly":
        return
    if _template_we_set is not None and default != _template_we_set:
        return
    pio.templates.default = plotly_theme
    _template_we_set = plotly_theme


def _patch_plotly(module: Any) -> None:
    base = module.BaseFigure
    if getattr(base, "_duckexplorer_patched", False):
        return
    base._duckexplorer_patched = True

    def show(self: Any, *args: Any, **kwargs: Any) -> None:
        if current is not None:
            current.add({"type": "plotly", "json": self.to_json()})

    original_init_template = base._initialize_layout_template

    def initialize_layout_template(self: Any) -> Any:
        _apply_plotly_theme()
        return original_init_template(self)

    base.show = show
    base._initialize_layout_template = initialize_layout_template


# -- altair ------------------------------------------------------------------------


def _patch_altair(module: Any) -> None:
    """chart.show() draws the chart in the running cell (Altair would want IPython or a browser)."""
    base = getattr(module, "TopLevelMixin", None)
    if base is None:
        return

    def show(self: Any, *args: Any, **kwargs: Any) -> None:
        if current is not None:
            current.add(vegalite_output(self.to_dict()))

    base.show = show


class _ImportHook(importlib.abc.MetaPathFinder):
    """Patches plotly and altair as soon as they are imported, without importing them up front."""

    targets: dict[str, Callable[[Any], None]] = {
        "plotly.basedatatypes": _patch_plotly,
        # plotly.express reads the default template before building a figure.
        "plotly.io": lambda module: _apply_plotly_theme(),
        "altair": _patch_altair,
    }

    def find_spec(self, fullname, path, target=None):  # type: ignore[override]
        after_exec = self.targets.get(fullname)
        if after_exec is None:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None:
            return None
        loader = spec.loader
        original_exec = loader.exec_module

        def exec_module(module: Any) -> None:
            original_exec(module)
            after_exec(module)

        loader.exec_module = exec_module  # type: ignore[method-assign]
        return spec


def install_hooks() -> None:
    # Modules imported already (tests make several kernels in one process) are patched now.
    for name, patch in _ImportHook.targets.items():
        if name in sys.modules:
            patch(sys.modules[name])
    if not any(isinstance(f, _ImportHook) for f in sys.meta_path):
        sys.meta_path.insert(0, _ImportHook())


# -- running code ------------------------------------------------------------------

_cell_counter = 0


def run_cell(code: str, namespace: dict) -> None:
    """Execute a cell; if it ends in an expression (without a trailing ';'), display its value."""
    global _cell_counter
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)

    _apply_plotly_theme()  # the VS Code theme may have changed since the last cell
    tree = ast.parse(code, filename=filename, mode="exec")
    last_expr: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not code.rstrip().endswith(";"):
        last_expr = ast.Expression(tree.body.pop().value)

    exec(compile(tree, filename, "exec"), namespace)
    if last_expr is not None:
        value = eval(compile(last_expr, filename, "eval"), namespace)
        display(value)


def format_error(exc: BaseException) -> dict:
    """Traceback limited to user frames (from the first cell frame onwards)."""
    te = traceback.TracebackException.from_exception(exc)
    frames = list(te.stack)
    first_user = next((i for i, f in enumerate(frames) if f.filename.startswith("<cell-")), None)
    if first_user is not None:
        te.stack = traceback.StackSummary.from_list(frames[first_user:])
    elif not isinstance(exc, SyntaxError):
        te.stack = traceback.StackSummary.from_list([])
    return {
        "ename": type(exc).__name__,
        "evalue": str(exc),
        "traceback": "".join(te.format()),
    }
