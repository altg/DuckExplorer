"""The duckdb versions the kernel works with, checked when it starts (before anything else imports duckdb's API).

The kernel works with duckdb 1.x and 2.x. DuckDB 2.0 changed the Python API the kernel uses (relations have no
fetchone(), an unread execute() result blocks its connection, sql() returns a relation for every statement, error
excerpts and duckdb_functions() changed), so a later major version may too: rather than failing feature by feature
with one, the kernel says at startup that it needs a version it knows.
"""

from __future__ import annotations

import re

# What `pip install` needs, for the message (the extension's Install packages uses the same).
DUCKDB_REQUIREMENT = "duckdb<3"
# Printed to stderr at startup; the extension recognizes it and offers to install DUCKDB_REQUIREMENT.
UNSUPPORTED_DUCKDB = "DuckExplorer needs duckdb 1.x or 2.x"
NEWEST_SUPPORTED = 2

_MAJOR = re.compile(r"\d+")


def duckdb_major(version: str) -> int | None:
    """The major version of a duckdb version string ("2.0.0", "1.5.0.dev123"), or None when it has none."""
    match = _MAJOR.match(version)
    return int(match[0]) if match else None


def duckdb_problem(version: str) -> str | None:
    """Why the kernel can't run with this duckdb version, or None when it can."""
    major = duckdb_major(version)
    if major is None or major <= NEWEST_SUPPORTED:
        return None  # a development build without a version: try it
    return (
        f"{UNSUPPORTED_DUCKDB}, and this Python has duckdb {version}. "
        f'Install a supported version with: python -m pip install "{DUCKDB_REQUIREMENT}"'
    )
