import argparse
import json
import sqlite3
import sys
import zipfile
from pathlib import Path

from .binary import FormatError
from .ingest import inspect, parse_sources
from .store import lookup_code, search


def main():
    parser = argparse.ArgumentParser(description="GSDX/GSFX/XML extraction for an AI agent")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("inspect", help="Identify the actual format and metadata")
    check.add_argument("input")
    ingest = commands.add_parser("parse", help="Create JSONL, SQLite FTS5, and a manifest")
    ingest.add_argument("inputs", nargs="+")
    ingest.add_argument("--output", required=True)
    ingest.add_argument("--chunk-size", type=int, default=1600)
    ingest.add_argument("--overlap", type=int, default=180)
    ingest.add_argument("--require-numeric", action="store_true",
                        help="Exit 2 if no norms/catalog resources/estimate positions were extracted")
    query = commands.add_parser("search", help="Retrieve cited source passages by prefix search")
    query.add_argument("database")
    query.add_argument("query")
    query.add_argument("--limit", type=int, default=5)
    query.add_argument("--source-id")
    lookup = commands.add_parser("lookup", help="Find all versions/occurrences of an exact code")
    lookup.add_argument("database")
    lookup.add_argument("code")
    lookup.add_argument("--source-id")
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = inspect(args.input)
        elif args.command == "parse":
            result = parse_sources(args.inputs, args.output, args.chunk_size, args.overlap)
            # Do not dump hundreds of source metadata fields into routine CLI output.
            print(json.dumps({"output": str(Path(args.output).resolve()), "status": result["status"],
                              "counts": result["counts"], "approved_for_calculation": False},
                             ensure_ascii=False, indent=2))
            if args.require_numeric and not any(result["counts"].get(k) for k in
                                                 ("norms", "catalog_resources", "estimate_positions")):
                print("No structured numeric records; see manifest.json", file=sys.stderr)
                return 2
            return 0
        elif args.command == "search":
            result = search(args.database, args.query, args.limit, args.source_id)
        else:
            result = lookup_code(args.database, args.code, args.source_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (FormatError, OSError, ValueError, sqlite3.Error, zipfile.BadZipFile) as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

