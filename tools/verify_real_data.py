"""Independent count/field/provenance checks against public real input files."""
import argparse
import hashlib
import json
import sqlite3
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grand_parser.store import get_record, search


def run(gsdb, fsdb, xmlzip):
    report = {"checks": [], "sampled_norms": 0, "sampled_catalog_resources": 0,
              "verified_chunk_slices": 0}
    for path in (gsdb, fsdb):
        with sqlite3.connect(path) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert not db.execute("PRAGMA foreign_key_check").fetchall()
    report["checks"].append("sqlite_integrity_and_foreign_keys")
    with sqlite3.connect(gsdb) as db:
        pages = {key: json.loads(value)["text"] for key, value in
                 db.execute("SELECT id,payload FROM records WHERE kind='pages'")}
        for (value,) in db.execute("SELECT payload FROM records WHERE kind='chunks'"):
            chunk = json.loads(value)
            assert chunk["text"] == pages[chunk["page_id"]][chunk["char_start"]:chunk["char_end"]]
            report["verified_chunk_slices"] += 1
        hits = search(gsdb, "защита корроз", limit=5)
        assert hits
        assert all(get_record(gsdb, hit["id"])["text"] == hit["text"] for hit in hits)
    report["checks"].append("all_chunk_character_slices_and_search_retrieval")
    totals = {"norms": 0, "norm_resources": 0, "catalog_resources": 0}
    with zipfile.ZipFile(xmlzip) as archive, sqlite3.connect(fsdb) as db:
        for item in archive.infolist():
            data = archive.read(item)
            root = ET.fromstring(data)
            source = "sha256:" + hashlib.sha256(data).hexdigest()
            assert db.execute("SELECT 1 FROM sources WHERE id=?", (source,)).fetchone()
            works = root.findall(".//Work")
            resources = root.findall(".//Resource") if root.tag == "ResourceCatalog" else []
            totals["norms"] += len(works)
            totals["catalog_resources"] += len(resources)
            totals["norm_resources"] += sum(len(r) for work in works for r in work if r.tag == "Resources")
            sample_indices = sorted(set([0, len(works)//4, len(works)//2, 3*len(works)//4, len(works)-1])) if works else []
            for index in sample_indices:
                work = works[index]
                code = root.get("BaseType") + work.get("Code")
                row = db.execute("SELECT id,payload FROM records WHERE kind='norms' AND source_id=? AND code=?", (source, code)).fetchone()
                assert row
                key, payload = row
                norm = json.loads(payload)
                assert norm["attributes"] == work.attrib
                assert norm["measure_unit"] == work.get("MeasureUnit")
                source_resources = [x for group in work if group.tag == "Resources" for x in group]
                assert norm["resource_count"] == len(source_resources)
                for ordinal, resource in enumerate(source_resources):
                    payload = db.execute("SELECT payload FROM records WHERE id=?", (key + f":resource:{ordinal}",)).fetchone()[0]
                    stored = json.loads(payload)
                    assert stored["resource_code"] == resource.get("Code")
                    assert stored["quantity_source"] == resource.get("Quantity")
                    assert stored["xml"]["attributes"] == resource.attrib
                    assert stored["resource_kind"] == resource.tag
                report["sampled_norms"] += 1
            for index in sorted(set([0, len(resources)//2, len(resources)-1])) if resources else []:
                resource = resources[index]
                stored = json.loads(db.execute("SELECT payload FROM records WHERE kind='catalog_resources' AND source_id=? AND code=?", (source, resource.get("Code"))).fetchone()[0])
                assert stored["xml"]["attributes"] == resource.attrib
                source_prices = resource.find("Prices")
                stored_prices = next(x for x in stored["xml"]["children"] if x["tag"] == "Prices")
                assert [x.attrib for x in source_prices] == [x["attributes"] for x in stored_prices["children"]]
                report["sampled_catalog_resources"] += 1
        for kind, count in totals.items():
            assert db.execute("SELECT count(*) FROM records WHERE kind=?", (kind,)).fetchone()[0] == count
    report["checks"].append("source_hashes_complete_counts_and_exact_sampled_fields")
    report.update(totals=totals, status="passed")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--gsdx-db", required=True)
    p.add_argument("--fsnb-db", required=True)
    p.add_argument("--xml-zip", required=True)
    p.add_argument("--report", required=True)
    a = p.parse_args()
    result = run(a.gsdx_db, a.fsnb_db, a.xml_zip)
    Path(a.report).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
