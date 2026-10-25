import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["MPLBACKEND"] = "module://duckexplorer_kernel.mpl_backend"

from duckexplorer_kernel.kernel import Kernel  # noqa: E402


@pytest.fixture
def kernel():
    return Kernel()


@pytest.fixture
def sample_db(tmp_path):
    import duckdb

    path = tmp_path / "shop.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        """
        CREATE TABLE orders AS
        SELECT range AS id, 'c' || (range % 5) AS customer, (range * 1.5)::DOUBLE AS amount
        FROM range(1000);
        CREATE VIEW big_orders AS SELECT * FROM orders WHERE amount > 1000;
        CREATE SCHEMA staging;
        CREATE TABLE staging.raw(a INTEGER, b VARCHAR);
        """
    )
    con.close()
    return path
