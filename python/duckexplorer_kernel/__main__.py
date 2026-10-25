import os

# Must be set before anything imports matplotlib: plt.show() then emits into the running cell.
os.environ["MPLBACKEND"] = "module://duckexplorer_kernel.mpl_backend"

from .server import main  # noqa: E402

main()
