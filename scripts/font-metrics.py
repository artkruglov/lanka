#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate lib/domain/font-metrics-plex.json for the Focus 3 renderer.

Usage:
  python3 scripts/font-metrics.py fonts/IBMPlexSans-Regular.ttf fonts/IBMPlexSans-SemiBold.ttf fonts/IBMPlexMono-Medium.ttf > lib/domain/font-metrics-plex.json

Requires fontTools (pip install fonttools). Output shape:
{
  "family": {"sans": "IBM Plex Sans", "mono": "IBM Plex Mono"},
  "files":  {"sans-regular": ..., "sans-bold": ..., "mono": ...},
  "vertical": {"sans": {"ascent": 1.025, "descent": 0.275, "capHeight": ..., "xHeight": ...}, "mono": {...}},
  "widths":  {"sans-regular": {"<codepoint>": advance/unitsPerEm, ...}, "sans-bold": {...}, "mono": {...}}
}
All numbers are in em (divided by unitsPerEm). Advance widths only; kerning is not applied by the
renderer, so measured widths are conservative by a few px on kerned pairs.
"""
import json, sys
from fontTools.ttLib import TTFont

def widths(path):
    f = TTFont(path)
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    hmtx = f["hmtx"].metrics
    out = {}
    for cp, gname in cmap.items():
        if gname in hmtx:
            out[str(cp)] = round(hmtx[gname][0] / upm, 5)
    hhea, os2 = f["hhea"], f["OS/2"]
    vertical = {
        "ascent": round(hhea.ascent / upm, 4),
        "descent": round(abs(hhea.descent) / upm, 4),
        "capHeight": round(getattr(os2, "sCapHeight", 0) / upm, 4),
        "xHeight": round(getattr(os2, "sxHeight", 0) / upm, 4),
        "typoAscent": round(os2.sTypoAscender / upm, 4),
        "typoDescent": round(abs(os2.sTypoDescender) / upm, 4),
    }
    name = f["name"].getDebugName(16) or f["name"].getDebugName(1)  # typographic family, else family
    return name, vertical, out

def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    sans_r, sans_b, mono = argv[1:]
    n1, v1, w1 = widths(sans_r)
    n2, v2, w2 = widths(sans_b)
    n3, v3, w3 = widths(mono)
    doc = {
        "family": {"sans": n1, "mono": n3},
        "files": {"sans-regular": sans_r, "sans-bold": sans_b, "mono": mono},
        "vertical": {"sans": v1, "mono": v3},
        "widths": {"sans-regular": w1, "sans-bold": w2, "mono": w3},
    }
    json.dump(doc, sys.stdout, ensure_ascii=False, separators=(",", ":"))

if __name__ == "__main__":
    main(sys.argv)
