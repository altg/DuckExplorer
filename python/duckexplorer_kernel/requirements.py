"""The duckdb versions the kernel works with, checked when it starts (before anything else imports duckdb's API).

DuckDB 2.0 changed the Python API the kernel is written against: relations no longer have fetchone(), an
unfinished execute() result blocks its connection, and error excerpts and duckdb_functions() changed. Until
the kernel supports it, it says so at startup rather than failing feature by feature.
"""

from __future__ import annotations

# What `pip install` needs, for the message (the extension's Install packages uses the same).
DUCKDB_REQUIREMENT = "duckdb<2"
# Printed to stderr at startup; the extension recognizes it and offers to install DUCKDB_REQUIREMENT.
UNSUPPORTED_DUCKDB = "DuckExplorer needs duckdb 1.x"


def duckdb_problem(version: str) -> str | None:
    """Why the kernel can't run with this duckdb version, or None when it can."""
    try:
        major = int(version.split(".")[0])
    except ValueError:
        return None  # a development build: try it
    if major < 2:
        return None
    return (
        f"{UNSUPPORTED_DUCKDB}, and this Python has duckdb {version}. "
        f'Install a supported version with: python -m pip install "{DUCKDB_REQUIREMENT}"'
    )
