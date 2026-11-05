"""The Chart view of a result: a chart of its columns, drawn with Vega-Lite and kept as Altair or Plotly code.

A chart, as the grid's Chart view sends it. Every part may be left out, and is then chosen from the
columns' types and contents (resolve()):

    {"mark": "bar" | "line" | "area" | "point",
     "x": 0,                        # column index
     "y": 3,                        # a numeric column, or None to count rows
     "aggregate": "sum" | "mean" | "median" | "min" | "max" | "none",
     "color": 1,                    # a column, or None
     "timeUnit": "auto" | "none" | "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute"}

The chart's data is one SQL query over the result's columns by name (DuckDB aggregates, so a chart
of millions of rows sends a few hundred values). The preview runs it over the stored result, as the
grid's filter keeps it; the code that keeps the chart in a notebook runs it over the cell's query
with the filter as SQL, so both draw the same values.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
import math
import re
from dataclasses import dataclass, field

import duckdb
import pyarrow as pa

from . import filters
from .filters import InvalidFilter
from .profile import column_kind
from .session import quote_ident

MARKS = ("bar", "line", "area", "point")
AGGREGATES = ("sum", "mean", "median", "min", "max", "none")
# Coarsest first, with their length in microseconds (months and years on average).
TIME_UNITS = {
    "year": 365.25 * 86_400e6,
    "quarter": 91.3125 * 86_400e6,
    "month": 30.4375 * 86_400e6,
    "week": 7 * 86_400e6,
    "day": 86_400e6,
    "hour": 3_600e6,
    "minute": 60e6,
}
# Vega-Lite's names for the bars of a time unit (bars on a time axis need one to have a width).
_VL_TIME_UNITS = {
    "year": "year",
    "quarter": "yearquarter",
    "month": "yearmonth",
    "week": "yearweek",
    "day": "yearmonthdate",
    "hour": "yearmonthdatehours",
    "minute": "yearmonthdatehoursminutes",
}
# Rows of chart data at most (Altair refuses more, unless told otherwise).
MAX_ROWS = 5000
# A bar chart of categories shows the largest ones.
MAX_BARS = 100
# How many points (bars) on a time axis "auto" aims for.
AUTO_POINTS = {"bar": 60, "line": 500, "area": 500, "point": 500}
# A line shows its points when there are few.
MARKER_POINTS = 60
COLOR_CATEGORIES = 10
_SQL_AGGREGATES = {"sum": "sum", "mean": "avg", "median": "median", "min": "min", "max": "max"}
_TITLES = {"sum": "Sum of", "mean": "Average of", "median": "Median of", "min": "Min of", "max": "Max of"}
_CHARTABLE = {"numeric", "temporal", "text", "boolean"}
# Numbers that identify rather than measure: not a default for y.
_ID_NAME = re.compile(r"(^id$|^id_|_(id|no|nr|num|number|key|code)$|[a-z](Id|No)$)")
_SIMPLE_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_ ]*")
_SAMPLE = f"USING SAMPLE reservoir({MAX_ROWS} ROWS) REPEATABLE (42)"
_VL_TYPES = {"nominal": "N", "ordinal": "O", "quantitative": "Q", "temporal": "T"}


@dataclass
class _Field:
    """A column of the chart's data."""

    name: str
    title: str
    type: str  # Vega-Lite's: nominal, ordinal, quantitative, temporal
    extra: dict = field(default_factory=dict)  # timeUnit, sort


@dataclass
class _Plan:
    chart: dict
    select: list[str]
    grouped: bool
    order: list[str]
    x: _Field
    y: _Field
    color: _Field | None
    limit: int | None = None
    sampled: bool = False
    note: str | None = None
    rows: int = 0  # of the chart's data


# -- the preview ------------------------------------------------------------------


def chart_spec(side: duckdb.DuckDBPyConnection, scan: pa.Table, columns: list[dict], request: dict | None) -> dict:
    """The chart of `scan` (a stored result's rows the filter keeps, columns c0, c1, …) as a Vega-Lite
    spec with its data, and the chart as resolved. Call with the side lock held."""
    kinds = chart_kinds(columns)
    view = "__dx_chart"
    side.register(view, scan)
    try:
        source = _preview_source(view, columns, kinds)
        plan = _plan(side, source, columns, kinds, request or {})
        query = _query(plan, source)
        rel = side.sql(query)
        names = rel.columns
        rows = [dict(zip(names, map(_json_value, row))) for row in rel.fetchall()]
    except duckdb.Error as exc:
        raise InvalidFilter(str(exc).strip()) from None
    finally:
        side.unregister(view)
    return {
        "chart": plan.chart,
        "kinds": kinds,
        "spec": _vega_lite(plan, rows),
        "rows": len(rows),
        **({"note": plan.note} if plan.note else {}),
    }


def chart_kinds(columns: list[dict]) -> list[str]:
    """What each column can be in a chart: numeric, temporal, text or boolean, else other (lists, structs,
    and later columns with an earlier column's name, which SQL can't refer to)."""
    kinds = []
    seen: set[str] = set()
    for column in columns:
        kind = column_kind(column["type"])
        name = column["name"].lower()
        kinds.append(kind if kind in _CHARTABLE and name not in seen else "other")
        seen.add(name)
    return kinds


def _preview_source(view: str, columns: list[dict], kinds: list[str]) -> str:
    """The stored rows (columns c0, c1, …) under the result's column names, the chartable ones."""
    named = ", ".join(f"c{i} AS {quote_ident(c['name'])}" for i, c in enumerate(columns) if kinds[i] != "other")
    return f"(SELECT {named} FROM {view})"


# -- the code -----------------------------------------------------------------------


def chart_code(
    side: duckdb.DuckDBPyConnection,
    scan: pa.Table,
    columns: list[dict],
    request: dict,
    source_sql: str,
    where: str,
    library: str,
) -> str:
    """Python that draws the chart with `library` ("altair" or "plotly"): the chart's query over the
    query `source_sql` (rows filtered by `where`, SQL over the column names), then the chart. The plan is
    made over `scan`, the rows the preview shows, so the code draws the same chart."""
    kinds = chart_kinds(columns)
    view = "__dx_chart"
    side.register(view, scan)
    try:
        plan = _plan(side, _preview_source(view, columns, kinds), columns, kinds, request)
    except duckdb.Error as exc:
        raise InvalidFilter(str(exc).strip()) from None
    finally:
        side.unregister(view)
    inner = f"(\n{source_sql}\n)"
    if where and plan.sampled:
        # A sample is taken before WHERE applies, so the filter goes inside.
        inner = f"(\nSELECT *\nFROM {inner}\nWHERE {where}\n)"
        where = ""
    query = _query(plan, inner, where)
    if library == "altair":
        return _altair_code(plan, query)
    return _plotly_code(plan, query)


def source_query(code: str) -> str:
    """The last statement of a SQL cell, to chart from as a subquery."""
    return filters.last_statement(code)


def _altair_code(plan: _Plan, query: str) -> str:
    def channel(kind: str, f: _Field) -> str:
        args: list[str] = []
        if _SIMPLE_FIELD.fullmatch(f.name):
            args.append(_py_str(f"{f.name}:{_VL_TYPES[f.type]}"))
        else:
            args += [f"field={_py_str(_vl_field(f.name))}", f"type={_py_str(f.type)}"]
        for key, value in f.extra.items():
            args.append(f"{key}={_py_str(value)}")
        args.append(f"title={_py_str(f.title)}")
        return f"alt.{kind}({', '.join(args)})"

    mark_args = ["tooltip=True"] + (["point=True"] if plan.chart["mark"] == "line" and _markers(plan) else [])
    encodings = [f"x={channel('X', plan.x)}", f"y={channel('Y', plan.y)}"]
    if plan.color is not None:
        encodings.append(f"color={channel('Color', plan.color)}")
    lines = [
        "import altair as alt",
        "",
        f"chart_data = sql({_py_sql(query)})",
        "",
        "(",
        "    alt.Chart(chart_data)",
        f"    .mark_{plan.chart['mark']}({', '.join(mark_args)})",
        "    .encode(",
        *[f"        {e}," for e in encodings],
        "    )",
        '    .properties(width="container", height=300)',
        ")",
    ]
    return "\n".join(lines)


def _plotly_code(plan: _Plan, query: str) -> str:
    function = {"bar": "bar", "line": "line", "area": "area", "point": "scatter"}[plan.chart["mark"]]
    args = ["chart_data", f"x={_py_str(plan.x.name)}", f"y={_py_str(plan.y.name)}"]
    if plan.color is not None:
        args.append(f"color={_py_str(plan.color.name)}")
    if plan.chart["mark"] == "line" and _markers(plan):
        args.append("markers=True")
    labels = {f.name: f.title for f in (plan.x, plan.y, plan.color) if f is not None and f.title != f.name}
    if labels:
        args.append(f"labels={{{', '.join(f'{_py_str(k)}: {_py_str(v)}' for k, v in labels.items())}}}")
    return "\n".join(
        [
            "import plotly.express as px",
            "",
            f"chart_data = sql({_py_sql(query)})",
            "",
            f"px.{function}({', '.join(args)})",
        ]
    )


# -- planning -------------------------------------------------------------------------


def _plan(side: duckdb.DuckDBPyConnection, source: str, columns: list[dict], kinds: list[str], request: dict) -> _Plan:
    if not any(kind in _CHARTABLE for kind in kinds):
        raise InvalidFilter("Nothing to chart: the result has no number, date or text columns.")
    stats = _stats(side, source, columns, kinds)
    chart = resolve(request, columns, kinds, stats)
    name = lambda i: filters.column_name(i, columns, side)  # noqa: E731
    mark, x, y, aggregate, color = chart["mark"], chart["x"], chart["y"], chart["aggregate"], chart["color"]
    x_kind = kinds[x]
    x_name = columns[x]["name"]
    x_sql = name(x)
    unit = chart["timeUnit"]
    if unit != "none" and not stats["time"][x][2][unit]:
        x_sql = f"date_trunc('{unit}', {x_sql}) AS {x_sql}"  # values already on the unit stay as they are
    used = {x_name.lower()}
    if color is not None:
        used.add(columns[color]["name"].lower())

    # The y column of the data: the aggregate's own name when it would clash with x or color.
    if y is None:
        y_name = _unique("count", used)
        y_sql = f"count(*) AS {filters.quote_name(y_name, side)}"
        y_title = "Count of rows"
    elif aggregate == "none":
        y_name = columns[y]["name"]
        if y_name.lower() in used:
            raise InvalidFilter(f"{y_name} can't be on both axes without an aggregate.")
        y_sql = name(y)
        y_title = y_name
    else:
        base = columns[y]["name"]
        y_name = _unique(base if base.lower() not in used else f"{aggregate}_{base}", used)
        y_sql = f"{_SQL_AGGREGATES[aggregate]}({name(y)}) AS {filters.quote_name(y_name, side)}"
        y_title = f"{_TITLES[aggregate]} {base}"
    grouped = y is None or aggregate != "none"

    select = [x_sql]
    if color is not None:
        select.append(name(color))
    select.append(y_sql)

    x_type = {"temporal": "temporal", "numeric": "quantitative"}.get(x_kind, "nominal")
    x_extra: dict = {}
    if mark == "bar" and x_kind == "numeric" and stats["distinct"][x] <= AUTO_POINTS["bar"]:
        x_type = "ordinal"  # a bar per value
    if mark == "bar" and x_kind == "temporal" and unit != "none":
        x_extra["timeUnit"] = _VL_TIME_UNITS[unit]
    categories = mark == "bar" and x_type == "nominal"
    if categories and color is None:
        x_extra["sort"] = "-y"  # the largest first
    x_field = _Field(x_name, x_name, x_type, x_extra)
    y_field = _Field(y_name, y_title, "quantitative")
    color_field = None
    if color is not None:
        c_kind = kinds[color]
        c_type = {"temporal": "temporal", "numeric": "quantitative"}.get(c_kind, "nominal")
        color_field = _Field(columns[color]["name"], columns[color]["name"], c_type)

    y_ref = filters.quote_name(y_name, side)
    order: list[str] = []
    if categories and color is None:
        order = [f"{y_ref} DESC", filters.quote_name(x_name, side)]
    elif mark != "point" or grouped:
        order = [filters.quote_name(x_name, side)] + ([name(color)] if color is not None else [])
    plan = _Plan(chart, select, grouped, order, x_field, y_field, color_field)

    # How many rows the chart's data has, and what to show when there are too many.
    total = side.sql(f"SELECT count(*) FROM ({_query(plan, source)})").fetchone()[0]
    plan.rows = total
    if categories and color is None and total > MAX_BARS:
        plan.limit = plan.rows = MAX_BARS
        plan.note = f"The {MAX_BARS} largest of {total:,} {x_name} values"
    elif total > MAX_ROWS and not grouped:
        plan.sampled = True
        plan.rows = MAX_ROWS
        plan.note = f"{MAX_ROWS:,} rows sampled from {total:,}"
    elif total > MAX_ROWS:
        plan.limit = plan.rows = MAX_ROWS
        plan.note = f"The first {MAX_ROWS:,} of {total:,} points"
    elif total == 0:
        plan.note = "No rows to chart"
    return plan


def resolve(request: dict, columns: list[dict], kinds: list[str], stats: dict) -> dict:
    """The chart with the parts the request leaves out chosen from the columns: a line over time, bars
    per category, or a scatter of two numbers, colored by a column with a few values."""
    distinct = stats["distinct"]
    chartable = [i for i, k in enumerate(kinds) if k in _CHARTABLE]
    numeric = [i for i in chartable if kinds[i] == "numeric"]
    measures = [i for i in numeric if not _id_like(columns[i]["name"])] or numeric
    temporal = [i for i in chartable if kinds[i] == "temporal"]
    categorical = [i for i in chartable if kinds[i] in ("text", "boolean")]

    mark = _choice(request, "mark", MARKS)
    x = _column(request, "x", chartable, columns)
    y = _column(request, "y", numeric, columns, numeric_only=True)
    aggregate = _choice(request, "aggregate", AGGREGATES)

    if x is None:
        if mark in (None, "line", "area") and temporal:
            x = temporal[0]
        elif mark in (None, "bar") and categorical:
            few = [i for i in categorical if 2 <= distinct[i] <= MAX_BARS]
            x = (few or categorical)[0]
        elif mark == "point" or (mark is None and len(measures) >= 2):
            x = measures[0] if measures else chartable[0]
        else:
            x = (temporal or categorical or measures or chartable)[0]
    if mark is None:
        if kinds[x] == "temporal":
            mark = "line"
        elif kinds[x] == "numeric" and "y" not in request and len([i for i in measures if i != x]) >= 1:
            mark = "point"
        else:
            mark = "bar"
    if "y" not in request:
        y = next((i for i in measures if i != x), None)
    if aggregate is None:
        aggregate = "none" if mark == "point" and y is not None else "sum"
    if y is None and aggregate == "none":
        aggregate = "sum"  # counting rows is an aggregate

    if "color" in request:
        color = _column(request, "color", chartable, columns)
    else:
        color = next((i for i in categorical if i != x and 2 <= distinct[i] <= COLOR_CATEGORIES), None)
    if color == x:
        color = None

    unit = _choice(request, "timeUnit", ("auto", "none", *TIME_UNITS)) or "auto"
    if kinds[x] != "temporal" or (aggregate == "none" and y is not None):
        unit = "none"  # values that aren't aggregated keep their times
    elif unit == "auto":
        unit = _auto_unit(stats, x, AUTO_POINTS[mark])
    return {"mark": mark, "x": x, "y": y, "aggregate": aggregate, "color": color, "timeUnit": unit}


def _auto_unit(stats: dict, x: int, points: int) -> str:
    """The time unit for "auto": the coarsest one the values already fall on, when there are few of them
    (monthly data stays monthly, and bars get a width); else the finest one that gives at most
    `points` points."""
    time = stats["time"].get(x)
    if time is None:
        return "none"
    low, high, aligned = time
    aligned_units = [unit for unit in TIME_UNITS if aligned.get(unit)]
    if stats["distinct"][x] <= points:
        return aligned_units[0] if aligned_units else "none"
    span = (high - low) if low is not None and high is not None else 0
    for unit in reversed(TIME_UNITS):
        if span / TIME_UNITS[unit] + 1 <= points:
            return unit
    return "year"


def _stats(side: duckdb.DuckDBPyConnection, source: str, columns: list[dict], kinds: list[str]) -> dict:
    """Row count, distinct values per chartable column, and for temporal columns their range (epoch µs)
    and which time units every value falls on: one scan."""
    aggregates = ["count(*)"]
    plan: list[tuple[int, str]] = []
    for i, kind in enumerate(kinds):
        if kind not in _CHARTABLE:
            continue
        c = quote_ident(columns[i]["name"])
        aggregates.append(f"approx_count_distinct({c})")
        plan.append((i, "distinct"))
        if kind == "temporal":
            aggregates += [f"min(epoch_us({c}))", f"max(epoch_us({c}))"]
            aggregates += [f"bool_and({c} = date_trunc('{unit}', {c}))" for unit in TIME_UNITS]
            plan.append((i, "time"))
    values = list(side.sql(f"SELECT {', '.join(aggregates)} FROM {source}").fetchone())
    stats: dict = {"rows": values.pop(0), "distinct": [0] * len(columns), "time": {}}
    for i, what in plan:
        if what == "distinct":
            stats["distinct"][i] = values.pop(0) or 0
        else:
            low, high = values.pop(0), values.pop(0)
            aligned = {unit: bool(values.pop(0)) for unit in TIME_UNITS}
            stats["time"][i] = (low, high, aligned)
    return stats


def _query(plan: _Plan, source: str, where: str = "") -> str:
    lines = [f"SELECT {', '.join(plan.select)}", f"FROM {source}"]
    if plan.sampled:
        lines.append(_SAMPLE)
    if where:
        lines.append(f"WHERE {where}")
    if plan.grouped:
        lines.append("GROUP BY ALL")
    if plan.order:
        lines.append(f"ORDER BY {', '.join(plan.order)}")
    if plan.limit is not None:
        lines.append(f"LIMIT {plan.limit}")
    return "\n".join(lines)


# -- Vega-Lite --------------------------------------------------------------------------


def _vega_lite(plan: _Plan, rows: list[dict]) -> dict:
    def channel(f: _Field) -> dict:
        return {"field": _vl_field(f.name), "type": f.type, "title": f.title, **f.extra}

    mark: dict = {"type": plan.chart["mark"], "tooltip": True}
    if plan.chart["mark"] == "line" and _markers(plan):
        mark["point"] = True
    encoding = {"x": channel(plan.x), "y": channel(plan.y)}
    if plan.color is not None:
        encoding["color"] = channel(plan.color)
    return {
        "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
        "data": {"values": rows},
        "mark": mark,
        "encoding": encoding,
        "width": "container",
        "height": 300,
    }


def _markers(plan: _Plan) -> bool:
    """Lines show their points while there are few of them (per line)."""
    lines = COLOR_CATEGORIES if plan.color is not None else 1
    return plan.limit is None and not plan.sampled and plan.rows <= MARKER_POINTS * lines


# -- helpers ------------------------------------------------------------------------------


def _choice(request: dict, key: str, allowed: tuple) -> str | None:
    value = request.get(key)
    if value is None:
        return None
    if value not in allowed:
        raise InvalidFilter(f"Unknown chart {key} {value!r}")
    return value


def _column(request: dict, key: str, allowed: list[int], columns: list[dict], numeric_only: bool = False) -> int | None:
    value = request.get(key)
    if value is None:
        return None
    try:
        index = int(value)
    except (TypeError, ValueError):
        raise InvalidFilter(f"Malformed chart {key}: {value!r}") from None
    if index not in allowed:
        name = columns[index]["name"] if 0 <= index < len(columns) else f"column {index + 1}"
        what = "a number column" if numeric_only else "a number, date or text column"
        raise InvalidFilter(f"{name} can't be charted on {key}: choose {what}.")
    return index


def _id_like(name: str) -> bool:
    """order_id, line_no, customerId: lower case for the suffixes, camel case as written."""
    return bool(_ID_NAME.search(name.lower()) or _ID_NAME.search(name))


def _unique(name: str, used: set[str]) -> str:
    candidate, n = name, 1
    while candidate.lower() in used:
        n += 1
        candidate = f"{name}_{n}"
    return candidate


def _json_value(value: object) -> object:
    """A value of the chart's data as JSON: times without a zone read as local times in the chart."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) < 2**53 else float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, decimal.Decimal):
        return float(value) if value.is_finite() else None
    if isinstance(value, dt.datetime):
        return value.replace(tzinfo=None).isoformat()
    if isinstance(value, dt.date):
        return dt.datetime.combine(value, dt.time()).isoformat()
    return str(value)


def _vl_field(name: str) -> str:
    """A column name as a Vega-Lite field, where dots and brackets would reach into nested values."""
    return re.sub(r"([.\[\]\\])", r"\\\1", name)


def _py_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _py_sql(query: str) -> str:
    """The query as a Python string literal, triple-quoted while it can be."""
    if '"""' not in query and not query.endswith('"'):
        if "\\" not in query:
            return f'"""\n{query}\n"""'
        if not query.endswith("\\"):
            return f'r"""\n{query}\n"""'
    return repr(query)
