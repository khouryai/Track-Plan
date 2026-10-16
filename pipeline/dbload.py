"""Create db/trackmap.db from web/data/map.json (standard library only).

Used by pipeline/build.py after extraction, and by server.py to create the
database on first run from the committed map.json.  Existing access requests
are carried over when the database is rebuilt.
"""
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DIR = os.path.join(ROOT, "db")


def write_db(data, log=print):
    path = os.path.join(DB_DIR, "trackmap.db")
    keep_requests = []
    if os.path.exists(path):        # preserve access requests across rebuilds
        old = sqlite3.connect(path)
        try:
            old.row_factory = sqlite3.Row
            keep_requests = [dict(r) for r in old.execute("SELECT * FROM access_requests")]
        except sqlite3.Error:
            pass
        old.close()
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(open(os.path.join(DB_DIR, "schema.sql")).read())
    db.executemany("INSERT INTO tracks(id,line,number,from_mp,to_mp) VALUES (?,?,?,?,?)",
                   [(t["id"], t["line"], t["number"], t["from_mp"], t["to_mp"]) for t in data["tracks"]])
    db.executemany(
        "INSERT INTO milepost_labels(id,text,mp,suffix,kind,status,confidence,x,y,bbox) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(l["id"], l["text"], l["mp"], l["suffix"], l["kind"], l["status"], l["confidence"], l["x"], l["y"],
          json.dumps(l["bbox"])) for l in data["labels"]])
    for t, pieces in data["routes"].items():
        for pc in pieces:
            cur = db.execute("INSERT INTO track_pieces(track_id,from_mp,to_mp) VALUES (?,?,?)",
                             (t, pc["from_mp"], pc["to_mp"]))
            pid = cur.lastrowid
            for k, lg in enumerate(pc["legs"]):
                db.execute("INSERT INTO track_legs(piece_id,seq,from_mp,to_mp,geometry,mps) VALUES (?,?,?,?,?,?)",
                           (pid, k, lg["from_mp"], lg["to_mp"], json.dumps(lg["pts"]), json.dumps(lg["mps"])))
            for a in pc["anchors"]:
                db.execute("INSERT INTO route_anchors(track_id,piece_id,mp,x,y,label_id,line_level) VALUES (?,?,?,?,?,?,?)",
                           (t, pid, a["mp"], a["x"], a["y"], a["label"], int(a["line_level"])))
    db.executemany(
        "INSERT INTO track_segments(id,name,kind,track_id,switches,end_a,end_b,length_pt,geometry) VALUES (?,?,?,?,?,?,?,?,?)",
        [(g["id"], g["name"], g["kind"], g["track"], json.dumps(g["switches"]), json.dumps(g["ends"][0]),
          json.dumps(g["ends"][1]), g["len"], json.dumps(g["pts"])) for g in data.get("segments", [])])
    db.executemany("INSERT INTO locations(id,name,kind,x,y,near) VALUES (?,?,?,?,?,?)",
                   [(l["id"], l["name"], l["kind"], l["x"], l["y"], l["near"]) for l in data.get("locations", [])])
    db.executemany("INSERT INTO stations(name,x,y,bbox) VALUES (?,?,?,?)",
                   [(s["name"], s["x"], s["y"], json.dumps(s["bbox"])) for s in data["stations"]])
    if keep_requests:
        cols = [c[1] for c in db.execute("PRAGMA table_info(access_requests)")]
        for r in keep_requests:
            r = {k: v for k, v in r.items() if k in cols}
            db.execute(f"INSERT INTO access_requests({','.join(r)}) VALUES ({','.join('?' * len(r))})", list(r.values()))
    db.commit()
    db.close()
    log(f"wrote db/trackmap.db ({len(keep_requests)} existing access requests preserved)")


def write_db_from_json(path=os.path.join(ROOT, "web", "data", "map.json"), log=print):
    with open(path) as f:
        write_db(json.load(f), log)


if __name__ == "__main__":
    write_db_from_json()
