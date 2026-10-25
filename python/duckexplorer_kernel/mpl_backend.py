"""Matplotlib backend for DuckExplorer: Agg rendering, with plt.show() emitting PNGs into the running cell."""

from matplotlib.backends.backend_agg import (  # noqa: F401
    FigureCanvasAgg,
    new_figure_manager,
    new_figure_manager_given_figure,
)

FigureCanvas = FigureCanvasAgg


def show(*args, **kwargs) -> None:
    from . import pyexec

    pyexec.flush_figures()
