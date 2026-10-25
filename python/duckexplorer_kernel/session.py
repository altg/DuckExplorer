"""The DuckDB connection owned by the kernel: attached databases and catalog introspection."""

from __future__ import annotations

import os
import re
import threading

import duckdb

# Schemas DuckDB creates in every database that are noise in a schema browser.
_HIDDEN_SCHEMAS = ("information_schema", "pg_catalog")
_RESERVED_ALIASES = {"memory", "system", "temp", "main"}


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


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
        self.current_database = self._read_current_database()

    def _read_current_database(self) -> str:
        return self.con.execute("SELECT current_database()").fetchone()[0]

    def refresh_current_database(self) -> str:
        """Call on the main thread after anything that may have run USE."""
        self.current_database = self._read_current_database()
        return self.current_database

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

    def schema(self) -> dict:
        """Database → schema → table/view → column tree for every user database."""
        with self.side_lock:
            cur = self.side
            databases = cur.execute(
                """
                SELECT database_name, path, readonly, type
                FROM duckdb_databases()
                WHERE NOT internal
                ORDER BY database_oid
                """
            ).fetchall()
            names = [row[0] for row in databases]
            if not names:
                return {"current": self.current_database, "databases": []}
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

        return {
            "current": self.current_database,
            "databases": [
                {
                    **db,
                    "schemas": [
                        {**schema, "relations": list(schema["relations"].values())}
                        for schema in db["schemas"].values()
                    ],
                }
                for db in tree.values()
            ],
        }
