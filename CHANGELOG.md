# Changelog

All notable changes to DuckExplorer are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Milestone 2, DuckDB UI parity (in progress).

### Added

- **Column Explorer**: the **Columns** button under a result shows each column's distribution (a
  histogram for numbers and dates, the most frequent values otherwise), its NULL share, distinct
  count and min/max/mean. The kernel computes the statistics in a few scans and caches them with
  the result.
- **Sorting**: click a column header to sort ascending, descending, then back to the query's
  order. DuckDB sorts the whole result in the kernel; the stored result and `df` keep the query's
  order.
- **Filtering**: right-click a cell to keep or exclude its value (or, for numbers and dates, keep
  values ≥ or ≤ it); right-click a header for NULL filters and sorting. The **Filter** button opens
  a `WHERE` box for any SQL condition on the result's columns. Filters show as removable chips,
  combine with each other and with the sort, and the footer counts the matching rows. The Column
  Explorer follows the filter, and clicking a histogram bar or a value filters to it.
- **Edit as SQL** turns the filter chips into the same condition in the `WHERE` box, to change it
  with `OR`, `IN` or `ILIKE`. **New cell** adds a SQL cell below with the cell's query wrapped in
  the filter and the grid's sort, and runs it.
- **Table summary**: click a table or view in the Databases view to open a panel beside the
  notebook with its Column Explorer, its rows, and the grid's sorting and filters. **New cell**
  writes `SELECT * FROM <table> WHERE …` into the notebook. Tables over 1,000,000 rows are
  summarized from a reservoir sample, which the panel says.
- **SQL completions** in notebook cells: table and view names from every attached database,
  temporary tables and the notebook's DataFrames; the columns of the tables a query reads
  (aliases, CTEs, subqueries, struct fields); DuckDB's functions and types; file names in
  `FROM '…'` and `read_*('…')`; `read_csv`'s named options; and parameter hints while typing a
  function's arguments.
- **`.sql` files**: **Ctrl+Enter** (or **Run** above a statement) runs the statement at the cursor
  or the selected statements; **Ctrl+Shift+Enter**, the editor title's Run button or **Run File** in
  the Explorer runs the whole file, stopping at the first error. The last statement's rows show in
  the **DuckDB Results** view in the bottom panel, with the notebook grid; **Insert query** writes
  the filtered, sorted query below the statement. Errors are underlined where DuckDB reports them.
  Files share the kernel session with notebooks, and completions work in them while the kernel
  runs.
- **Query History** view: every query run in a notebook SQL cell or a `.sql` file, by day, newest
  first, with when it ran, its rows (or what it did, or its error) and how long it took. **Run
  Again**, **Open in Editor**, **Run in Notebook**, **Go to Source**, **Copy Query**, **Remove from
  History** and **Search Query History**. The history is kept per workspace; queries that create
  secrets or set credentials are never kept.
- Settings: `duckexplorer.sqlFiles` (default on) and `duckexplorer.historySize` (default 500,
  0 stops recording).
- `npm run dev` builds the extension and opens an Extension Development Host on `samples/`.

### Fixed

- List types such as `INTEGER[]` were treated as numeric in the grid.
- The Column Explorer failed for a whole result when the mean of a `HUGEINT` or wide `DECIMAL`
  column overflowed; means are now `DOUBLE`.
- `TIMESTAMPTZ` histogram labels were in UTC while min/max used the session time zone.
- Restarting the kernel while it was starting hung for 60 seconds, then reported a bogus startup
  failure.
- A histogram-bar filter let in values outside the histogram's range once the filter it was made
  under was removed.

## [0.1.0] - 2026-10-25

Milestone 1.

### Added

- **Databases view** in the activity bar: attach `.duckdb` files (read-write, read-only, or a new
  file) and browse database → schema → table/view → column. Attached files are re-attached when
  the kernel restarts, and the first one becomes the default database.
- **DuckDB notebooks** (`*.duckbook`) with SQL and Python cells sharing one DuckDB session, run by
  a Python kernel (`python -m duckexplorer_kernel`) that talks JSON lines over stdio.
- A virtualized results grid that loads pages from the kernel as you scroll, with keyboard
  navigation, Ctrl+C and resizable columns.
- Every SQL result is a pandas DataFrame named `df` in Python (`-- name: sales` also keeps it as
  `sales`), SQL cells can query DataFrames by name, and Python cells get `con`, `sql("…")` and
  `display(obj)`.
- Chart output: Plotly figures render interactively and follow the VS Code theme;
  Matplotlib/Seaborn figures render as PNGs. A DataFrame or DuckDB relation as a Python cell's last
  expression renders as a grid.
- Relative paths resolve against the notebook's folder, and the notebook's Interrupt button stops
  a running cell.
- Commands: Add Database, Detach Database, Refresh, New DuckDB Notebook, Preview Table, Copy Name,
  Restart Kernel and Show Kernel Log.
- Settings: `duckexplorer.pythonPath`, `duckexplorer.pageSize` and `duckexplorer.maxPandasRows`.
