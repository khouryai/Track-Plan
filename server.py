#!/usr/bin/env python3
"""Track map server: serves web/ and a small JSON API over db/trackmap.db.

    python3 server.py [--port 8000]

API
  GET    /api/tracks                         calibrated tracks and MP ranges
  GET    /api/locate?track=W1&mp=23.5        drawing position of a milepost
  GET    /api/segment?track=W1&from=23&to=24 drawing geometry of an MP range
  GET    /api/requests[?track=W1]            access requests
  POST   /api/requests                       create (JSON body)
  PUT    /api/requests/<id>                  update (JSON body, partial)
  DELETE /api/requests/<id>
Standard library only.
"""
import argparse
import json
import os
import sqlite3
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DB = os.path.join(ROOT, "db", "trackmap.db")

FIELDS = ["request_no", "track_id", "from_mp", "to_mp", "start_time", "end_time",
          "work_type", "requester", "status", "notes"]
STATUSES = {"requested", "approved", "active", "completed", "cancelled"}


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


# ------------------------------------------------------------ linear referencing

def track_legs(con, track):
    rows = con.execute(
        "SELECT l.geometry, l.mps FROM track_legs l JOIN track_pieces p ON p.id = l.piece_id "
        "WHERE p.track_id = ? ORDER BY p.id, l.seq", (track,)).fetchall()
    return [(json.loads(r["geometry"]), json.loads(r["mps"])) for r in rows]


def segment(con, track, a, b):
    """Polylines covering milepost range [a, b] on a track."""
    lo, hi = min(a, b), max(a, b)
    out = []
    for pts, mps in track_legs(con, track):
        cur = []
        for (p0, p1), (m0, m1) in zip(zip(pts, pts[1:]), zip(mps, mps[1:])):
            c0, c1 = max(min(m0, m1), lo), min(max(m0, m1), hi)
            if c0 > c1:                      # segment outside the range
                if cur:
                    out.append(cur)
                    cur = []
                continue

            def at(m):
                f = 0.0 if m1 == m0 else (m - m0) / (m1 - m0)
                return [round(p0[0] + f * (p1[0] - p0[0]), 2), round(p0[1] + f * (p1[1] - p0[1]), 2)]
            start, end = (c0, c1) if m0 <= m1 else (c1, c0)
            if not cur:
                cur = [at(start)]
            cur.append(at(end))
        if cur:
            out.append(cur)
    return out


# ------------------------------------------------------------ HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            return
        super().log_message(fmt, *args)

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, status, msg):
        self.send_json({"error": msg}, status)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return None

    def route(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        return parts, {k: v[0] for k, v in parse_qs(u.query).items()}

    # -- validation shared by POST/PUT
    def clean(self, con, data, partial):
        if not isinstance(data, dict):
            return None, "body must be a JSON object"
        rec = {k: data[k] for k in FIELDS if k in data}
        if not partial:
            for k in ("track_id", "from_mp", "to_mp"):
                if rec.get(k) in (None, ""):
                    return None, f"{k} is required"
        if "track_id" in rec and not con.execute("SELECT 1 FROM tracks WHERE id=?", (rec["track_id"],)).fetchone():
            return None, f"unknown track {rec['track_id']!r}"
        for k in ("from_mp", "to_mp"):
            if k in rec:
                try:
                    rec[k] = float(rec[k])
                except (TypeError, ValueError):
                    return None, f"{k} must be a number"
        if "status" in rec and rec["status"] not in STATUSES:
            return None, f"status must be one of {sorted(STATUSES)}"
        return rec, None

    def do_GET(self):
        parts, q = self.route()
        if not parts or parts[0] != "api":
            return super().do_GET()
        con = db()
        try:
            if parts[1:] == ["tracks"]:
                return self.send_json([dict(r) for r in con.execute("SELECT * FROM tracks ORDER BY id")])
            if parts[1:] == ["requests"]:
                sql, args = "SELECT * FROM access_requests", []
                if "track" in q:
                    sql, args = sql + " WHERE track_id = ?", [q["track"]]
                return self.send_json([dict(r) for r in con.execute(sql + " ORDER BY start_time, id", args)])
            if parts[1:] in (["locate"], ["segment"]):
                try:
                    a = float(q["mp"] if parts[1] == "locate" else q["from"])
                    b = a if parts[1] == "locate" else float(q["to"])
                    track = q["track"]
                except (KeyError, ValueError):
                    return self.error_json(HTTPStatus.BAD_REQUEST, "need track and numeric mp / from,to")
                geo = segment(con, track, a, b)
                if not geo:
                    return self.error_json(HTTPStatus.NOT_FOUND, f"{track} MP {a}-{b} is outside the calibrated range")
                if parts[1] == "locate":
                    return self.send_json({"track": track, "mp": a, "x": geo[0][0][0], "y": geo[0][0][1]})
                return self.send_json({"track": track, "from_mp": a, "to_mp": b, "polylines": geo})
            return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        finally:
            con.close()

    def do_POST(self):
        parts, _ = self.route()
        if parts != ["api", "requests"]:
            return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        con = db()
        try:
            rec, err = self.clean(con, self.body(), partial=False)
            if err:
                return self.error_json(HTTPStatus.BAD_REQUEST, err)
            rec.setdefault("status", "requested")
            cur = con.execute(f"INSERT INTO access_requests({','.join(rec)}) VALUES ({','.join('?' * len(rec))})",
                              list(rec.values()))
            con.commit()
            row = con.execute("SELECT * FROM access_requests WHERE id=?", (cur.lastrowid,)).fetchone()
            return self.send_json(dict(row), HTTPStatus.CREATED)
        finally:
            con.close()

    def do_PUT(self):
        parts, _ = self.route()
        if len(parts) != 3 or parts[:2] != ["api", "requests"] or not parts[2].isdigit():
            return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        con = db()
        try:
            rec, err = self.clean(con, self.body(), partial=True)
            if err:
                return self.error_json(HTTPStatus.BAD_REQUEST, err)
            if rec:
                sets = ",".join(f"{k}=?" for k in rec)
                con.execute(f"UPDATE access_requests SET {sets}, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') "
                            "WHERE id=?", list(rec.values()) + [int(parts[2])])
                con.commit()
            row = con.execute("SELECT * FROM access_requests WHERE id=?", (int(parts[2]),)).fetchone()
            if row is None:
                return self.error_json(HTTPStatus.NOT_FOUND, "no such request")
            return self.send_json(dict(row))
        finally:
            con.close()

    def do_DELETE(self):
        parts, _ = self.route()
        if len(parts) != 3 or parts[:2] != ["api", "requests"] or not parts[2].isdigit():
            return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        con = db()
        try:
            n = con.execute("DELETE FROM access_requests WHERE id=?", (int(parts[2]),)).rowcount
            con.commit()
            if not n:
                return self.error_json(HTTPStatus.NOT_FOUND, "no such request")
            return self.send_json({"deleted": int(parts[2])})
        finally:
            con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    if not os.path.exists(DB):
        sys.path.insert(0, os.path.join(ROOT, "pipeline"))
        from dbload import write_db_from_json
        write_db_from_json()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Track map on http://{args.host}:{args.port}/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
