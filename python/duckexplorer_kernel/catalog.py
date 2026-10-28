"""What SQL completions need from the session besides the schema tree: DuckDB's functions, types
and keywords, and the DataFrames a notebook's SQL cells can scan by name."""

from __future__ import annotations

import re
import sys
from typing import Any

import duckdb
import pyarrow as pa

# Overloads listed per function; date_trunc or strftime have a few, `+` has dozens.
MAX_SIGNATURES = 8
MAX_FRAMES = 100
MAX_FRAME_COLUMNS = 500

_KINDS = ("scalar", "aggregate", "macro", "table", "table_macro")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# Table functions name their positional parameters col0, col1, …; the rest are `name := value`.
_POSITIONAL = re.compile(r"col\d+")


def functions_version(cur: duckdb.DuckDBPyConnection) -> str:
    """Changes when an extension is loaded or a macro is created or dropped."""
    count, digest = cur.execute(
        "SELECT count(*), bit_xor(hash(database_name || '.' || schema_name || '.' || function_name || function_type))"
        " FROM duckdb_functions()"
    ).fetchone()
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
    functions: dict[tuple, dict] = {}
    for name, kind, database, schema, internal, params, types, returns, varargs, description, examples in rows:
        if not _IDENTIFIER.fullmatch(name) or "POINTER" in (types or []):
            continue  # operators, and internals such as arrow_scan(POINTER, …)
        kind = "table" if kind == "table_macro" else kind
        key = (name, kind, database, schema)
        entry = functions.get(key)
        if entry is None:
            entry = functions[key] = {"name": name, "kind": kind, "signatures": []}
            if not internal:
                entry["database"], entry["schema"] = database, schema
        if description and "description" not in entry:
            entry["description"] = description
        if examples and "example" not in entry:
            entry["example"] = examples[0]
        signature = _signature(kind, params or [], types or [], returns, varargs)
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


def _signature(kind: str, params: list, types: list, returns: Any, varargs: Any) -> dict:
    positional, named = [], []
    for i, name in enumerate(params):
        type_name = types[i] if i < len(types) else None
        param = {"name": name}
        if type_name:
            param["type"] = type_name
        # Unnamed parameters (col0, …) show as their type alone.
        if kind == "table" and not _POSITIONAL.fullmatch(name):
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
