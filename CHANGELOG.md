# Changelog

All notable changes to DuckExplorer are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Milestone 3, in progress.

### Added

- **DuckDB 2.0 support**: the kernel works with duckdb 1.x and 2.x (2.0 needs Python 3.11 or
  later). The Install packages button installs `duckdb<3`, and with duckdb 3.0 or later the kernel
  says at startup that it needs 1.x or 2.x and offers to install it. With duckdb 2, completions show
  a table function's positional parameters by name (`read_csv(path)`), and New cell isn't available
  for a `PRAGMA`'s rows, since DuckDB 2 no longer gives the query a `PRAGMA` stands for.
- CI runs the tests with duckdb 1.x (Linux, Python 3.10) and 2.x (Linux and Windows, Python 3.13).

### Changed

- A statement whose only result says that it succeeded, such as `PRAGMA enable_profiling`, shows
  "Statement executed" in a notebook rather than an empty grid, as other statements do.

## [0.2.0] - 2026-11-07

Milestone 2, DuckDB UI parity.

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
- **Export**: the **Export** button under a result saves its rows to CSV, Parquet or Excel
  (`.xlsx`), filtered and sorted as the grid shows them; **Export…** on a table or view in the
  Databases view saves all of it. Excel files are written by DuckDB's `excel` extension, installed
  the first time, and are checked against a sheet's 1,048,575-row limit before anything is written.
- **Dropped files**: drop `.duckdb`/`.ddb`/`.db` files on the Databases view to attach them, and
  data files (`.csv`, `.tsv`, `.parquet`, `.json`, `.jsonl`, `.ndjson`, `.xlsx`, text formats also
  `.gz`/`.zst`) to open them as views in an in-memory `files` database and summarize them; **Open in
  DuckExplorer** in the Explorer does the same. Opened files come back after a kernel restart.
  Shift+drop into a SQL cell or `.sql` file writes SQL that reads the file by path.
- **Live cell output**: printed lines, `display()`, `plt.show()` and `fig.show()` appear while a
  cell runs, batched a few times a second; the saved notebook is as if they came at once. A cell's
  printed text is kept up to 1,000,000 characters.
- **Altair and Vega-Lite** output: Altair charts (including `chart.show()`) and anything that
  displays as Vega-Lite render with Vega-Lite in the VS Code theme. Vega loads with the first chart.
- **Chart view** ("Chart this") under every results grid: bars, lines, areas or a scatter of the
  rows the filter keeps, opening on a chart picked from the columns. DuckDB aggregates the data, so
  millions of rows draw a few hundred values. **New cell** keeps the chart as a Python cell (Altair,
  else Plotly) that draws it from the cell's query.
- Settings: `duckexplorer.sqlFiles` (default on) and `duckexplorer.historySize` (default 500,
  0 stops recording).
- `npm run dev` builds the extension and opens an Extension Development Host on `samples/`.
- CI on Windows and Linux (unit, kernel and VS Code integration tests), an MIT `LICENSE`, this
  changelog, and `npm run package` to build a `.vsix`.

### Fixed

- List types such as `INTEGER[]` were treated as numeric in the grid.
- The Column Explorer failed for a whole result when the mean of a `HUGEINT` or wide `DECIMAL`
  column overflowed; means are now `DOUBLE`.
- `TIMESTAMPTZ` histogram labels were in UTC while min/max used the session time zone.
- Restarting the kernel while it was starting hung for 60 seconds, then reported a bogus startup
  failure.
- A histogram-bar filter let in values outside the histogram's range once the filter it was made
  under was removed.
- With DuckDB 2.0 installed (what `pip install duckdb` gives since its release), most features
  failed one by one, since it changed the Python API the kernel uses. The kernel now needs duckdb
  1.x and says so when it starts, and the extension offers to install `duckdb<2`, as its Install
  packages button now does too. DuckDB 2.0 support is planned for milestone 3.
- Printing in a loop slowed down with the square of the output (300,000 lines took over a minute).
- The kernel kept running after VS Code went away while a cell was running.
- Detaching a database that was added through another name for its folder (an 8.3 short path such
  as `C:\Users\RUNNER~1`, a junction or a symlink) left it in the saved list, so it was attached
  again when the kernel restarted.

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
