"""The duckdb versions the kernel starts with (duckexplorer_kernel.requirements)."""

import os
import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from duckexplorer_kernel.requirements import DUCKDB_REQUIREMENT, UNSUPPORTED_DUCKDB, duckdb_major, duckdb_problem


@pytest.mark.parametrize("version", ["1.1.3", "1.5.6", "1.5.0.dev123", "2.0.0", "2.1.0rc1", "2.2.0.dev45", "dev"])
def test_duckdb_1_and_2_are_supported(version):
    assert duckdb_problem(version) is None


@pytest.mark.parametrize("version", ["3.0.0", "3.1.0rc1", "10.0"])
def test_a_later_major_version_is_not(version):
    problem = duckdb_problem(version)
    assert problem.startswith(UNSUPPORTED_DUCKDB)
    assert f"duckdb {version}" in problem
    assert f'pip install "{DUCKDB_REQUIREMENT}"' in problem


def test_the_installed_duckdb_is_supported():
    # The tests (and CI) run against a duckdb the kernel supports.
    assert duckdb_problem(duckdb.__version__) is None


@pytest.mark.parametrize(("version", "major"), [("1.5.6", 1), ("2.0.0", 2), ("1.5.0.dev123", 1), ("10.0", 10), ("dev", None)])
def test_major_version(version, major):
    assert duckdb_major(version) == major


def test_the_kernel_stops_at_startup_with_an_unsupported_duckdb(tmp_path):
    # A stand-in duckdb module that says it is 3.0.0, found before the real one.
    (tmp_path / "duckdb.py").write_text("__version__ = '3.0.0'\n")
    path = os.pathsep.join([str(tmp_path), str(Path(__file__).resolve().parents[1])])
    proc = subprocess.run(
        [sys.executable, "-m", "duckexplorer_kernel"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "PYTHONPATH": path},
    )
    assert proc.returncode == 1
    assert proc.stdout == ""  # no ready notification
    assert proc.stderr.startswith(f"{UNSUPPORTED_DUCKDB}, and this Python has duckdb 3.0.0.")
