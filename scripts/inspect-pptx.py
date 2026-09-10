#!/usr/bin/env python3
"""Read PPTX object structure and embedded chart data; no Office automation.

This is evidence for export review, not a visual or editability certification.
Usage: python3 scripts/inspect-pptx.py presentation.pptx [another.pptx ...]
"""

import hashlib
import io
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}


def xml(archive, name):
    return ET.fromstring(archive.read(name))


def numbered(name):
    return int(re.search(r"(\d+)\.xml$", name).group(1))


def box(element):
    transform = element.find(".//a:xfrm", NS)
    if transform is None:
        transform = element.find("p:xfrm", NS)
    if transform is None:
        return None
    result = {}
    for child in transform:
        if child.tag.rsplit("}", 1)[-1] in ("off", "ext"):
            result.update({k: int(v) for k, v in child.attrib.items()})
    return result


def relationships(archive, part):
    folder, filename = posixpath.split(part)
    relpath = f"{folder}/_rels/{filename}.rels"
    if relpath not in archive.namelist():
        return {}
    return {
        rel.attrib["Id"]: (
            rel.attrib["Target"] if rel.get("TargetMode") == "External"
            else posixpath.normpath(posixpath.join(folder, rel.attrib["Target"])).lstrip("/")
        )
        for rel in xml(archive, relpath)
    }


def workbook(archive, name):
    with zipfile.ZipFile(io.BytesIO(archive.read(name))) as book:
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            strings = ["".join(node.itertext()) for node in xml(book, "xl/sharedStrings.xml")]
        sheets = {}
        for path in sorted(n for n in book.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
            cells = {}
            for cell in xml(book, path).findall(".//s:c", NS):
                value = cell.findtext("s:v", default="", namespaces=NS)
                if cell.get("t") == "s":
                    value = strings[int(value)]
                elif cell.get("t") == "inlineStr":
                    value = "".join(cell.find("s:is", NS).itertext())
                cells[cell.attrib["r"]] = value
            sheets[path] = cells
        return {"path": name, "sha256": hashlib.sha256(archive.read(name)).hexdigest(), "sheets": sheets}


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        files = archive.namelist()
        result = {
            "file": str(path.resolve()),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "slides": [],
            "charts": [],
            "workbooks": [],
        }
        for name in sorted((n for n in files if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=numbered):
            tree = xml(archive, name)
            objects = []
            for layer, element in enumerate(tree.find("p:cSld/p:spTree", NS)):
                kind = element.tag.rsplit("}", 1)[-1]
                if kind in ("nvGrpSpPr", "grpSpPr"):
                    continue
                texts = [t.text or "" for t in element.findall(".//a:t", NS)]
                obj = {"layer": layer, "kind": kind, "boxEmu": box(element)}
                if texts:
                    obj["textRuns"] = texts
                    obj["fonts"] = sorted(set(f.get("typeface") for f in element.findall(".//a:latin", NS) if f.get("typeface")))
                chart = element.find(".//c:chart", NS)
                if chart is not None:
                    obj["chartPart"] = relationships(archive, name).get(chart.get(f"{{{NS['r']}}}id"))
                fill = element.find("p:spPr/a:solidFill/a:srgbClr", NS)
                if fill is not None:
                    obj["fill"] = fill.get("val")
                objects.append(obj)
            result["slides"].append({
                "part": name,
                "textObjects": sum(bool(o.get("textRuns")) for o in objects),
                "pictures": sum(o["kind"] == "pic" for o in objects),
                "nativeCharts": len(tree.findall(".//c:chart", NS)),
                "nativeTables": len(tree.findall(".//a:tbl", NS)),
                "objects": objects,
            })
        for name in sorted(n for n in files if re.fullmatch(r"ppt/charts/chart\d+\.xml", n)):
            tree = xml(archive, name)
            result["charts"].append({
                "part": name,
                "series": [{
                    "labels": [v.text for v in series.findall("c:cat//c:pt/c:v", NS)],
                    "values": [v.text for v in series.findall("c:val//c:pt/c:v", NS)],
                } for series in tree.findall(".//c:ser", NS)],
            })
        for name in sorted(n for n in files if n.startswith("ppt/embeddings/") and n.endswith(".xlsx")):
            result["workbooks"].append(workbook(archive, name))
        return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    print(json.dumps([inspect(Path(p)) for p in sys.argv[1:]], ensure_ascii=False, indent=2))
