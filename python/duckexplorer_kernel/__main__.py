import os
import sys

# Must be set before anything imports matplotlib: plt.show() then emits into the running cell.
os.environ["MPLBACKEND"] = "module://duckexplorer_kernel.mpl_backend"

import duckdb  # noqa: E402

from .requirements import duckdb_problem  # noqa: E402

problem = duckdb_problem(duckdb.__version__)
if problem:
    # Before the ready notification: the extension shows this and offers to install a supported duckdb.
    sys.stderr.write(problem + "\n")
    sys.exit(1)

from .server import main  # noqa: E402

main()
