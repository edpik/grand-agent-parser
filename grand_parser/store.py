from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Sink:
    def __init__(self, output):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=False)
        self.files = {}
        self.counts = Counter()
        self.db = sqlite3.connect(self.output / "grand.sqlite")
        self.db.executescript("""
          PRAGMA foreign_keys=ON;
          CREATE TABLE sources(id TEXT PRIMARY KEY, format TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
            source_id TEXT NOT NULL REFERENCES sources(id), code TEXT, title TEXT,
            text TEXT, payload TEXT NOT NULL);
          CREATE INDEX records_by_kind_code ON records(kind,code);
          CREATE INDEX records_by_source ON records(source_id,kind);
          CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, source_id UNINDEXED,
            kind UNINDEXED, title, text, tokenize='unicode61');
        """)

    def source(self, identifier, kind, metadata):
        self.db.execute("INSERT INTO sources VALUES(?,?,?)", (identifier, kind, dumps(metadata)))

    def emit(self, kind, key, source, payload, code=None, title=None, text=None):
        record = {"id": key, "source_id": source,
                  "approved_for_calculation": False, **payload}
        encoded = dumps(record)
        self.db.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?)",
                        (key, kind, source, code, title, text, encoded))
        if kind in {"chunks", "norms", "catalog_resources", "estimate_positions"}:
            self.db.execute("INSERT INTO search VALUES(?,?,?,?,?)",
                            (key, source, kind, title or "", text or ""))
        if kind not in self.files:
            self.files[kind] = (self.output / (kind + ".jsonl")).open("w", encoding="utf-8")
        self.files[kind].write(encoded + "\n")
        self.counts[kind] += 1

    def finish(self, manifest):
        self.db.commit()
        issues = self.db.execute("PRAGMA foreign_key_check").fetchall()
        integrity = self.db.execute("PRAGMA integrity_check").fetchone()[0]
        if issues or integrity != "ok":
            raise ValueError(f"SQLite validation failed: {issues}, {integrity}")
        manifest["counts"] = dict(self.counts)
        manifest["sqlite_integrity"] = integrity
        for handle in self.files.values():
            handle.close()
        self.db.close()
        (self.output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def abort(self):
        for handle in self.files.values():
            handle.close()
        self.db.close()


def search(database, query, limit=5, source_id=None):
    import re
    tokens = re.findall(r"\w+", query, re.UNICODE)
    if not tokens:
        return []
    match = " AND ".join('"' + token + '"*' for token in tokens[:20])
    connection = sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True)
    try:
        sql = """SELECT r.payload, bm25(search) FROM search
            JOIN records r ON r.id=search.id WHERE search MATCH ?"""
        params = [match]
        if source_id:
            sql += " AND r.source_id=?"
            params.append(source_id)
        sql += " ORDER BY bm25(search),r.id LIMIT ?"
        params.append(max(1, min(limit, 100)))
        return [json.loads(row[0]) for row in connection.execute(sql, params)]
    finally:
        connection.close()


def get_record(database, identifier):
    """Fetch an exact cited record rather than search again and change evidence."""
    with sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True) as db:
        row = db.execute("SELECT payload FROM records WHERE id=?", (identifier,)).fetchone()
        return json.loads(row[0]) if row else None


def lookup_code(database, code, source_id=None):
    """Return every occurrence/version unless an explicit source is selected."""
    with sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True) as db:
        sql = "SELECT payload FROM records WHERE code=?"
        params = [code]
        if source_id:
            sql += " AND source_id=?"
            params.append(source_id)
        return [json.loads(row[0]) for row in db.execute(sql + " ORDER BY id", params)]

