# DuckExplorer

A DuckDB UI-style analysis workspace inside VS Code. Attach DuckDB databases, browse their
schemas, run SQL in notebooks, scroll through large results, and chart them with Python
(Plotly or Matplotlib) in the same notebook.

## Features (milestone 1)

- **Databases view** (activity bar → DuckExplorer): attach `.duckdb` files (read-write,
  read-only, or create new) and browse database → schema → table/view → column. Attached files
  are re-attached when the kernel restarts. The first attached file becomes the default database,
  like opening it with the DuckDB CLI.
- **DuckDB notebooks** (`*.duckbook`): SQL and Python cells in one shared session.
  - SQL results appear in a virtualized grid that loads pages from the kernel as you scroll
    (hundreds of thousands of rows are fine). Click a cell, then use the arrow keys or Ctrl+C.
    Drag a header edge to resize a column. Click a header to sort by that column (ascending,
    descending, then back to the query's order); DuckDB sorts the whole result in the kernel.
  - **Filtering**: right-click a cell to keep or exclude its value (or, for numbers and dates,
    keep values ≥ or ≤ it); right-click a header for NULL filters and sorting. The **Filter**
    button under a result opens a `WHERE` box for any SQL condition on the result's columns
    (`amount > 100 AND status = 'open'`, Enter to apply, Shift+Enter for a new line). Filters
    show as removable chips and combine with each other and with the sort; the footer counts
    the matching rows.
  - **Edit as SQL** turns the chips into the same condition in the `WHERE` box
    (`status = 'shipped' AND order_date BETWEEN '2024-01-01' AND '2024-01-19'`), so you can
    change it in ways chips can't (`OR`, `IN`, `ILIKE`). **New cell** adds a SQL cell below with
    the cell's query wrapped in that filter and the grid's sort, and runs it, so the filtered
    result is kept with the notebook.
  - **Column Explorer**: the **Columns** button under a result shows every column's distribution
    (a histogram for numbers and dates, the most frequent values otherwise), its NULL share,
    distinct count, and min/max/mean, for the rows the filter keeps. Click a histogram bar or a
    value to filter to it (bars re-bin, so you can drill in), or elsewhere on a column's line to
    jump to that column in the rows.
  - Every SQL result is available in Python as a pandas DataFrame named `df`. Start a SQL cell
    with `-- name: sales` to also keep it as `sales`.
  - SQL cells can query DataFrames created in Python cells by name.
  - Python helpers: `con` (the DuckDB connection), `sql("…")` → DataFrame, `display(obj)`.
  - Charts: Plotly figures render interactively; Matplotlib/Seaborn figures render as PNGs
    (`plt.show()` or the end of the cell). Plotly follows the VS Code light/dark theme.
  - A DataFrame or DuckDB relation as the last expression of a Python cell renders as a grid.
  - Relative paths (`ATTACH 'x.duckdb'`, `read_csv('data.csv')`) resolve against the notebook's
    folder. Stop runs with the notebook's Interrupt button.
- **Preview Table** from the tree adds and runs `SELECT * … LIMIT 100` in the active notebook.

## Requirements

- VS Code 1.100+
- Python 3.10+ with `duckdb` and `pyarrow` (required), and `pandas`, `matplotlib`, `plotly`
  (optional, for DataFrames and charts):

  ```bash
  python -m pip install duckdb pyarrow pandas matplotlib plotly
  ```

  The kernel uses the `duckexplorer.pythonPath` setting, else the interpreter selected in the
  Python extension, else `python` on PATH. If a package is missing, DuckExplorer offers to
  install it.

## Run it from source

```bash
npm install
npm run compile
python samples/make_sample_db.py
```

Then press **F5** ("Run DuckExplorer") to open an Extension Development Host on the `samples`
folder, open `demo.duckbook` and choose **Run All**.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `duckexplorer.pythonPath` | empty | Interpreter for the kernel |
| `duckexplorer.pageSize` | 200 | Rows per page in the results grid |
| `duckexplorer.maxPandasRows` | 1,000,000 | Row cap when a SQL result is turned into a DataFrame (0 = never) |

## How it works

```
VS Code extension host (TypeScript)          Python kernel (python -m duckexplorer_kernel)
 ├─ Databases tree view ──┐                   ├─ Session: duckdb.connect(':memory:') + ATTACH files
 ├─ .duckbook serializer  │  JSON lines        ├─ Result store: recent results kept as Arrow tables
 ├─ Notebook controller  ─┼─ over stdio  ────► ├─ SQL cells → first page; more pages on request
 └─ Renderer messaging  ──┘                    └─ Python cells: per-notebook namespaces, output capture
Notebook renderer (webview): results grid + Plotly (loaded on demand)
```

- One kernel process owns the DuckDB connection, so SQL and Python share one session, and
  DuckDB's one-writer file lock is never contended between them.
- Result pages are rendered with DuckDB's own `VARCHAR` casts, so values look exactly as in the
  DuckDB CLI. Page, sort, column-statistics and schema requests run on a second cursor, so they
  don't wait behind a running cell.
- A sorted or filtered grid pages through row numbers that DuckDB selected and ordered once
  (NULLs last, ties in query order); the stored result and the `df` DataFrame keep every row in
  the query's order. Value filters compare the text the grid shows, so they match exactly what
  you clicked; `≥`/`≤` compare typed values, and a histogram-bar filter reuses the expression
  that counted the bar. Column statistics are computed in a few scans when the Columns view
  opens, then cached with the result for that filter.
- Written as SQL, value filters become typed comparisons (DOUBLE values stay quoted, because
  DuckDB reads a bare `0.30000000000000004` as a DECIMAL and converts it inexactly) and bars
  become ranges. Integer and DATE bars are exact; a DOUBLE or timestamp value right on a bar's
  edge can land on the other side in SQL, and the grid says so when the row count changes.
  The new cell reruns only the cell's last statement, as a subquery.
- `.duckbook` files are JSON. Table outputs store only their first page; after reopening a file
  or restarting the kernel, run the cell again to scroll further.

Source layout: `src/kernel` (process + protocol), `src/explorer` (tree view), `src/notebook`
(serializer + controller), `src/renderer` (grid, filter bar and menus, Column Explorer, Plotly), `python/duckexplorer_kernel`
(kernel), `samples` (demo database builder + notebook).

## Tests

```bash
npm run test:python   # kernel: pytest
npm test              # VS Code integration test (downloads a test build of VS Code once)
```

## Roadmap

- **Milestone 2, DuckDB UI parity:** done so far: Column Explorer, sorting and filtering in the
  grid. Next: table summary on click, schema-aware SQL autocomplete, running `.sql` files, query
  history, export (CSV/Parquet/Excel), drag-and-drop data files, a "Chart this" builder,
  Altair/Vega-Lite output, streaming cell output.
- **Milestone 3:** Instant SQL-style live preview with CTE inspection; S3/HTTP secrets and
  MotherDuck; text-to-SQL; export notebooks to HTML or `.ipynb`.
