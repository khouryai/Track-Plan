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


# ---------------------------------------------------------------- free text

def free_text(prim):
    """Horizontal stroke-glyph text that is not inside a milepost box, oval or
    track tag: switch numbers (SW389, or SW stacked over 389), derails (DR53)
    and facility codes (WXE, MXD).  Returns list of dict(text, bbox, conf)."""
    import collections
    boxes = [(c["x0"], c["top"], c["x1"], c["bottom"]) for c in pdfmap.find_containers(prim)]
    boxes += [(r["x0"], r["top"], r["x1"], r["bottom"]) for r in prim["rects"]
              if (14 < r["x1"] - r["x0"] < 18 and 4.5 < r["bottom"] - r["top"] < 7)
              or (14 < r["bottom"] - r["top"] < 18 and 4.5 < r["x1"] - r["x0"] < 7)]
    B = np.array(boxes)
    free = []
    for g in pdfmap.stroke_objects(prim):
        if not 0 < g["lw"] <= 0.7 or g["bottom"] - g["top"] > 4.2 or g["x1"] - g["x0"] > 4.2:
            continue
        if ((B[:, 0] - 0.3 <= g["x0"]) & (B[:, 2] + 0.3 >= g["x1"]) &
                (B[:, 1] - 0.3 <= g["top"]) & (B[:, 3] + 0.3 >= g["bottom"])).any():
            continue
        free.append(g)
    parent = list(range(len(free)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    grid = collections.defaultdict(list)
    for i, g in enumerate(free):
        grid[(int(g["x0"] // 10), int(g["top"] // 10))].append(i)
    for i, g in enumerate(free):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid[(int(g["x0"] // 10) + dx, int(g["top"] // 10) + dy)]:
                    if j <= i:
                        continue
                    h = free[j]
                    vo = min(g["bottom"], h["bottom"]) - max(g["top"], h["top"])
                    if vo < 0.5 * min(g["bottom"] - g["top"], h["bottom"] - h["top"], 3.0):
                        continue
                    if max(h["x0"] - g["x1"], g["x0"] - h["x1"]) < 2.2:   # same word
                        parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i, g in enumerate(free):
        groups[find(i)].append(g)
    words = []
    for G in groups.values():
        x0, x1 = min(g["x0"] for g in G), max(g["x1"] for g in G)
        t, b = min(g["top"] for g in G), max(g["bottom"] for g in G)
        if b - t < 2.5:
            continue
        c = dict(x0=x0 - 0.5, x1=x1 + 0.5, top=t - 1.5, bottom=b + 1.5, vert=False, kind="free")
        chars, _ = pdfmap.segment_characters(c, G)
        labs = [classify(ch["img"], align=True) for ch in chars]
        if not labs:
            continue
        words.append(dict(text="".join(l.rstrip("~") for l, _ in labs),
                          conf=round(float(min(s for _, s in labs)), 3), bbox=[x0, t, x1, b]))
    # "SW" stacked over its number
    used = set()
    for w in words:
        if w["text"] != "SW":
            continue
        x0, t, x1, b = w["bbox"]
        below = [v for v in words if re.fullmatch(r"\d{2,4}", v["text"]) and id(v) not in used
                 and 0 <= v["bbox"][1] - b < 3.0 and min(x1, v["bbox"][2]) - max(x0, v["bbox"][0]) > -1.5]
        if below:
            v = min(below, key=lambda v: v["bbox"][1] - b)
            used.add(id(v))
            w["text"] = "SW" + v["text"]
            w["bbox"] = [min(x0, v["bbox"][0]), t, max(x1, v["bbox"][2]), v["bbox"][3]]
            w["conf"] = min(w["conf"], v["conf"])
    return [w for w in words if id(w) not in used and w["conf"] >= 0.9]


def track_names(pdf_path=None):
    """Track names written beside the lines in real text ("M3", "W1", "C2")."""
    import pdfplumber
    page = pdfplumber.open(pdf_path or pdfmap.PDF).pages[0]
    out = []
    for w in page.extract_words():
        if re.fullmatch(r"[ACKLMRSWY]X?\d", w["text"]):
            out.append(dict(name=w["text"], x=(w["x0"] + w["x1"]) / 2, y=(w["top"] + w["bottom"]) / 2,
                            bbox=[w["x0"], w["top"], w["x1"], w["bottom"]]))
    return out
