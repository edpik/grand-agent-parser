"""Synthetic fixtures test boundaries and mappings, not estimate correctness."""
import json
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

from grand_parser.binary import FormatError, Gsdx, article_pages, inflate
from grand_parser.ingest import parse_sources
from grand_parser.store import get_record, lookup_code, search
from grand_parser.text import chunks, html_text
from grand_parser.xmlio import decimal_string, parse_xml


def packed(data):
    encoder = zlib.compressobj(wbits=-15)
    return struct.pack("<I", len(data)) + encoder.compress(data) + encoder.flush()


def record(kind, body):
    return bytes([kind]) + struct.pack("<I", len(body) + 4) + body


def article(pages, flag=1):
    entries = []
    for page in pages:
        raw = page.encode("cp1251")
        inner = struct.pack("<Q", len(raw)) + raw + bytes([0, flag]) + record(1, struct.pack("<I", 0))
        entries.append(record(1, record(2, inner)))
    body = b"HTML" + struct.pack("<6I", 1, 1010, 730, 730, 1010, len(pages)) + b"".join(entries)
    return b"HTML\x02" + struct.pack("<I", len(body) + 4) + body


def container(blocks):
    names = b"".join(b"\x01" + bytes([len(n.encode("cp1251"))]) + n.encode("cp1251") + b"\0" for n in blocks)
    directory = 20 + len(names)
    offset = directory + len(blocks) * 12
    entries, payload = [], []
    for data in blocks.values():
        entries.append(struct.pack("<QI", offset, len(data)))
        payload.append(data)
        offset += len(data)
    return b"SDB\x05" + struct.pack("<4I", 12, len(blocks), directory, 0xFFFFFFFF) + names + b"".join(entries + payload)


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self):
        catalog = '<?xml version="1.0" encoding="windows-1251"?><Region Caption="Тест" ID="TEST"><Folder Caption="ТЕР"><Document ID="1" Caption="Коррозия" Sign="ТЕР13"/></Folder></Region>'
        page = '<html><head><style>hidden</style></head><body><p>Защита от коррозии.</p><table><tr><td>Материал</td><td>100 м2</td></tr></table><script>bad()</script></body></html>'
        blocks = {"Content": packed(catalog.encode("cp1251")),
                  "1\\Article2": packed(article([page, page], flag=0)),
                  "1\\Data": b"GSH\x03" + b"unknown-numeric-data"}
        path = self.root / "synthetic.gsdx"
        path.write_bytes(container(blocks))
        return path

    def test_gsdx_pages_provenance_search_and_partial_status(self):
        path = self.fixture()
        result = parse_sources([path], self.root / "parsed", size=128, overlap=20)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["counts"]["documents"], 1)
        self.assertEqual(result["counts"]["pages"], 2)
        self.assertEqual(result["sources"][0]["gsh_payloads"], 1)
        self.assertFalse(result["approved_for_calculation"])
        self.assertNotIn("norms", result["counts"])
        hits = search(self.root / "parsed/grand.sqlite", "корроз")
        self.assertEqual(len(hits), 2)
        pages = {p["id"]: p for p in map(json.loads, (self.root / "parsed/pages.jsonl").read_text().splitlines())}
        for hit in hits:
            self.assertEqual(hit["text"], pages[hit["page_id"]]["text"][hit["char_start"]:hit["char_end"]])
            self.assertNotIn("hidden", hit["text"])
            self.assertNotIn("bad()", hit["text"])
            self.assertEqual(get_record(self.root / "parsed/grand.sqlite", hit["id"]), hit)
        self.assertEqual(search(self.root / "parsed/grand.sqlite", "корроз", source_id="missing"), [])

    def test_decompression_rejects_trailing_bytes_and_size_lies(self):
        blob = packed(b"hello")
        self.assertEqual(inflate(blob), b"hello")
        for corrupt in (blob + b"junk", struct.pack("<I", 2) + blob[4:], blob[:-1]):
            with self.assertRaises(FormatError):
                inflate(corrupt)
        with self.assertRaises(FormatError):
            inflate(struct.pack("<I", 2 ** 31))

    def test_reject_out_of_file_block(self):
        path = self.fixture()
        data = bytearray(path.read_bytes())
        directory = struct.unpack_from("<I", data, 12)[0]
        struct.pack_into("<Q", data, directory, len(data) + 50)
        path.write_bytes(data)
        with self.assertRaises(FormatError):
            Gsdx(path)

    def test_reject_html_page_boundary_lie(self):
        data = bytearray(article(["<html><body>тест</body></html>"]))
        struct.pack_into("<Q", data, 47, 100000)
        with self.assertRaises(FormatError):
            article_pages(data)

    def test_chunks_are_exact_bounded_slices(self):
        text = ("Русский текст, 100 м².\n" * 200)
        result = list(chunks(text, 160, 20))
        self.assertEqual(result[0][0], 0)
        self.assertEqual(result[-1][1], len(text))
        for start, end, value in result:
            self.assertLessEqual(end - start, 160)
            self.assertEqual(value, text[start:end])
        for left, right in zip(result, result[1:]):
            self.assertEqual(left[1] - right[0], 20)

    def test_xml_entities_are_rejected_in_utf16_too(self):
        xml = '<!DOCTYPE doc [<!ENTITY a "text">]><doc>&a;</doc>'
        for encoding in ("utf-8", "utf-16", "utf-32"):
            with self.assertRaises(FormatError):
                parse_xml(xml.encode(encoding))

    def test_no_formula_evaluation_or_missing_zero(self):
        self.assertEqual(decimal_string("0.000"), "0.000")
        self.assertEqual(decimal_string("1.2300"), "1.2300")
        for value in (None, "2*3", "NaN", "1,5", "__import__('os')"):
            self.assertIsNone(decimal_string(value))

    def test_gsfx_positions_keep_duplicates_and_exact_values(self):
        xml = b'''<Document><Chapters><Chapter SysID="C1">
          <Position SysID="1" Code="TEST" Caption="One" Units="m2" Quantity="2*3" PriceLevel="2001"><Quantity Fx="2*3" Result="6.0000"/><Resources><Resource Code="R" Quantity="0.50"/></Resources></Position>
          <Position SysID="2" Code="TEST" Caption="Two" Units="m2" Quantity="2*4" PriceLevel="2001"/>
        </Chapter></Chapters><DefectsList><Defect><Position SysID="ref1" Code="NOT_A_ROW"/></Defect></DefectsList></Document>'''
        path = self.root / "synthetic.gsfx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Data.xml", xml)
        result = parse_sources([path], self.root / "parsed")
        self.assertEqual(result["counts"]["estimate_positions"], 2)
        values = list(map(json.loads, (self.root / "parsed/estimate_positions.jsonl").read_text().splitlines()))
        self.assertEqual(values[0]["quantity_result_literal"], "6.0000")
        self.assertIsNone(values[1]["quantity_result_literal"])
        self.assertEqual(values[0]["xml"]["children"][1]["children"][0]["attributes"]["Quantity"], "0.50")
        self.assertEqual(len(lookup_code(self.root / "parsed/grand.sqlite", "TEST")), 2)

    def test_other_document_type_is_not_normalized_as_local_estimate(self):
        path = self.root / "other.xml"
        path.write_text('<Document DocumentType="{00000000-0000-0000-0000-000000000000}"><Chapters><Chapter><Position Code="NOT_LS"/></Chapter></Chapters></Document>')
        result = parse_sources([path], self.root / "parsed")
        self.assertEqual(result["sources"][0]["estimate_positions"], 0)
        self.assertFalse(result["sources"][0]["position_mapping_applied"])
        self.assertNotIn("estimate_positions", result["counts"])

    def test_protected_gsfx_is_explicit_and_not_fabricated(self):
        path = self.root / "protected.gsfx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Data.xml.crypt", b"protected")
        result = parse_sources([path], self.root / "parsed")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["sources"][0]["status"], "unsupported_protected_payload")
        self.assertEqual(result["counts"], {})

    def test_zip_traversal_rejected_with_atomic_output(self):
        path = self.root / "bad.gsfx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("../Data.xml", "<Document/>")
        with self.assertRaises(FormatError):
            parse_sources([path], self.root / "parsed")
        self.assertFalse((self.root / "parsed").exists())
        self.assertFalse(list(self.root.glob(".grand-parser-*")))

    def test_fsnb_abstract_resources_and_precision(self):
        path = self.root / "synthetic.xml"
        path.write_text('''<base BaseType="ГЭСН" PriceLevel="01.01.2022"><ResourcesDirectory><ResourceCategory CodePrefix="ГЭСН"><Section Code="13" Name="Защита"><NameGroup BeginName="Окраска:"><Work Code="13-01-001-01" EndName="стали" MeasureUnit="100 м2"><Content><Item Text="Очистка"/></Content><Resources><Resource Code="R" Quantity="0.00100"/><AbstractResource Code="A" Quantity="П"/></Resources><NrSp><ReasonItem Nr="NR" Sp="SP"/></NrSp></Work></NameGroup></Section></ResourceCategory></ResourcesDirectory></base>''', encoding="utf-8")
        result = parse_sources([path], self.root / "parsed")
        self.assertEqual(result["counts"]["norm_resources"], 2)
        norms = json.loads((self.root / "parsed/norms.jsonl").read_text())
        self.assertEqual(norms["name"], "Окраска: стали")
        self.assertEqual(norms["measure_unit"], "100 м2")
        rows = list(map(json.loads, (self.root / "parsed/norm_resources.jsonl").read_text().splitlines()))
        self.assertEqual(rows[0]["quantity_literal"], "0.00100")
        self.assertIsNone(rows[1]["quantity_literal"])
        self.assertEqual(rows[1]["quantity_source"], "П")

    def test_output_not_overwritten(self):
        output = self.root / "parsed"
        output.mkdir()
        (output / "keep").write_text("existing")
        with self.assertRaises(FileExistsError):
            parse_sources([self.fixture()], output)
        self.assertEqual((output / "keep").read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
