"""Power facilities and interlocking limits, read off the drawing.

Two things the sheet draws that the track plan uses for checking requests:

* **Traction power.** Substations (triangles) and gap breaker stations
  (hexagons), each standing on a leader that runs through a milepost box to the
  track — so each is pinned to the milepost written in that box. Between two of
  them on a line is one power section: the stretch of third rail a power-off
  request takes out, and that a power-on request on the same stretch clashes
  with. Switching stations (diamonds) are listed too, but do not end a section.
* **Interlocking limits.** Dimension arrows under (or over) the tracks, labelled
  with the interlocking (C35, W45), between extension lines down from the
  tracks. Each track the arrow covers — the nearest arrow above or below it —
  is read as a milepost range on that track, so a request can be made by
  interlocking as well as by milepost. An interlocking named on the sheet
  without arrows (a station's, labelled at a point) has no limits here.

Run on its own it adds both to web/data/map.json without rebuilding anything
else; `build.py` runs it as part of the extraction.

    python3 pipeline/facilities.py
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import pdfmap  # noqa: E402

LEGEND_BOX = (0, 0, 600, 700)  # the sheet's legend, top left: its symbols are not on the railway
CODE_RE = re.compile(r"^[A-Z]{3}$")
TRACK_RE = re.compile(r"^([A-Z]+?)(\d+)$")


def _closed(o):
    p = o["pts"]
    return len(p) >= 4 and math.dist(p[0], p[-1]) < 0.5


def _in_legend(x, y):
    return LEGEND_BOX[0] <= x <= LEGEND_BOX[2] and LEGEND_BOX[1] <= y <= LEGEND_BOX[3]


def _lines_of(label):
    """The lines a milepost label speaks for: "13.53M1" → M, "11.68A2/L2" → A and L, "4.37C" → C."""
    out = []
    for t in label.get("tracks") or [label.get("suffix") or ""]:
        m = TRACK_RE.match(t) or re.match(r"^([A-Z]+)$", t)
        if m and m.group(1) not in out:
            out.append(m.group(1))
    return out


def power_facilities(prim, words, labels):
    """
    Every substation, gap breaker station and switching station on the sheet:
    `{kind, code, lines, track, mp, x, y}`, the milepost read from the box its
    leader runs through. A symbol with no box under or over it is left out.
    """
    shapes = {
        "substation": lambda o, n, w, h: n == 3 and 16 <= w <= 18.5 and 14 <= h <= 16.5,
        "gap_breaker": lambda o, n, w, h: n == 6 and 11 <= w <= 13 and 13 <= h <= 15,
        "switching": lambda o, n, w, h: n == 4 and 16 <= w <= 18.5 and 16 <= h <= 18.5,
    }
    out = []
    for o in prim["curves"] + prim["lines"]:
        if o["fill"] or not _closed(o):
            continue
        n, w, h = len(o["pts"]) - 1, o["x1"] - o["x0"], o["bottom"] - o["top"]
        kind = next((k for k, test in shapes.items() if test(o, n, w, h)), None)
        if kind is None:
            continue
        cx, cy = (o["x0"] + o["x1"]) / 2, (o["top"] + o["bottom"]) / 2
        if _in_legend(cx, cy):
            continue
        inside = [w["text"] for w in words
                  if o["x0"] - 1 <= (w["bbox"][0] + w["bbox"][2]) / 2 <= o["x1"] + 1
                  and o["top"] - 1 <= (w["bbox"][1] + w["bbox"][3]) / 2 <= o["bottom"] + 1]
        code = "".join(inside)
        near = [(l, l["bbox"][1] - o["bottom"]) for l in labels
                if abs((l["bbox"][0] + l["bbox"][2]) / 2 - cx) < 4 and 0 <= l["bbox"][1] - o["bottom"] < 45]
        near += [(l, o["top"] - l["bbox"][3]) for l in labels
                 if abs((l["bbox"][0] + l["bbox"][2]) / 2 - cx) < 4 and 0 <= o["top"] - l["bbox"][3] < 45]
        if not near:
            continue
        label = min(near, key=lambda p: p[1])[0]
        lines = _lines_of(label)
        if label.get("mp") is None or not lines:
            continue
        tracks = [t for t in (label.get("tracks") or []) if TRACK_RE.match(t)]
        out.append({
            "kind": kind, "code": code if CODE_RE.match(code) else None, "lines": lines,
            "track": tracks[0] if len(tracks) == 1 else None, "mp": label["mp"],
            "x": round(cx, 2), "y": round(cy, 2),
        })
    out.sort(key=lambda f: (f["lines"][0], f["mp"]))
    return out


def power_sections(facilities):
    """
    The power sections each line is cut into: between two substations or gap
    breaker stations next to each other along the line. `{id, line, from_mp,
    to_mp, from, to}` — `from` and `to` name the facilities at the ends.
    """
    by_line = {}
    for f in facilities:
        if f["kind"] == "switching":
            continue
        for line in f["lines"]:
            by_line.setdefault(line, []).append(f)
    out = []
    for line, fs in sorted(by_line.items()):
        fs = sorted({f["mp"]: f for f in fs}.values(), key=lambda f: f["mp"])
        for a, b in zip(fs, fs[1:]):
            if b["mp"] - a["mp"] < 0.05:
                continue
            name = lambda f: f["code"] or f"{'substation' if f['kind'] == 'substation' else 'gap breaker'} {f['mp']:.2f}"
            out.append({"id": f"{line}:{a['mp']:.2f}-{b['mp']:.2f}", "line": line, "from_mp": a["mp"], "to_mp": b["mp"],
                        "from": name(a), "to": name(b)})
    return out


def _arrows(prim, words):
    """
    Each interlocking's dimension arrow: `(name, x0, x1, y)`, its ends where its
    extension lines are, named by the label just above it — a label in the row
    above that has no arrow of its own is a point, not limits.
    """
    segs = [l for l in prim["lines"] + prim["curves"] if len(l["pts"]) == 2]
    H = [l for l in segs if abs(l["pts"][0][1] - l["pts"][1][1]) < 0.3 and abs(l["pts"][0][0] - l["pts"][1][0]) > 6]
    V = [l for l in segs if abs(l["pts"][0][0] - l["pts"][1][0]) < 0.3 and abs(l["pts"][0][1] - l["pts"][1][1]) > 4]
    names = [w for w in words if re.fullmatch(r"[A-Z]\d{2}", w["text"]) and w["bbox"][3] - w["bbox"][1] <= w["bbox"][2] - w["bbox"][0]]
    out = []
    for h in H:
        ay = h["pts"][0][1]
        ax0, ax1 = min(h["pts"][0][0], h["pts"][1][0]), max(h["pts"][0][0], h["pts"][1][0])
        over = [w for w in names if ax0 - 2 <= (w["bbox"][0] + w["bbox"][2]) / 2 <= ax1 + 2 and -1 <= ay - w["bbox"][3] <= 12]
        if not over:
            continue
        name = min(over, key=lambda w: ay - w["bbox"][3])["text"]

        def ext(x, side):
            c = [v for v in V if (x - 12 <= v["pts"][0][0] <= x + 0.5 if side < 0 else x - 0.5 <= v["pts"][0][0] <= x + 12)
                 and min(v["pts"][0][1], v["pts"][1][1]) < ay - 4 and max(v["pts"][0][1], v["pts"][1][1]) >= ay - 1]
            return min(c, key=lambda v: abs(v["pts"][0][0] - x))["pts"][0][0] if c else None

        e0, e1 = ext(ax0, -1), ext(ax1, 1)
        if e0 is None or e1 is None:
            continue  # an arrow that is not between extension lines is not an interlocking's limits
        out.append((name, e0, e1, ay))
    return out


def _portion(routes, track, x0, x1):
    """The stretch of a track between two x positions: `(mean y, from_mp, to_mp, length)`, or None."""
    lo = hi = None
    ys, length = [], 0.0
    for pc in routes.get(track, []):
        for lg in pc["legs"]:
            P, M = lg["pts"], lg["mps"]
            for i in range(len(P) - 1):
                (ax, ay), (bx, by) = P[i], P[i + 1]
                a, b = max(min(ax, bx), x0), min(max(ax, bx), x1)
                if a > b:
                    continue
                for xx in (a, b):
                    f = 0 if bx == ax else (xx - ax) / (bx - ax)
                    m = M[i] + f * (M[i + 1] - M[i])
                    lo = m if lo is None else min(lo, m)
                    hi = m if hi is None else max(hi, m)
                    ys.append(ay + f * (by - ay))
                length += b - a
    if lo is None or hi - lo < 0.005:
        return None
    return sum(ys) / len(ys), lo, hi, length


def interlockings(prim, words, routes):
    """
    The interlockings drawn with limits: `{name, limits: [{track, from_mp,
    to_mp}], boxes}`. A track is in the interlocking whose arrow is nearest it,
    above or below, where that arrow spans at least a third of the stretch.
    """
    arrows = _arrows(prim, words)
    found = {}
    for track in routes:
        for i, (name, x0, x1, ay) in enumerate(arrows):
            p = _portion(routes, track, x0, x1)
            if p is None or p[3] < (x1 - x0) / 3:
                continue
            found.setdefault(track, []).append((abs(p[0] - ay), i, p))
    by_arrow = {}
    for track, hits in found.items():
        # The nearest arrow over a stretch claims it; another arrow over a different stretch of the same track may too.
        for dist, i, p in sorted(hits):
            if dist > 110:
                continue
            name, x0, x1, ay = arrows[i]
            closer = [d for d, j, q in hits if j != i and d < dist and not (arrows[j][2] <= x0 or arrows[j][1] >= x1)]
            if closer:
                continue
            by_arrow.setdefault(i, []).append({"track": track, "from_mp": round(p[1], 3), "to_mp": round(p[2], 3)})
    out = {}
    for i, limits in by_arrow.items():
        name, x0, x1, ay = arrows[i]
        ix = out.setdefault(name, {"name": name, "limits": [], "boxes": []})
        ix["boxes"].append([round(x0, 1), round(ay - 110, 1), round(x1, 1), round(ay, 1)])
        for l in limits:
            held = next((h for h in ix["limits"] if h["track"] == l["track"]), None)
            if held:
                held["from_mp"], held["to_mp"] = min(held["from_mp"], l["from_mp"]), max(held["to_mp"], l["to_mp"])
            else:
                ix["limits"].append(l)
    for ix in out.values():
        _steady(ix["limits"])
        ix["limits"].sort(key=lambda l: (TRACK_RE.match(l["track"]).group(1), int(TRACK_RE.match(l["track"]).group(2))))
    return sorted(out.values(), key=lambda ix: (ix["name"][0], int(ix["name"][1:])))


def _steady(limits):
    """
    Where the drawing squeezes a long stretch (a tunnel) into the width of an
    interlocking, one track's calibration can run through it while the track
    beside it does not: C25 is C1 8.62–8.88 but C2 8.62–11.11. A track of a
    line whose range is more than three times the shortest of that line's, and
    over 0.6 mile, takes the shortest's range instead, marked `adjusted`.
    """
    by_line = {}
    for l in limits:
        by_line.setdefault(TRACK_RE.match(l["track"]).group(1), []).append(l)
    for same in by_line.values():
        if len(same) < 2:
            continue
        ref = min(same, key=lambda l: l["to_mp"] - l["from_mp"])
        span = ref["to_mp"] - ref["from_mp"]
        for l in same:
            if l is not ref and l["to_mp"] - l["from_mp"] > max(0.6, 3 * span):
                l.update(from_mp=ref["from_mp"], to_mp=ref["to_mp"], adjusted=True)


def add_to(data, prim, log=print):
    """Read both off the drawing into the map data, as build.py and main() do."""
    import pdfplumber
    import labels as labelmod
    page = pdfplumber.open(pdfmap.PDF).pages[0]
    text = [dict(text=w["text"], bbox=[w["x0"], w["top"], w["x1"], w["bottom"]]) for w in page.extract_words()]
    facilities = power_facilities(prim, labelmod.free_text(prim), data["labels"])
    data["power"] = {"facilities": facilities, "sections": power_sections(facilities)}
    data["interlockings"] = interlockings(prim, text, data["routes"])
    log(f"  {sum(f['kind'] == 'substation' for f in facilities)} substations, "
        f"{sum(f['kind'] == 'gap_breaker' for f in facilities)} gap breaker stations, "
        f"{len(data['power']['sections'])} power sections; "
        f"{len(data['interlockings'])} interlockings with limits")
    return data


def main():
    path = os.path.join(ROOT, "web", "data", "map.json")
    with open(path) as f:
        data = json.load(f)
    add_to(data, pdfmap.load_primitives())
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
