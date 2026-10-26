"""Grid filters: the conditions and SQL WHERE text of a filtered result view, as DuckDB predicates.

A filter spec, as sent by the results grid:

    {"conditions": [{"column": 2, "op": "eq", "value": "shipped"}, …], "where": "amount > 100"}

Conditions refer to columns by position and compare against values as the grid shows them
(DuckDB's VARCHAR casts). `where` is SQL over the result's column names, as in a WHERE clause.
"""

from __future__ import annotations

import json
import math

from .profile import bucket_expression, column_kind
from .session import quote_literal

_VALUE_OPERATORS = {
    # Equality compares the displayed text, so it matches exactly what the grid shows for any type.
    "eq": "{c}::VARCHAR = {v}",
    # Rows with NULL in the column stay: excluding a value shouldn't hide unrelated rows.
    "ne": "{c}::VARCHAR IS DISTINCT FROM {v}",
    # Ordering compares typed values; DuckDB casts the string literal to the column's type.
    "ge": "{c} >= {v}",
    "le": "{c} <= {v}",
}


class InvalidFilter(Exception):
    """A filter the kernel can't apply: bad SQL in the WHERE text, a value of the wrong type, …"""


def normalize(spec: dict | None) -> dict | None:
    """The spec with empty parts dropped, or None when it doesn't filter anything."""
    if not spec:
        return None
    conditions = spec.get("conditions") or []
    where = spec.get("where") or ""
    if not isinstance(conditions, list) or not isinstance(where, str):
        raise InvalidFilter("Malformed filter")
    where = where.strip()
    if not conditions and not where:
        return None
    return {"conditions": conditions, "where": where}


def cache_key(spec: dict | None) -> str:
    """Identifies the rows a normalized spec selects ('' for every row)."""
    if spec is None:
        return ""
    conditions = [{k: v for k, v in c.items() if k != "label"} for c in spec["conditions"]]
    return json.dumps({"conditions": conditions, "where": spec["where"]}, sort_keys=True)


def condition_sql(condition: dict, columns: list[dict]) -> str:
    """One condition as a predicate over the positional scan columns c0, c1, …"""
    try:
        column = int(condition["column"])
        op = condition["op"]
    except (KeyError, TypeError, ValueError):
        raise InvalidFilter(f"Malformed filter condition: {condition!r}") from None
    if not 0 <= column < len(columns):
        raise InvalidFilter(f"No column {column}")
    c = f"c{column}"
    if op == "null":
        return f"{c} IS NULL"
    if op == "notNull":
        return f"{c} IS NOT NULL"
    if op == "bin":
        return _bin_sql(condition, column, columns[column]["type"])
    template = _VALUE_OPERATORS.get(op)
    if template is None:
        raise InvalidFilter(f"Unknown filter operator {op!r}")
    value = condition.get("value")
    if not isinstance(value, str):
        raise InvalidFilter(f"Malformed filter condition: {condition!r}")
    return template.format(c=c, v=quote_literal(value))


def _bin_sql(condition: dict, column: int, type_name: str) -> str:
    """Rows in one Column Explorer histogram bar, with the exact expression that counted them."""
    try:
        bins = condition["bins"]
        low, width, count = float(bins["low"]), float(bins["width"]), int(bins["count"])
        index = int(condition["index"])
    except (KeyError, TypeError, ValueError):
        raise InvalidFilter("Malformed histogram filter") from None
    kind = column_kind(type_name)
    if kind not in ("numeric", "temporal") or not (math.isfinite(low) and math.isfinite(width)):
        raise InvalidFilter("Malformed histogram filter")
    if count < 1 or not 0 <= index < count:
        raise InvalidFilter("Malformed histogram filter")
    return f"{bucket_expression(column, kind, type_name, low, width, count)} = {index}"
