"""Builds samples/demo.duckdb: a deterministic synthetic shop dataset for trying DuckExplorer.

    python samples/make_sample_db.py [output-path]
"""

import sys
from pathlib import Path

import duckdb

SQL = """
-- Deterministic pseudo-random integer in [0, n) for a row (no random(): output is reproducible).
CREATE TEMP MACRO rnd(seed, salt, n) AS (hash(seed * 1000003 + salt) % n)::BIGINT;

CREATE TABLE products AS
WITH categories AS (
    SELECT * FROM (VALUES
        (0, 'Electronics', 180), (1, 'Home', 70), (2, 'Garden', 45), (3, 'Toys', 30),
        (4, 'Sports', 60), (5, 'Books', 18), (6, 'Beauty', 25), (7, 'Grocery', 9)
    ) AS t(idx, category, base_price)
)
SELECT
    range + 1 AS product_id,
    c.category || ' ' || ['Basic', 'Plus', 'Pro', 'Max', 'Mini', 'Classic'][rnd(range, 1, 6) + 1]
        || ' ' || (range + 1) AS name,
    c.category,
    round(c.base_price * (0.5 + rnd(range, 2, 1000) / 1000.0), 2)::DECIMAL(10, 2) AS unit_price
FROM range(120)
JOIN categories c ON c.idx = range % 8;

CREATE TABLE customers AS
WITH countries AS (
    SELECT row_number() OVER () - 1 AS idx, * FROM (VALUES
        ('Germany', 'EMEA'), ('France', 'EMEA'), ('United Kingdom', 'EMEA'), ('Saudi Arabia', 'EMEA'),
        ('Nigeria', 'EMEA'), ('United States', 'Americas'), ('Canada', 'Americas'), ('Brazil', 'Americas'),
        ('Mexico', 'Americas'), ('Japan', 'APAC'), ('India', 'APAC'), ('Australia', 'APAC')
    ) AS t(country, region)
)
SELECT
    range + 1 AS customer_id,
    ['Ava', 'Noah', 'Mia', 'Liam', 'Zara', 'Omar', 'Lena', 'Yusuf', 'Sofia', 'Ethan', 'Amira', 'Kenji'][rnd(range, 3, 12) + 1]
        || ' ' ||
    ['Khan', 'Smith', 'Garcia', 'Müller', 'Okafor', 'Tanaka', 'Silva', 'Martin', 'Patel', 'Haddad', 'Nguyen', 'Brown'][rnd(range, 4, 12) + 1]
        AS name,
    c.country,
    c.region,
    CASE WHEN rnd(range, 5, 10) < 6 THEN 'Consumer' WHEN rnd(range, 5, 10) < 9 THEN 'Small Business' ELSE 'Enterprise' END AS segment,
    DATE '2021-01-01' + rnd(range, 6, 1460)::INTEGER AS signup_date
FROM range(5000)
JOIN countries c ON c.idx = rnd(range, 7, 12);

CREATE TABLE orders AS
SELECT
    range + 1 AS order_id,
    rnd(range, 10, 5000) + 1 AS customer_id,
    -- More orders over time (sqrt skew) plus a December peak.
    CASE WHEN rnd(range, 11, 100) < 8
         THEN make_date(2023 + rnd(range, 12, 2)::INTEGER, 12, 1 + rnd(range, 13, 31)::INTEGER)
         ELSE DATE '2023-01-01' + (sqrt(rnd(range, 14, 1000000) / 1000000.0) * 730)::INTEGER
    END AS order_date,
    CASE WHEN rnd(range, 15, 100) < 85 THEN 'delivered'
         WHEN rnd(range, 15, 100) < 92 THEN 'shipped'
         WHEN rnd(range, 15, 100) < 97 THEN 'returned'
         ELSE 'cancelled' END AS status,
    ['web', 'web', 'mobile', 'mobile', 'store', 'partner'][rnd(range, 16, 6) + 1] AS channel
FROM range(120000);

CREATE TABLE order_items AS
WITH lines AS (
    SELECT order_id, unnest(range(1 + rnd(order_id, 20, 4))) + 1 AS line_no FROM orders
)
SELECT
    l.order_id,
    l.line_no,
    p.product_id,
    1 + rnd(l.order_id * 10 + l.line_no, 22, 4) AS quantity,
    p.unit_price,
    CASE rnd(l.order_id * 10 + l.line_no, 23, 10) WHEN 0 THEN 0.20 WHEN 1 THEN 0.10 ELSE 0 END::DECIMAL(3, 2) AS discount
FROM lines l
JOIN products p ON p.product_id = rnd(l.order_id * 10 + l.line_no, 21, 120) + 1
ORDER BY l.order_id, l.line_no;

CREATE VIEW order_totals AS
SELECT o.order_id, o.customer_id, o.order_date, o.status, o.channel,
       count(*) AS items,
       round(sum(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS revenue
FROM orders o
JOIN order_items oi USING (order_id)
GROUP BY ALL;

COMMENT ON TABLE orders IS 'One row per order (synthetic data, 2023-2024)';
COMMENT ON TABLE order_items IS 'Order lines; revenue = quantity * unit_price * (1 - discount)';
"""


def build(path: Path) -> None:
    path.unlink(missing_ok=True)
    Path(str(path) + ".wal").unlink(missing_ok=True)
    con = duckdb.connect(str(path))
    try:
        con.execute(SQL)
        counts = con.execute(
            "SELECT table_name, estimated_size FROM duckdb_tables() ORDER BY table_name"
        ).fetchall()
    finally:
        con.close()
    print(f"Wrote {path}")
    for table, rows in counts:
        print(f"  {table:<12} {rows:>9,} rows")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("demo.duckdb")
    build(target.resolve())
