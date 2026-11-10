"""HTML-to-text and bounded chunks with exact character provenance."""
from __future__ import annotations

import re
from html.parser import HTMLParser


def decode_html(data):
    match = re.search(br'charset\s*=\s*["\']?([\w-]+)', data[:4096], re.I)
    encodings = ([match.group(1).decode("ascii")] if match else []) + ["utf-8-sig", "cp1251"]
    for encoding in encodings:
        try:
            return data.decode(encoding), encoding
        except (UnicodeDecodeError, LookupError):
            pass
    raise ValueError("Unsupported HTML text encoding")


class TextReader(HTMLParser):
    BREAKS = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head"}:
            self.skip += 1
        if not self.skip:
            if tag in self.BREAKS:
                self.parts.append("\n")
            elif tag in {"td", "th"}:
                self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "head"}:
            self.skip = max(0, self.skip - 1)
        elif not self.skip and tag in self.BREAKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def result(self):
        lines = []
        for line in "".join(self.parts).splitlines():
            line = re.sub(r"\s+", " ", line.replace("\xa0", " ")).strip().strip("|").strip()
            if line:
                lines.append(line)
        return "\n".join(lines)


def html_text(data):
    value, encoding = decode_html(data)
    reader = TextReader()
    reader.feed(value)
    reader.close()
    return reader.result(), encoding


def chunks(text, size=1600, overlap=180):
    if not 128 <= size <= 32000 or not 0 <= overlap < size // 2:
        raise ValueError("Invalid chunk size or overlap")
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            split = text.rfind("\n", start + size // 2, end)
            if split >= 0:
                end = split + 1
        yield start, end, text[start:end]
        if end == len(text):
            break
        start = end - overlap

