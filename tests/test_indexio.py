import struct
import unittest
import tempfile
from pathlib import Path
from grand_parser.store import Sink, search, lookup_code
from grand_parser.binary import FormatError, Block
from grand_parser.indexio import record_table, read_index_records


def table(records, version=1):
    offset = 12 + len(records) * 4
    offsets = []
    for data in records:
        offsets.append(struct.pack('<I', offset))
        offset += len(data)
    return struct.pack('<IiI', 23, version, len(records)) + b''.join(offsets + records)


def string(value):
    data = value.encode('cp1251')
    return struct.pack('<I', len(data)) + data


class Reader:
    def __init__(self, blocks):
        self.values = blocks
        self.blocks = {name: Block(name, 1000, len(value)) for name, value in blocks.items()}

    def read(self, name):
        return self.values[name]


class IndexTests(unittest.TestCase):
    def fixture(self):
        return Reader({'DocRows': table([b'undecoded']),
                       'CodeIndex': table([string('тест-001') + struct.pack('<I', 0)]),
                       'FtsWords': table([string('автоцистерна'), string('10')]),
                       'Fts2\\Row0': table([struct.pack('<III', 0, 1, 0),
                                            struct.pack('<III', 1, 1, 2)])})

    def test_ordered_tokens_provenance_and_explicit_limits(self):
        records, decoded, descriptions = read_index_records(self.fixture())
        self.assertEqual(descriptions, 1)
        self.assertEqual(records[0]['codes'], ['тест-001'])
        self.assertEqual(records[0]['search_text'], 'автоцистерна 10')
        self.assertEqual(records[0]['token_gaps'], 1)
        self.assertEqual(records[0]['file_offset'], 1016)
        self.assertFalse(records[0]['approved_for_calculation'])
        self.assertNotIn('DocRows', decoded)
        self.assertNotIn('unit', records[0])

    def test_corrupt_reference_and_token_position(self):
        reader = self.fixture()
        reader.values['CodeIndex'] = table([string('X') + struct.pack('<I', 10)])
        with self.assertRaises(FormatError):
            read_index_records(reader)
        reader = self.fixture()
        reader.values['Fts2\\Row0'] = table([struct.pack('<III', 0, 1, 0), struct.pack('<III', 1, 1, 0)])
        with self.assertRaises(FormatError):
            read_index_records(reader)

    def test_record_boundaries_and_empty_arrays(self):
        self.assertEqual(record_table(struct.pack('<IiI', 23, -1, 0)), [])
        with self.assertRaises(FormatError):
            record_table(struct.pack('<IiII', 23, 1, 1, 15) + b'x')
        with self.assertRaises(FormatError):
            record_table(table([], version=2))

    def test_index_records_are_searchable_in_sqlite_with_exact_source_lookup(self):
        records, _, _ = read_index_records(self.fixture())
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'parsed'
            sink = Sink(out)
            sink.source('source', 'GSDX_SDB5', {})
            record = records[0]
            sink.emit('base_index_records', 'source:row:0', 'source', record,
                      code=record['codes'][0], title=record['codes'][0], text=record['search_text'])
            sink.finish({})
            hits = search(out / 'grand.sqlite', 'автоцистерна')
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0]['source_id'], 'source')
            self.assertFalse(hits[0]['approved_for_calculation'])
            self.assertEqual(lookup_code(out / 'grand.sqlite', 'тест-001')[0]['id'], hits[0]['id'])
