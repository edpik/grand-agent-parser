"""Lossless XML fields plus conservative normalization of known source schemas."""
from __future__ import annotations

import codecs
import re
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

from .binary import FormatError


def tag(node):
    return node.tag.rsplit("}", 1)[-1]


def parse_xml(data: bytes, max_bytes=256 * 1024 * 1024):
    if len(data) > max_bytes:
        raise FormatError("XML exceeds the size limit")
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        text = data.decode("utf-32")
    elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) or data[:2] in (b"<\x00", b"\x00<"):
        text = data.decode("utf-16" if data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)
                           else "utf-16-le" if data[:2] == b"<\x00" else "utf-16-be")
    else:
        declaration = re.search(br'encoding\s*=\s*["\']([^"\']+)', data[:256], re.I)
        encoding = declaration.group(1).decode("ascii") if declaration else "utf-8-sig"
        try:
            text = data.decode(encoding)
        except (UnicodeDecodeError, LookupError) as exc:
            raise FormatError("Invalid XML encoding") from exc
    if re.search(r"<!\s*(DOCTYPE|ENTITY)\b", text, re.I):
        raise FormatError("DTD and entity declarations are not supported")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise FormatError(f"Invalid XML: {exc}") from exc
    stack = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > 128:
            raise FormatError("XML nesting exceeds the depth limit")
        stack.extend((child, depth + 1) for child in node)
    return root


def tree(node):
    """Keep namespaces, unknown attributes, ordered children, text and tail."""
    result = {"tag": node.tag, "attributes": dict(node.attrib)}
    if node.text and node.text.strip():
        result["text"] = node.text
    if node.tail and node.tail.strip():
        result["tail"] = node.tail
    if len(node):
        result["children"] = [tree(child) for child in node]
    return result


def decimal_string(value):
    """Accept a numeric literal only; never evaluate a supplied formula."""
    if value is None or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", value.strip()):
        return None
    try:
        result = Decimal(value.strip())
        return value.strip() if result.is_finite() else None
    except InvalidOperation:
        return None


def import_fsnb(root, sink, source):
    prefix = root.get("BaseType", "")
    metadata = {"root_attributes": dict(root.attrib),
                "decrees": [tree(c) for c in root if tag(c) == "Decrees"],
                "numeric_extraction": "exact_source_strings", "approved_for_calculation": False}
    sink.emit("documents", source + ":xml", source, metadata,
              title=root.get("BaseName", prefix or "ResourceCatalog"))
    counts = {"norms": 0, "norm_resources": 0, "catalog_resources": 0}

    def walk(node, sections, category=None, begin_name=""):
        kind = tag(node)
        if kind == "ResourceCategory":
            category = dict(node.attrib)
        if kind == "Section":
            sections = sections + [dict(node.attrib)]
        if kind == "NameGroup":
            begin_name = node.get("BeginName", "")
        if kind == "Work":
            code = node.get("Code")
            if not code:
                raise FormatError("FSNB Work has no Code")
            key = f"{source}:{prefix}:{code}"
            title = " ".join(v for v in (begin_name, node.get("EndName", "")) if v)
            operations = [c.get("Text", "") for g in node if tag(g) == "Content" for c in g]
            resources = [c for g in node if tag(g) == "Resources" for c in g]
            record = {"norm_id": key, "base_type": prefix, "code": code, "name": title,
                      "measure_unit": node.get("MeasureUnit"), "sections": sections,
                      "operations": operations, "attributes": dict(node.attrib),
                      "other_children": [tree(c) for c in node if tag(c) not in ("Content", "Resources")],
                      "resource_count": len(resources), "approved_for_calculation": False}
            sink.emit("norms", key, source, record, code=prefix + code, title=title,
                      text="\n".join(operations))
            counts["norms"] += 1
            for i, resource in enumerate(resources):
                attrs = dict(resource.attrib)
                record = {"norm_id": key, "ordinal": i, "resource_kind": tag(resource),
                          "resource_code": attrs.get("Code"), "name": attrs.get("EndName"),
                          "measure_unit": attrs.get("MeasureUnit"),
                          "quantity_literal": decimal_string(attrs.get("Quantity")),
                          "quantity_source": attrs.get("Quantity"), "xml": tree(resource)}
                sink.emit("norm_resources", key + f":resource:{i}", source, record,
                          code=attrs.get("Code"), title=attrs.get("EndName"))
                counts["norm_resources"] += 1
            return
        if kind == "Resource" and tag(root) == "ResourceCatalog":
            code = node.get("Code")
            if not code:
                raise FormatError("FSNB catalog Resource has no Code")
            record = {"code": code, "name": node.get("Name"),
                      "measure_unit": node.get("MeasureUnit"), "category": category,
                      "sections": sections, "xml": tree(node),
                      "price_level": "base_2022", "approved_for_calculation": False}
            sink.emit("catalog_resources", source + ":resource:" + code, source, record,
                      code=code, title=node.get("Name"))
            counts["catalog_resources"] += 1
            return
        for child in node:
            walk(child, sections, category, begin_name)

    walk(root, [])
    return counts


def import_grand_xml(root, sink, source):
    """Known Position fields follow the publisher's OpenXML_LS schema.

    The original tree remains authoritative; this is extraction, not a smeta engine.
    """
    sink.emit("documents", source + ":xml", source,
              {"root_tag": root.tag, "xml": tree(root),
               "approved_for_calculation": False}, title=root.get("Caption", "Document"))
    count = 0
    # DefectsList also contains Position nodes, but those are references rather
    # than estimate rows. Only the documented LS chapter path is normalized.
    positions = [(chapter, pos) for group in root if tag(group) == "Chapters"
                 for chapter in group if tag(chapter) == "Chapter"
                 for pos in chapter if tag(pos) == "Position"]
    ls_type = "2B0470FD-477C-4359-9F34-EEBE36B7D340"
    declared_type = root.get("DocumentType", "").strip("{}").upper()
    if declared_type and declared_type != ls_type:
        positions = []
    for chapter, pos in positions:
        count += 1
        qty_nodes = [x for x in pos if tag(x) == "Quantity"]
        qty = qty_nodes[0] if qty_nodes else None
        result = qty.get("Result") if qty is not None else None
        if result is None and qty is None:
            result = pos.get("Quantity")
        record = {"position_id": pos.get("SysID"), "ordinal": count - 1,
                  "chapter": dict(chapter.attrib),
                  "number": pos.get("Number"), "code": pos.get("Code"),
                  "name": pos.get("Caption"), "measure_unit": pos.get("Units"),
                  "quantity_source": pos.get("Quantity"),
                  "quantity_result_literal": decimal_string(result),
                  "quantity_details": tree(qty) if qty is not None else None,
                  "price_level": pos.get("PriceLevel"), "xml": tree(pos),
                  "formula_evaluated": False, "approved_for_calculation": False}
        # Ordinal prevents dropping two occurrences of the same price code/SysID.
        sink.emit("estimate_positions", source + f":position:{count - 1}", source, record,
                  code=pos.get("Code"), title=pos.get("Caption"))
    return {"estimate_positions": count,
            "position_mapping": "OpenXML_LS_Chapters_Chapter_Position",
            "position_mapping_applied": not declared_type or declared_type == ls_type}

