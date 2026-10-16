"""Linear referencing: tie decoded mileposts to the track network and build
one milepost-calibrated route polyline per track (W1, W2, C1, ...).

Pipeline
  1. snap every label to the network via its leader line (end point, or a ray
     continued along the leader when it stops at a symbol beside the track);
  2. chain the anchors of each numbered track in MP order along shortest
     network paths, dropping anchors that force a detour (out of sequence);
  3. learn which network edges each track uses, then re-snap anchors that
     landed on a different track (leaders cross other tracks on their way);
  4. add line-level mileposts (e.g. "4.37C") to every track of that line the
     leader ray reaches, keeping them only where they fit the MP sequence;
  5. rebuild the routes.
"""
import math
import re

import networkx as nx
import numpy as np

SNAP_MAX = 9.0     # pt; a leader should end on (or right next to) its track
RAY_MAX = 90.0     # pt; how far to continue a leader looking for its track
TRACK_RE = re.compile(r"^([A-Z]+)(\d+)$")


class Network:
    def __init__(self, edges):
        self.edges = edges
        segs = []
        for ei, e in enumerate(edges):
            p = np.asarray(e["pts"], float)
            cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
            e["cum"] = cum
            e["length"] = float(cum[-1])
            for k in range(len(p) - 1):
                segs.append((ei, k, *p[k], *p[k + 1]))
        self.S = np.array(segs)
        self.G = nx.Graph()
        for ei, e in enumerate(edges):
            a, b = e["a"], e["b"]
            if a == b:
                continue
            if self.G.has_edge(a, b) and self.G[a][b]["w"] <= e["length"]:
                continue
            self.G.add_edge(a, b, w=e["length"], ei=ei)
        self._sp = {}

    # -- geometry helpers -------------------------------------------------
    def _mask(self, allowed):
        return np.isin(self.S[:, 0], list(allowed)) if allowed is not None else None

    def snap(self, x, y, allowed=None):
        """Nearest point on the network: dict(edge, s, x, y, dist)."""
        S = self.S
        x0, y0, x1, y1 = S[:, 2], S[:, 3], S[:, 4], S[:, 5]
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy
        L2[L2 == 0] = 1e-9
        t = np.clip(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1)
        px, py = x0 + t * dx, y0 + t * dy
        d = np.hypot(px - x, py - y)
        m = self._mask(allowed)
        if m is not None:
            if not m.any():
                return None
            d = np.where(m, d, np.inf)
        i = int(np.argmin(d))
        ei, k = int(S[i, 0]), int(S[i, 1])
        s = self.edges[ei]["cum"][k] + t[i] * math.sqrt(L2[i])
        return dict(edge=ei, s=float(s), x=float(px[i]), y=float(py[i]), dist=float(d[i]))

    def rays(self, x, y, ux, uy, max_t=RAY_MAX, allowed=None):
        """All network crossings of the ray (x,y)+t(ux,uy), sorted by t."""
        S = self.S
        x0, y0 = S[:, 2], S[:, 3]
        dx, dy = S[:, 4] - x0, S[:, 5] - y0
        den = ux * dy - uy * dx
        with np.errstate(divide="ignore", invalid="ignore"):
            t = ((x0 - x) * dy - (y0 - y) * dx) / den
            u = ((x0 - x) * uy - (y0 - y) * ux) / den
        ok = (np.abs(den) > 1e-9) & (t >= -0.5) & (t <= max_t) & (u >= 0) & (u <= 1)
        m = self._mask(allowed)
        if m is not None:
            ok &= m
        out = []
        for i in np.nonzero(ok)[0]:
            ei, k = int(S[i, 0]), int(S[i, 1])
            s = self.edges[ei]["cum"][k] + u[i] * math.hypot(dx[i], dy[i])
            out.append(dict(edge=ei, s=float(s), x=float(x0[i] + u[i] * dx[i]),
                            y=float(y0[i] + u[i] * dy[i]), dist=float(max(t[i], 0))))
        out.sort(key=lambda c: c["dist"])
        return out

    def point_at(self, ei, s):
        e = self.edges[ei]
        p, cum = np.asarray(e["pts"]), e["cum"]
        s = min(max(s, 0), cum[-1])
        k = int(np.searchsorted(cum, s, side="right") - 1)
        k = min(max(k, 0), len(p) - 2)
        seg = cum[k + 1] - cum[k] or 1e-9
        f = (s - cum[k]) / seg
        return (p[k] + f * (p[k + 1] - p[k])).tolist()

    def sub_polyline(self, ei, s0, s1):
        e = self.edges[ei]
        p, cum = np.asarray(e["pts"]), e["cum"]
        lo, hi = sorted((s0, s1))
        inner = [p[k].tolist() for k in range(len(p)) if lo < cum[k] < hi]
        pts = [self.point_at(ei, lo)] + inner + [self.point_at(ei, hi)]
        return pts if s0 <= s1 else pts[::-1]

    def _dist(self, a, b):
        key = (a, b) if a < b else (b, a)
        if key not in self._sp:
            try:
                self._sp[key] = nx.shortest_path_length(self.G, a, b, weight="w")
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                self._sp[key] = math.inf
        return self._sp[key]

    def path(self, A, B, want_pts=True):
        """Shortest path between two snapped points -> (length, polyline, edge ids)."""
        if A["edge"] == B["edge"]:
            pts = self.sub_polyline(A["edge"], A["s"], B["s"]) if want_pts else None
            return abs(A["s"] - B["s"]), pts, [A["edge"]]
        ea, eb = self.edges[A["edge"]], self.edges[B["edge"]]
        best = None
        for na, da in ((ea["a"], A["s"]), (ea["b"], ea["length"] - A["s"])):
            for nb, db in ((eb["a"], B["s"]), (eb["b"], eb["length"] - B["s"])):
                tot = da + self._dist(na, nb) + db
                if best is None or tot < best[0]:
                    best = (tot, na, nb)
        tot, na, nb = best
        if tot == math.inf:
            return math.inf, None, []
        nodes = nx.shortest_path(self.G, na, nb, weight="w")
        eids = [A["edge"]] + [self.G[u][v]["ei"] for u, v in zip(nodes, nodes[1:])] + [B["edge"]]
        if not want_pts:
            return tot, None, eids
        pts = self.sub_polyline(A["edge"], A["s"], 0 if na == ea["a"] else ea["length"])
        for u, v in zip(nodes, nodes[1:]):
            e = self.edges[self.G[u][v]["ei"]]
            seg = e["pts"] if e["a"] == u else e["pts"][::-1]
            pts += [list(q) for q in seg[1:]]
        pts += self.sub_polyline(B["edge"], 0 if nb == eb["a"] else eb["length"], B["s"])[1:]
        return tot, pts, eids


def track_ids(suffix):
    """'A2/L2' -> ['A2','L2'];  'W1' -> ['W1'];  None -> []"""
    return [t for t in (suffix or "").split("/") if t]


def numbered(t):
    return bool(TRACK_RE.match(t))


def _leader_dirs(l):
    for ld in l.get("leaders") or []:
        if len(ld) >= 2:
            (ax, ay), (bx, by) = ld[-2], ld[-1]
            n = math.hypot(bx - ax, by - ay) or 1
            yield (bx, by), ((bx - ax) / n, (by - ay) / n)


def snap_label(net, l, allowed=None):
    """Best network point for a label, optionally restricted to some edges."""
    best = None
    for (bx, by), _ in _leader_dirs(l):
        c = net.snap(bx, by, allowed)
        if c and c["dist"] <= SNAP_MAX and (best is None or c["dist"] < best["dist"]):
            best = dict(c, how="leader")
    if best is None:
        for (bx, by), (ux, uy) in _leader_dirs(l):
            hits = net.rays(bx, by, ux, uy, allowed=allowed)
            if hits and (best is None or hits[0]["dist"] < best["ray"]):
                best = dict(hits[0], how="leader-ray", ray=hits[0]["dist"])
    if best is None:
        x0, t, x1, b = l["bbox"]
        c = net.snap((x0 + x1) / 2, (t + b) / 2, allowed)
        if c and c["dist"] < 40:
            best = dict(c, how="nearest")
    return best


def anchor_labels(net, labels):
    anchors = []
    by_box = {}
    for li, l in enumerate(labels):
        if l["mp"] is None:
            continue
        sn = snap_label(net, l)
        a = dict(label=li, mp=l["mp"], suffix=l["track"], tracks=track_ids(l["track"]),
                 ok=sn is not None, **(sn or dict(edge=None, s=None, x=None, y=None, dist=None, how=None)))
        anchors.append(a)
        by_box[li] = a
    # side-by-side box pairs ("23.29W | 0.99Y") share one leader
    for a in anchors:
        if a["ok"]:
            continue
        bx = labels[a["label"]]["bbox"]
        for b in anchors:
            if b is a or not b["ok"]:
                continue
            ob = labels[b["label"]]["bbox"]
            touch = (abs(bx[2] - ob[0]) < 1.0 or abs(bx[0] - ob[2]) < 1.0 or
                     abs(bx[3] - ob[1]) < 1.0 or abs(bx[1] - ob[3]) < 1.0)
            overlap = min(bx[2], ob[2]) - max(bx[0], ob[0]) > -1 and min(bx[3], ob[3]) - max(bx[1], ob[1]) > -1
            if touch and overlap:
                a.update({k: b[k] for k in ("edge", "s", "x", "y", "dist")}, ok=True, how="paired")
                break
    return anchors


def _chain(net, A):
    """Order anchors by MP and drop those forcing detours. Returns (kept, dropped)."""
    A = sorted(A, key=lambda a: (a["mp"], a["label"]))
    uniq = []
    for a in A:
        if uniq and abs(uniq[-1]["mp"] - a["mp"]) < 1e-6:
            continue
        uniq.append(a)
    A, dropped = uniq, []
    while len(A) > 2:
        worst, wr = None, 1.25
        for i in range(1, len(A) - 1):
            d1 = net.path(A[i - 1], A[i], False)[0]
            d2 = net.path(A[i], A[i + 1], False)[0]
            d0 = net.path(A[i - 1], A[i + 1], False)[0]
            if d0 == math.inf:
                continue
            if (d1 + d2) - d0 > 15 and (d0 == 0 or (d1 + d2) / d0 > wr):
                worst, wr = i, (d1 + d2) / max(d0, 1e-9)
        if worst is None:
            break
        dropped.append(A.pop(worst))
    # endpoints can be out of sequence too: drop if unreachable
    while len(A) > 1 and net.path(A[0], A[1], False)[0] == math.inf:
        dropped.append(A.pop(0))
    while len(A) > 1 and net.path(A[-2], A[-1], False)[0] == math.inf:
        dropped.append(A.pop())
    return A, dropped


def _route_edges(net, A):
    used = set()
    for a, b in zip(A, A[1:]):
        used.update(net.path(a, b, False)[2])
    return used


def _between(net, A, cand):
    """Index at which cand fits A by MP, if its position is also consistent."""
    mps = [a["mp"] for a in A]
    i = int(np.searchsorted(mps, cand["mp"]))
    if i == 0 or i == len(A):
        return None
    if min(abs(cand["mp"] - mps[i - 1]), abs(mps[i] - cand["mp"])) < 1e-6:
        return None
    d0 = net.path(A[i - 1], A[i], False)[0]
    d1 = net.path(A[i - 1], cand, False)[0]
    d2 = net.path(cand, A[i], False)[0]
    if d0 == math.inf or (d1 + d2) - d0 > 2.0:
        return None
    # proportional sanity: position along leg vs MP fraction
    f_pos = d1 / max(d0, 1e-9)
    f_mp = (cand["mp"] - mps[i - 1]) / (mps[i] - mps[i - 1])
    if abs(f_pos - f_mp) > 0.6:
        return None
    return i


def _leg_overlap(net, a, b, eids, claimed, t):
    """Fraction of the a->b path that runs on edges claimed by another track."""
    tot = 0.0
    other = 0.0
    for ei in eids[1:-1]:
        L = net.edges[ei]["length"]
        tot += L
        if claimed.get(ei, t) != t:
            other += L
    return other / tot if tot > 0 else 0.0


def _segment(net, A, claimed, t):
    """Split a chain where a leg would run mostly along another track (track
    names such as C3 / W3 are reused for separate short tracks)."""
    segs = [[A[0]]] if A else []
    for a, b in zip(A, A[1:]):
        L, _, eids = net.path(a, b, False)
        if L == math.inf or _leg_overlap(net, a, b, eids, claimed, t) > 0.5:
            segs.append([b])
        else:
            segs[-1].append(b)
            for ei in eids[1:-1]:
                claimed.setdefault(ei, t)
    return segs


def _end_dir(e, at_start, probe=5.0):
    """Unit direction of edge e leaving its start (or end) node."""
    p = np.asarray(e["pts"])
    if not at_start:
        p = p[::-1]
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    k = int(np.searchsorted(cum, min(probe, cum[-1])))
    k = min(max(k, 1), len(p) - 1)
    v = p[k] - p[0]
    n = np.hypot(*v) or 1e-9
    return v / n


def build_rails(net, max_turn=35.0):
    """Partition network edges into rails: at every node, pair up incident edge
    ends that continue straight (smallest turn first).  Chains of paired edges
    are continuous running rails; diverging crossovers end up as short rails.
    Returns list of rails, each a list of (edge, forward) in travel order."""
    ends = {}
    for ei, e in enumerate(net.edges):
        if e["a"] == e["b"]:
            continue
        ends.setdefault(e["a"], []).append((ei, True, _end_dir(e, True)))
        ends.setdefault(e["b"], []).append((ei, False, _end_dir(e, False)))
    cos_max = math.cos(math.radians(max_turn))
    link = {}   # (edge, at_start) -> (edge, at_start)
    for node, E in ends.items():
        cands = []
        for i in range(len(E)):
            for j in range(i + 1, len(E)):
                c = -float(E[i][2] @ E[j][2])     # straight-through => opposite leaving dirs
                if c > cos_max and E[i][0] != E[j][0]:
                    cands.append((c, i, j))
        used = set()
        for c, i, j in sorted(cands, reverse=True):
            if i in used or j in used:
                continue
            used |= {i, j}
            link[(E[i][0], E[i][1])] = (E[j][0], E[j][1])
            link[(E[j][0], E[j][1])] = (E[i][0], E[i][1])
    seen, rails = set(), []
    for ei in range(len(net.edges)):
        if ei in seen or net.edges[ei]["a"] == net.edges[ei]["b"]:
            continue
        # walk backwards to the rail's start
        cur, fwd = ei, True
        guard = 0
        while (cur, fwd) in link and guard < 10000:
            nxt, at_start = link[(cur, fwd)]
            if nxt == ei:
                break
            cur, fwd = nxt, not at_start
            guard += 1
        # now walk forward from (cur, travelling away from that end)
        rail, start = [], cur
        cur = start
        while cur not in seen:
            seen.add(cur)
            rail.append((cur, fwd))
            key = (cur, not fwd)          # the end we leave from
            if key not in link:
                break
            nxt, at_start = link[key]
            cur, fwd = nxt, at_start
        rails.append(rail)
    return rails


TAG_REACH = 450.0   # pt along a rail that a track-number tag speaks for


def follow_tracks(net, votes, tags=()):
    """votes: list of (edge, s, track) from explicit mileposts; tags: list of
    (edge, s, number) from the drawn track-number tags.  Returns {edge: track}
    labelling every edge on a voted rail with the nearest consistent vote.
    A vote is discarded when the nearest tag on its rail names another number
    (leaders sometimes stop on the near track when they mean the far one)."""
    rails = build_rails(net)
    rail_of, off = {}, {}
    for ri, rail in enumerate(rails):
        pos = 0.0
        for ei, fwd in rail:
            rail_of[ei] = ri
            off[ei] = (pos, fwd)
            pos += net.edges[ei]["length"]
    def along(ei, s):
        p0, fwd = off[ei]
        return p0 + (s if fwd else net.edges[ei]["length"] - s)

    tag_rail = {}
    for ei, s, n in tags:
        if ei in rail_of:
            tag_rail.setdefault(rail_of[ei], []).append((along(ei, s), n))
    letters, numbers = {}, {}
    rejected = []
    for ei, s_, t in votes:
        if ei not in rail_of:
            continue
        ri, x = rail_of[ei], along(ei, s_)
        m = TRACK_RE.match(t)
        if m is None:                      # line-level milepost: letter only
            letters.setdefault(ri, []).append((x, t))
            continue
        T = tag_rail.get(ri)
        if T:
            tx, tn = min(T, key=lambda q: abs(q[0] - x))
            if abs(tx - x) < TAG_REACH and m.group(2) != tn:
                rejected.append((ei, s_, t))
                continue
        letters.setdefault(ri, []).append((x, m.group(1)))
        numbers.setdefault(ri, []).append((x, m.group(2)))
    for ri, T in tag_rail.items():
        numbers.setdefault(ri, []).extend(T)
    follow_tracks.rejected = rejected
    follow_tracks.rails, follow_tracks.rail_of, follow_tracks.tag_rail = rails, rail_of, tag_rail
    follow_tracks.along = along

    def nearest(V, x):
        return min(V, key=lambda v: abs(v[0] - x))[1]

    def smooth(V):
        V.sort()
        return [v for i, v in enumerate(V)
                if not (0 < i < len(V) - 1 and V[i - 1][1] == V[i + 1][1] != v[1])] or V

    label = {}
    for ri in set(letters) & set(numbers):
        Ls, Ns = smooth(letters[ri]), smooth(numbers[ri])
        for ei, fwd in rails[ri]:
            mid = along(ei, net.edges[ei]["length"] / 2)
            label[ei] = nearest(Ls, mid) + nearest(Ns, mid)
    return label


def _monotone_filter(items):
    """items: list of (pos, mp, weight, obj) along one rail.  Keep the heaviest
    subset whose MP is monotonic with position (either direction)."""
    items = sorted(items, key=lambda q: q[0])
    best = None
    for sign in (1, -1):
        n = len(items)
        W = [0.0] * n
        P = [-1] * n
        for i in range(n):
            W[i] = items[i][2]
            for j in range(i):
                if sign * (items[i][1] - items[j][1]) > 0 and W[j] + items[i][2] > W[i]:
                    W[i], P[i] = W[j] + items[i][2], j
        if n == 0:
            return [], []
        i = max(range(n), key=lambda k: W[k])
        keep = []
        while i >= 0:
            keep.append(i)
            i = P[i]
        if best is None or W[keep[0]] > best[0]:
            best = (W[keep[0]], set(keep))
    kept = [items[i][3] for i in sorted(best[1])]
    dropped = [items[i][3] for i in range(len(items)) if i not in best[1]]
    return kept, dropped


def solve(net, labels, tags=(), log=print):
    anchors = anchor_labels(net, labels)
    tag_snaps = []
    for tg in tags:
        c = net.snap(tg["x"], tg["y"])
        if c and c["dist"] < 12:
            tag_snaps.append((c["edge"], c["s"], tg["n"]))
    log(f"  {len(tag_snaps)} of {len(tags)} track-number tags snapped to rails")
    groups = {}
    for a in anchors:
        if a["ok"]:
            for t in a["tracks"]:
                if numbered(t):
                    groups.setdefault(t, []).append(a)
    # 1. rough chains -> trusted seeds for rail following
    votes = []
    for t, A in groups.items():
        for a in A:
            votes.append((a["edge"], a["s"], t))
    for a in anchors:
        if a["ok"]:
            for ln in a["tracks"]:
                if re.fullmatch(r"[A-Z]", ln):
                    votes.append((a["edge"], a["s"], ln))
    edge_track = follow_tracks(net, votes, tag_snaps)
    log(f"  {len(follow_tracks.rejected)} milepost votes contradicted by track-number tags")
    edges_of = {}
    for ei, t in edge_track.items():
        edges_of.setdefault(t, set()).add(ei)
        groups.setdefault(t, [])
    log(f"  rail following labelled {len(edge_track)} of {len(net.edges)} network edges")
    # 2. re-snap explicit anchors onto their own track's rails
    resnapped = 0
    for t, A in groups.items():
        E = edges_of.get(t)
        if not E:
            continue
        for i, a in enumerate(A):
            if a["edge"] in E:
                continue
            c = snap_label(net, labels[a["label"]], allowed=E)
            if c and c["how"] != "nearest":
                A[i] = dict(a, **{k: c[k] for k in ("edge", "s", "x", "y", "dist", "how")}, resnap=True)
                resnapped += 1
    log(f"  re-snapped {resnapped} anchors onto their own track")
    # 3. line-level mileposts project onto every track of their line
    added = 0
    for a in anchors:
        if not a["ok"]:
            continue
        for line in a["tracks"]:
            if not re.fullmatch(r"[A-Z]", line):
                continue
            for t, E in edges_of.items():
                if TRACK_RE.match(t).group(1) != line:
                    continue
                c = snap_label(net, labels[a["label"]], allowed=E)
                if c is None or c["how"] == "nearest":
                    continue
                groups[t].append(dict(a, **{k: c[k] for k in ("edge", "s", "x", "y", "dist", "how")},
                                      tracks=[t], line_level=True))
                added += 1
    log(f"  projected {added} line-level mileposts onto tracks")
    # 4. per rail, keep only anchors whose MP runs monotonically along the rail
    ft = follow_tracks
    pre_dropped = {}
    for t, A in groups.items():
        by_rail, rest = {}, []
        for a in A:
            ri = ft.rail_of.get(a["edge"])
            if ri is None:
                rest.append(a)
            else:
                w = 1.0 if a.get("line_level") else 2.0
                by_rail.setdefault(ri, []).append((ft.along(a["edge"], a["s"]), a["mp"], w, a))
        keep = list(rest)
        for ri, items in by_rail.items():
            k, d = _monotone_filter(items)
            keep += k
            pre_dropped.setdefault(t, []).extend(d)
        groups[t] = keep
    # 5. final chains, split where a leg leaves its own rails
    routes = {}
    claimed = dict(edge_track)
    for t in sorted(groups):
        if not groups[t]:
            continue
        A, dropped = _chain(net, groups[t])
        dropped = pre_dropped.get(t, []) + dropped
        segs = _segment(net, A, claimed, t)
        pieces = []
        for sg in segs:
            legs = []
            for a, b in zip(sg, sg[1:]):
                L, poly, _ = net.path(a, b)
                if poly is None:
                    continue
                cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(np.asarray(poly), axis=0).T))])
                tot = cum[-1] or 1e-9
                legs.append(dict(from_mp=a["mp"], to_mp=b["mp"], length=round(float(L), 2),
                                 pts=[[round(x, 2), round(y, 2)] for x, y in poly],
                                 mps=[round(a["mp"] + (b["mp"] - a["mp"]) * c / tot, 5) for c in cum]))
            pieces.append(dict(
                from_mp=sg[0]["mp"], to_mp=sg[-1]["mp"],
                anchors=[dict(mp=a["mp"], x=round(a["x"], 2), y=round(a["y"], 2), label=a["label"],
                              line_level=bool(a.get("line_level"))) for a in sg],
                legs=legs))
        routes[t] = dict(track=t, pieces=pieces,
                         dropped=[dict(mp=a["mp"], label=a["label"], line_level=bool(a.get("line_level")))
                                  for a in dropped])
        nd = [a["mp"] for a in dropped if not a.get("line_level")]
        if nd:
            log(f"  {t}: dropped out-of-sequence explicit anchors at MP {nd}")
    return anchors, routes, edge_track
