"""Build everything from source/System_Map_Print.pdf:

  web/map.svg          exact vector copy of the drawing (base layer)
  web/data/map.json    extracted data for the viewer
  db/trackmap.db       SQLite database (schema in db/schema.sql)
  docs/qa_report.md    items needing human review

Usage:  python3 pipeline/build.py [--skip-svg]
"""
import datetime
import json
import os
import pickle
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import labels as labelmod  # noqa: E402
import facilities  # noqa: E402
import linref  # noqa: E402
import pdfmap  # noqa: E402
import segments as segmod  # noqa: E402
import tracks  # noqa: E402
from dbload import write_db  # noqa: E402

ROOT = pdfmap.ROOT
WEB = os.path.join(ROOT, "web")
DB_DIR = os.path.join(ROOT, "db")
BUILD = os.path.join(ROOT, "build")
DOCS = os.path.join(ROOT, "docs")


def log(*a):
    print(*a, flush=True)


def make_svg():
    env = dict(os.environ, FONTCONFIG_FILE=os.path.join(HERE, "fonts.conf"))
    subprocess.run(["pdftocairo", "-svg", pdfmap.PDF, os.path.join(WEB, "map.svg")], check=True, env=env)


def stations(prim):
    """Station / yard names: white text in black filled boxes."""
    out, seen = [], set()
    for b in prim["curves"] + prim["rects"]:
        if not b["fill"]:
            continue
        w, h = b["x1"] - b["x0"], b["bottom"] - b["top"]
        if not (8 < w < 140 and 8 < h < 80):
            continue
        cs = [c for c in prim["chars"] if c["x0"] >= b["x0"] - 0.5 and c["x1"] <= b["x1"] + 0.5
              and c["top"] >= b["top"] - 0.5 and c["bottom"] <= b["bottom"] + 0.5]
        if not cs:
            continue
        m = cs[0]["matrix"]
        if abs(m[1]) > abs(m[0]):      # rotated: columns left->right, read bottom->top
            cols = {}
            for c in cs:
                cols.setdefault(round(c["x0"] / 2), []).append(c)
            lines = ["".join(c["text"] for c in sorted(v, key=lambda c: -c["bottom"])) for _, v in sorted(cols.items())]
        else:
            rows = {}
            for c in cs:
                rows.setdefault(round(c["top"] / 2), []).append(c)
            lines = ["".join(c["text"] for c in sorted(v, key=lambda c: c["x0"])) for _, v in sorted(rows.items())]
        name = " ".join(l.strip() for l in lines if l.strip())
        # skip track / interlocking codes in black boxes (K20, "Y 3", "1 Y C")
        if len(name) < 3 or (re.search(r"\d", name) and not re.search(r"[a-z]", name)):
            continue
        key = (name, round(b["x0"]), round(b["top"]))
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(name=name, bbox=[round(b["x0"], 2), round(b["top"], 2), round(b["x1"], 2), round(b["bottom"], 2)],
                        x=round((b["x0"] + b["x1"]) / 2, 2), y=round((b["top"] + b["bottom"]) / 2, 2)))
    return out


def text_words():
    """Upright real-text words (yard track names such as DTF01, TF5)."""
    import pdfplumber
    page = pdfplumber.open(pdfmap.PDF).pages[0]
    return [dict(text=w["text"], bbox=[w["x0"], w["top"], w["x1"], w["bottom"]]) for w in page.extract_words()]


def apply_overrides(L):
    path = os.path.join(HERE, "overrides.json")
    if not os.path.exists(path):
        return L
    with open(path) as f:
        rules = json.load(f).get("corrections", [])
    used = 0
    out = []
    for l in L:
        rule = next((r for r in rules if r["text"] == l["text"] and abs(r["x"] - l["bbox"][0]) <= 3
                     and abs(r["y"] - l["bbox"][1]) <= 3), None)
        if rule:
            used += 1
            if rule.get("ignore"):
                continue
            if "mp" in rule:
                l["mp"] = float(rule["mp"])
            if "track" in rule:
                l["track"] = rule["track"]
            l["corrected"] = True
        out.append(l)
    log(f"  applied {used} of {len(rules)} manual corrections from pipeline/overrides.json")
    return out


def main():
    t0 = time.time()
    os.makedirs(os.path.join(WEB, "data"), exist_ok=True)
    os.makedirs(DB_DIR, exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)
    if "--skip-svg" not in sys.argv:
        log("rendering base map SVG ...")
        make_svg()
    log("loading drawing primitives ...")
    prim = pdfmap.load_primitives()
    log("decoding milepost labels ...")
    L = apply_overrides(labelmod.decode(prim))
    labelmod.trace_leaders(prim, L)
    tags = labelmod.track_tags(prim)
    log(f"  {len(L)} labels, {len(tags)} track-number tags")
    log("extracting track network ...")
    _, edges = tracks.extract(prim)
    log(f"  {len(edges)} network edges, {sum(e['length'] for e in edges):.0f} pt of track")
    net = linref.Network(edges)
    log("solving milepost linear referencing ...")
    names = labelmod.track_names()
    anchors, routes, edge_track = linref.solve(net, L, tags, names, log=log)
    st = stations(prim)
    log(f"  {len(st)} station / yard names")
    log("naming every track segment ...")
    words = labelmod.free_text(prim)
    segs = segmod.build_segments(edges, edge_track, routes, words, text_words())
    kinds = {}
    for g in segs:
        kinds[g["kind"]] = kinds.get(g["kind"], 0) + 1
    log(f"  {len(segs)} segments {kinds}; {sum(w['text'].startswith('SW') for w in words)} switch labels read")
    locs = segmod.locations(st, routes)

    # ---- label status
    used, line_used, dropped = {}, set(), {}
    for t, r in routes.items():
        for pc in r["pieces"]:
            for a in pc["anchors"]:
                if a["line_level"]:
                    line_used.add(a["label"])
                else:
                    used.setdefault(a["label"], []).append(t)
        for d in r["dropped"]:
            if not d["line_level"]:
                dropped.setdefault(d["label"], []).append(t)
    anc_by_label = {a["label"]: a for a in anchors}
    out_labels = []
    for i, l in enumerate(L):
        a = anc_by_label.get(i)
        if l["mp"] is None:
            status = "unreadable"
        elif a is None or not a["ok"]:
            status = "unanchored"
        elif i in used:
            status = "anchored"
        elif i in dropped:
            status = "out_of_sequence"
        elif i in line_used:
            status = "line_level"
        elif not l["track"]:
            status = "facility"
        else:
            status = "unused"
        out_labels.append(dict(
            id=i, text=l["text"], mp=l["mp"], suffix=l["track"], kind=l["kind"],
            bbox=[round(v, 2) for v in l["bbox"]], confidence=l["confidence"], flipped=l["flipped"],
            x=round(a["x"], 2) if a and a["ok"] else None, y=round(a["y"], 2) if a and a["ok"] else None,
            snap=a["how"] if a else None, status=status,
            tracks=sorted(set(used.get(i, []) + dropped.get(i, []))) or (a["tracks"] if a else [])))

    # drop internal-only fields from routes, add summary
    track_list = []
    for t, r in sorted(routes.items()):
        m = linref.TRACK_RE.match(t)
        pieces = [p for p in r["pieces"] if p["legs"]]
        if not pieces:
            continue
        track_list.append(dict(id=t, line=m.group(1), number=int(m.group(2)),
                               from_mp=min(min(p["from_mp"], p["to_mp"]) for p in pieces),
                               to_mp=max(max(p["from_mp"], p["to_mp"]) for p in pieces)))
        r["pieces"] = pieces

    data = dict(
        generated=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        source=os.path.basename(pdfmap.PDF),
        page=dict(width=prim["width"], height=prim["height"]),
        tracks=track_list,
        routes={t["id"]: routes[t["id"]]["pieces"] for t in track_list},
        labels=out_labels,
        stations=st,
        tags=tags,
        segments=segs,
        locations=locs,
        switches=[dict(text=w["text"], bbox=[round(v, 2) for v in w["bbox"]]) for w in words if w["text"].startswith("SW")],
    )
    log("reading power facilities and interlocking limits ...")
    facilities.add_to(data, prim, log=log)
    with open(os.path.join(WEB, "data", "map.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    log(f"wrote web/data/map.json ({os.path.getsize(os.path.join(WEB, 'data', 'map.json')) / 1e6:.1f} MB)")
    write_db(data, log)
    write_qa(data, routes)
    with open(os.path.join(BUILD, "solve.pkl"), "wb") as f:
        pickle.dump((L, anchors, routes, edge_track, edges), f)
    log(f"done in {time.time() - t0:.0f}s")


def write_qa(data, routes):
    L = data["labels"]
    by = {}
    for l in L:
        by.setdefault(l["status"], []).append(l)
    lines = ["# Extraction QA report", "",
             f"Source: `{data['source']}` - generated {data['generated']}", "",
             "## Summary", "",
             f"- Milepost labels decoded: **{len(L)}** "
             f"({sum(l['kind'] == 'box' for l in L)} milepost boxes, {sum(l['kind'] == 'oval' for l in L)} interface ovals)",
             f"- Lowest glyph-match confidence: {min(l['confidence'] for l in L):.3f}",
             f"- Tracks with milepost-calibrated geometry: **{len(data['tracks'])}** "
             f"({', '.join(t['id'] for t in data['tracks'])})",
             f"- Stations / yards named: {len(data['stations'])}", ""]
    lines += ["| status | count | meaning |", "|---|---|---|"]
    meaning = {
        "anchored": "track-specific milepost used to calibrate its track",
        "line_level": "line milepost (e.g. `4.37C`) projected onto each track of the line",
        "facility": "milepost of a facility (vent room, substation...) with no track suffix",
        "out_of_sequence": "**review** - conflicts with neighbouring mileposts, not used",
        "unanchored": "**review** - leader could not be traced to a track",
        "unused": "**review** - decoded but not used (track has no calibrated route)",
        "unreadable": "**review** - text did not parse as a milepost",
    }
    for k in ["anchored", "line_level", "facility", "out_of_sequence", "unanchored", "unused", "unreadable"]:
        lines.append(f"| {k} | {len(by.get(k, []))} | {meaning[k]} |")
    lines += ["", "## Track coverage", "", "| track | MP range | pieces | anchors (explicit + line-level) |",
              "|---|---|---|---|"]
    for t in data["tracks"]:
        P = data["routes"][t["id"]]
        ne = sum(not a["line_level"] for p in P for a in p["anchors"])
        nl = sum(a["line_level"] for p in P for a in p["anchors"])
        rng = ", ".join(f"{p['from_mp']}-{p['to_mp']}" for p in P)
        lines.append(f"| {t['id']} | {rng} | {len(P)} | {ne} + {nl} |")
    for k, title in [("out_of_sequence", "Out-of-sequence mileposts (check the drawing)"),
                     ("unanchored", "Mileposts whose leader could not be followed to a track"),
                     ("unused", "Decoded but unused")]:
        items = by.get(k, [])
        if not items:
            continue
        lines += ["", f"## {title}", "", "| label | page position (pt) | tracks |", "|---|---|---|"]
        for l in sorted(items, key=lambda l: (l["suffix"] or "", l["mp"] or 0)):
            bx = l["bbox"]
            lines.append(f"| `{l['text']}` | x {bx[0]:.0f}, y {bx[1]:.0f} | {', '.join(l['tracks'])} |")
    os.makedirs(DOCS, exist_ok=True)
    with open(os.path.join(DOCS, "qa_report.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    log("wrote docs/qa_report.md")


if __name__ == "__main__":
    main()
