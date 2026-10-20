"""Operational data for the track map: accounts, the look-ahead and TAWRs.

server.py is the HTTP front; this module is what it does, so the rules can be
tested without a socket (tests/test_server.py). Everything a person may or may
not do is decided here, never in the browser: the browser only offers what
web/data/tawr_workflow.json allows, and this module refuses anything else
with a reason.

Standard library only. The database is db/operations.db (schema in
db/operations.sql), apart from the map database that the extraction rebuilds.
"""
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
# TRACKPLAN_OPS_DB and TRACKPLAN_TEMPLATE put both somewhere else — the tests
# use them so a run never touches the real database.
OPS_DB = os.environ.get("TRACKPLAN_OPS_DB") or os.path.join(ROOT, "db", "operations.db")
SCHEMA = os.path.join(ROOT, "db", "operations.sql")
WORKFLOW_PATH = os.path.join(ROOT, "web", "data", "tawr_workflow.json")
TEMPLATE_PATH = os.environ.get("TRACKPLAN_TEMPLATE") or os.path.join(ROOT, "db", "tawr_template.pdf")

ROLES = ("requester", "manager", "viewer")
SESSION_DAYS = 14
PBKDF2_ITERATIONS = 200_000
ROW_FIELDS = ("kind", "parent_id", "sort", "activity_id", "description", "location",
              "sswp", "party", "work_hours", "link")
TEXT_LIMIT = 4000
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX_RE = re.compile(r"^[0-9A-Fa-f]{6}$")

DEFAULT_LEGEND = [
    {"argb": "FFFF00", "meaning": "Day Shift", "role": "shift"},
    {"argb": "FFC000", "meaning": "Swing Shift", "role": "shift"},
    {"argb": "0070C0", "meaning": "Night Shift", "role": "shift"},
    {"argb": "000000", "meaning": "Blanket Shift", "role": "shift"},
    {"argb": "FF0000", "meaning": "Cancellation", "role": "shift"},
]
DEFAULT_CODES = [
    {"code": "X", "name": "EIC", "party": "BART", "sort": 10, "tawr_line": "systems", "active": True},
    {"code": "WIT", "name": "BART witness", "party": "BART", "sort": 20, "tawr_line": "none", "active": True},
    {"code": "TCE", "name": "TCE", "party": "BART", "sort": 30, "tawr_line": "systems", "active": True},
    {"code": "ROC", "name": "ROC", "party": "BART", "sort": 40, "tawr_line": "occ", "active": True},
]


class Refused(Exception):
    """A request the rules do not allow. `status` is the HTTP status to answer with."""

    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_workflow(path=WORKFLOW_PATH):
    with open(path) as f:
        return json.load(f)


# ------------------------------------------------------------ the database

def connect(path=None):
    con = sqlite3.connect(path or OPS_DB, timeout=15, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db(path=None):
    """Create or upgrade the operations database. Safe to run on every start."""
    path = path or OPS_DB
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = connect(path)
    try:
        con.execute("PRAGMA journal_mode = WAL")
        with open(SCHEMA) as f:
            schema = f.read()
        con.executescript(schema)
        if _upgrade_tawrs(con, schema):
            con.executescript(schema)  # its indexes went with the old table
        for key, value in (("legend", DEFAULT_LEGEND), ("codes", DEFAULT_CODES), ("la_version", 0),
                           ("la_edits_since", now_iso())):
            con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", (key, json.dumps(value)))
    finally:
        con.close()


def _upgrade_tawrs(con, schema):
    """
    A database made before BART's answer was recorded: its requests table
    allows fewer statuses and has no `bart` or `access`. SQLite cannot change a
    CHECK constraint, so the table is rebuilt from the schema and every row
    copied across, ids and all. Answers whether it was.
    """
    row = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tawrs'").fetchone()
    if row is None or "'cancelled'" in row["sql"]:
        return False
    create = re.search(r"CREATE TABLE IF NOT EXISTS tawrs \(.*?\n\);", schema, re.S).group(0)
    old = [r["name"] for r in con.execute("PRAGMA table_info(tawrs)")]
    cols = ", ".join(old)
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        with Tx(con):
            con.execute(create.replace("CREATE TABLE IF NOT EXISTS tawrs (", "CREATE TABLE tawrs_new (", 1))
            con.execute(f"INSERT INTO tawrs_new ({cols}) SELECT {cols} FROM tawrs")
            con.execute("DROP TABLE tawrs")
            con.execute("ALTER TABLE tawrs_new RENAME TO tawrs")
            if con.execute("PRAGMA foreign_key_check(tawrs)").fetchone():
                raise RuntimeError("the requests table did not survive its upgrade")
    finally:
        con.execute("PRAGMA foreign_keys = ON")
    return True


class Tx:
    """BEGIN IMMEDIATE … COMMIT, or ROLLBACK on any exception."""

    def __init__(self, con):
        self.con = con

    def __enter__(self):
        self.con.execute("BEGIN IMMEDIATE")
        return self.con

    def __exit__(self, kind, *_):
        self.con.execute("ROLLBACK" if kind else "COMMIT")
        return False


def meta_get(con, key, default=None):
    r = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(r["value"]) if r and r["value"] is not None else default


def meta_set(con, key, value):
    con.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)))


# ------------------------------------------------------------ accounts

def hash_password(password, salt=None, iterations=PBKDF2_ITERATIONS):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt}${digest}"


def check_password(password, stored):
    try:
        _, iterations, salt, digest = stored.split("$")
        mine = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(mine, digest)


def public_user(r):
    return None if r is None else {"id": r["id"], "username": r["username"], "name": r["name"],
                                   "role": r["role"], "active": bool(r["active"])}


def user_count(con):
    return con.execute("SELECT count(*) FROM users").fetchone()[0]


def _check_account(username, name, role, password, partial=False):
    if not partial or username is not None:
        if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._@-]{2,64}", username or ""):
            raise Refused("username: 2-64 letters, digits or . _ @ -", 400)
    if not partial or name is not None:
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise Refused("give a name", 400)
    if not partial or role is not None:
        if role not in ROLES:
            raise Refused(f"role must be one of {', '.join(ROLES)}", 400)
    if not partial or password is not None:
        if not isinstance(password, str) or len(password) < 8:
            raise Refused("the password must be at least 8 characters", 400)


def create_user(con, username, name, role, password, actor=None):
    """An account. The first ever is the track allocation manager and needs no actor."""
    _check_account(username, name, role, password)
    with Tx(con):
        first = user_count(con) == 0
        if not first and (actor is None or actor["role"] != "manager"):
            raise Refused("only the track allocation manager adds accounts")
        if first:
            role = "manager"
        if con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise Refused(f"{username} already has an account", 409)
        cur = con.execute("INSERT INTO users(username, name, role, password_hash) VALUES (?, ?, ?, ?)",
                          (username, name.strip(), role, hash_password(password)))
        return public_user(con.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_user(con, user_id, changes, actor):
    if actor["role"] != "manager":
        raise Refused("only the track allocation manager changes accounts")
    _check_account(None, changes.get("name"), changes.get("role"), changes.get("password"), partial=True)
    with Tx(con):
        r = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if r is None:
            raise Refused("no such account", 404)
        role = changes.get("role", r["role"])
        active = bool(changes.get("active", bool(r["active"])))
        if r["role"] == "manager" and (role != "manager" or not active):
            others = con.execute("SELECT count(*) FROM users WHERE role = 'manager' AND active = 1 AND id <> ?",
                                 (user_id,)).fetchone()[0]
            if not others:
                raise Refused("there has to be one active track allocation manager", 409)
        sets = {"role": role, "active": int(active)}
        if changes.get("name") is not None:
            sets["name"] = changes["name"].strip()
        if changes.get("password") is not None:
            sets["password_hash"] = hash_password(changes["password"])
        con.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                    list(sets.values()) + [user_id])
        if not active or changes.get("password") is not None:
            con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        return public_user(con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def list_users(con):
    return [public_user(r) for r in con.execute("SELECT * FROM users ORDER BY active DESC, name")]


def login(con, username, password):
    """A session token for the right password, or None."""
    r = con.execute("SELECT * FROM users WHERE username = ? AND active = 1", (username or "",)).fetchone()
    if r is None or not check_password(password or "", r["password_hash"]):
        return None, None
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with Tx(con):
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso(),))
        con.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                    (hashlib.sha256(token.encode()).hexdigest(), r["id"], expires))
    return token, public_user(r)


def logout(con, token):
    if token:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))


def user_for_token(con, token):
    if not token:
        return None
    r = con.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
        (hashlib.sha256(token.encode()).hexdigest(), now_iso())).fetchone()
    return public_user(r)


def require_write(actor, workflow):
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] not in workflow["write"]:
        raise Refused("a viewer cannot change anything")


# ------------------------------------------------------------ the look-ahead

def _row_out(r):
    d = {k: r[k] for k in ("id",) + ROW_FIELDS}
    d["link"] = json.loads(r["link"]) if r["link"] else None
    return d


def lookahead(con):
    return {
        "rows": [_row_out(r) for r in con.execute("SELECT * FROM la_rows ORDER BY sort, id")],
        "cells": [dict(r) for r in con.execute("SELECT row_id, day, color, text FROM la_cells")],
        "legend": meta_get(con, "legend", DEFAULT_LEGEND),
        "codes": meta_get(con, "codes", DEFAULT_CODES),
        "version": meta_get(con, "la_version", 0),
    }


def _text(v, name):
    if v is None:
        return ""
    if not isinstance(v, str) or len(v) > TEXT_LIMIT:
        raise Refused(f"{name} must be text", 400)
    return v


def _check_link(link):
    if link is None:
        return None
    if not isinstance(link, dict):
        raise Refused("link must be an object", 400)
    geom = link.get("geometry") or []
    try:
        ok = isinstance(geom, list) and sum(len(pl) for pl in geom) <= 200000 and all(
            isinstance(pl, list) and all(isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p)
                                         for p in pl) for pl in geom)
    except TypeError:
        ok = False
    if not ok:
        raise Refused("link geometry must be a list of polylines [[x, y], ...]", 400)
    if not isinstance(link.get("limits") or [], list):
        raise Refused("link limits must be a list", 400)
    return json.dumps(link, separators=(",", ":"))


# What a look-ahead row's history keeps of a link: where it is, never the drawing's geometry.
LINK_BRIEF = ("location_id", "location_name", "location_kind", "limits")
# A row's own fields as its history tells them; where it sits (`sort`) is not what it says.
LOGGED_ROW_FIELDS = ("kind", "parent_id", "activity_id", "description", "location", "sswp", "party", "work_hours", "link")


def _link_brief(link):
    if not link:
        return None
    if isinstance(link, str):
        link = json.loads(link)
    return {k: link[k] for k in LINK_BRIEF if link.get(k) is not None}


def _row_brief(r):
    """A row as its history keeps it: what it says, never where it sits."""
    out = {}
    for k in LOGGED_ROW_FIELDS:
        v = r[k] if k in r.keys() else None
        out[k] = _link_brief(v) if k == "link" else v
    return out


def _row_label(con, r):
    """What a row was called when it changed: "C-W101 · Cable trough", and a Resource row by its activity."""
    if r is None:
        return ""
    if r["kind"] == "resource":
        parent = con.execute("SELECT * FROM la_rows WHERE id = ?", (r["parent_id"],)).fetchone() if r["parent_id"] else None
        return f"Names under {_row_label(con, parent)}" if parent else "Names"
    aid, desc = (r["activity_id"] or "").strip(), (r["description"] or "").strip()
    return " · ".join(x for x in (aid, desc) if x) or ("Section" if r["kind"] == "section" else "Activity")


def apply_ops(con, ops, actor, workflow, log=True):
    """
    The look-ahead's ops (web/js/lookahead.js applyOps), applied in order, all
    or nothing — and each thing they change written to `la_edits` with who did
    it and what it was before. `log` may instead be the lines to write in their
    place, in the same transaction: an import says what it replaced, once.
    """
    require_write(actor, workflow)
    if not isinstance(ops, list) or len(ops) > 20000:
        raise Refused("ops must be a list", 400)
    stamp = now_iso()
    edits = []
    labels = {}

    def label_of(rid):
        if rid not in labels:
            labels[rid] = _row_label(con, con.execute("SELECT * FROM la_rows WHERE id = ?", (rid,)).fetchone())
        return labels[rid]

    with Tx(con):
        for op in ops:
            kind = op.get("op") if isinstance(op, dict) else None
            if kind == "row":
                rid = op.get("id")
                if not isinstance(rid, str) or not rid or len(rid) > 64:
                    raise Refused("a row needs an id", 400)
                s = op.get("set") or {}
                if not isinstance(s, dict):
                    raise Refused("set must be an object", 400)
                vals = {}
                for k, v in s.items():
                    if k not in ROW_FIELDS:
                        continue
                    if k == "kind":
                        if v not in ("section", "activity", "resource"):
                            raise Refused("kind must be section, activity or resource", 400)
                        vals[k] = v
                    elif k == "sort":
                        if not isinstance(v, (int, float)):
                            raise Refused("sort must be a number", 400)
                        vals[k] = float(v)
                    elif k == "link":
                        vals[k] = _check_link(v)
                    elif k == "parent_id":
                        vals[k] = v if isinstance(v, str) and v else None
                    else:
                        vals[k] = _text(v, k)
                old = con.execute("SELECT * FROM la_rows WHERE id = ?", (rid,)).fetchone()
                changed_before, changed_after = {}, {}
                if old is not None:
                    for k, v in vals.items():
                        if k not in LOGGED_ROW_FIELDS:
                            continue
                        was = old[k]
                        if k == "link":
                            if (json.loads(was) if was else None) != (json.loads(v) if v else None):
                                changed_before[k], changed_after[k] = _link_brief(was), _link_brief(v)
                        elif (was if was is not None else "") != (v if v is not None else ""):
                            changed_before[k], changed_after[k] = was, v
                vals["updated_by"], vals["updated_at"] = actor["id"], stamp
                if old is not None:
                    con.execute(f"UPDATE la_rows SET {', '.join(f'{k} = ?' for k in vals)} WHERE id = ?",
                                list(vals.values()) + [rid])
                else:
                    vals.setdefault("kind", "activity")
                    vals["id"] = rid
                    con.execute(f"INSERT INTO la_rows({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                                list(vals.values()))
                labels.pop(rid, None)
                if old is None:
                    edits.append(("row", "insert", rid, None, label_of(rid), None,
                                  _row_brief(con.execute("SELECT * FROM la_rows WHERE id = ?", (rid,)).fetchone())))
                elif changed_after:
                    edits.append(("row", "update", rid, None, label_of(rid), changed_before, changed_after))
            elif kind == "delete_row":
                old = con.execute("SELECT * FROM la_rows WHERE id = ?", (op.get("id"),)).fetchone()
                if old is not None:
                    edits.append(("row", "delete", old["id"], None, label_of(old["id"]), _row_brief(old), None))
                con.execute("DELETE FROM la_cells WHERE row_id = ?", (op.get("id"),))
                con.execute("DELETE FROM la_rows WHERE id = ?", (op.get("id"),))
                labels.pop(op.get("id"), None)
            elif kind == "cell":
                day, color, text = op.get("day"), op.get("color"), _text(op.get("text"), "text")
                if not isinstance(day, str) or not DAY_RE.match(day):
                    raise Refused("day must be YYYY-MM-DD", 400)
                if color is not None and (not isinstance(color, str) or not HEX_RE.match(color)):
                    raise Refused("color must be RRGGBB", 400)
                was = con.execute("SELECT color, text FROM la_cells WHERE row_id = ? AND day = ?", (op.get("row_id"), day)).fetchone()
                before = {"color": was["color"], "text": was["text"]} if was else None
                if not color and not text:
                    con.execute("DELETE FROM la_cells WHERE row_id = ? AND day = ?", (op.get("row_id"), day))
                    after = None
                else:
                    if not con.execute("SELECT 1 FROM la_rows WHERE id = ?", (op.get("row_id"),)).fetchone():
                        raise Refused("that row is not on the look-ahead (reload: somebody may have deleted it)", 409)
                    con.execute("INSERT INTO la_cells(row_id, day, color, text) VALUES (?, ?, ?, ?) "
                                "ON CONFLICT(row_id, day) DO UPDATE SET color = excluded.color, text = excluded.text",
                                (op["row_id"], day, color.upper() if color else None, text))
                    after = {"color": color.upper() if color else None, "text": text}
                if before != after:
                    action = "insert" if before is None else "delete" if after is None else "update"
                    edits.append(("cell", action, op.get("row_id"), day, label_of(op.get("row_id")), before, after))
            else:
                raise Refused(f"unknown op {kind!r}", 400)
        version = meta_get(con, "la_version", 0) + 1
        meta_set(con, "la_version", version)
        _log_edits(con, version, stamp, actor, edits if log is True else log or [])
    return {"version": version}


def _log_edits(con, batch, stamp, actor, edits):
    con.executemany(
        "INSERT INTO la_edits(batch, at, user_id, by_name, target, action, row_id, day, label, before, after) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(batch, stamp, actor["id"], actor["name"], target, action, row_id, day, label,
          None if before is None else json.dumps(before), None if after is None else json.dumps(after))
         for target, action, row_id, day, label, before, after in edits])


def replace_lookahead(con, rows, cells, actor, workflow, legend=None):
    """
    The whole look-ahead at once (a workbook import), as ops so the same checks
    apply. Its history is one line — what was there and what came in — not a
    line for every day of every row it replaced.
    """
    require_write(actor, workflow)
    if not isinstance(rows, list) or not isinstance(cells, list):
        raise Refused("rows and cells must be lists", 400)
    had = {"rows": con.execute("SELECT count(*) FROM la_rows").fetchone()[0],
           "cells": con.execute("SELECT count(*) FROM la_cells").fetchone()[0]}
    ops = [{"op": "delete_row", "id": r["id"]} for r in con.execute("SELECT id FROM la_rows")]
    ops += [{"op": "row", "id": r.get("id"), "set": {k: r.get(k) for k in ROW_FIELDS if k in r}} for r in rows]
    ops += [{"op": "cell", **c} for c in cells]
    out = apply_ops(con, ops, actor, workflow,
                    log=[("import", "replace", None, None, "", had, {"rows": len(rows), "cells": len(cells)})])
    if legend is not None:
        set_legend(con, legend, actor, workflow)
    return out


def list_edits(con, actor, row=None, day=None, rows=None, since=None, start=None, end=None, before=None, limit=200):
    """
    The look-ahead's history, newest first: one day of a row (`row` and `day`),
    a row (`row`), several rows since a moment (`rows`, `since` — what changed
    under a request after it was submitted), the days `start`…`end` (with every
    change that is not to a day), older than an edit (`before`, for the next
    page). Anybody signed in may read it.
    """
    if actor is None:
        raise Refused("sign in first", 401)
    where, args = [], []
    if row:
        where.append("row_id = ?")
        args.append(row)
    if rows:
        if not isinstance(rows, list) or len(rows) > 500:
            raise Refused("rows: at most 500", 400)
        where.append(f"row_id IN ({', '.join('?' * len(rows))})")
        args += rows
    for name, v in (("day", day), ("start", start), ("end", end)):
        if v is not None and not DAY_RE.match(str(v)):
            raise Refused(f"{name} must be YYYY-MM-DD", 400)
    if day:
        where.append("day = ?")
        args.append(day)
    if start:
        where.append("(day IS NULL OR day >= ?)")
        args.append(start)
    if end:
        where.append("(day IS NULL OR day <= ?)")
        args.append(end)
    if since:
        try:
            moment = datetime.fromisoformat(str(since).replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            raise Refused("since must be a moment, YYYY-MM-DDTHH:MM:SSZ", 400)
        where.append("at > ?")
        args.append(moment.strftime("%Y-%m-%dT%H:%M:%SZ"))
    if before is not None:
        where.append("id < ?")
        args.append(int(before))
    limit = max(1, min(int(limit or 200), 2000))
    sql = "SELECT * FROM la_edits" + (f" WHERE {' AND '.join(where)}" if where else "") + " ORDER BY id DESC LIMIT ?"
    found = con.execute(sql, args + [limit + 1]).fetchall()
    out = [{"id": e["id"], "batch": e["batch"], "at": e["at"], "by": e["by_name"], "by_id": e["user_id"],
            "target": e["target"], "action": e["action"], "row_id": e["row_id"], "day": e["day"], "label": e["label"],
            "before": json.loads(e["before"]) if e["before"] else None,
            "after": json.loads(e["after"]) if e["after"] else None} for e in found[:limit]]
    return {"edits": out, "more": len(found) > limit, "since": meta_get(con, "la_edits_since")}


def set_legend(con, legend, actor, workflow):
    require_write(actor, workflow)
    if not isinstance(legend, list) or not all(
            isinstance(e, dict) and HEX_RE.match(str(e.get("argb", ""))) and isinstance(e.get("meaning"), str)
            for e in legend):
        raise Refused("legend: [{argb: RRGGBB, meaning, role}]", 400)
    clean = [{"argb": e["argb"].upper(), "meaning": e["meaning"][:80],
              "role": e.get("role") if e.get("role") in ("shift", "ignore") else "shift"} for e in legend]
    with Tx(con):
        was = meta_get(con, "legend", DEFAULT_LEGEND)
        version = meta_get(con, "la_version", 0) + 1
        meta_set(con, "legend", clean)
        meta_set(con, "la_version", version)
        if was != clean:
            _log_edits(con, version, now_iso(), actor, [("legend", "update", None, None, "", was, clean)])
    return clean


def set_codes(con, codes, actor, workflow):
    require_write(actor, workflow)
    if not isinstance(codes, list) or not all(
            isinstance(c, dict) and re.fullmatch(r"[A-Za-z0-9]{1,8}", str(c.get("code", ""))) for c in codes):
        raise Refused("codes: [{code (1-8 letters or digits), name, party, tawr_line}]", 400)
    clean = []
    for i, c in enumerate(codes):
        line = c.get("tawr_line") if c.get("tawr_line") in ("systems", "occ", "none") else "systems"
        clean.append({"code": c["code"].upper(), "name": str(c.get("name") or "")[:80],
                      "party": str(c.get("party") or "BART")[:40], "sort": int(c.get("sort") or (i + 1) * 10),
                      "tawr_line": line, "active": c.get("active", True) is not False})
    with Tx(con):
        was = meta_get(con, "codes", DEFAULT_CODES)
        version = meta_get(con, "la_version", 0) + 1
        meta_set(con, "codes", clean)
        meta_set(con, "la_version", version)
        if was != clean:
            _log_edits(con, version, now_iso(), actor, [("codes", "update", None, None, "", was, clean)])
    return clean


# ------------------------------------------------------------ TAWRs

JSON_COLS = ("fields", "generated", "source", "history", "bart", "access")


def tawr_out(r):
    d = dict(r)
    for k in JSON_COLS:
        d[k] = json.loads(d[k]) if d.get(k) else ({} if k != "history" else [])
    return d


def list_tawrs(con, since=None, actor=None):
    """Every request (from the week of `since`), each with its conversation and files (`with_talk`)."""
    sql, args = "SELECT * FROM tawrs", []
    if since:
        sql, args = sql + " WHERE week_start >= ?", [since]
    out = [tawr_out(r) for r in con.execute(sql + " ORDER BY week_start, location_name, shift, id", args)]
    return with_talk(con, out, actor)


def with_talk(con, records, actor=None):
    """
    Requests with what was said and sent with them: `comments` oldest first,
    `attachments` (what each file is, never its bytes), and `seen_comment` — the
    newest comment `actor` has been shown — so the page can say what is new.
    """
    comments, files, seen = {}, {}, {}
    ids = [r["id"] for r in records]
    for at in range(0, len(ids), 500):  # an older SQLite takes at most 999 values in one statement
        part = ids[at:at + 500]
        marks = ", ".join("?" * len(part))
        for c in con.execute(f"SELECT * FROM tawr_comments WHERE tawr_id IN ({marks}) ORDER BY id", part):
            comments.setdefault(c["tawr_id"], []).append(_comment_out(c))
        for a in con.execute(f"SELECT * FROM tawr_attachments WHERE tawr_id IN ({marks}) ORDER BY id", part):
            files.setdefault(a["tawr_id"], []).append(_attachment_out(a))
        if actor is not None:
            seen.update({r["tawr_id"]: r["seen_comment"] for r in con.execute(
                f"SELECT tawr_id, seen_comment FROM tawr_seen WHERE user_id = ? AND tawr_id IN ({marks})", [actor["id"]] + part)})
    for r in records:
        r["comments"] = comments.get(r["id"], [])
        r["attachments"] = files.get(r["id"], [])
        r["seen_comment"] = seen.get(r["id"], 0)
    return records


def _full(con, tid, actor=None):
    """One request as the page reads it: with its conversation and files."""
    return with_talk(con, [tawr_out(_get_tawr(con, tid))], actor)[0]


def list_merges(con):
    return [dict(r, keys=json.loads(r["keys"])) for r in con.execute("SELECT * FROM tawr_merges ORDER BY created_at")]


def _get_tawr(con, tid):
    r = con.execute("SELECT * FROM tawrs WHERE id = ?", (tid,)).fetchone()
    if r is None:
        raise Refused("no such request", 404)
    return r


def _json_obj(v, name):
    if v is None:
        return None
    if not isinstance(v, dict):
        raise Refused(f"{name} must be an object", 400)
    s = json.dumps(v, separators=(",", ":"))
    if len(s) > 2_000_000:
        raise Refused(f"{name} is too large", 400)
    return s


def _history(r, actor, action, note=None):
    h = json.loads(r["history"] or "[]") if r is not None else []
    h.append({"at": now_iso(), "by": actor["name"], "by_id": actor["id"], "action": action, **({"note": note} if note else {})})
    return json.dumps(h)


def _record_values(rec):
    if not isinstance(rec, dict):
        raise Refused("a request must be an object", 400)
    week, key, shift = rec.get("week_start"), rec.get("group_key"), rec.get("shift")
    if not isinstance(week, str) or not DAY_RE.match(week) or datetime.strptime(week, "%Y-%m-%d").weekday() != 0:
        raise Refused("week_start must be a Monday, YYYY-MM-DD", 400)
    if not isinstance(key, str) or not key or len(key) > 1000:
        raise Refused("group_key is required", 400)
    if not isinstance(shift, str) or not shift:
        raise Refused("shift is required", 400)
    first = rec.get("first_day")
    if first is not None and (not isinstance(first, str) or not DAY_RE.match(first)):
        raise Refused("first_day must be YYYY-MM-DD", 400)
    return {
        "week_start": week, "group_key": key, "shift": shift[:20],
        "location_name": _text(rec.get("location_name"), "location_name"), "first_day": first,
        "fields": _json_obj(rec.get("fields") or {}, "fields"),
        "generated": _json_obj(rec.get("generated") or {}, "generated"),
        "source": _json_obj(rec.get("source") or {}, "source"),
    }


def create_tawr(con, rec, actor, workflow):
    """A new draft. Always a draft, whatever the body says."""
    require_write(actor, workflow)
    vals = _record_values(rec)
    with Tx(con):
        if con.execute("SELECT 1 FROM tawrs WHERE week_start = ? AND group_key = ? "
                       "AND status NOT IN ('superseded', 'consolidated')", (vals["week_start"], vals["group_key"])).fetchone():
            raise Refused("there is already a request for that place and shift this week", 409)
        vals.update(status="draft", created_by=actor["id"], history=_history(None, actor, "created"))
        cur = con.execute(f"INSERT INTO tawrs({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})", list(vals.values()))
        return _full(con, cur.lastrowid, actor)


def update_tawr(con, tid, changes, actor, workflow):
    """
    Change what a request says. Its fields as the workflow's `edit` table
    allows; what the look-ahead generated (generated, source, place) only while
    it is a draft — an approved request is final, and a submitted one is the
    manager's to read as it was sent.
    """
    if actor is None:
        raise Refused("sign in first", 401)
    if not isinstance(changes, dict):
        raise Refused("body must be an object", 400)
    with Tx(con):
        r = _get_tawr(con, tid)
        sets = {}
        if "fields" in changes:
            if actor["role"] not in workflow["edit"].get(r["status"], []):
                raise Refused(f"a {r['status']} request cannot be changed by a {workflow['roles'][actor['role']].lower()}")
            sets["fields"] = _json_obj(changes["fields"], "fields")
        regen = [k for k in ("generated", "source", "location_name", "first_day") if k in changes]
        if regen:
            require_write(actor, workflow)
            if r["status"] != "draft":
                raise Refused(f"only a draft follows the look-ahead; this one is {r['status']}", 409)
            for k in regen:
                if k in ("generated", "source"):
                    sets[k] = _json_obj(changes[k], k)
                elif k == "first_day":
                    if not DAY_RE.match(str(changes[k] or "")):
                        raise Refused("first_day must be YYYY-MM-DD", 400)
                    sets[k] = changes[k]
                else:
                    sets[k] = _text(changes[k], k)
        if not sets:
            return _full(con, tid, actor)
        sets.update(updated_by=actor["id"], updated_at=now_iso())
        if "fields" in sets:
            sets["history"] = _history(r, actor, "edited")
        con.execute(f"UPDATE tawrs SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", list(sets.values()) + [tid])
        return _full(con, tid, actor)


def _blocking(r):
    src = json.loads(r["source"] or "{}")
    return [f for f in src.get("flags", []) if f.get("blocking")]


def _day(v, name):
    if v is None or v == "":
        return None
    if not isinstance(v, str) or not DAY_RE.match(v):
        raise Refused(f"{name} must be YYYY-MM-DD", 400)
    return v


def act_on_tawr(con, tid, action, actor, workflow, note=None, on=None, released=False):
    """
    Move a request along the workflow: submit, withdraw, approve, reject,
    reopen, revise, discard — and after approval, BART denied it (`note` is
    BART's reason) or it was cancelled and the track released (`released`:
    BART has been told). `on` is the day it happened, as the person saw it.
    """
    if actor is None:
        raise Refused("sign in first", 401)
    rule = workflow["actions"].get(action)
    if rule is None or action in ("consolidate", "split"):
        raise Refused(f"unknown action {action!r}", 400)
    with Tx(con):
        r = _get_tawr(con, tid)
        if actor["role"] not in rule["roles"]:
            raise Refused(f"a {workflow['roles'][actor['role']].lower()} cannot {action} a request")
        if r["status"] not in rule["from"]:
            raise Refused(f"a {r['status']} request cannot be {action}ed", 409)
        if rule.get("unblocked"):
            blocking = _blocking(r)
            if blocking:
                raise Refused("fix what is flagged first: " + " ".join(f["message"] for f in blocking), 409)
        if rule.get("note") and not (isinstance(note, str) and note.strip()):
            raise Refused("say why", 400)
        stamp = now_iso()
        if action == "discard":
            con.execute("DELETE FROM tawrs WHERE id = ?", (tid,))
            _drop_orphan_files(con)
            return {"deleted": tid}
        sets = {"status": rule["to"], "updated_by": actor["id"], "updated_at": stamp,
                "history": _history(r, actor, action, note.strip() if isinstance(note, str) and note.strip() else None)}
        if action == "submit":
            sets.update(submitted_by=actor["id"], submitted_at=stamp, decision_note=None)
        elif action in ("approve", "reject"):
            sets.update(decided_by=actor["id"], decided_at=stamp, decision_note=(note or "").strip() or None)
        elif action in ("deny", "cancel"):
            day = _day(on, "on") or stamp[:10]
            bart = json.loads(r["bart"] or "{}")
            if action == "deny":
                bart.update(answer="denied", answered_on=day, note=note.strip()[:1000])
            elif released:
                bart["released_on"] = day
            sets["bart"] = json.dumps({**bart, "by": actor["name"]})
        con.execute(f"UPDATE tawrs SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", list(sets.values()) + [tid])
        if rule.get("creates"):
            # Revise: superseded, and a draft takes its place carrying what it said.
            cur = con.execute(
                "INSERT INTO tawrs(week_start, group_key, shift, location_name, first_day, status, fields, generated, "
                "source, supersedes, created_by, history) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
                (r["week_start"], r["group_key"], r["shift"], r["location_name"], r["first_day"], r["fields"],
                 r["generated"], r["source"], tid, actor["id"], _history(None, actor, f"revision of #{tid}")))
            # Its files go with it: they are part of what is sent. Its conversation stays on the
            # request it was said about, and the page shows it with the revision.
            _carry_files(con, tid, cur.lastrowid)
            return _full(con, cur.lastrowid, actor)
        return _full(con, tid, actor)


def _may_record(r, kind, actor, workflow):
    if actor is None:
        raise Refused("sign in first", 401)
    rule = workflow.get("records", {}).get(kind)
    if rule is None:
        raise Refused(f"nothing called {kind!r} is recorded on a request", 400)
    if actor["role"] not in rule["roles"]:
        raise Refused(f"a {workflow['roles'][actor['role']].lower()} cannot record that")
    if r["status"] not in rule["on"]:
        raise Refused(f"that is recorded on an approved request; this one is {r['status']}", 409)


def record_bart(con, tid, body, actor, workflow):
    """
    What happened with BART after approval: the day it was sent, BART's
    reference, that BART granted it (a denial is the `deny` step, which ends the
    request), and after a cancellation the day BART was told the track is free.
    Only the keys sent change; null clears one.
    """
    if not isinstance(body, dict):
        raise Refused("body must be an object", 400)
    with Tx(con):
        r = _get_tawr(con, tid)
        _may_record(r, "bart", actor, workflow)
        bart = json.loads(r["bart"] or "{}")
        said = []
        for k in ("sent_on", "answered_on", "released_on"):
            if k in body:
                if k == "released_on" and r["status"] != "cancelled":
                    raise Refused("the track is released once the request is cancelled", 409)
                bart[k] = _day(body[k], k)
        if "ref" in body:
            ref = body["ref"]
            if ref is not None and (not isinstance(ref, str) or len(ref) > 60):
                raise Refused("BART's reference is at most 60 characters", 400)
            bart["ref"] = (ref or "").strip() or None
        if "answer" in body:
            if body["answer"] not in (None, "granted"):
                raise Refused("BART's answer is granted, or nothing yet — a denial is recorded with its reason", 400)
            if r["status"] != "approved" and body["answer"]:
                raise Refused("only an approved request is granted", 409)
            bart["answer"] = body["answer"]
            if body["answer"] and not bart.get("answered_on"):
                bart["answered_on"] = now_iso()[:10]
        if bart.get("sent_on") and "sent_on" in body:
            said.append(f"sent to BART {bart['sent_on']}")
        if bart.get("ref") and "ref" in body:
            said.append(f"BART reference {bart['ref']}")
        if bart.get("answer") == "granted" and "answer" in body:
            said.append("BART granted it")
        if bart.get("released_on") and "released_on" in body:
            said.append(f"BART told the track is released {bart['released_on']}")
        bart["by"] = actor["name"]
        con.execute("UPDATE tawrs SET bart = ?, history = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(bart), _history(r, actor, "; ".join(said) or "BART details changed"), actor["id"], now_iso(), tid))
        return _full(con, tid, actor)


def record_access(con, tid, body, actor, workflow):
    """Whether each day's access was used, once it has been: `{days: {date: true|false}, note}`."""
    if not isinstance(body, dict) or not isinstance(body.get("days"), dict) or not body["days"]:
        raise Refused("say which days the access was used", 400)
    with Tx(con):
        r = _get_tawr(con, tid)
        _may_record(r, "access", actor, workflow)
        asked = {d.get("date") for d in json.loads(r["source"] or "{}").get("days", [])}
        days = {}
        for day, used in body["days"].items():
            if day not in asked:
                raise Refused(f"{day} is not one of the days this request asked for", 400)
            if not isinstance(used, bool):
                raise Refused("each day is used (true) or not (false)", 400)
            days[day] = used
        note = body.get("note")
        if note is not None and (not isinstance(note, str) or len(note) > 1000):
            raise Refused("the note is at most 1,000 characters", 400)
        access = {"days": days, "note": (note or "").strip() or None, "on": _day(body.get("on"), "on") or now_iso()[:10], "by": actor["name"]}
        used = sum(days.values())
        con.execute("UPDATE tawrs SET access = ?, history = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(access), _history(r, actor, f"access recorded: used on {used} of {len(days)} day{'s' if len(days) != 1 else ''}",
                                                  access["note"]), actor["id"], now_iso(), tid))
        return _full(con, tid, actor)


def consolidate(con, ids, merge, record, actor, workflow, note=None):
    """
    Make several requests one: the track allocation manager's answer to two
    places that overlap. `merge` is {id, week_start, keys}; `record` is the
    merged request as the look-ahead reads it with the merge applied (its key
    'merge:' + id). The members are kept, marked consolidated, so a split puts
    them back.
    """
    rule = workflow["actions"]["consolidate"]
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] not in rule["roles"]:
        raise Refused("only the track allocation manager consolidates requests")
    if not isinstance(ids, list) or len(set(ids)) < 2:
        raise Refused("pick two or more requests to consolidate", 400)
    if not isinstance(merge, dict) or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", str(merge.get("id", ""))):
        raise Refused("merge needs an id", 400)
    vals = _record_values(record)
    if vals["group_key"] != f"merge:{merge['id']}":
        raise Refused("the merged request's key must be merge:<id>", 400)
    with Tx(con):
        rows = [_get_tawr(con, int(i)) for i in ids]
        weeks = {r["week_start"] for r in rows}
        shifts = {r["shift"] for r in rows}
        if len(weeks) != 1 or len(shifts) != 1:
            raise Refused("only requests in the same week and shift can be consolidated", 409)
        # A TCR and track are different categories of work: never one request.
        kinds = {json.loads(r["source"] or "{}").get("kind") for r in rows}
        if len(kinds) != 1:
            raise Refused("a TCR request and a track request cannot be consolidated — they are different categories of work", 409)
        for r in rows:
            if r["status"] not in rule["from"]:
                raise Refused(f"#{r['id']} is {r['status']}; only drafts and submitted requests can be consolidated", 409)
        keys = sorted(r["group_key"] for r in rows)
        if sorted(merge.get("keys") or []) != keys or merge.get("week_start") != rows[0]["week_start"] \
                or vals["week_start"] != rows[0]["week_start"] or vals["shift"] != rows[0]["shift"]:
            raise Refused("the merge does not match the requests picked (reload and try again)", 409)
        if con.execute("SELECT 1 FROM tawr_merges WHERE id = ?", (merge["id"],)).fetchone():
            raise Refused("that merge already exists", 409)
        con.execute("INSERT INTO tawr_merges(id, week_start, shift, keys, created_by) VALUES (?, ?, ?, ?, ?)",
                    (merge["id"], rows[0]["week_start"], rows[0]["shift"], json.dumps(keys), actor["id"]))
        status = "submitted" if all(r["status"] == "submitted" for r in rows) else "draft"
        stamp = now_iso()
        listed = ", ".join(f"#{r['id']}" for r in rows)
        vals.update(status=status, created_by=actor["id"],
                    history=_history(None, actor, f"consolidated from {listed}", note),
                    submitted_by=actor["id"] if status == "submitted" else None,
                    submitted_at=stamp if status == "submitted" else None)
        cur = con.execute(f"INSERT INTO tawrs({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})", list(vals.values()))
        new_id = cur.lastrowid
        for r in rows:
            con.execute("UPDATE tawrs SET status = 'consolidated', status_before = ?, merged_into = ?, "
                        "updated_by = ?, updated_at = ?, history = ? WHERE id = ?",
                        (r["status"], new_id, actor["id"], stamp, _history(r, actor, f"consolidated into #{new_id}", note), r["id"]))
            _carry_files(con, r["id"], new_id)
        return _full(con, new_id, actor)


def split(con, tid, actor, workflow):
    """Undo a consolidation: the merged request goes, its members come back as they were."""
    rule = workflow["actions"]["split"]
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] not in rule["roles"]:
        raise Refused("only the track allocation manager splits a consolidated request")
    with Tx(con):
        r = _get_tawr(con, tid)
        if not r["group_key"].startswith("merge:"):
            raise Refused("that request was not consolidated", 409)
        if r["status"] not in rule["from"]:
            raise Refused(f"a {r['status']} request cannot be split; revise it first", 409)
        members = con.execute("SELECT * FROM tawrs WHERE merged_into = ? AND status = 'consolidated'", (tid,)).fetchall()
        stamp = now_iso()
        # What was said about the merged request, and the files added to it rather than carried in
        # from its members, go back to every member: splitting loses nothing anybody wrote or sent.
        for m in members:
            con.execute("INSERT INTO tawr_comments(tawr_id, user_id, by_name, at, text) "
                        "SELECT ?, user_id, by_name, at, text FROM tawr_comments WHERE tawr_id = ? ORDER BY id", (m["id"], tid))
            _carry_files(con, tid, m["id"], own_only=True)
        con.execute("DELETE FROM tawrs WHERE id = ?", (tid,))
        con.execute("DELETE FROM tawr_merges WHERE id = ?", (r["group_key"][len("merge:"):],))
        restored = []
        for m in members:
            back = m["status_before"] if m["status_before"] in ("draft", "submitted") else "draft"
            con.execute("UPDATE tawrs SET status = ?, status_before = NULL, merged_into = NULL, updated_by = ?, "
                        "updated_at = ?, history = ? WHERE id = ?",
                        (back, actor["id"], stamp, _history(m, actor, f"split back out of #{tid}"), m["id"]))
            restored.append(m["id"])
        _drop_orphan_files(con)
        return {"deleted": tid, "restored": restored}


# ------------------------------------------------------------ what is said and sent with a request

COMMENT_LIMIT = 2000
ATTACH_MAX = 20 * 1024 * 1024
ATTACH_PER_REQUEST = 20
# What may be sent with a request, by extension, and the type each is served as: documents,
# drawings, photos, emails — never a page or a program. Mirrored in web/js/attachments.js.
ATTACH_TYPES = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "csv": "text/csv", "txt": "text/plain",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "tif": "image/tiff", "tiff": "image/tiff",
    "dwg": "image/vnd.dwg", "dxf": "image/vnd.dxf",
    "msg": "application/vnd.ms-outlook", "eml": "message/rfc822",
    "zip": "application/zip",
}


def _comment_out(c):
    return {"id": c["id"], "at": c["at"], "by": c["by_name"], "by_id": c["user_id"], "text": c["text"]}


def _attachment_out(a):
    return {"id": a["id"], "name": a["name"], "type": a["type"], "size": a["size"], "sha256": a["sha256"],
            "at": a["at"], "by": a["by_name"], "by_id": a["user_id"], "copied_from": a["copied_from"]}


def add_comment(con, tid, text, actor, workflow):
    """Say something on a request — any request, at any point in its life; viewers read."""
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] not in workflow.get("comment", workflow["write"]):
        raise Refused(f"a {workflow['roles'][actor['role']].lower()} cannot comment")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        raise Refused("write something first", 400)
    if len(text) > COMMENT_LIMIT:
        raise Refused("a comment is at most 2,000 characters", 400)
    with Tx(con):
        _get_tawr(con, tid)
        cur = con.execute("INSERT INTO tawr_comments(tawr_id, user_id, by_name, at, text) VALUES (?, ?, ?, ?, ?)",
                          (tid, actor["id"], actor["name"], now_iso(), text))
        _seen(con, actor, tid, cur.lastrowid)  # what you wrote, you have read
        return _full(con, tid, actor)


def list_comments(con, tid, actor):
    """A request's conversation as it stands now: opened, it is current, whatever the page loaded before."""
    if actor is None:
        raise Refused("sign in first", 401)
    _get_tawr(con, tid)
    return [_comment_out(c) for c in con.execute("SELECT * FROM tawr_comments WHERE tawr_id = ? ORDER BY id", (tid,))]


def _seen(con, actor, tid, upto):
    con.execute("INSERT INTO tawr_seen(user_id, tawr_id, seen_comment) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id, tawr_id) DO UPDATE SET seen_comment = max(seen_comment, excluded.seen_comment)",
                (actor["id"], tid, upto))


def mark_seen(con, tid, upto, actor):
    """`actor` has been shown the conversation up to comment `upto`: nothing older is new to them."""
    if actor is None:
        raise Refused("sign in first", 401)
    if not isinstance(upto, int) or upto < 0:
        raise Refused("upto must be a comment id", 400)
    with Tx(con):
        _get_tawr(con, tid)
        _seen(con, actor, tid, upto)
    return {"tawr_id": tid, "seen_comment": upto}


def clean_file_name(name):
    """A file's own name, without a folder, control characters or anything a file system refuses."""
    name = re.split(r"[\\/]", str(name or ""))[-1]
    name = re.sub(r"[\x00-\x1f\x7f<>:\"|?*]+", "", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > 120:
        stem, dot, ext = name.rpartition(".")
        name = f"{stem[:110].rstrip()}.{ext[:8]}" if dot and len(ext) <= 8 else name[:120]
    return name


def _may_attach(r, actor, workflow):
    """Files change where the request's fields may: a draft is its requester's, a submitted one the manager's."""
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] not in workflow["edit"].get(r["status"], []):
        raise Refused(f"the files on a {r['status']} request cannot be changed by a "
                      f"{workflow['roles'][actor['role']].lower()}", 409 if actor["role"] in workflow["write"] else 403)


def add_attachment(con, tid, name, data, actor, workflow):
    """Send a file with a request: the SSWP, a drawing, a permit."""
    name = clean_file_name(name)
    ext = name.rpartition(".")[2].lower() if "." in name else ""
    if not name or ext not in ATTACH_TYPES:
        raise Refused("only documents, drawings, photos, emails and zip files can be attached "
                      "(PDF, Word, Excel, PowerPoint, CSV, text, PNG, JPEG, TIFF, DWG, DXF, MSG, EML, ZIP)", 415)
    if not data:
        raise Refused("the file is empty", 400)
    if len(data) > ATTACH_MAX:
        raise Refused("a file is at most 20 MB", 413)
    sha = hashlib.sha256(data).hexdigest()
    with Tx(con):
        r = _get_tawr(con, tid)
        _may_attach(r, actor, workflow)
        if con.execute("SELECT count(*) FROM tawr_attachments WHERE tawr_id = ?", (tid,)).fetchone()[0] >= ATTACH_PER_REQUEST:
            raise Refused(f"a request carries at most {ATTACH_PER_REQUEST} files", 409)
        con.execute("INSERT OR IGNORE INTO files(sha256, size, data) VALUES (?, ?, ?)", (sha, len(data), sqlite3.Binary(data)))
        con.execute("INSERT INTO tawr_attachments(tawr_id, sha256, name, type, size, user_id, by_name, at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (tid, sha, name, ATTACH_TYPES[ext], len(data), actor["id"], actor["name"], now_iso()))
        con.execute("UPDATE tawrs SET history = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                    (_history(r, actor, f"attached {name}"), actor["id"], now_iso(), tid))
        return _full(con, tid, actor)


def get_attachment(con, aid, actor):
    """A file sent with a request — `(name, type, bytes)` — for anybody signed in."""
    if actor is None:
        raise Refused("sign in first", 401)
    a = con.execute("SELECT a.name, a.type, f.data FROM tawr_attachments a JOIN files f ON f.sha256 = a.sha256 "
                    "WHERE a.id = ?", (aid,)).fetchone()
    if a is None:
        raise Refused("no such file", 404)
    return a["name"], a["type"], bytes(a["data"])


def delete_attachment(con, tid, aid, actor, workflow):
    with Tx(con):
        r = _get_tawr(con, tid)
        a = con.execute("SELECT * FROM tawr_attachments WHERE id = ? AND tawr_id = ?", (aid, tid)).fetchone()
        if a is None:
            raise Refused("no such file on that request", 404)
        _may_attach(r, actor, workflow)
        con.execute("DELETE FROM tawr_attachments WHERE id = ?", (aid,))
        con.execute("UPDATE tawrs SET history = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                    (_history(r, actor, f"removed {a['name']}"), actor["id"], now_iso(), tid))
        _drop_orphan_files(con)
        return _full(con, tid, actor)


def _carry_files(con, from_id, to_id, own_only=False):
    """A request's files onto another (a revision, a consolidation, a split); the bytes are shared, never copied."""
    con.execute("INSERT INTO tawr_attachments(tawr_id, sha256, name, type, size, copied_from, user_id, by_name, at) "
                "SELECT ?, sha256, name, type, size, id, user_id, by_name, at FROM tawr_attachments "
                f"WHERE tawr_id = ?{' AND copied_from IS NULL' if own_only else ''} ORDER BY id", (to_id, from_id))


def _drop_orphan_files(con):
    con.execute("DELETE FROM files WHERE sha256 NOT IN (SELECT sha256 FROM tawr_attachments)")


# ------------------------------------------------------------ setup

SETTING_KEYS = {
    "requestor_name", "requestor_cell_phone", "requestor_signature",
    "person_in_charge_name", "person_in_charge_cell_phone", "project_rep_name", "project_rep_cell_phone",
    "category_default", "category_tcr", "category_track", "hours_day", "hours_swing", "hours_night", "hours_possession", "auto_lead_days",
    "template_info", "phases", "learn_predict", "learn_threshold", "support_capacity",
}
SHIFT_IDS = ("day", "swing", "night", "possession")
# What a viewer may read of them: the phases, for looking at the track plan by phase.
PUBLIC_SETTING_KEYS = {"phases"}
MAX_PHASES = 50


def get_settings(con, actor=None, workflow=None):
    """Phone numbers and a signature: the requester's and the manager's to read.
    A viewer is answered with the public ones alone, not refused."""
    rows = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM tawr_settings")}
    if workflow is not None:
        if actor is None:
            raise Refused("sign in first", 401)
        if actor["role"] not in workflow["write"]:
            return {k: v for k, v in rows.items() if k in PUBLIC_SETTING_KEYS}
    return rows


def _check_phases(text):
    """Phases are `[{id, name, note, bbox: [x0, y0, x1, y1]}]` in drawing points: web/js/phases.js."""
    try:
        phases = json.loads(text)
    except ValueError:
        raise Refused("phases must be JSON", 400)
    if not isinstance(phases, list) or len(phases) > MAX_PHASES:
        raise Refused(f"phases must be a list of at most {MAX_PHASES}", 400)
    for ph in phases:
        name = ph.get("name") if isinstance(ph, dict) else None
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise Refused("every phase needs a name of up to 80 characters", 400)
        box = ph.get("bbox")
        if (not isinstance(box, list) or len(box) != 4
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in box)
                or box[0] >= box[2] or box[1] >= box[3]):
            raise Refused(f"phase {name!r} needs a box on the drawing", 400)
        if len(str(ph.get("note") or "")) > 300:
            raise Refused(f"the note on phase {name!r} is too long", 400)


def _check_capacity(text):
    """What BART can provide: `{code: {shift: n}}`, whole numbers from 0 to 99."""
    try:
        cap = json.loads(text)
    except ValueError:
        raise Refused("support_capacity must be JSON", 400)
    if not isinstance(cap, dict) or len(cap) > 50:
        raise Refused("support_capacity is an object of support codes", 400)
    for code, shifts in cap.items():
        if not isinstance(code, str) or not 0 < len(code) <= 10 or not isinstance(shifts, dict):
            raise Refused("support_capacity is an object of support codes, each an object of shifts", 400)
        for shift, n in shifts.items():
            if shift not in SHIFT_IDS:
                raise Refused(f"unknown shift {shift!r} in support_capacity", 400)
            if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= 99:
                raise Refused(f"what BART provides of {code} on a {shift} shift is a whole number from 0 to 99", 400)


def _threshold_ok(v):
    try:
        return 0.5 <= float(v) <= 0.95
    except ValueError:
        return False


def set_settings(con, values, actor, workflow):
    require_write(actor, workflow)
    if not isinstance(values, dict):
        raise Refused("settings must be an object", 400)
    bad = [k for k in values if k not in SETTING_KEYS]
    if bad:
        raise Refused(f"unknown setting {bad[0]!r}", 400)
    with Tx(con):
        for k, v in values.items():
            if v is not None and (not isinstance(v, str) or len(v) > 200_000):
                raise Refused(f"{k} must be text", 400)
            if k == "phases" and v:
                _check_phases(v)
            if k == "support_capacity" and v:
                _check_capacity(v)
            if k == "learn_predict" and v not in (None, "", "on", "off"):
                raise Refused("learn_predict is on or off", 400)
            if k == "learn_threshold" and v and not _threshold_ok(v):
                raise Refused("learn_threshold is a number from 0.5 to 0.95", 400)
            con.execute("INSERT INTO tawr_settings(key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, "
                        "updated_at = excluded.updated_at", (k, v, actor["id"], now_iso()))
    return get_settings(con)


def list_descriptions(con):
    return [dict(r) for r in con.execute("SELECT * FROM tawr_descriptions ORDER BY activity")]


def save_description(con, did, body, actor, workflow):
    require_write(actor, workflow)
    activity = _text((body or {}).get("activity"), "activity").strip()
    description = _text((body or {}).get("description"), "description").strip()
    if not activity:
        raise Refused("name the activity", 400)
    fold = re.sub(r"[^a-z0-9]", "", activity.lower())
    with Tx(con):
        for r in con.execute("SELECT * FROM tawr_descriptions"):
            if re.sub(r"[^a-z0-9]", "", r["activity"].lower()) == fold and r["id"] != did:
                raise Refused(f'"{r["activity"]}" already has wording — edit that one', 409)
        if did is None:
            cur = con.execute("INSERT INTO tawr_descriptions(activity, description) VALUES (?, ?)", (activity, description))
            did = cur.lastrowid
        elif not con.execute("UPDATE tawr_descriptions SET activity = ?, description = ? WHERE id = ?",
                             (activity, description, did)).rowcount:
            raise Refused("no such wording", 404)
    return dict(con.execute("SELECT * FROM tawr_descriptions WHERE id = ?", (did,)).fetchone())


def delete_description(con, did, actor, workflow):
    require_write(actor, workflow)
    if not con.execute("DELETE FROM tawr_descriptions WHERE id = ?", (did,)).rowcount:
        raise Refused("no such wording", 404)
    return {"deleted": did}


# ------------------------------------------------------------ the learning memory

MEMORY_KINDS = ("form", "link", "reject", "outcome")
MEMORY_LIMIT = 5000        # read at most this many, the newest
MEMORY_DATA_MAX = 20_000   # characters of JSON in one entry
MEMORY_SELECT = "SELECT m.*, u.name AS by_name FROM memory m LEFT JOIN users u ON u.id = m.created_by"


def _memory_out(r):
    return {"id": r["id"], "kind": r["kind"], "tawr_id": r["tawr_id"], "data": json.loads(r["data"]),
            "at": r["created_at"], "by": r["by_name"] or "", "by_id": r["created_by"]}


def list_memory(con, actor, workflow):
    """What the memory holds, oldest first — for the requester and the manager, who raise and decide."""
    require_write(actor, workflow)
    rows = con.execute(MEMORY_SELECT + " ORDER BY m.id DESC LIMIT ?", (MEMORY_LIMIT,)).fetchall()
    return [_memory_out(r) for r in reversed(rows)]


def add_memory(con, entries, actor, workflow):
    """Entries web/js/learn.js wrote: kept as they are, once their shape is checked."""
    require_write(actor, workflow)
    if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
        raise Refused("send between 1 and 50 entries", 400)
    ids = []
    with Tx(con):
        for e in entries:
            if not isinstance(e, dict) or e.get("kind") not in MEMORY_KINDS:
                raise Refused("unknown kind of memory", 400)
            tid = e.get("tawr_id")
            if tid is not None and (not isinstance(tid, int) or isinstance(tid, bool)):
                raise Refused("tawr_id must be a number", 400)
            data = e.get("data")
            text = json.dumps(data, separators=(",", ":"))
            if not isinstance(data, dict) or len(text) > MEMORY_DATA_MAX:
                raise Refused(f"memory data must be an object of at most {MEMORY_DATA_MAX:,} characters", 400)
            ids.append(con.execute("INSERT INTO memory(kind, tawr_id, data, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
                                   (e["kind"], tid, text, actor["id"], now_iso())).lastrowid)
    marks = ",".join("?" * len(ids))
    return [_memory_out(r) for r in con.execute(MEMORY_SELECT + f" WHERE m.id IN ({marks}) ORDER BY m.id", ids)]


def forget_memory(con, mid, actor, workflow):
    require_write(actor, workflow)
    if not con.execute("DELETE FROM memory WHERE id = ?", (mid,)).rowcount:
        raise Refused("no such memory", 404)
    return {"forgotten": mid}


def clear_memory(con, actor, workflow):
    require_write(actor, workflow)
    if actor["role"] != "manager":
        raise Refused("only the track allocation manager clears the memory")
    return {"forgotten": con.execute("DELETE FROM memory").rowcount}


# ------------------------------------------------------------ the deadlines as a calendar

LEAD_DAYS = 17
SHIFT_LABELS = {"day": "Day", "swing": "Swing", "night": "Night", "possession": "Blanket", "unmapped": "Unmapped colour"}


def make_calendar_token(con, actor):
    """A new calendar link for whoever is signed in, replacing theirs: the token, shown once."""
    if actor is None:
        raise Refused("sign in first", 401)
    token = secrets.token_urlsafe(24)
    with Tx(con):
        con.execute("INSERT INTO calendar_feeds(user_id, token_hash, created_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at",
                    (actor["id"], hashlib.sha256(token.encode()).hexdigest(), now_iso()))
    return {"token": token}


def stop_calendar_token(con, actor):
    if actor is None:
        raise Refused("sign in first", 401)
    return {"stopped": bool(con.execute("DELETE FROM calendar_feeds WHERE user_id = ?", (actor["id"],)).rowcount)}


def calendar_user(con, token):
    """Whose link a token is, while they still have an account."""
    if not token:
        return None
    r = con.execute("SELECT u.* FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND u.active = 1",
                    (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    return public_user(r) if r else None


def _ics_text(s):
    return str(s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _fold(line):
    """A content line folded at 75 octets (RFC 5545): the rest follows a space."""
    out, cur, size = [], "", 0
    for ch in line:
        n = len(ch.encode())
        if size + n > (74 if out else 75):
            out.append(cur)
            cur, size = "", 0
        cur += ch
        size += n
    out.append(cur)
    return "\r\n ".join(out)


def calendar_ics(con, today=None, stamp=None, name="Track Plan — TAWRs"):
    """
    The TAWR deadlines and the approved access as iCalendar, as web/js/today.js
    writes it for the static site: an all-day event on each week's deadline —
    its first day of work less the lead time — with a reminder the day before,
    for the week before this one and ten after; and an event for every day of
    approved access, its hours as the look-ahead has them.
    """
    today = today or datetime.now().date()
    dtstamp = (stamp or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    day = lambda iso: datetime.strptime(iso, "%Y-%m-%d").date()
    monday = lambda d: d - timedelta(days=d.weekday())
    start = monday(today) - timedelta(days=7)
    tawrs = [tawr_out(r) for r in con.execute(
        "SELECT * FROM tawrs WHERE status NOT IN ('superseded', 'consolidated') ORDER BY week_start, location_name, shift, id")]
    weeks = {t["week_start"] for t in tawrs}
    weeks |= {monday(day(r["day"])).isoformat() for r in con.execute("SELECT DISTINCT day FROM la_cells WHERE color IS NOT NULL")}
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Track Plan//TAWR deadlines//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
             f"X-WR-CALNAME:{_ics_text(name)}"]
    for week in sorted(w for w in weeks if start.isoformat() <= w <= (start + timedelta(days=7 * 11 - 1)).isoformat()):
        these = [t for t in tawrs if t["week_start"] == week]
        deadline = day(min([t["first_day"] or week for t in these] or [week])) - timedelta(days=LEAD_DAYS)
        counts = {}
        for t in these:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        said = ", ".join(f"{n} {s}" for s, n in counts.items())
        lines += ["BEGIN:VEVENT", f"UID:deadline-{week}@track-plan", f"DTSTAMP:{dtstamp}",
                  f"DTSTART;VALUE=DATE:{deadline:%Y%m%d}", f"DTEND;VALUE=DATE:{deadline + timedelta(days=1):%Y%m%d}",
                  f"SUMMARY:{_ics_text(f'TAWRs due — week of {week}')}",
                  "DESCRIPTION:" + _ics_text(f"The track access work requests for the week of {week} go to BART today."
                                             + (f" Requests: {said}." if said else "")),
                  "TRANSP:TRANSPARENT",
                  "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(f'TAWRs due tomorrow — week of {week}')}",
                  "TRIGGER:-PT15H", "END:VALARM", "END:VEVENT"]
    access = []
    for t in tawrs:
        if t["status"] != "approved":
            continue
        for d in t["source"].get("days", []):
            if start.isoformat() <= d.get("date", "") <= (start + timedelta(days=84)).isoformat():
                access.append((d["date"], str(d.get("start") or ""), d, t))
    for date, _, d, t in sorted(access, key=lambda a: (a[0], a[1])):
        hours = re.fullmatch(r"\d{4}", d.get("start") or "") and re.fullmatch(r"\d{4}", d.get("end") or "")
        ends = day(date) + timedelta(days=1) if hours and d["end"] <= d["start"] else day(date)
        what = "; ".join(" ".join(x for x in (a.get("activityId"), a.get("title")) if x) for a in t["source"].get("activities", []))
        b = t["bart"] or {}
        if b.get("answer") == "granted":
            bart = "Granted by BART" + (f" ({b['ref']})" if b.get("ref") else "") + "."
        elif b.get("sent_on"):
            bart = "Sent to BART, waiting for its answer."
        else:
            bart = "Approved, not yet sent to BART."
        if hours:
            when = [f"DTSTART:{date.replace('-', '')}T{d['start']}00", f"DTEND:{ends:%Y%m%d}T{d['end']}00"]
        else:
            when = [f"DTSTART;VALUE=DATE:{date.replace('-', '')}", f"DTEND;VALUE=DATE:{day(date) + timedelta(days=1):%Y%m%d}"]
        summary = f"Track access #{t['id']} {t['location_name']} · {SHIFT_LABELS.get(t['shift'], t['shift'])}"
        area = (t["fields"] or {}).get("row1_area") or t["location_name"]
        lines += ["BEGIN:VEVENT", f"UID:tawr-{t['id']}-{date}@track-plan", f"DTSTAMP:{dtstamp}", *when,
                  f"SUMMARY:{_ics_text(summary)}", f"LOCATION:{_ics_text(area)}", f"DESCRIPTION:{_ics_text(what + chr(10) + bart)}",
                  f"STATUS:{'CONFIRMED' if b.get('answer') == 'granted' else 'TENTATIVE'}", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def save_template(data, actor, workflow, path=None):
    """BART's blank form, kept beside the database — never under web/, never committed."""
    require_write(actor, workflow)
    path = path or TEMPLATE_PATH
    if not data.startswith(b"%PDF-"):
        raise Refused("that is not a PDF", 400)
    if len(data) > 20_000_000:
        raise Refused("that PDF is too large", 400)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return {"size": len(data)}


def load_template(actor, path=None):
    if actor is None:
        raise Refused("sign in first", 401)
    if actor["role"] == "viewer":
        raise Refused("BART's form is for the requester and the track allocation manager")
    path = path or TEMPLATE_PATH
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return f.read()
