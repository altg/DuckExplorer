-- DuckExplorer runs .sql files too. Ctrl+Enter (or Run above a statement) runs the statement at
-- the cursor, or the selected ones; Ctrl+Shift+Enter (or the editor's Run button) runs the file.
-- The last statement's rows show in the DuckDB Results view below; an error is underlined here.
-- Statements share the session with notebooks: tables made here can be queried there.

-- Relative paths resolve against this file's folder.
ATTACH IF NOT EXISTS 'demo.duckdb' AS demo (READ_ONLY);
USE demo;

-- Orders per channel and status
SELECT channel, status, count(*) AS orders, round(sum(revenue), 2) AS revenue
FROM order_totals
GROUP BY ALL
ORDER BY channel, orders DESC;

-- The best customers, kept as a temporary table for later queries (and notebooks)
CREATE OR REPLACE TEMP TABLE top_customers AS
SELECT c.customer_id, c.name, c.country, c.segment, sum(t.revenue) AS revenue
FROM customers c
JOIN order_totals t USING (customer_id)
WHERE t.status <> 'cancelled'
GROUP BY ALL
ORDER BY revenue DESC
LIMIT 100;

SELECT country, count(*) AS customers, round(avg(revenue), 2) AS avg_revenue
FROM top_customers
GROUP BY country
ORDER BY customers DESC;
