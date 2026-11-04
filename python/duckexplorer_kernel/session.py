"""The DuckDB connection owned by the kernel: attached databases and catalog introspection."""

from __future__ import annotations

import os
import re
import threading

import duckdb

# Schemas DuckDB creates in every database that are noise in a schema browser.
_HIDDEN_SCHEMAS = ("information_schema", "pg_catalog")
# The in-memory database that holds a view for each data file opened in the Databases view.
FILES_DATABASE = "files"
_RESERVED_ALIASES = {"memory", "system", "temp", "main", FILES_DATABASE}
# Compression a text file's name may end with, after its format.
_COMPRESSION = (".gz", ".zst")


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _file_stem(path: str) -> str:
    """`sales` for sales.csv and sales.csv.gz."""
    name = os.path.basename(path)
    if name.lower().endswith(_COMPRESSION):
        name = os.path.splitext(name)[0]
    return os.path.splitext(name)[0]


class Session:
    """Owns the main connection (used by the executing cell) and a side cursor.

    The side cursor serves catalog and paging requests from a second thread so the
    schema tree and results grid stay responsive while a cell is running.
    """

    def __init__(self, database: str = ":memory:") -> None:
        self.con = duckdb.connect(database)
        self.con.execute("SET enable_progress_bar = false")
        # Lets sql() inside Python cells see DataFrames defined in the calling frames.
        self.con.execute("SET python_scan_all_frames = true")
        self.side = self.con.cursor()
        self.side_lock = threading.Lock()
        self.current_database = self.current_schema = ""
        # Temporary tables and views belong to the connection that made them: the side cursor
        # can't list the main connection's, so they are read here, on the main thread.
        self.temp_relations: list[dict] = []
        self.refresh_current_database()

    def refresh_current_database(self) -> str:
        """Call on the main thread after anything that may have run USE or made temporary tables."""
        self.current_database, self.current_schema = self.con.execute(
            "SELECT current_database(), current_schema()"
        ).fetchone()
        self.temp_relations = self._read_temp_relations()
        return self.current_database

    def _read_temp_relations(self) -> list[dict]:
        columns = self.con.execute(
            """
            SELECT table_name, column_name, data_type, is_nullable
            FROM duckdb_columns()
            WHERE database_name = 'temp'
            ORDER BY table_name, column_index
            """
        ).fetchall()
        if not columns:
            return []
        views = self.con.execute("SELECT view_name FROM duckdb_views() WHERE database_name = 'temp'").fetchall()
        view_names = {row[0] for row in views}
        relations: dict[str, dict] = {}
        for name, column, data_type, nullable in columns:
            kind = "view" if name in view_names else "table"
            relation = relations.setdefault(
                name, {"name": name, "kind": kind, "rowEstimate": None, "comment": None, "columns": []}
            )
            relation["columns"].append({"name": column, "type": data_type, "nullable": bool(nullable)})
        return list(relations.values())

    # -- attach / detach -----------------------------------------------------------

    def attach(self, path: str, alias: str | None = None, read_only: bool = False) -> str:
        path = os.path.abspath(path)
        existing = self._alias_for_path(path)
        if existing:
            return existing
        alias = alias or self._unique_alias(path)
        options = " (READ_ONLY)" if read_only else ""
        self.con.execute(f"ATTACH {quote_literal(path)} AS {quote_ident(alias)}{options}")
        # Like opening a file with the DuckDB CLI: the first attached file becomes the default.
        if self.refresh_current_database() == "memory":
            self.con.execute(f"USE {quote_ident(alias)}")
            self.refresh_current_database()
        return alias

    def detach(self, alias: str) -> None:
        if self.refresh_current_database() == alias:
            self.con.execute("USE memory")
        self.con.execute(f"DETACH {quote_ident(alias)}")
        self.refresh_current_database()

    # -- data files -----------------------------------------------------------------

    def open_file(self, path: str, name: str | None = None) -> str:
        """A data file (CSV, Parquet, JSON, Excel) as a view in the in-memory `files` database, named
        after the file (or `name`, when it was open before a restart); returns the view's name. A file
        that is open already keeps its view. The view's comment is the file's path."""
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"No such file: {path}")
        self.con.execute(f"ATTACH IF NOT EXISTS ':memory:' AS {quote_ident(FILES_DATABASE)}")
        (db_path,) = self.con.execute(
            "SELECT path FROM duckdb_databases() WHERE database_name = $db", {"db": FILES_DATABASE}
        ).fetchone()
        if db_path:
            raise ValueError(
                f'A database attached as "{FILES_DATABASE}" ({db_path}) is in the way: detach it to open data files.'
            )
        views = self._file_views()
        wanted = os.path.normcase(path)
        for view, view_path in views.items():
            if view_path and os.path.normcase(os.path.abspath(view_path)) == wanted:
                return view
        name = self._unique_name(name or _file_stem(path), {view.lower() for view in views} | self._file_tables())
        qualified = f"{quote_ident(FILES_DATABASE)}.main.{quote_ident(name)}"
        # DuckDB picks the reader by the file's extension, and reads the file again for each query.
        self.con.execute(f"CREATE VIEW {qualified} AS SELECT * FROM {quote_literal(path)}")
        self.con.execute(f"COMMENT ON VIEW {qualified} IS {quote_literal(path)}")
        return name

    def close_file(self, name: str) -> None:
        self.con.execute(f"DROP VIEW IF EXISTS {quote_ident(FILES_DATABASE)}.main.{quote_ident(name)}")

    def _file_views(self) -> dict[str, str | None]:
        rows = self.con.execute(
            "SELECT view_name, comment FROM duckdb_views() WHERE database_name = $db AND schema_name = 'main'",
            {"db": FILES_DATABASE},
        ).fetchall()
        return dict(rows)

    def _file_tables(self) -> set[str]:
        rows = self.con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = $db AND schema_name = 'main'",
            {"db": FILES_DATABASE},
        ).fetchall()
        return {row[0].lower() for row in rows}

    @staticmethod
    def _unique_name(stem: str, taken: set[str]) -> str:
        base = re.sub(r"\W+", "_", stem).strip("_").lower() or "file"
        if base[0].isdigit():
            base = "file_" + base
        name, n = base, 2
        while name in taken:
            name, n = f"{base}_{n}", n + 1
        return name

    def _alias_for_path(self, path: str) -> str | None:
        wanted = os.path.normcase(path)
        for name, db_path in self.con.execute(
            "SELECT database_name, path FROM duckdb_databases() WHERE path IS NOT NULL"
        ).fetchall():
            if os.path.normcase(os.path.abspath(db_path)) == wanted:
                return name
        return None

    def _unique_alias(self, path: str) -> str:
        stem = os.path.splitext(os.path.basename(path))[0]
        base = re.sub(r"\W+", "_", stem).strip("_") or "db"
        if base[0].isdigit():
            base = "db_" + base
        taken = {row[0] for row in self.con.execute("SELECT database_name FROM duckdb_databases()").fetchall()}
        taken |= _RESERVED_ALIASES
        alias, n = base, 2
        while alias in taken:
            alias, n = f"{base}_{n}", n + 1
        return alias

    # -- catalog -------------------------------------------------------------------

    def schema(self, include_temp: bool = False) -> dict:
        """Database → schema → table/view → column tree for every user database, and for `temp`
        (temporary tables and views) when include_temp is set."""
        with self.side_lock:
            cur = self.side
            databases = cur.execute(
                """
                SELECT database_name, path, readonly, type
                FROM duckdb_databases()
                WHERE NOT internal
                ORDER BY (database_name = $files AND path IS NULL), database_oid  -- opened files last
                """,
                {"files": FILES_DATABASE},
            ).fetchall()
            names = [row[0] for row in databases]
            current = {"current": self.current_database, "currentSchema": self.current_schema}
            temp_db = []
            if include_temp and self.temp_relations:
                temp_schema = {"name": "main", "relations": self.temp_relations}
                temp_db.append({"name": "temp", "path": None, "readOnly": False, "type": "duckdb", "schemas": [temp_schema]})
            if not names:
                return {**current, "databases": temp_db}
            schemas = cur.execute(
                """
                SELECT database_name, schema_name
                FROM duckdb_schemas()
                WHERE list_contains($dbs, database_name) AND NOT list_contains($hidden, schema_name)
                ORDER BY database_name, schema_name
                """,
                {"dbs": names, "hidden": list(_HIDDEN_SCHEMAS)},
            ).fetchall()
            relations = cur.execute(
                """
                SELECT database_name, schema_name, table_name, 'table' AS kind, estimated_size, comment
                FROM duckdb_tables()
                WHERE list_contains($dbs, database_name) AND NOT internal
                UNION ALL
                SELECT database_name, schema_name, view_name, 'view', NULL, comment
                FROM duckdb_views()
                WHERE list_contains($dbs, database_name) AND NOT internal
                ORDER BY 1, 2, 3
                """,
                {"dbs": names},
            ).fetchall()
            columns = cur.execute(
                """
                SELECT database_name, schema_name, table_name, column_name, data_type, is_nullable
                FROM duckdb_columns()
                WHERE list_contains($dbs, database_name) AND NOT internal
                ORDER BY database_name, schema_name, table_name, column_index
                """,
                {"dbs": names},
            ).fetchall()

        tree: dict[str, dict] = {}
        for name, path, read_only, db_type in databases:
            tree[name] = {
                "name": name,
                "path": path,
                "readOnly": bool(read_only),
                "type": db_type,
                "schemas": {},
            }
        for db, schema in schemas:
            if db in tree:
                tree[db]["schemas"][schema] = {"name": schema, "relations": {}}
        for db, schema, rel, kind, estimated, comment in relations:
            schema_node = tree.get(db, {}).get("schemas", {}).get(schema)
            if schema_node is not None:
                schema_node["relations"][rel] = {
                    "name": rel,
                    "kind": kind,
                    "rowEstimate": estimated,
                    "comment": comment,
                    "columns": [],
                }
        for db, schema, rel, column, data_type, nullable in columns:
            rel_node = tree.get(db, {}).get("schemas", {}).get(schema, {}).get("relations", {}).get(rel)
            if rel_node is not None:
                rel_node["columns"].append({"name": column, "type": data_type, "nullable": bool(nullable)})

        databases = [
            {
                **db,
                "schemas": [
                    {**schema, "relations": list(schema["relations"].values())} for schema in db["schemas"].values()
                ],
            }
            for db in tree.values()
        ]
        return {**current, "databases": databases + temp_db}
