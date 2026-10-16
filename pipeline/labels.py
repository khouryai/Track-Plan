"""Decode milepost / interface-location labels and trace their leader lines."""
import math
import os
import re

import numpy as np
from scipy import ndimage

import pdfmap

STRUCT = np.ones((5, 5), bool)
_P = np.load(os.path.join(os.path.dirname(os.path.abspath(__file__)), "glyph_prototypes.npz"))
PROTOS, PLABELS = _P["protos"], list(_P["labels"])
PDIL = [ndimage.binary_dilation(p, STRUCT) for p in PROTOS]
PTOP = [int(np.argmax(p.any(axis=1))) for p in PROTOS]

# "24.39W1", "0.99Y", "11.68A2/L2", "2.08C3/C4", "19.71HTT", "1.65KX"
LABEL_RE = re.compile(r"^(?P<mp>\d{1,3}\.\d{1,4})(?P<track>[A-Z][A-Z0-9/]*)?$")


def classify(img, align=False):
    """Nearest glyph prototype.  align=True ignores vertical placement (for
    glyphs in containers other than milepost boxes, e.g. track-number tags)."""
    x0 = pdfmap.norm(img)
    top = int(np.argmax(x0.any(axis=1))) if x0.any() else 0
    best, bs = None, 0.0
    cache = {}
    for lab, p, dp, pt in zip(PLABELS, PROTOS, PDIL, PTOP):
        sh = (pt - top) if align else 0
        if sh not in cache:
            x = np.roll(x0, sh, axis=0)
            cache[sh] = (x, ndimage.binary_dilation(x, STRUCT))
        x, dx = cache[sh]
        s = min((x & dp).sum() / max(x.sum(), 1), (p & dx).sum() / max(p.sum(), 1))
        if s > bs:
            best, bs = lab, s
    return best, bs


def decode(prim):
    strokes = pdfmap.stroke_objects(prim)
    out = []
    for c in pdfmap.find_containers(prim):
        chars, used = pdfmap.segment_characters(c, strokes)
        labs = [classify(ch["img"]) for ch in chars]
        flipped = sum(l.endswith("~") for l, _ in labs) > len(labs) / 2
        text = "".join(l.rstrip("~") for l, _ in labs)
        if flipped:
            text = text[::-1]
        conf = min((s for _, s in labs), default=0.0)
        m = LABEL_RE.match(text)
        out.append(dict(
            kind=c["kind"], vert=c["vert"], bbox=[c["x0"], c["top"], c["x1"], c["bottom"]],
            text=text, flipped=flipped, confidence=round(float(conf), 3),
            mp=float(m.group("mp")) if m else None,
            track=(m.group("track") if m else None),
            valid=bool(m)))
    _dedupe(out)
    return out


def _dedupe(labels):
    """Overlapping containers (e.g. oval detected twice) keep one copy."""
    seen = set()
    for l in labels:
        key = tuple(round(v) for v in l["bbox"])
        l["dup"] = key in seen
        seen.add(key)
    labels[:] = [l for l in labels if not l["dup"]]
    for l in labels:
        del l["dup"]


# ---------------------------------------------------------------- leaders

def _seg_lines(prim):
    """Thin straight segments (0.6pt and lighter) usable as leader lines."""
    segs = []
    for o in prim["lines"]:
        if o["lw"] <= 0.72 and not o["fill"]:
            (x0, y0), (x1, y1) = o["pts"][0], o["pts"][-1]
            if math.hypot(x1 - x0, y1 - y0) > 1.5:
                segs.append((x0, y0, x1, y1))
    for o in prim["curves"]:     # bent leaders are drawn as open polylines
        if o["lw"] <= 0.72 and not o["fill"] and max(o["x1"] - o["x0"], o["bottom"] - o["top"]) >= 8:
            p = o["pts"]
            if len(p) <= 6 and p[0] != p[-1]:
                for (x0, y0), (x1, y1) in zip(p, p[1:]):
                    if math.hypot(x1 - x0, y1 - y0) > 1.5:
                        segs.append((x0, y0, x1, y1))
    return segs


def trace_leaders(prim, labels):
    """For each label find the leader line leaving its container and follow it
    (across small gaps where it is broken around other linework) to its end."""
    segs = _seg_lines(prim)
    # spatial hash of segment endpoints
    grid = {}
    for i, (x0, y0, x1, y1) in enumerate(segs):
        for e, (x, y) in enumerate(((x0, y0), (x1, y1))):
            grid.setdefault((int(x // 8), int(y // 8)), []).append((i, e))

    def near(x, y, r):
        for gx in range(int((x - r) // 8), int((x + r) // 8) + 1):
            for gy in range(int((y - r) // 8), int((y + r) // 8) + 1):
                for i, e in grid.get((gx, gy), ()):
                    s = segs[i]
                    px, py = (s[0], s[1]) if e == 0 else (s[2], s[3])
                    d = math.hypot(px - x, py - y)
                    if d <= r:
                        yield i, e, d

    for l in labels:
        x0, t, x1, b = l["bbox"]
        cx, cy = (x0 + x1) / 2, (t + b) / 2
        # candidate start points: midpoints of the container's edges
        starts = [(cx, t), (cx, b), (x0, cy), (x1, cy)]
        cands = []
        for sx, sy in starts:
            for i, e, d in near(sx, sy, 4.5):
                s = segs[i]
                fx, fy = (s[2], s[3]) if e == 0 else (s[0], s[1])
                # the far end must lie outside the container
                if x0 - 0.5 <= fx <= x1 + 0.5 and t - 0.5 <= fy <= b + 0.5:
                    continue
                cands.append((d, i, e))
        cands.sort()
        l["leaders"] = []
        seen_first = set()
        for _, i, e in cands:
            if i in seen_first:
                continue
            seen_first.add(i)
            l["leaders"].append(_follow(segs, near, i, e))
        l["leader"] = l["leaders"][0] if l["leaders"] else None
    return labels


def _follow(segs, near, i, e):
    used = {i}
    path = []
    s = segs[i]
    p0 = (s[0], s[1]) if e == 0 else (s[2], s[3])
    p1 = (s[2], s[3]) if e == 0 else (s[0], s[1])
    path += [p0, p1]
    while True:
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        n = math.hypot(dx, dy) or 1
        ux, uy = dx / n, dy / n
        nxt = None
        for j, e2, d in near(p1[0], p1[1], 7.0):
            if j in used:
                continue
            q = segs[j]
            a = (q[0], q[1]) if e2 == 0 else (q[2], q[3])
            z = (q[2], q[3]) if e2 == 0 else (q[0], q[1])
            vx, vy = z[0] - a[0], z[1] - a[1]
            m = math.hypot(vx, vy) or 1
            cos = (vx * ux + vy * uy) / m
            if d < 0.3:                      # connected corner: any turn
                ok = cos > -0.5
            else:                            # gap: must continue collinearly
                gx, gy = a[0] - p1[0], a[1] - p1[1]
                off = abs(gx * uy - gy * ux)
                ok = cos > 0.995 and off < 0.3 and (gx * ux + gy * uy) > 0
            if ok and (nxt is None or d < nxt[0]):
                nxt = (d, j, a, z)
        if nxt is None:
            break
        _, j, a, z = nxt
        used.add(j)
        p0, p1 = a, z
        path += [a, z]
    return [[round(x, 2), round(y, 2)] for x, y in path]


def track_tags(prim):
    """Small track-number tags ("1", "2", ...) drawn beside each running track.
    Returns list of dict(n, x, y, vert)."""
    strokes = [o for o in prim["curves"] + prim["lines"]
               if not o["fill"] and max(o["x1"] - o["x0"], o["bottom"] - o["top"]) < 8]
    out = []
    for r in prim["rects"]:
        w, h = r["x1"] - r["x0"], r["bottom"] - r["top"]
        if 14 < w < 18 and 4.5 < h < 7:
            vert = False
        elif 14 < h < 18 and 4.5 < w < 7:
            vert = True
        else:
            continue
        c = dict(x0=r["x0"], top=r["top"], x1=r["x1"], bottom=r["bottom"], vert=vert, kind="tag")
        chars, _ = pdfmap.segment_characters(c, strokes)
        if len(chars) != 1:
            continue
        lab, conf = classify(chars[0]["img"], align=True)
        lab = lab.rstrip("~")
        if lab in "1234" and conf > 0.85:
            out.append(dict(n=lab, x=(r["x0"] + r["x1"]) / 2, y=(r["top"] + r["bottom"]) / 2, vert=vert,
                            bbox=[r["x0"], r["top"], r["x1"], r["bottom"]]))
    return out
