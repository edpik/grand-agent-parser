"""Observed unencoded GSDX code/forward search indexes, not numeric GSH data."""
from __future__ import annotations

import re
import struct
from .binary import FormatError

MAX_RECORDS = 500_000
MAX_TOKENS = 2_000_000


def record_table(data, version=1):
    if len(data) < 12:
        raise FormatError('Truncated GSDX record-array header')
    magic, actual_version, count = struct.unpack_from('<IiI', data)
    if magic != 23:
        raise FormatError('Unsupported GSDX record-array signature')
    if count == 0 and actual_version == -1 and len(data) == 12:
        return []
    if actual_version != version or count > MAX_RECORDS or 12 + count * 4 > len(data):
        raise FormatError('Unsupported GSDX record-array version/count')
    if count == 0:
        if len(data) != 12:
            raise FormatError('Unexpected bytes in empty GSDX record array')
        return []
    offsets = struct.unpack_from('<' + 'I' * count, data, 12)
    result, previous = [], 12 + count * 4
    for index, offset in enumerate(offsets):
        end = offsets[index + 1] if index + 1 < count else len(data)
        if offset != previous or not offset <= end <= len(data):
            raise FormatError('Invalid GSDX record-array offsets')
        result.append((offset, end))
        previous = end
    return result


def string_record(data, trailing=0):
    if len(data) < 4 + trailing:
        raise FormatError('Truncated GSDX index string')
    size, = struct.unpack_from('<I', data)
    if 4 + size + trailing != len(data):
        raise FormatError('GSDX index string length mismatch')
    return data[4:4 + size].decode('cp1251')


def read_index_records(reader):
    decoded, result = set(), {}
    if 'CodeIndex' not in reader.blocks or 'DocRows' not in reader.blocks:
        return [], decoded, 0
    refs = record_table(reader.read('DocRows'))
    codes = reader.read('CodeIndex')
    for start, end in record_table(codes):
        record = codes[start:end]
        code = string_record(record, trailing=4)
        row, = struct.unpack_from('<I', record, len(record) - 4)
        if row >= len(refs):
            raise FormatError('GSDX code references a missing DocRows record')
        if row not in result:
            offset, row_end = refs[row]
            result[row] = dict(row_index=row, codes=[], search_text='', token_count=0,
                               token_gaps=0, index_status='code_only',
                               source_locator=f'DocRows:record:{row}',
                               file_offset=reader.blocks['DocRows'].offset + offset,
                               record_bytes=row_end - offset, purpose='retrieval_only',
                               numeric_extraction='unsupported_binary_payload',
                               approved_for_calculation=False)
        result[row]['codes'].append(code)
    decoded.add('CodeIndex')
    search_blocks = [name for name in reader.blocks if re.fullmatch(r'Fts2\\Row\d+', name)]
    descriptions = tokens = characters = 0
    if search_blocks and 'FtsWords' in reader.blocks:
        raw = reader.read('FtsWords')
        words = [string_record(raw[start:end]) for start, end in record_table(raw)]
        decoded.add('FtsWords')
        for name in search_blocks:
            row = int(name[len('Fts2\\Row'):])
            if row not in result:
                raise FormatError('Forward search index references a row without a code')
            positions, raw = {}, reader.read(name)
            for start, end in record_table(raw):
                if end - start < 8 or (end - start) % 4:
                    raise FormatError('Truncated GSDX token-position record')
                word, count = struct.unpack_from('<II', raw, start)
                tokens += count
                if word >= len(words) or count * 4 + 8 != end - start or tokens > MAX_TOKENS:
                    raise FormatError('Invalid or excessive GSDX search index')
                for position in struct.unpack_from('<' + 'I' * count, raw, start + 8):
                    if position >= MAX_TOKENS or position in positions:
                        raise FormatError('Ambiguous GSDX token position')
                    positions[position] = words[word]
            ordered = sorted(positions)
            text = ' '.join(positions[p] for p in ordered)
            characters += len(text)
            if characters > 50_000_000:
                raise FormatError('GSDX indexed text exceeds limit')
            result[row].update(search_text=text, token_count=len(ordered),
                               token_gaps=ordered[-1] + 1 - len(ordered) if ordered else 0,
                               search_block=name, index_status='search_tokens')
            descriptions += 1
            decoded.add(name)
    return [result[row] for row in sorted(result)], decoded, descriptions
