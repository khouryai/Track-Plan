"""Every piece of track on the drawing as a selectable segment, plus the
station / train-control-room locations offered for access requests.

A segment is one network edge (track between two junctions or ends).  Each
gets a name a person would use, which comes from:
  * the running track it belongs to (from rail following: M1, W2, C3 ...)
  * the switch labels drawn beside it (crossovers: "Crossover SW389/SW387")
  * yard track labels in the drawing text (DTF01, TF5 ...)
and the calibrated milepost at each end where it meets a calibrated track, so
crossovers and yard leads can be described as "between M1 MP 16.20 and M3
MP 16.21" even though they carry no milepost labels of their own.
"""
import math
import re

import numpy as np

YARD_RE = re.compile(r"^(D?TF\d{1,2}|ST|HTT)$")


def _route_index(routes):
    """Flattened calibrated segments: arrays x0,y0,x1,y1,m0,m1 + track ids."""
    rows, names = [], []
    for t, r in routes.items():
        for pc in r["pieces"]:
            for lg in pc["legs"]:
                P, M = lg["pts"], lg["mps"]
                for i in range(len(P) - 1):
                    rows.append((*P[i], *P[i + 1], M[i], M[i + 1]))
                    names.append(t)
    return np.array(rows, float), names


def _nearest_route(R, names, x, y, r=12.0, track=None):
    if not len(R):
        return None
    x0, y0, x1, y1, m0, m1 = R.T
    dx, dy = x1 - x0, y1 - y0
    L2 = np.maximum(dx * dx + dy * dy, 1e-9)
    t = np.clip(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1)
    d = np.hypot(x0 + t * dx - x, y0 + t * dy - y)
    if track is not None:
        d = np.where(np.array(names) == track, d, np.inf)
    i = int(np.argmin(d))
    if d[i] > r:
        return None
    return dict(track=names[i], mp=round(float(m0[i] + t[i] * (m1[i] - m0[i])), 3), d=float(d[i]))


def _same_line_continuation(ends):
    """M2 running on into W2 (the W line continues the M line's mileposts):
    a gap in calibration along one physical track, not a crossover."""
    a, b = ends
    return a["track"][-1] == b["track"][-1] and a["track"][0] != b["track"][0] and abs(a["mp"] - b["mp"]) < 1.0


def _dist_to_poly(pts, x, y):
    p = np.asarray(pts, float)
    a, b = p[:-1], p[1:]
    ab = b - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-9)
    t = np.clip(((x - a[:, 0]) * ab[:, 0] + (y - a[:, 1]) * ab[:, 1]) / L2, 0, 1)
    q = a + t[:, None] * ab
    return float(np.min(np.hypot(q[:, 0] - x, q[:, 1] - y)))


def _samples(pts, step=2.0):
    p = np.asarray(pts, float)
    out = [p[0]]
    for a, b in zip(p[:-1], p[1:]):
        n = max(1, int(math.hypot(*(b - a)) / step))
        out += [a + (b - a) * k / n for k in range(1, n + 1)]
    return np.array(out)


def _diverging_legs(edges, probe=12.0):
    """For every junction, the first `probe` pt of its diverging leg: of the
    legs leaving the node, the one left over once the straightest pair (the
    through route) is taken out."""
    legs = {}
    for e in edges:
        for n, pts in ((e["a"], e["pts"]), (e["b"], e["pts"][::-1])):
            p = np.asarray(pts, float)
            cum = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
            k = min(len(p) - 1, max(1, int(np.searchsorted(cum, probe))))
            legs.setdefault(n, []).append(p[:k + 1])
    out = {}
    for n, L in legs.items():
        if len(L) < 3:
            continue
        dirs = [(l[-1] - l[0]) / (np.hypot(*(l[-1] - l[0])) or 1e-9) for l in L]
        best = min(((i, j) for i in range(len(L)) for j in range(i + 1, len(L))), key=lambda ij: float(dirs[ij[0]] @ dirs[ij[1]]))
        rest = [L[k] for k in range(len(L)) if k not in best]
        out[n] = (L[best[0]][0], rest)
    return out


def assign_switches(edges, switches, reach=26.0):
    """Each switch label marks exactly one turnout, i.e. one junction of the
    network.  Assign labels to junctions one-to-one, minimising distance to the
    junction plus distance to its diverging leg (labels are drawn beside the
    diverging leg), since nearest-label alone is ambiguous where turnouts are
    packed together."""
    from scipy.optimize import linear_sum_assignment
    J = _diverging_legs(edges)
    if not J or not switches:
        return {}
    nodes = list(J)
    C = np.array([[(w["bbox"][0] + w["bbox"][2]) / 2, (w["bbox"][1] + w["bbox"][3]) / 2] for w in switches])
    cost = np.full((len(switches), len(nodes)), 1e6)
    for j, n in enumerate(nodes):
        p, rest = J[n]
        d_node = np.hypot(C[:, 0] - p[0], C[:, 1] - p[1])
        d_leg = np.min([[_dist_to_poly(leg, x, y) if len(leg) > 1 else 99 for x, y in C] for leg in rest], axis=0)
        cost[:, j] = np.where(d_node <= reach, d_node + d_leg, 1e6)
    rows, cols = linear_sum_assignment(cost)
    return {nodes[c]: switches[r]["text"] for r, c in zip(rows, cols) if cost[r, c] < 1e6}


def build_segments(edges, edge_track, routes, words, text_words):
    R, names = _route_index(routes)
    switches = [w for w in words if re.fullmatch(r"SW\d{3,4}", w["text"])]
    yards = [w for w in text_words if YARD_RE.match(w["text"])]
    deg = {}
    for e in edges:
        deg[e["a"]] = deg.get(e["a"], 0) + 1
        deg[e["b"]] = deg.get(e["b"], 0) + 1
    node_sw = assign_switches(edges, switches)
    segs = []
    for i, e in enumerate(edges):
        pts = [[round(x, 2), round(y, 2)] for x, y in e["pts"]]
        L = float(e["length"])
        # how much of it is milepost-calibrated
        S = _samples(pts)
        hits = [_nearest_route(R, names, x, y, r=1.2) for x, y in S]
        cal = [h["track"] for h in hits if h]
        cal_track = max(set(cal), key=cal.count) if cal else None
        cal_frac = len(cal) / len(S)
        ends = []
        for (x, y) in (pts[0], pts[-1]):
            h = _nearest_route(R, names, x, y, r=14.0)
            ends.append({"track": h["track"], "mp": h["mp"]} if h else None)
        # labels drawn beside it
        def near(ws, r):
            out = []
            for w in ws:
                cx, cy = (w["bbox"][0] + w["bbox"][2]) / 2, (w["bbox"][1] + w["bbox"][3]) / 2
                d = _dist_to_poly(pts, cx, cy)
                if d <= r:
                    out.append((d, w["text"]))
            return [t for _, t in sorted(out)]
        sw = [x for x in (node_sw.get(e["a"]), node_sw.get(e["b"])) if x] or list(dict.fromkeys(near(switches, 14.0)))[:1]
        yd = list(dict.fromkeys(near(yards, 12.0)))[:1]
        track = edge_track.get(i)
        both_connected = deg.get(e["a"], 0) > 1 and deg.get(e["b"], 0) > 1
        if cal_frac >= 0.5:
            kind, name = "running", cal_track
        elif both_connected and L < 220 and ends[0] and ends[1] and ends[0]["track"] != ends[1]["track"] \
                and not _same_line_continuation(ends):
            kind = "crossover"
            pair = [x for x in (node_sw.get(e["a"]), node_sw.get(e["b"])) if x]
            pair = sorted(set(pair), key=lambda t: int(t[2:]))
            name = "Crossover " + "/".join(pair) if pair else "Crossover"
        elif yd:
            kind, name = "yard", yd[0]
        elif track:
            kind, name = "track", track
        elif sw:
            kind, name = "track", "Track at " + sw[0]
        else:
            kind, name = "track", "Track segment"
        segs.append(dict(id=i, a=int(e["a"]), b=int(e["b"]), pts=pts, len=round(L, 1),
                         kind=kind, name=name, track=track or cal_track, switches=sw, ends=ends,
                         calibrated=round(cal_frac, 2)))
    return segs


def locations(stations, routes):
    """Access-request locations: every station and its train control room,
    plus yards.  Positioned at the station's name box on the drawing."""
    R, names = _route_index(routes)
    out, seen = [], set()
    for s in sorted(stations, key=lambda s: s["name"]):
        if s["name"] in seen:
            continue
        seen.add(s["name"])
        h = _nearest_route(R, names, s["x"], s["y"], r=120.0)
        near = f"{h['track']} MP {h['mp']:.2f}" if h else None
        if "Yard" in s["name"]:
            out.append(dict(id="yard:" + s["name"], name=s["name"], kind="yard", x=s["x"], y=s["y"], near=near))
        elif "Platform" in s["name"]:
            out.append(dict(id="plat:" + s["name"], name=s["name"], kind="platform", x=s["x"], y=s["y"], near=near))
        else:
            out.append(dict(id="stn:" + s["name"], name=s["name"] + " Station", kind="station",
                            x=s["x"], y=s["y"], near=near))
            out.append(dict(id="tcr:" + s["name"], name=s["name"] + " TCR (Train Control Room)", kind="tcr",
                            x=s["x"], y=s["y"], near=near))
    return out
