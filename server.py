#!/usr/bin/env python3
"""Track map server: serves web/ and a JSON API over the map and operations databases.

    python3 server.py [--port 8000] [--host 127.0.0.1]
    python3 server.py --add-user USERNAME --name "Full Name" --role requester|manager|viewer

Map (open to anyone who can reach the server)
  GET    /api/tracks                         calibrated tracks and MP ranges
  GET    /api/locate?track=W1&mp=23.5        drawing position of a milepost
  GET    /api/segment?track=W1&from=23&to=24 drawing geometry of an MP range

Accounts
  GET    /api/me                             who is signed in; whether the first account is still to be made
  POST   /api/setup                          the first account (becomes the track allocation manager)
  POST   /api/login, /api/logout
  GET    /api/users, POST /api/users, PUT /api/users/<id>      (track allocation manager)

The look-ahead (signed in; changes by a requester or the manager)
  GET    /api/lookahead                      rows, cells, legend, support codes, version
  GET    /api/lookahead/version
  POST   /api/lookahead/ops                  {ops}: web/js/lookahead.js ops, all or nothing
  POST   /api/lookahead/replace              {rows, cells, legend?}: a workbook import
  PUT    /api/lookahead/legend, /api/lookahead/codes

TAWRs (signed in; who may do what is web/data/tawr_workflow.json)
  GET    /api/tawrs[?since=YYYY-MM-DD], GET /api/tawrs/merges
  POST   /api/tawrs                          a new draft
  PUT    /api/tawrs/<id>                     {fields} and, on a draft, {generated, source, …}
  POST   /api/tawrs/<id>/<action>            submit | withdraw | approve | reject | reopen | revise | discard
  POST   /api/tawrs/consolidate              {ids, merge, record, note}   (track allocation manager)
  POST   /api/tawrs/<id>/split                                             (track allocation manager)
  GET/PUT /api/tawr/settings, /api/tawr/template (application/pdf)
  GET/POST /api/tawr/descriptions, PUT/DELETE /api/tawr/descriptions/<id>

Legacy access requests (reads open; changes need a requester or the manager)
  GET    /api/requests[?track=W1], POST /api/requests, PUT/DELETE /api/requests/<id>

Every change must carry the header `X-Requested-With: trackplan`: a page on
another site cannot send it without the browser asking first, and this server
never says yes, so a signed-in browser cannot be made to change anything from
elsewhere. Standard library only.
"""
import argparse
import getpass
import json
import os
import sqlite3
import sys
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import operations as ops

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DB = os.path.join(ROOT, "db", "trackmap.db")
COOKIE = "tp_session"

FIELDS = ["request_no", "track_id", "from_mp", "to_mp", "start_time", "end_time",
          "work_type", "requester", "status", "notes", "location", "geometry", "limits", "description"]
JSON_FIELDS = ("geometry", "limits")
STATUSES = {"requested", "approved", "active", "completed", "cancelled"}
WORKFLOW = ops.load_workflow()


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def row(r):
    d = dict(r)
    for k in JSON_FIELDS:
        if d.get(k):
            d[k] = json.loads(d[k])
    return d


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

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, obj, status=HTTPStatus.OK, cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, data, content_type):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def error_json(self, status, msg):
        self.send_json({"error": msg}, status)

    def raw_body(self, limit=25_000_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ops.Refused("request too large", 413)
        return self.rfile.read(n) if n else b""

    def body(self):
        try:
            return json.loads(self.raw_body() or b"{}")
        except json.JSONDecodeError:
            return None

    def route(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        return parts, {k: v[0] for k, v in parse_qs(u.query).items()}

    def token(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c[COOKIE].value if COOKIE in c else None

    def actor(self, con):
        return ops.user_for_token(con, self.token())

    def session_cookie(self, token, clear=False):
        flags = "Path=/; HttpOnly; SameSite=Lax"
        if self.headers.get("X-Forwarded-Proto") == "https":
            flags += "; Secure"
        if clear:
            return f"{COOKIE}=; Max-Age=0; {flags}"
        return f"{COOKIE}={token}; Max-Age={ops.SESSION_DAYS * 86400}; {flags}"

    def same_site(self):
        """A change must say it came from this application (see the module's docstring)."""
        return self.headers.get("X-Requested-With") == "trackplan"

    # -------------------------------------------------- dispatch

    def handle_api(self, method):
        parts, q = self.route()
        if method != "GET" and not self.same_site():
            return self.error_json(HTTPStatus.FORBIDDEN, "missing X-Requested-With: trackplan")
        try:
            if parts[1:2] in (["tracks"], ["locate"], ["segment"], ["requests"]):
                return self.legacy(method, parts, q)
            con = ops.connect()
            try:
                return self.operations(con, method, parts[1:], q)
            finally:
                con.close()
        except ops.Refused as e:
            return self.error_json(e.status, str(e))

    def operations(self, con, method, p, q):
        me = self.actor(con)

        def need():
            if me is None:
                raise ops.Refused("sign in first", 401)
            return me

        # accounts
        if p == ["me"] and method == "GET":
            return self.send_json({"mode": "server", "user": me, "setup_needed": ops.user_count(con) == 0,
                                   "workflow": WORKFLOW})
        if p == ["setup"] and method == "POST":
            b = self.body() or {}
            if ops.user_count(con):
                raise ops.Refused("the first account has been made; sign in", 409)
            ops.create_user(con, b.get("username"), b.get("name"), "manager", b.get("password"))
            token, user = ops.login(con, b.get("username"), b.get("password"))
            return self.send_json({"user": user}, HTTPStatus.CREATED, cookie=self.session_cookie(token))
        if p == ["login"] and method == "POST":
            b = self.body() or {}
            token, user = ops.login(con, b.get("username"), b.get("password"))
            if not token:
                raise ops.Refused("wrong username or password", 401)
            return self.send_json({"user": user}, cookie=self.session_cookie(token))
        if p == ["logout"] and method == "POST":
            ops.logout(con, self.token())
            return self.send_json({"ok": True}, cookie=self.session_cookie(None, clear=True))
        if p == ["users"]:
            actor = need()
            if actor["role"] != "manager":
                raise ops.Refused("only the track allocation manager manages accounts")
            if method == "GET":
                return self.send_json(ops.list_users(con))
            if method == "POST":
                b = self.body() or {}
                return self.send_json(ops.create_user(con, b.get("username"), b.get("name"), b.get("role"),
                                                      b.get("password"), actor), HTTPStatus.CREATED)
        if len(p) == 2 and p[0] == "users" and p[1].isdigit() and method == "PUT":
            return self.send_json(ops.update_user(con, int(p[1]), self.body() or {}, need()))

        # the look-ahead
        if p == ["lookahead"] and method == "GET":
            need()
            return self.send_json(ops.lookahead(con))
        if p == ["lookahead", "version"] and method == "GET":
            need()
            return self.send_json({"version": ops.meta_get(con, "la_version", 0)})
        if p == ["lookahead", "ops"] and method == "POST":
            return self.send_json(ops.apply_ops(con, (self.body() or {}).get("ops"), need(), WORKFLOW))
        if p == ["lookahead", "replace"] and method == "POST":
            b = self.body() or {}
            return self.send_json(ops.replace_lookahead(con, b.get("rows"), b.get("cells"), need(), WORKFLOW, b.get("legend")))
        if p == ["lookahead", "legend"] and method == "PUT":
            return self.send_json(ops.set_legend(con, (self.body() or {}).get("legend"), need(), WORKFLOW))
        if p == ["lookahead", "codes"] and method == "PUT":
            return self.send_json(ops.set_codes(con, (self.body() or {}).get("codes"), need(), WORKFLOW))

        # TAWRs
        if p == ["tawrs"]:
            actor = need()
            if method == "GET":
                return self.send_json(ops.list_tawrs(con, q.get("since")))
            if method == "POST":
                return self.send_json(ops.create_tawr(con, self.body(), actor, WORKFLOW), HTTPStatus.CREATED)
        if p == ["tawrs", "merges"] and method == "GET":
            need()
            return self.send_json(ops.list_merges(con))
        if p == ["tawrs", "consolidate"] and method == "POST":
            b = self.body() or {}
            return self.send_json(ops.consolidate(con, b.get("ids"), b.get("merge"), b.get("record"), need(),
                                                  WORKFLOW, b.get("note")), HTTPStatus.CREATED)
        if len(p) == 2 and p[0] == "tawrs" and p[1].isdigit() and method == "PUT":
            return self.send_json(ops.update_tawr(con, int(p[1]), self.body(), need(), WORKFLOW))
        if len(p) == 3 and p[0] == "tawrs" and p[1].isdigit() and method == "POST":
            if p[2] == "split":
                return self.send_json(ops.split(con, int(p[1]), need(), WORKFLOW))
            return self.send_json(ops.act_on_tawr(con, int(p[1]), p[2], need(), WORKFLOW, (self.body() or {}).get("note")))
        if p == ["tawr", "settings"]:
            if method == "GET":
                return self.send_json(ops.get_settings(con, need(), WORKFLOW))
            if method == "PUT":
                return self.send_json(ops.set_settings(con, self.body(), need(), WORKFLOW))
        if p == ["tawr", "template"]:
            if method == "GET":
                data = ops.load_template(need())
                if data is None:
                    raise ops.Refused("BART's form has not been uploaded", 404)
                return self.send_bytes(data, "application/pdf")
            if method == "PUT":
                return self.send_json(ops.save_template(self.raw_body(), need(), WORKFLOW))
        if p == ["tawr", "descriptions"]:
            if method == "GET":
                need()
                return self.send_json(ops.list_descriptions(con))
            if method == "POST":
                return self.send_json(ops.save_description(con, None, self.body(), need(), WORKFLOW), HTTPStatus.CREATED)
        if len(p) == 3 and p[:2] == ["tawr", "descriptions"] and p[2].isdigit():
            if method == "PUT":
                return self.send_json(ops.save_description(con, int(p[2]), self.body(), need(), WORKFLOW))
            if method == "DELETE":
                return self.send_json(ops.delete_description(con, int(p[2]), need(), WORKFLOW))
        return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")

    # -------------------------------------------------- the map, and the legacy requests

    def clean(self, con, data, partial):
        if not isinstance(data, dict):
            return None, "body must be a JSON object"
        rec = {k: data[k] for k in FIELDS if k in data}
        if rec.get("track_id") and not con.execute("SELECT 1 FROM tracks WHERE id=?", (rec["track_id"],)).fetchone():
            return None, f"unknown track {rec['track_id']!r}"
        for k in ("from_mp", "to_mp"):
            if rec.get(k) is not None:
                try:
                    rec[k] = float(rec[k])
                except (TypeError, ValueError):
                    return None, f"{k} must be a number"
        if rec.get("geometry") is not None:
            g = rec["geometry"]
            try:
                ok = isinstance(g, list) and sum(len(pl) for pl in g) <= 200000 and all(
                    isinstance(pl, list) and len(pl) >= 2 and all(len(p) == 2 and all(isinstance(v, (int, float)) for v in p) for p in pl)
                    for pl in g)
            except TypeError:
                ok = False
            if not ok:
                return None, "geometry must be a list of polylines [[x, y], ...]"
        if rec.get("limits") is not None and not isinstance(rec["limits"], list):
            return None, "limits must be a list"
        for k in ("location", "description", "notes", "request_no", "work_type", "requester"):
            if rec.get(k) is not None and (not isinstance(rec[k], str) or len(rec[k]) > 4000):
                return None, f"{k} must be text"
        if "status" in rec and rec["status"] not in STATUSES:
            return None, f"status must be one of {sorted(STATUSES)}"
        if not partial and not (rec.get("geometry") or rec.get("location") or
                                (rec.get("track_id") and rec.get("from_mp") is not None and rec.get("to_mp") is not None)):
            return None, "give track limits (geometry), a track and MP range, or a location"
        for k in JSON_FIELDS:
            if k in rec and rec[k] is not None:
                rec[k] = json.dumps(rec[k], separators=(",", ":"))
        return rec, None

    def legacy(self, method, parts, q):
        if method != "GET":
            oc = ops.connect()
            try:
                ops.require_write(self.actor(oc), WORKFLOW)
            finally:
                oc.close()
        con = db()
        try:
            if method == "GET":
                if parts[1:] == ["tracks"]:
                    return self.send_json([dict(r) for r in con.execute("SELECT * FROM tracks ORDER BY id")])
                if parts[1:] == ["requests"]:
                    sql, args = "SELECT * FROM access_requests", []
                    if "track" in q:
                        sql, args = sql + " WHERE track_id = ?", [q["track"]]
                    return self.send_json([row(r) for r in con.execute(sql + " ORDER BY start_time, id", args)])
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
            if method == "POST" and parts == ["api", "requests"]:
                rec, err = self.clean(con, self.body(), partial=False)
                if err:
                    return self.error_json(HTTPStatus.BAD_REQUEST, err)
                rec.setdefault("status", "requested")
                cur = con.execute(f"INSERT INTO access_requests({','.join(rec)}) VALUES ({','.join('?' * len(rec))})",
                                  list(rec.values()))
                con.commit()
                r = con.execute("SELECT * FROM access_requests WHERE id=?", (cur.lastrowid,)).fetchone()
                return self.send_json(row(r), HTTPStatus.CREATED)
            if len(parts) != 3 or parts[:2] != ["api", "requests"] or not parts[2].isdigit():
                return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
            rid = int(parts[2])
            if method == "PUT":
                rec, err = self.clean(con, self.body(), partial=True)
                if err:
                    return self.error_json(HTTPStatus.BAD_REQUEST, err)
                if rec:
                    sets = ",".join(f"{k}=?" for k in rec)
                    con.execute(f"UPDATE access_requests SET {sets}, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') "
                                "WHERE id=?", list(rec.values()) + [rid])
                    con.commit()
                r = con.execute("SELECT * FROM access_requests WHERE id=?", (rid,)).fetchone()
                if r is None:
                    return self.error_json(HTTPStatus.NOT_FOUND, "no such request")
                return self.send_json(row(r))
            if method == "DELETE":
                n = con.execute("DELETE FROM access_requests WHERE id=?", (rid,)).rowcount
                con.commit()
                if not n:
                    return self.error_json(HTTPStatus.NOT_FOUND, "no such request")
                return self.send_json({"deleted": rid})
            return self.error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        finally:
            con.close()

    def do_GET(self):
        parts, _ = self.route()
        if not parts or parts[0] != "api":
            return super().do_GET()
        return self.handle_api("GET")

    def do_POST(self):
        return self.handle_api("POST")

    def do_PUT(self):
        return self.handle_api("PUT")

    def do_DELETE(self):
        return self.handle_api("DELETE")


def ensure_map_db():
    """Create the map database on first run, or upgrade an older one (requests are kept)."""
    stale = not os.path.exists(DB)
    if not stale:
        con = sqlite3.connect(DB)
        cols = {r[1] for r in con.execute("PRAGMA table_info(access_requests)")}
        con.close()
        stale = not {"geometry", "location", "limits"} <= cols
    if stale:
        sys.path.insert(0, os.path.join(ROOT, "pipeline"))
        from dbload import write_db_from_json
        write_db_from_json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--add-user", metavar="USERNAME", help="add an account and exit")
    ap.add_argument("--name", help="with --add-user: the person's name")
    ap.add_argument("--role", choices=ops.ROLES, default="requester", help="with --add-user")
    args = ap.parse_args()
    ops.init_db()
    if args.add_user:
        password = getpass.getpass(f"Password for {args.add_user}: ")
        con = ops.connect()
        try:
            first = ops.user_count(con) == 0
            # From the command line the person at the server is trusted, as the manager would be.
            actor = None if first else {"id": None, "role": "manager", "name": "server console"}
            user = ops.create_user(con, args.add_user, args.name or args.add_user, args.role, password, actor)
        except ops.Refused as e:
            sys.exit(str(e))
        finally:
            con.close()
        print(f"added {user['username']} as {WORKFLOW['roles'][user['role']]}")
        return
    ensure_map_db()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Track map on http://{args.host}:{args.port}/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
