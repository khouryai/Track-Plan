"""Extract the track centreline network from the drawing.

Tracks are drawn as pairs of parallel 1.08pt lines ~3.7pt apart (grade and
subway sections) or as filled bars ~3.7pt thick (aerial sections), broken at
12pt train-control boxes.  We rasterise only that linework, close the gap
between the paired lines, skeletonise, and vectorise the skeleton into a
graph of polylines in PDF point coordinates.
"""
import math

import networkx as nx
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.morphology import skeletonize

R = 3.0   # raster pixels per point
TRACK_LW = (1.08, 0.84)   # 0.84 is used for the S-line (Warm Springs) section


def _bar_thickness(pts):
    """Thickness of a thin filled polygon (area / half perimeter heuristics)."""
    n = len(pts)
    if n < 3:
        return None
    a = 0.0
    per = 0.0
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        a += x0 * y1 - x1 * y0
        per += math.hypot(x1 - x0, y1 - y0)
    a = abs(a) / 2
    if per == 0:
        return None
    # for a long thin rectangle: area = L*t, per = 2L + 2t
    disc = (per / 2) ** 2 - 4 * a
    if disc < 0:
        return None
    return ((per / 2) - math.sqrt(disc)) / 2


def _thin_pairs(prim, lo=3.3, hi=4.0, min_overlap=2.0):
    """Thin straight segments that run parallel to a partner 3.3-4pt away: the
    two rails of a track drawn in a lighter weight (0.6/0.72/0.84pt)."""
    segs = []
    for o in prim["lines"] + prim["curves"]:
        if o["fill"] or o["lw"] >= 1.0 or o["lw"] == 0:
            continue
        p = o["pts"]
        for (x0, y0), (x1, y1) in zip(p, p[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            if L >= 4:
                segs.append((x0, y0, x1, y1, L))
    grid = {}
    for i, (x0, y0, x1, y1, L) in enumerate(segs):
        grid.setdefault((int((x0 + x1) / 2 // 40), int((y0 + y1) / 2 // 40)), []).append(i)
    keep = set()
    for i, (x0, y0, x1, y1, L) in enumerate(segs):
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        gx, gy = int((x0 + x1) / 2 // 40), int((y0 + y1) / 2 // 40)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if j <= i:
                        continue
                    a0, b0, a1, b1, M = segs[j]
                    vx, vy = (a1 - a0) / M, (b1 - b0) / M
                    if abs(ux * vx + uy * vy) < 0.999:
                        continue
                    off = abs((a0 - x0) * uy - (b0 - y0) * ux)
                    if not lo <= off <= hi:
                        continue
                    t0 = (a0 - x0) * ux + (b0 - y0) * uy
                    t1 = (a1 - x0) * ux + (b1 - y0) * uy
                    ov = min(L, max(t0, t1)) - max(0, min(t0, t1))
                    if ov >= min_overlap:
                        keep.add(i)
                        keep.add(j)
    return [segs[i][:4] for i in keep]


def track_mask(prim):
    W, H = int(prim["width"] * R) + 1, int(prim["height"] * R) + 1
    im = Image.new("1", (W, H), 0)
    d = ImageDraw.Draw(im)
    for o in prim["lines"] + prim["curves"]:
        if o["lw"] in TRACK_LW and not o["fill"]:
            d.line([(x * R, y * R) for x, y in o["pts"]], fill=1, width=max(1, int(1.08 * R)))
    for x0, y0, x1, y1 in _thin_pairs(prim):
        d.line([(x0 * R, y0 * R), (x1 * R, y1 * R)], fill=1, width=max(1, int(1.08 * R)))
    for o in prim["curves"]:
        if o["fill"] and len(o["pts"]) >= 4:
            t = _bar_thickness(o["pts"])
            span = max(o["x1"] - o["x0"], o["bottom"] - o["top"])
            if t is not None and 3.0 < t < 4.6 and span > 6:
                d.polygon([(x * R, y * R) for x, y in o["pts"]], fill=1)
    for o in prim["rects"]:   # train-control boxes sit on the track
        w, h = o["x1"] - o["x0"], o["bottom"] - o["top"]
        if 10.5 < w < 13 and 10.5 < h < 13:
            d.rectangle([o["x0"] * R, o["top"] * R, o["x1"] * R, o["bottom"] * R], fill=1)
    m = np.array(im, dtype=bool)
    r = int(2.6 * R)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    disk = xx * xx + yy * yy <= r * r
    m = ndimage.binary_closing(m, structure=disk)
    return m


def skeleton_graph(mask):
    sk = skeletonize(mask)
    ys, xs = np.nonzero(sk)
    idx = {(y, x): i for i, (y, x) in enumerate(zip(ys, xs))}
    G = nx.Graph()
    for (y, x), i in idx.items():
        for dy, dx in ((0, 1), (1, -1), (1, 0), (1, 1)):
            j = idx.get((y + dy, x + dx))
            if j is not None:
                G.add_edge(i, j, w=math.hypot(dy, dx))
    pos = np.stack([xs / R, ys / R], axis=1)
    return G, pos


def vectorise(G, pos, min_len=4.0, simplify=0.4):
    """Collapse the pixel graph into polyline edges between junctions/ends."""
    deg = dict(G.degree())
    nodes = {n for n, k in deg.items() if k != 2}
    edges = []
    seen = set()
    for n in nodes:
        for nb in G.neighbors(n):
            if (n, nb) in seen:
                continue
            path = [n, nb]
            prev, cur = n, nb
            while cur not in nodes:
                nxt = [k for k in G.neighbors(cur) if k != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                path.append(cur)
            seen.add((path[-1], path[-2]))
            seen.add((n, nb))
            edges.append(path)
    # pure cycles (no junction) are ignored - tracks always have ends/junctions
    out = []
    for p in edges:
        pts = pos[p]
        L = float(np.sum(np.hypot(*np.diff(pts, axis=0).T)))
        out.append(dict(a=int(p[0]), b=int(p[-1]), length=L, pts=_rdp(pts, simplify)))
    # drop short spurs (skeleton whiskers) hanging off junctions
    cnt = {}
    for e in out:
        cnt[e["a"]] = cnt.get(e["a"], 0) + 1
        cnt[e["b"]] = cnt.get(e["b"], 0) + 1
    out = [e for e in out if not (e["length"] < min_len and (cnt[e["a"]] == 1 or cnt[e["b"]] == 1))]
    return out


def _rdp(pts, eps):
    if len(pts) < 3:
        return [list(map(float, p)) for p in pts]
    a, b = pts[0], pts[-1]
    ab = b - a
    n = math.hypot(*ab) or 1e-9
    d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        return _rdp(pts[: i + 1], eps)[:-1] + _rdp(pts[i:], eps)
    return [list(map(float, a)), list(map(float, b))]


def _plen(pts):
    p = np.asarray(pts, float)
    return float(np.sum(np.hypot(*np.diff(p, axis=0).T))) if len(p) > 1 else 0.0


def _dir(pts, from_start, probe=5.0):
    p = np.asarray(pts, float)
    if not from_start:
        p = p[::-1]
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    k = min(max(int(np.searchsorted(cum, min(probe, cum[-1]))), 1), len(p) - 1)
    v = p[k] - p[0]
    return v / (np.hypot(*v) or 1e-9)


def clean(edges, micro=1.5, spur=12.0, gap=20.0):
    """Tidy the raw skeleton graph:
      * contract micro-edges (pixel triangles at junctions) into single nodes
      * prune short dangling spurs (track-number tags, box corners)
      * merge chains through degree-2 nodes into single polylines
      * bridge collinear gaps where the drawing style changes (portals, boxes)
    """
    # 1. contract micro edges
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    for e in edges:
        if e["length"] < micro:
            ra, rb = find(e["a"]), find(e["b"])
            if ra != rb:
                parent[ra] = rb
    coords = {}
    for e in edges:
        for n, p in ((e["a"], e["pts"][0]), (e["b"], e["pts"][-1])):
            coords.setdefault(find(n), []).append(p)
    cpos = {n: np.mean(np.asarray(v), axis=0).tolist() for n, v in coords.items()}
    E = []
    for e in edges:
        a, b = find(e["a"]), find(e["b"])
        if e["length"] < micro and a == b:
            continue
        pts = [cpos[a]] + [list(p) for p in e["pts"][1:-1]] + [cpos[b]]
        E.append(dict(a=a, b=b, pts=pts, length=_plen(pts)))

    def degrees(E):
        deg = {}
        for e in E:
            deg[e["a"]] = deg.get(e["a"], 0) + 1
            deg[e["b"]] = deg.get(e["b"], 0) + 1
        return deg

    # 2. prune spurs (repeat: removing one can expose another)
    for _ in range(3):
        deg = degrees(E)
        E = [e for e in E if not (e["length"] < spur and (deg[e["a"]] == 1) != (deg[e["b"]] == 1)
                                  and max(deg[e["a"]], deg[e["b"]]) >= 3)]
    # drop isolated scraps
    deg = degrees(E)
    E = [e for e in E if not (deg[e["a"]] == 1 and deg[e["b"]] == 1 and e["length"] < spur)]

    # 3. merge through degree-2 nodes
    def merge(E):
        while True:
            deg = degrees(E)
            inc = {}
            for i, e in enumerate(E):
                inc.setdefault(e["a"], []).append(i)
                inc.setdefault(e["b"], []).append(i)
            node = next((n for n, k in deg.items() if k == 2 and len(set(inc[n])) == 2), None)
            if node is None:
                return E
            i, j = inc[node]
            e1, e2 = E[i], E[j]
            p1 = e1["pts"] if e1["b"] == node else e1["pts"][::-1]
            a = e1["a"] if e1["b"] == node else e1["b"]
            p2 = e2["pts"] if e2["a"] == node else e2["pts"][::-1]
            b = e2["b"] if e2["a"] == node else e2["a"]
            pts = p1 + p2[1:]
            E = [e for k, e in enumerate(E) if k not in (i, j)]
            E.append(dict(a=a, b=b, pts=pts, length=_plen(pts)))

    E = merge(E)
    # 4. bridge collinear gaps between dead ends
    deg = degrees(E)
    ends = []
    for e in E:
        for n, at_start in ((e["a"], True), (e["b"], False)):
            if deg[n] == 1:
                p = np.asarray(e["pts"][0] if at_start else e["pts"][-1], float)
                ends.append((n, p, -_dir(e["pts"], at_start)))   # outward direction
    pairs = []
    for i in range(len(ends)):
        ni, pi, di = ends[i]
        for j in range(i + 1, len(ends)):
            nj, pj, dj = ends[j]
            v = pj - pi
            d = float(np.hypot(*v))
            if d == 0 or d > gap:
                continue
            u = v / d
            if float(di @ u) > 0.97 and float(dj @ -u) > 0.97:
                pairs.append((d, ni, nj, pi.tolist(), pj.tolist()))
    pairs.sort()
    used = set()
    for d, ni, nj, pi, pj in pairs:
        if ni in used or nj in used:
            continue
        used |= {ni, nj}
        E.append(dict(a=ni, b=nj, pts=[pi, pj], length=d, bridge=True))
    E = merge(E)
    for e in E:
        e["pts"] = _rdp(np.asarray(e["pts"], float), 0.4)
        e["length"] = _plen(e["pts"])
    return E


def extract(prim):
    m = track_mask(prim)
    G, pos = skeleton_graph(m)
    edges = clean(vectorise(G, pos, min_len=0.0))
    return m, edges
