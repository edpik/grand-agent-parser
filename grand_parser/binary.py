"""Empirical SDB5/GSDX reader; not an official format specification."""
from __future__ import annotations

import hashlib
import mmap
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path


class FormatError(ValueError):
    pass


def integer(data, offset, fmt="<I"):
    size = struct.calcsize(fmt)
    if offset < 0 or offset + size > len(data):
        raise FormatError(f"Truncated integer at {offset}")
    return struct.unpack_from(fmt, data, offset)[0]


def inflate(data: bytes, limit: int = 128 * 1024 * 1024) -> bytes:
    """Only the observed uint32-size + raw-DEFLATE encoding is accepted."""
    expected = integer(data, 0)
    if not 0 < expected <= limit:
        raise FormatError(f"Invalid or excessive decompressed size: {expected}")
    try:
        decoder = zlib.decompressobj(-15)
        result = decoder.decompress(data[4:], expected + 1)
    except zlib.error as exc:
        raise FormatError("Not the supported DEFLATE block encoding") from exc
    if (len(result) != expected or not decoder.eof or decoder.unused_data
            or decoder.unconsumed_tail):
        raise FormatError("DEFLATE size, end-of-stream, or trailing-byte mismatch")
    return result


@dataclass(frozen=True)
class Block:
    name: str
    offset: int
    length: int


class Gsdx:
    def __init__(self, path: Path, max_file=512 * 1024 * 1024):
        self.path = Path(path)
        if not 20 <= self.path.stat().st_size <= max_file:
            raise FormatError("GSDX input is truncated or exceeds the file limit")
        self.file = self.path.open("rb")
        self.data = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            self.blocks = self._directory()
        except BaseException:
            self.close()
            raise

    def close(self):
        self.data.close()
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _directory(self):
        data = self.data
        if data[:4] != b"SDB\x05":
            raise FormatError("Unsupported SDB signature/version; expected SDB5")
        count = integer(data, 8)
        directory = integer(data, 12)
        if not 1 <= count <= 50000 or not 20 <= directory <= len(data):
            raise FormatError("Invalid directory header")
        pos, names = 20, []
        for _ in range(count):
            if pos + 2 > directory or data[pos] != 1:
                raise FormatError("Invalid directory name marker")
            length = data[pos + 1]
            end = pos + 2 + length
            if length == 0 or end >= directory or data[end] != 0:
                raise FormatError("Invalid directory name length/terminator")
            names.append(data[pos + 2:end].decode("cp1251"))
            pos = end + 1
        if pos != directory or len(set(names)) != count:
            raise FormatError("Directory name size mismatch or duplicate names")
        payload_start = directory + 12 * count
        if payload_start > len(data):
            raise FormatError("Truncated directory table")
        blocks = {}
        for i, name in enumerate(names):
            offset = integer(data, directory + 12 * i, "<Q")
            length = integer(data, directory + 12 * i + 8)
            if offset < payload_start or offset + length > len(data):
                raise FormatError(f"Block outside payload bounds: {name}")
            blocks[name] = Block(name, offset, length)
        end = payload_start
        for block in sorted(blocks.values(), key=lambda b: b.offset):
            if block.offset < end:
                raise FormatError(f"Overlapping blocks: {block.name}")
            end = block.offset + block.length
        return blocks

    def read(self, name):
        block = self.blocks[name]
        return self.data[block.offset:block.offset + block.length]

    def decoded(self, name):
        return inflate(self.read(name))


def tlv_end(data, pos, expected_tag, enclosing_end=None):
    bound = len(data) if enclosing_end is None else enclosing_end
    if pos < 0 or pos + 5 > bound or data[pos] != expected_tag:
        raise FormatError(f"Invalid HTML container tag {expected_tag} at {pos}")
    size = integer(data, pos + 1)
    end = pos + 1 + size
    if size < 4 or end > bound:
        raise FormatError("HTML container record exceeds its bounds")
    return end


def _assets(data, pos, end):
    """Validate asset boundaries; return metadata, never execute or write assets."""
    if tlv_end(data, pos, 1, end) != end:
        raise FormatError("Unexpected asset list length")
    count = integer(data, pos + 5)
    if count > 100000:
        raise FormatError("Excessive asset count")
    cur, result = pos + 9, []
    for _ in range(count):
        asset_end = tlv_end(data, cur, 1, end)
        size = integer(data, cur + 5)
        name_start = cur + 9
        content_size_pos = name_start + size
        if content_size_pos + 8 > asset_end:
            raise FormatError("Truncated asset name")
        name = data[name_start:content_size_pos].decode("cp1251")
        content_size = integer(data, content_size_pos, "<Q")
        content_start = content_size_pos + 8
        if content_start + content_size != asset_end:
            raise FormatError("Asset byte count mismatch")
        result.append({"name": name, "bytes": content_size,
                       "sha256": hashlib.sha256(data[content_start:asset_end]).hexdigest()})
        cur = asset_end
    if cur != end:
        raise FormatError("Unconsumed asset list bytes")
    return result


def article_pages(data: bytes):
    """Read every page from the observed HTML2 container, without scanning images."""
    if (len(data) < 37 or data[:5] != b"HTML\x02" or data[9:13] != b"HTML"
            or integer(data, 5) != len(data) - 5 or integer(data, 13) != 1):
        raise FormatError("Unsupported HTML container header/version")
    count = integer(data, 33)
    if count > 100000:
        raise FormatError("Excessive page count")
    pos, pages = 37, []
    for index in range(count):
        end = tlv_end(data, pos, 1)
        if tlv_end(data, pos + 5, 2, end) != end:
            raise FormatError("Unexpected nested HTML record length")
        size = integer(data, pos + 10, "<Q")
        start = pos + 18
        tail = start + size
        if tail + 2 > end or data[tail:tail + 2] not in (b"\x00\x01", b"\x00\x00"):
            raise FormatError("Unsupported HTML page suffix")
        body = data[start:tail]
        if not body.lower().lstrip().startswith(b"<html") or not body.lower().rstrip().endswith(b"</html>"):
            raise FormatError("HTML page boundary mismatch")
        assets = _assets(data, tail + 2, end)
        pages.append({"page_index": index, "html_bytes": body, "assets": assets,
                      "decoded_offset": start, "decoded_length": size,
                      "suffix_flags_hex": data[tail:tail + 2].hex()})
        pos = end
    return pages, {"page_count": count, "uninterpreted_trailer_bytes": len(data) - pos,
                   "trailer_sha256": hashlib.sha256(data[pos:]).hexdigest()}

