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
  - **SQL completions**: table and view names after `FROM` and `JOIN` (from every attached
    database, plus the notebook's DataFrames), the columns of the tables the query reads (`o.`
    lists the columns of the table aliased `o`, and CTEs and subqueries count too), struct
    fields, DuckDB's functions, types after `::`, and file names in `FROM '…'` or
    `read_parquet('…')`, relative to the notebook's folder. Typing a function's arguments shows
    its parameters, and `read_csv('…', ` lists its named options. Keywords follow the cell's case.
  - Every SQL result is available in Python as a pandas DataFrame named `df`. Start a SQL cell
    with `-- name: sales` to also keep it as `sales`.
  - SQL cells can query DataFrames created in Python cells by name.
  - Python helpers: `con` (the DuckDB connection), `sql("…")` → DataFrame, `display(obj)`.
  - Charts: Plotly figures render interactively; Matplotlib/Seaborn figures render as PNGs
    (`plt.show()` or the end of the cell). Plotly follows the VS Code light/dark theme.
  - A DataFrame or DuckDB relation as the last expression of a Python cell renders as a grid.
  - Relative paths (`ATTACH 'x.duckdb'`, `read_csv('data.csv')`) resolve against the notebook's
    folder. Stop runs with the notebook's Interrupt button.
- **Table summary**: click a table or view in the Databases view (the arrow still lists its
  columns) to open its summary beside the notebook: the Column Explorer for the whole relation,
  its rows, and the same sorting and filters as under a notebook cell. **New cell** there writes
  `SELECT * FROM <table> WHERE …` into the notebook. Tables over 1,000,000 rows are summarized
  from a random sample, which the panel says. **Refresh** reads the rows again.
- **Preview Table** from the tree adds and runs `SELECT * … LIMIT 100` in the active notebook.
- **.sql files**: **Ctrl+Enter** (or **Run** above a statement) runs the statement at the cursor,
  or the selected statements; **Ctrl+Shift+Enter** (or the Run button in the editor title, or
  **Run File** on a `.sql` file in the Explorer) runs the whole file, stopping at the first error.
  The last statement's rows show in the **DuckDB Results** view in the bottom panel, with the same
  grid as a notebook cell (sorting, filters, Column Explorer); its **Insert query** writes the
  filtered, sorted query below the statement and runs it. Statements without rows say what they
  did (`3 rows inserted`). An error is underlined where DuckDB says it is. Files share the session
  with notebooks, so a temporary table made in one is visible in the other, and relative paths
  resolve against the file's folder. Completions work as in notebook cells once the kernel is
  running (a `.sql` file alone doesn't start it). Turn all of this off with `duckexplorer.sqlFiles`.
- **Query History** (in the DuckExplorer view, below Databases): every query run in a notebook SQL
  cell or a `.sql` file, by day, newest first, with when it ran, how many rows it returned (or what
  it did, or its error) and how long it took. Hover over one to read all of it. Click it to open it
  in a read-only editor, where **Run** (or Ctrl+Enter) runs it again, in the folder it first ran in,
  so relative paths still work. **Run Again** does that in one click; **Open in Editor** copies it
  into a new editor to change; **Run in Notebook** adds it to the active notebook and runs it; **Go
  to Source** selects it in its cell or file (where it is now, if the file changed); Delete removes
  it (or a day's queries, after asking). **Search** in the view's title bar searches every query. The
  history is kept per workspace, 500 queries by default (`duckexplorer.historySize`). Queries that
  create secrets or set credentials (`CREATE SECRET`, `SET s3_secret_access_key = …`, a `password=`
  or `token=` in a connection string, `user:password@` or a SAS `sig=` in a URL) are not kept.

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
folder, open `demo.duckbook` and choose **Run All**, or open `demo.sql` and press Ctrl+Shift+Enter.

From a terminal, `npm run dev` builds and opens the same window without the debugger (run it
again to rebuild and reload). It passes absolute paths: `code --extensionDevelopmentPath=.`
doesn't work, because the `code` command reads a relative path from the root of the drive.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `duckexplorer.pythonPath` | empty | Interpreter for the kernel |
| `duckexplorer.pageSize` | 200 | Rows per page in the results grid |
| `duckexplorer.maxPandasRows` | 1,000,000 | Row cap when a SQL result is turned into a DataFrame (0 = never) |
| `duckexplorer.sqlFiles` | true | Run buttons, Ctrl+Enter and completions in `.sql` files |
| `duckexplorer.historySize` | 500 | Queries kept in each workspace's Query History (0 = don't record) |

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
  DuckDB CLI. Page, sort, filter, column-statistics, schema, completion and table-summary
  requests run on a second cursor, so they don't wait behind a running cell.
- A table summary loads the relation (or a 1,000,000-row reservoir sample) as a stored result,
  like a query's, so the summary panel reuses the notebook grid and Column Explorer. The panel
  is a webview that sends the grid's requests through the extension to the kernel.
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
- Completions read the cell's SQL with a tokenizer rather than a parser, so half-typed SQL
  still works. They find the query's `FROM` clause (before or after the cursor), its aliases,
  CTEs and subqueries, and look the names up in a catalog the kernel sends: the schema
  (including temporary tables, which only the main connection can see, so the kernel records
  them after each cell), the notebook's DataFrames, and `duckdb_functions()`. The catalog is
  reloaded at the next completion after a cell runs. The function list (about 900 functions) is
  sent again only when it changes (`LOAD`, `CREATE MACRO`).
- A `.sql` file is split into statements with the same tokenizer, so a `;` in a string or comment
  doesn't end one. The kernel runs them one at a time on the notebooks' connection with
  `execute()` (the relation API that SQL cells use drops the position of binder errors) and reads
  the position from the `LINE n: …` excerpt in DuckDB's message, counting wide characters as
  two columns, as DuckDB does.
- The query history is kept by the extension in VS Code's workspace state, not by the kernel, so it
  outlives kernel restarts. A notebook entry is the cell's SQL; a `.sql` entry is the statements that
  ran, as written, with what was between them. An entry opens as a read-only virtual document
  (`duckexplorer-history:`) that the `.sql` runner treats like a file, except that **Insert query**
  puts the new query in a new editor. Go to Source looks for the query's text in its file (the copy
  nearest to where it ran) or for a cell with that text.
- `.duckbook` files are JSON. Table outputs store only their first page; after reopening a file
  or restarting the kernel, run the cell again to scroll further.

Source layout: `src/kernel` (process + protocol), `src/explorer` (tree view, summary panel),
`src/notebook` (serializer, controller, grid requests), `src/sql` (SQL tokenizer, cursor
context, completions and parameter hints; running `.sql` files and their results view),
`src/history` (query history: entries, store, view),
`src/renderer` (grid, filter bar and menus, Column Explorer, Plotly, the pages of the summary
panel and results view), `python/duckexplorer_kernel` (kernel), `samples` (demo database
builder, notebook and `.sql` file).

## Tests

```bash
npm run test:python   # kernel: pytest
npm run test:unit     # SQL completion context, statement splitting, history entries: mocha, without VS Code
npm test              # VS Code integration test (downloads a test build of VS Code once)
```

The integration test opens `samples/` and needs `samples/demo.duckdb` (`python samples/make_sample_db.py`).
CI (`.github/workflows/ci.yml`) runs all three on Windows and Linux.

## Package

```bash
npm run package   # duckexplorer-<version>.vsix: a minified build, the Python kernel, README, CHANGELOG, LICENSE
```

## Roadmap

- **Milestone 2, DuckDB UI parity:** done so far: Column Explorer, sorting and filtering in the
  grid (with Edit as SQL and New cell), table summary on click, schema-aware SQL completions,
  running `.sql` files, query history. Next: export (CSV/Parquet/Excel), drag-and-drop data
  files, a "Chart this" builder, Altair/Vega-Lite output, streaming cell output.
- **Milestone 3:** Instant SQL-style live preview with CTE inspection; S3/HTTP secrets and
  MotherDuck; text-to-SQL; export notebooks to HTML or `.ipynb`.
