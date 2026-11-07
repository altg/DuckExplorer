"""What SQL completions need from the session besides the schema tree: DuckDB's functions, types
and keywords, and the DataFrames a notebook's SQL cells can scan by name."""

from __future__ import annotations

import re
import sys
from collections import Counter
from itertools import zip_longest
from typing import Any

import duckdb
import pyarrow as pa

from .requirements import duckdb_major

# Overloads listed per function; date_trunc or strftime have a few, `+` has dozens.
MAX_SIGNATURES = 8
MAX_FRAMES = 100
MAX_FRAME_COLUMNS = 500

_KINDS = ("scalar", "aggregate", "macro", "table", "table_macro")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# duckdb 1.x names table functions' positional parameters col0, col1, …; the rest are `name := value`.
_POSITIONAL = re.compile(r"col\d+")
# duckdb 2 names them too (`path`, `stop`). A development build without a version is taken to be the newest.
_NAMES_POSITIONAL = (duckdb_major(duckdb.__version__) or 2) >= 2


def functions_version(cur: duckdb.DuckDBPyConnection) -> str:
    """Changes when an extension is loaded or a macro is created or dropped."""
    [(count, digest)] = cur.execute(
        "SELECT count(*), bit_xor(hash(database_name || '.' || schema_name || '.' || function_name || function_type))"
        " FROM duckdb_functions()"
    ).fetchall()
    return f"{count}:{digest}"


def function_catalog(cur: duckdb.DuckDBPyConnection) -> dict:
    """Callable functions by name, with their overloads, plus DuckDB's type names and keywords."""
    version = functions_version(cur)
    rows = cur.execute(
        """
        SELECT function_name, function_type, database_name, schema_name, internal,
               parameters, parameter_types, return_type, varargs, description, examples
        FROM duckdb_functions()
        WHERE list_contains($kinds, function_type) AND NOT starts_with(function_name, '__')
        """,
        {"kinds": list(_KINDS)},
    ).fetchall()
    overloads: dict[tuple, list[tuple]] = {}
    for row in rows:
        name, kind, database, schema, _, _, types = row[:7]
        if not _IDENTIFIER.fullmatch(name) or "POINTER" in (types or []):
            continue  # operators, and internals such as arrow_scan(POINTER, …)
        key = (name, "table" if kind == "table_macro" else kind, database, schema)
        overloads.setdefault(key, []).append(row)
    positional = _positional_counts(overloads)
    functions: dict[tuple, dict] = {}
    for key, found in overloads.items():
        name, kind, database, schema = key
        entry = functions[key] = {"name": name, "kind": kind, "signatures": []}
        if not found[0][4]:  # not internal
            entry["database"], entry["schema"] = database, schema
        for row, count in zip(found, positional[key]):
            params, types, returns, varargs, description, examples = row[5:]
            if description and "description" not in entry:
                entry["description"] = description
            if examples and "example" not in entry:
                entry["example"] = examples[0]
            signature = _signature(params or [], types or [], returns, varargs, count)
            if signature not in entry["signatures"] and len(entry["signatures"]) < MAX_SIGNATURES:
                entry["signatures"].append(signature)
    types = cur.execute(
        "SELECT DISTINCT type_name FROM duckdb_types() WHERE database_name = 'system' AND type_name <> 'null'"
    ).fetchall()
    return {
        "version": version,
        "functions": sorted(functions.values(), key=lambda f: f["name"]),
        "types": sorted({row[0].upper() for row in types}),
    }


def _positional_counts(overloads: dict[tuple, list[tuple]]) -> dict[tuple, list[int]]:
    """How many of each overload's parameters are positional; a table function's others are named
    (`header := true`), and come after them.

    duckdb 1.x names a table function's positional parameters col0, col1, …. duckdb 2 names them
    (`path`, `stop`), so they are told apart by what named parameters are like: every overload of a
    function has the same ones, last. A function with one overload has its named parameters from the
    first one that functions with more overloads have as named (`sniff_csv(path, sep := …)`).
    """
    counts: dict[tuple, list[int]] = {}
    shared: Counter[str] = Counter()  # how many functions have a parameter of this name as named
    single = []
    for key, found in overloads.items():
        function_type = found[0][1]
        lists = [list(zip_longest(row[5] or [], row[6] or [])) for row in found]
        if function_type not in ("table", "table_macro"):
            counts[key] = [len(params) for params in lists]
        elif function_type == "table_macro" or not _NAMES_POSITIONAL:
            # col0, col1, … are positional, the others named (all of a table macro's, which have names).
            counts[key] = [sum(1 for name, _ in params if _POSITIONAL.fullmatch(name)) for params in lists]
        elif len(lists) > 1:
            suffix = 0
            while all(len(p) > suffix for p in lists) and len({p[-1 - suffix] for p in lists}) == 1:
                suffix += 1
            counts[key] = [len(p) - suffix for p in lists]
            shared.update(name for name, _ in lists[0][len(lists[0]) - suffix :])
        else:
            single.append((key, lists[0]))
    # Named by one other function only isn't enough: a parameter overloaded by its type alone ends the
    # list of read_duckdb's or parquet_bloom_probe's overloads.
    named = {name for name, functions in shared.items() if functions > 1}
    for key, params in single:
        counts[key] = [next((i for i, (name, _) in enumerate(params) if name in named), len(params))]
    return counts


def _signature(params: list, types: list, returns: Any, varargs: Any, positional_count: int) -> dict:
    positional, named = [], []
    for i, name in enumerate(params):
        type_name = types[i] if i < len(types) else None
        param = {"name": name}
        if type_name:
            param["type"] = type_name
        # Unnamed parameters (col0, …) show as their type alone.
        if i >= positional_count:
            named.append(param)
        else:
            if _POSITIONAL.fullmatch(name):
                param["name"] = ""
            positional.append(param)
    signature: dict[str, Any] = {"params": positional}
    if named:
        signature["named"] = named
    if returns:
        signature["returns"] = returns
    if varargs and varargs != "INVALID":
        signature["varargs"] = varargs
    return signature


def notebook_frames(namespace: dict, cur: duckdb.DuckDBPyConnection) -> list[dict]:
    """Python variables that SQL can scan by name (DataFrames, Arrow tables, relations), with columns.

    Called on the side thread while a cell may be running: values are only inspected, never scanned.
    """
    frames = []
    for name, value in list(namespace.items()):
        if name.startswith("_") or len(frames) >= MAX_FRAMES:
            continue
        try:
            columns = _frame_columns(value, cur)
        except Exception:
            continue
        if columns is not None:
            frames.append({"name": name, "columns": columns[:MAX_FRAME_COLUMNS]})
    return sorted(frames, key=lambda frame: frame["name"].lower())


def _frame_columns(value: Any, cur: duckdb.DuckDBPyConnection) -> list[dict] | None:
    if isinstance(value, duckdb.DuckDBPyRelation):
        return _columns(value.columns, value.types)
    if isinstance(value, (pa.Table, pa.RecordBatch)):
        rel = cur.from_arrow(value if isinstance(value, pa.Table) else pa.Table.from_batches([value]))
        return _columns(rel.columns, rel.types)
    pd = sys.modules.get("pandas")
    if pd is not None and isinstance(value, pd.DataFrame):
        # DuckDB's own reading of the frame (object columns are sampled), as a SQL cell would scan it.
        rel = cur.from_df(value)
        return _columns(rel.columns, rel.types)
    pl = sys.modules.get("polars")
    if pl is not None and isinstance(value, pl.DataFrame):
        return [{"name": str(name), "type": str(dtype)} for name, dtype in value.schema.items()]
    return None


def _columns(names: list[str], types: list) -> list[dict]:
    return [{"name": name, "type": str(type_)} for name, type_ in zip(names, types)]
