"""Low-level access to the vector content of the system map PDF.

The sheet is an AutoCAD plot: every milepost label is drawn as SHX stroke
glyphs (one polyline per stroke), not as PDF text.  This module loads the
primitives once and finds the label containers (rectangular milepost boxes
and oval interface-location boxes), splitting the strokes inside them into
characters in reading orientation.
"""
import os
import pickle

import numpy as np
import pdfplumber
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "source", "System_Map_Print.pdf")
CACHE = os.path.join(ROOT, "build", "primitives.pkl")

GRID = 0.12          # AutoCAD plot resolution in PDF points
S = 10               # raster pixels per point for glyph images
GLYPH_W = 64         # raster width of one character image


def load_primitives():
    """Return dict(width, height, lines, rects, curves, chars) with plain tuples."""
    if os.path.exists(CACHE) and os.path.getmtime(CACHE) > os.path.getmtime(PDF):
        with open(CACHE, "rb") as f:
            return pickle.load(f)
    page = pdfplumber.open(PDF).pages[0]

    def strip(o):
        return dict(x0=o["x0"], top=o["top"], x1=o["x1"], bottom=o["bottom"],
                    pts=[(float(x), float(y)) for x, y in o["pts"]],
                    lw=round(o.get("linewidth") or 0, 2), fill=bool(o.get("fill")))

    prim = dict(width=page.width, height=page.height,
                lines=[strip(o) for o in page.lines],
                rects=[strip(o) for o in page.rects],
                curves=[strip(o) for o in page.curves],
                chars=[dict(text=c["text"], x0=c["x0"], top=c["top"], x1=c["x1"],
                            bottom=c["bottom"], size=c["size"], upright=c["upright"],
                            matrix=tuple(c["matrix"]), font=c["fontname"])
                       for c in page.chars])
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "wb") as f:
        pickle.dump(prim, f)
    return prim


def stroke_objects(prim):
    """Small unfilled polylines - candidate glyph strokes."""
    out = []
    for o in prim["curves"] + prim["lines"]:
        if o["fill"]:
            continue
        if max(o["x1"] - o["x0"], o["bottom"] - o["top"]) < 8:
            out.append(o)
    return out


def find_containers(prim):
    """Milepost rectangles and interface-location ovals.

    Returns dicts with bbox, kind ('box'|'oval') and vert (text runs along y).
    """
    cons = []
    for r in prim["rects"]:
        w, h = r["x1"] - r["x0"], r["bottom"] - r["top"]
        if 6 < w < 8 and 20 < h < 36:
            cons.append(dict(kind="box", vert=True, x0=r["x0"], top=r["top"], x1=r["x1"], bottom=r["bottom"]))
        elif 6 < h < 8 and 20 < w < 40:
            cons.append(dict(kind="box", vert=False, x0=r["x0"], top=r["top"], x1=r["x1"], bottom=r["bottom"]))
    # ovals: two parallel 0.6pt sides ~23.4 long, ~7.4 apart, with arc ends
    L = [l for l in prim["lines"] if l["lw"] == 0.6]
    V = [l for l in L if abs(l["x0"] - l["x1"]) < 0.01 and 20 < l["bottom"] - l["top"] < 26]
    H = [l for l in L if abs(l["top"] - l["bottom"]) < 0.01 and 20 < l["x1"] - l["x0"] < 26]
    for l in V:
        for m in V:
            d = m["x0"] - l["x0"]
            if 7 < d < 8 and abs(m["top"] - l["top"]) < 0.2 and abs(m["bottom"] - l["bottom"]) < 0.2:
                cons.append(dict(kind="oval", vert=True, x0=l["x0"], x1=m["x0"],
                                 top=l["top"] - d / 2, bottom=l["bottom"] + d / 2))
    for l in H:
        for m in H:
            d = m["top"] - l["top"]
            if 7 < d < 8 and abs(m["x0"] - l["x0"]) < 0.2 and abs(m["x1"] - l["x1"]) < 0.2:
                cons.append(dict(kind="oval", vert=False, top=l["top"], bottom=m["top"],
                                 x0=l["x0"] - d / 2, x1=l["x1"] + d / 2))
    return cons


def _frame(c, x, y):
    """Map page coords into the container's reading frame (col along text, row across)."""
    if c["vert"]:   # text reads bottom-to-top
        return (c["bottom"] - y) * S, (x - c["x0"]) * S
    return (x - c["x0"]) * S, (y - c["top"]) * S


def segment_characters(c, strokes):
    """Group the strokes inside container c into characters; returns list of
    dict(c0, c1, img) in reading order (before any 180-degree flip)."""
    eps = 0.15
    inside = [g for g in strokes if g["x0"] >= c["x0"] - eps and g["x1"] <= c["x1"] + eps
              and g["top"] >= c["top"] - eps and g["bottom"] <= c["bottom"] + eps]
    across = (c["x1"] - c["x0"]) if c["vert"] else (c["bottom"] - c["top"])
    H = int(across * S) + 6
    st = []
    for g in inside:
        fp = [_frame(c, x, y) for x, y in g["pts"]]
        if max(p[1] for p in fp) - min(p[1] for p in fp) > 6.2 * S:
            continue    # oval end-arc, not a glyph (glyphs are <=5.6pt tall)
        st.append((min(p[0] for p in fp), max(p[0] for p in fp), fp))
    st.sort(key=lambda s: s[0])
    groups = []
    for s in st:
        # strokes of one character touch or overlap along the text direction
        if groups and s[0] < groups[-1]["c1"] + 1.0:
            g = groups[-1]
            g["s"].append(s[2])
            g["c1"] = max(g["c1"], s[1])
        else:
            groups.append(dict(c0=s[0], c1=s[1], s=[s[2]]))
    chars = []
    for g in groups:
        im = Image.new("L", (GLYPH_W, H), 0)
        d = ImageDraw.Draw(im)
        for fp in g["s"]:
            q = [(p[0] - g["c0"] + 4, p[1] + 3) for p in fp]
            if len(q) == 1:
                q = q * 2
            d.line(q, fill=255, width=3)
        chars.append(dict(c0=g["c0"], c1=g["c1"], img=np.array(im) > 0))
    return chars, inside


GLYPH_H = 90


def norm(img):
    o = np.zeros((GLYPH_H, GLYPH_W), bool)
    h = min(GLYPH_H, img.shape[0])
    o[:h] = img[:h]
    return o
