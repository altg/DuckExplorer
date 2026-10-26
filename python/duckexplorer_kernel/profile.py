"""Column Explorer statistics for a stored result: nulls, distinct counts, histograms, top values."""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass

import duckdb
import pyarrow as pa

HISTOGRAM_BINS = 20
TOP_VALUES = 10
# Above this many rows distinct counts use HyperLogLog (approx_count_distinct) instead of an exact count.
EXACT_DISTINCT_ROWS = 5_000_000

# Anchored at both ends: INTEGER[] is a list, not a number.
_NUMERIC = re.compile(
    r"^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL"
    r"|(DECIMAL|NUMERIC)(\(\d+,\s*\d+\))?)$"
)
_INTEGER = re.compile(r"^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$")
_FLOATING = re.compile(r"^(FLOAT|DOUBLE|REAL)$")
_TEMPORAL = re.compile(r"^(DATE|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE)$")
_EPOCH = dt.datetime(1970, 1, 1)
_SECOND_US = 1_000_000
_DAY_US = 86_400 * _SECOND_US


def column_kind(type_name: str) -> str:
    t = type_name.upper()
    if _NUMERIC.match(t):
        return "numeric"
    if _TEMPORAL.match(t):
        return "temporal"
    if t == "BOOLEAN":
        return "boolean"
    if t in ("VARCHAR", "UUID") or t.startswith("ENUM("):
        return "text"
    return "other"


def profile(side: duckdb.DuckDBPyConnection, scan: pa.Table, columns: list[dict]) -> dict:
    """Per-column statistics for `scan` (columns named c0, c1, …). Call with the side lock held."""
    rel = side.from_arrow(scan)
    rows = scan.num_rows
    kinds = [column_kind(c["type"]) for c in columns]
    profiles: list[dict] = [
        {"name": c["name"], "type": c["type"], "kind": kind, "nulls": 0, "distinct": 0}
        for c, kind in zip(columns, kinds)
    ]
    if rows == 0 or not columns:
        return {"rowCount": rows, "columns": profiles}

    # One scan for the per-column summary values.
    approx = rows > EXACT_DISTINCT_ROWS
    aggregates: list[str] = []
    for i, (column, kind) in enumerate(zip(columns, kinds)):
        c = f"c{i}"
        aggregates += [f"count({c})", f"approx_count_distinct({c})" if approx else f"count(DISTINCT {c})"]
        if kind in ("numeric", "temporal"):
            point = _point(i, kind, column["type"])
            aggregates += [
                f"min({c})::VARCHAR",
                f"max({c})::VARCHAR",
                f"min({point})",
                f"max({point})",
                # Averaged as DOUBLE: avg() of a HUGEINT or wide DECIMAL can overflow its exact sum.
                f"avg({c}::DOUBLE)::VARCHAR" if kind == "numeric" else "NULL",
            ]
    summary = list(rel.aggregate(", ".join(aggregates)).fetchone())

    ranges: dict[int, _Bins] = {}
    for i, kind in enumerate(kinds):
        p = profiles[i]
        non_null, distinct = summary.pop(0), summary.pop(0)
        p["nulls"] = rows - non_null
        p["distinct"] = min(distinct, non_null)
        if approx:
            p["distinctApprox"] = True
        if kind in ("numeric", "temporal"):
            p["min"], p["max"], low, high, mean = summary[:5]
            del summary[:5]
            if mean is not None:
                p["mean"] = _format_mean(mean)
            if low is not None and high is not None:
                ranges[i] = _bins_for(low, high, columns[i]["type"], kind)

    # One scan for every histogram.
    if ranges:
        expressions = [
            f"histogram({bucket_expression(i, kinds[i], columns[i]['type'], bins.low, bins.width, bins.count)})"
            for i, bins in ranges.items()
        ]
        counts = rel.aggregate(", ".join(expressions)).fetchone()
        for (i, bins), histogram in zip(ranges.items(), counts):
            histogram = histogram or {}
            type_name = columns[i]["type"].upper()
            bounds = [value for b in range(bins.count) for value in bins.bounds(b)]
            if type_name == "TIMESTAMP WITH TIME ZONE":
                labels = _session_time_labels(side, bounds)
            else:
                labels = [_label(value, kinds[i], type_name == "DATE") for value in bounds]
            profiles[i]["histogram"] = [
                {"start": labels[2 * b], "end": labels[2 * b + 1], "count": int(histogram.get(b, 0))}
                for b in range(bins.count)
            ]
            # Lets the grid filter to one bar with the same bucket expression (see filters.py).
            profiles[i]["bins"] = {"low": bins.low, "width": bins.width, "count": bins.count}

    # Top values for everything that isn't binned, one GROUP BY per column.
    for i, kind in enumerate(kinds):
        p = profiles[i]
        non_null = rows - p["nulls"]
        if kind in ("numeric", "temporal") or non_null == 0:
            continue
        if p["distinct"] == non_null and non_null > TOP_VALUES and not approx:
            p["unique"] = True  # e.g. an id column: every count would be 1
            continue
        c = f"c{i}"
        top = rel.filter(f"{c} IS NOT NULL").aggregate(f"{c}::VARCHAR AS v, count(*) AS n", f"{c}::VARCHAR")
        values = top.order("n DESC, v").limit(TOP_VALUES).fetchall()
        p["top"] = [{"value": value, "count": int(n)} for value, n in values]
        p["otherCount"] = non_null - sum(n for _, n in values)
    return {"rowCount": rows, "columns": profiles}


def _point(i: int, kind: str, type_name: str) -> str:
    """Column i as a DOUBLE (numbers) or epoch microseconds (dates, timestamps) for binning.

    NULL for NaN and ±inf, which can't be placed in a bar. epoch_us() is already NULL for ±infinity.
    """
    c = f"c{i}"
    if kind == "temporal":
        return f"epoch_us({c})"
    if _FLOATING.match(type_name.upper()):
        return f"CASE WHEN isfinite({c}) THEN {c}::DOUBLE END"
    return f"{c}::DOUBLE"


def bucket_expression(i: int, kind: str, type_name: str, low: float, width: float, count: int) -> str:
    """The histogram bar (0 … count-1) holding column i's value; NULL for NULL, NaN and ±inf."""
    point = _point(i, kind, type_name)
    if count == 1:
        bucket = "0"
    else:
        bucket = f"least(greatest(floor(({point} - ({low!r})) / {width!r}), 0), {count - 1})"
    # greatest() and least() skip NULLs, so NULLs (and NaN) are excluded explicitly.
    return f"(CASE WHEN {point} IS NOT NULL THEN {bucket}::INTEGER END)"


@dataclass
class _Bins:
    low: float
    high: float
    width: float
    count: int
    # > 0 when values are whole multiples of it (integers, days): bars are then inclusive ranges.
    unit: float = 0.0

    def bounds(self, bar: int) -> tuple[float, float]:
        if self.count == 1:
            return self.low, self.high
        start = self.low + bar * self.width
        end = start + self.width - self.unit if self.unit else start + self.width
        return start, min(end, self.high)


def _bins_for(low: float, high: float, type_name: str, kind: str) -> _Bins:
    t = type_name.upper()
    unit = 1.0 if _INTEGER.match(t) else _DAY_US if t == "DATE" else 0.0
    # One bar when the range is empty or too wide for a finite DOUBLE (e.g. -1e308 … 1e308).
    if high <= low or not math.isfinite(high - low):
        return _Bins(low, high, 0.0, 1, unit)
    if unit:
        width = math.ceil((high - low + unit) / unit / HISTOGRAM_BINS) * unit
        return _Bins(low, high, width, math.ceil((high - low + unit) / width), unit)
    width = (high - low) / HISTOGRAM_BINS
    if kind == "temporal" and width >= _SECOND_US:
        width = math.ceil(width / _SECOND_US) * _SECOND_US
    return _Bins(low, high, width, min(HISTOGRAM_BINS, math.ceil((high - low) / width)))


def _label(value: float, kind: str, date_only: bool) -> str:
    if kind == "temporal":
        try:
            moment = _EPOCH + dt.timedelta(microseconds=round(value))
        except OverflowError:  # beyond year 9999
            return f"{value:.6g} µs"
        if date_only:
            return moment.date().isoformat()
        return moment.isoformat(sep=" ", timespec="seconds" if moment.microsecond == 0 else "milliseconds")
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.6g}"


def _session_time_labels(side: duckdb.DuckDBPyConnection, values: list[float]) -> list[str]:
    """Epoch microseconds as TIMESTAMPTZ text in the session's time zone, as min and max show them."""
    labels = side.execute(
        "SELECT list_transform($v, x -> (make_timestamp(round(x)::BIGINT) AT TIME ZONE 'UTC')::VARCHAR)",
        {"v": values},
    ).fetchone()[0]
    return list(labels)


def _format_mean(text: str) -> str:
    try:
        value = float(text)
    except ValueError:
        return text
    if not math.isfinite(value):
        return text
    return _label(value, "numeric", False)
