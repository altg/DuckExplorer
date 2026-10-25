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
    Drag a header edge to resize a column.
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
  DuckDB CLI. Page and schema requests run on a second cursor, so they don't wait behind a
  running cell.
- `.duckbook` files are JSON. Table outputs store only their first page; after reopening a file
  or restarting the kernel, run the cell again to scroll further.

Source layout: `src/kernel` (process + protocol), `src/explorer` (tree view), `src/notebook`
(serializer + controller), `src/renderer` (grid + Plotly), `python/duckexplorer_kernel`
(kernel), `samples` (demo database builder + notebook).

## Tests

```bash
npm run test:python   # kernel: pytest
npm test              # VS Code integration test (downloads a test build of VS Code once)
```

## Roadmap

- **Milestone 2, DuckDB UI parity:** Column Explorer (histograms, null %, distinct counts, top
  values per column), table summary on click, sort/filter in the grid, schema-aware SQL
  autocomplete, running `.sql` files, query history, export (CSV/Parquet/Excel), drag-and-drop
  data files, a "Chart this" builder, Altair/Vega-Lite output, streaming cell output.
- **Milestone 3:** Instant SQL-style live preview with CTE inspection; S3/HTTP secrets and
  MotherDuck; text-to-SQL; export notebooks to HTML or `.ipynb`.
