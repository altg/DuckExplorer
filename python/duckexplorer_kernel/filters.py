"""Grid filters: the conditions and SQL WHERE text of a filtered result view, as DuckDB predicates.

A filter spec, as sent by the results grid:

    {"conditions": [{"column": 2, "op": "eq", "value": "shipped"}, …], "where": "amount > 100"}

Conditions refer to columns by position and compare against values as the grid shows them
(DuckDB's VARCHAR casts). `where` is SQL over the result's column names, as in a WHERE clause.

to_sql() writes a whole spec as one SQL condition over the column names, for the grid's WHERE box
and for a new cell that reruns the query with the filter (filtered_query()).
"""

from __future__ import annotations

import json
import math
import re
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal

import duckdb

from .profile import bar_predicate, bin_unit, column_kind
from .session import quote_ident, quote_literal

_VALUE_OPERATORS = {
    # Equality compares the displayed text, so it matches exactly what the grid shows for any type.
    "eq": "{c}::VARCHAR = {v}",
    # Rows with NULL in the column stay: excluding a value shouldn't hide unrelated rows.
    "ne": "{c}::VARCHAR IS DISTINCT FROM {v}",
    # Ordering compares typed values; DuckDB casts the string literal to the column's type.
    "ge": "{c} >= {v}",
    "le": "{c} <= {v}",
}
_SQL_OPERATORS = {"eq": "=", "ne": "IS DISTINCT FROM", "ge": ">=", "le": "<="}
_SIMPLE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER = re.compile(r"-?\d+(\.\d+)?([eE][+-]?\d+)?")
_FLOATING = re.compile(r"^(FLOAT|DOUBLE|REAL)$")
_DECIMAL_SCALE = re.compile(r"^(?:DECIMAL|NUMERIC)\(\d+,\s*(\d+)\)$")
# Types whose displayed text casts back to the same value, so SQL can compare them typed.
_TYPED_KINDS = {"numeric", "temporal", "boolean", "text"}
_TYPED_OTHER = {"TIME", "TIME WITH TIME ZONE", "INTERVAL"}
_keywords: set[str] | None = None


class InvalidFilter(Exception):
    """A filter the kernel can't apply: bad SQL in the WHERE text, a value of the wrong type, …"""


def _not_a_subquery() -> InvalidFilter:
    return InvalidFilter("The cell's query can't be used as a subquery (EXPLAIN, CALL, PRAGMA, …).")


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
    column, op = _column_and_op(condition, columns)
    c = f"c{column}"
    if op == "null":
        return f"{c} IS NULL"
    if op == "notNull":
        return f"{c} IS NOT NULL"
    if op == "bin":
        type_name = columns[column]["type"]
        low, high, width, count, index = _bin(condition, type_name)
        return bar_predicate(column, column_kind(type_name), type_name, low, high, width, count, index)
    return _VALUE_OPERATORS[op].format(c=c, v=quote_literal(_value(condition)))


# -- the filter as SQL over column names ------------------------------------------


def to_sql(spec: dict | None, columns: list[dict], side: duckdb.DuckDBPyConnection) -> str:
    """The spec as one condition over the result's column names ('' when it filters nothing).

    Value conditions become typed comparisons (`status = 'shipped'`, `amount >= 104.41`), histogram
    bars become ranges. Call with the side lock held.
    """
    if spec is None:
        return ""
    parts = [_condition_as_sql(c, columns, side) for c in spec["conditions"]]
    if spec["where"]:
        parts.append(f"({spec['where']})" if parts else spec["where"])
    return " AND ".join(parts)


def order_sql(sort: tuple[int, bool], columns: list[dict], side: duckdb.DuckDBPyConnection) -> str:
    """The grid's sort as an ORDER BY list (NULLs last, as in the grid)."""
    column, descending = sort
    return f"{column_name(column, columns, side)} {'DESC' if descending else 'ASC'} NULLS LAST"


def last_statement(code: str) -> str:
    """The last statement of a SQL cell, without leading comments and its semicolon, to use as a subquery."""
    try:
        statements = duckdb.extract_statements(code)
    except duckdb.Error as exc:
        raise InvalidFilter(f"The cell's SQL doesn't parse any more: {exc}") from None
    if not statements:
        raise InvalidFilter("The cell has no SQL statement.")
    if statements[-1].type.name == "PRAGMA":
        # duckdb 1.x gives the query a PRAGMA stands for (SELECT * FROM pragma_version()); 2.x the PRAGMA,
        # which `FROM (…)` reads as a table name.
        raise _not_a_subquery()
    return _bare_statement(statements[-1].query)


def filtered_query(code: str, where: str, order_by: str) -> str:
    """The last statement of a SQL cell as a subquery, with a WHERE and ORDER BY around it."""
    query = last_statement(code)
    # The closing parenthesis goes on its own line, after any trailing -- comment.
    lines = ["SELECT *", "FROM (", query, ")"]
    if where:
        lines.append(f"WHERE {where}")
    if order_by:
        lines.append(f"ORDER BY {order_by}")
    text = "\n".join(lines)
    try:
        duckdb.extract_statements(text)
    except duckdb.Error:
        raise _not_a_subquery() from None
    return text


def column_name(column: int, columns: list[dict], side: duckdb.DuckDBPyConnection) -> str:
    """The column's name as SQL, quoted only when it has to be."""
    name = columns[column]["name"]
    if any(other["name"].lower() == name.lower() for other in columns[:column]):
        raise InvalidFilter(f'The result has more than one column named "{name}"; SQL can only refer to the first one.')
    return quote_name(name, side)


def quote_name(name: str, side: duckdb.DuckDBPyConnection) -> str:
    """A name as SQL, quoted only when it has to be."""
    if _SIMPLE_NAME.fullmatch(name) and name.lower() not in _reserved_words(side):
        return name
    return quote_ident(name)


def _condition_as_sql(condition: dict, columns: list[dict], side: duckdb.DuckDBPyConnection) -> str:
    column, op = _column_and_op(condition, columns)
    name = column_name(column, columns, side)
    type_name = columns[column]["type"]
    kind = column_kind(type_name)
    if op == "null":
        return f"{name} IS NULL"
    if op == "notNull":
        return f"{name} IS NOT NULL"
    if op == "bin":
        return _bin_as_sql(condition, name, type_name, kind, side)
    value = _value(condition)
    typed = kind in _TYPED_KINDS or type_name.upper() in _TYPED_OTHER
    if op in ("eq", "ne") and not typed:
        return f"{name}::VARCHAR {_SQL_OPERATORS[op]} {quote_literal(value)}"
    return f"{name} {_SQL_OPERATORS[op]} {_literal(value, type_name, kind)}"


def _literal(value: str, type_name: str, kind: str) -> str:
    """A displayed value as a SQL literal. DOUBLEs stay quoted: DuckDB reads a bare 0.30000000000000004
    as a DECIMAL and converts it to a slightly different DOUBLE, while the string casts exactly."""
    if kind == "numeric" and not _FLOATING.match(type_name.upper()) and _NUMBER.fullmatch(value):
        return value
    if kind == "boolean" and value in ("true", "false"):
        return value
    return quote_literal(value)


def _bin_as_sql(condition: dict, name: str, type_name: str, kind: str, side: duckdb.DuckDBPyConnection) -> str:
    """A histogram bar as a range. Integer and DATE bars are exact; DOUBLE and timestamp bars compare
    against the bar's edges directly, which can differ from the histogram's rounding for edge values."""
    low, high, width, count, index = _bin(condition, type_name)
    unit = bin_unit(type_name)
    start = low if count == 1 else low + index * width
    last = count == 1 or index == count - 1
    if unit:
        # Whole steps (integers, days): an inclusive range.
        end = high if last else min(start + width - unit, high)
        first, final = _point_literals([start, end], type_name, kind, side, [ROUND_CEILING, ROUND_FLOOR])
        return f"{name} = {first}" if first == final else f"{name} BETWEEN {first} AND {final}"
    end = high if last else start + width
    operator = "<=" if last else "<"
    rounding = ROUND_FLOOR if last else ROUND_CEILING
    first, final = _point_literals([start, end], type_name, kind, side, [ROUND_CEILING, rounding])
    if _FLOATING.match(type_name.upper()):
        name = f"{name}::DOUBLE"  # the histogram bins FLOAT values as DOUBLE
    return f"{name} >= {first} AND {name} {operator} {final}"


def _point_literals(
    values: list[float], type_name: str, kind: str, side: duckdb.DuckDBPyConnection, roundings: list[str]
) -> list[str]:
    """Bar edges (DOUBLEs, or epoch microseconds for dates and timestamps) as SQL literals of the column's
    type, rounded inwards to the values the column can hold (whole numbers, its DECIMAL scale, µs)."""
    t = type_name.upper()
    if kind == "temporal":
        micros = [int(Decimal(repr(v)).to_integral_value(r)) for v, r in zip(values, roundings)]
        if t == "DATE":
            render = "make_timestamp(x)::DATE::VARCHAR"
        elif t == "TIMESTAMP WITH TIME ZONE":
            render = "(make_timestamp(x) AT TIME ZONE 'UTC')::VARCHAR"
        else:
            render = "make_timestamp(x)::VARCHAR"
        # A list comprehension: duckdb 2 refuses `x -> …` lambdas, and 1.x before 1.3 has no `lambda x: …`.
        [(texts,)] = side.execute(f"SELECT [{render} for x in $v::BIGINT[]]", {"v": micros}).fetchall()
        return [quote_literal(text) for text in texts]
    scale = _DECIMAL_SCALE.match(t)
    if bin_unit(type_name):
        return [str(int(Decimal(repr(v)).to_integral_value(r))) for v, r in zip(values, roundings)]
    if scale:
        step = Decimal(1).scaleb(-int(scale.group(1)))
        return [str(Decimal(repr(v)).quantize(step, rounding=r)) for v, r in zip(values, roundings)]
    return [quote_literal(repr(v)) for v in values]


def _bare_statement(query: str) -> str:
    """A statement without leading comment lines (`-- name: …`) and its closing semicolon."""
    lines = query.strip().splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("--")):
        lines.pop(0)
    text = "\n".join(lines).rstrip()
    return re.sub(r";\s*(--[^\n]*\s*)*$", "", text)


def _reserved_words(side: duckdb.DuckDBPyConnection) -> set[str]:
    """Keywords that can't be a bare column name (DuckDB's reserved and type/function keywords, plus
    column-name keywords such as `time`, which read ambiguously next to literals)."""
    global _keywords
    if _keywords is None:
        rows = side.execute("SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category <> 'unreserved'")
        _keywords = {row[0].lower() for row in rows.fetchall()}
    return _keywords


# -- validation ---------------------------------------------------------------------


def _column_and_op(condition: dict, columns: list[dict]) -> tuple[int, str]:
    try:
        column = int(condition["column"])
        op = condition["op"]
    except (KeyError, TypeError, ValueError):
        raise InvalidFilter(f"Malformed filter condition: {condition!r}") from None
    if not 0 <= column < len(columns):
        raise InvalidFilter(f"No column {column}")
    if op not in _VALUE_OPERATORS and op not in ("null", "notNull", "bin"):
        raise InvalidFilter(f"Unknown filter operator {op!r}")
    return column, op


def _value(condition: dict) -> str:
    value = condition.get("value")
    if not isinstance(value, str):
        raise InvalidFilter(f"Malformed filter condition: {condition!r}")
    return value


def _bin(condition: dict, type_name: str) -> tuple[float, float, float, int, int]:
    """(low, high, width, count, index) of a histogram-bar condition."""
    try:
        bins = condition["bins"]
        low, width, count = float(bins["low"]), float(bins["width"]), int(bins["count"])
        high = float(bins["high"])
        index = int(condition["index"])
    except (KeyError, TypeError, ValueError):
        raise InvalidFilter("Malformed histogram filter") from None
    if column_kind(type_name) not in ("numeric", "temporal"):
        raise InvalidFilter("Malformed histogram filter")
    if not all(math.isfinite(v) for v in (low, high, width)) or count < 1 or not 0 <= index < count:
        raise InvalidFilter("Malformed histogram filter")
    return low, high, width, count, index
