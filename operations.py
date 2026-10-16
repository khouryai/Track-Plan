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
            con.executescript(f.read())
        for key, value in (("legend", DEFAULT_LEGEND), ("codes", DEFAULT_CODES), ("la_version", 0)):
            con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", (key, json.dumps(value)))
    finally:
        con.close()


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


def apply_ops(con, ops, actor, workflow):
    """The look-ahead's ops (web/js/lookahead.js applyOps), applied in order, all or nothing."""
    require_write(actor, workflow)
    if not isinstance(ops, list) or len(ops) > 20000:
        raise Refused("ops must be a list", 400)
    stamp = now_iso()
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
                exists = con.execute("SELECT 1 FROM la_rows WHERE id = ?", (rid,)).fetchone()
                vals["updated_by"], vals["updated_at"] = actor["id"], stamp
                if exists:
                    con.execute(f"UPDATE la_rows SET {', '.join(f'{k} = ?' for k in vals)} WHERE id = ?",
                                list(vals.values()) + [rid])
                else:
                    vals.setdefault("kind", "activity")
                    vals["id"] = rid
                    con.execute(f"INSERT INTO la_rows({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                                list(vals.values()))
            elif kind == "delete_row":
                con.execute("DELETE FROM la_cells WHERE row_id = ?", (op.get("id"),))
                con.execute("DELETE FROM la_rows WHERE id = ?", (op.get("id"),))
            elif kind == "cell":
                day, color, text = op.get("day"), op.get("color"), _text(op.get("text"), "text")
                if not isinstance(day, str) or not DAY_RE.match(day):
                    raise Refused("day must be YYYY-MM-DD", 400)
                if color is not None and (not isinstance(color, str) or not HEX_RE.match(color)):
                    raise Refused("color must be RRGGBB", 400)
                if not color and not text:
                    con.execute("DELETE FROM la_cells WHERE row_id = ? AND day = ?", (op.get("row_id"), day))
                else:
                    if not con.execute("SELECT 1 FROM la_rows WHERE id = ?", (op.get("row_id"),)).fetchone():
                        raise Refused("that row is not on the look-ahead (reload: somebody may have deleted it)", 409)
                    con.execute("INSERT INTO la_cells(row_id, day, color, text) VALUES (?, ?, ?, ?) "
                                "ON CONFLICT(row_id, day) DO UPDATE SET color = excluded.color, text = excluded.text",
                                (op["row_id"], day, color.upper() if color else None, text))
            else:
                raise Refused(f"unknown op {kind!r}", 400)
        version = meta_get(con, "la_version", 0) + 1
        meta_set(con, "la_version", version)
    return {"version": version}


def replace_lookahead(con, rows, cells, actor, workflow, legend=None):
    """The whole look-ahead at once (a workbook import), as ops so the same checks apply."""
    require_write(actor, workflow)
    if not isinstance(rows, list) or not isinstance(cells, list):
        raise Refused("rows and cells must be lists", 400)
    ops = [{"op": "delete_row", "id": r["id"]} for r in con.execute("SELECT id FROM la_rows")]
    ops += [{"op": "row", "id": r.get("id"), "set": {k: r.get(k) for k in ROW_FIELDS if k in r}} for r in rows]
    ops += [{"op": "cell", **c} for c in cells]
    out = apply_ops(con, ops, actor, workflow)
    if legend is not None:
        set_legend(con, legend, actor, workflow)
    return out


def set_legend(con, legend, actor, workflow):
    require_write(actor, workflow)
    if not isinstance(legend, list) or not all(
            isinstance(e, dict) and HEX_RE.match(str(e.get("argb", ""))) and isinstance(e.get("meaning"), str)
            for e in legend):
        raise Refused("legend: [{argb: RRGGBB, meaning, role}]", 400)
    clean = [{"argb": e["argb"].upper(), "meaning": e["meaning"][:80],
              "role": e.get("role") if e.get("role") in ("shift", "ignore") else "shift"} for e in legend]
    with Tx(con):
        meta_set(con, "legend", clean)
        meta_set(con, "la_version", meta_get(con, "la_version", 0) + 1)
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
        meta_set(con, "codes", clean)
        meta_set(con, "la_version", meta_get(con, "la_version", 0) + 1)
    return clean


# ------------------------------------------------------------ TAWRs

JSON_COLS = ("fields", "generated", "source", "history")


def tawr_out(r):
    d = dict(r)
    for k in JSON_COLS:
        d[k] = json.loads(d[k]) if d.get(k) else ({} if k != "history" else [])
    return d


def list_tawrs(con, since=None):
    sql, args = "SELECT * FROM tawrs", []
    if since:
        sql, args = sql + " WHERE week_start >= ?", [since]
    return [tawr_out(r) for r in con.execute(sql + " ORDER BY week_start, location_name, shift, id", args)]


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
        return tawr_out(_get_tawr(con, cur.lastrowid))


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
            return tawr_out(r)
        sets.update(updated_by=actor["id"], updated_at=now_iso())
        if "fields" in sets:
            sets["history"] = _history(r, actor, "edited")
        con.execute(f"UPDATE tawrs SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", list(sets.values()) + [tid])
        return tawr_out(_get_tawr(con, tid))


def _blocking(r):
    src = json.loads(r["source"] or "{}")
    return [f for f in src.get("flags", []) if f.get("blocking")]


def act_on_tawr(con, tid, action, actor, workflow, note=None):
    """Move a request along the workflow: submit, withdraw, approve, reject, reopen, revise, discard."""
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
            return {"deleted": tid}
        sets = {"status": rule["to"], "updated_by": actor["id"], "updated_at": stamp,
                "history": _history(r, actor, action, note.strip() if isinstance(note, str) and note.strip() else None)}
        if action == "submit":
            sets.update(submitted_by=actor["id"], submitted_at=stamp, decision_note=None)
        elif action in ("approve", "reject"):
            sets.update(decided_by=actor["id"], decided_at=stamp, decision_note=(note or "").strip() or None)
        con.execute(f"UPDATE tawrs SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", list(sets.values()) + [tid])
        if rule.get("creates"):
            # Revise: superseded, and a draft takes its place carrying what it said.
            cur = con.execute(
                "INSERT INTO tawrs(week_start, group_key, shift, location_name, first_day, status, fields, generated, "
                "source, supersedes, created_by, history) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
                (r["week_start"], r["group_key"], r["shift"], r["location_name"], r["first_day"], r["fields"],
                 r["generated"], r["source"], tid, actor["id"], _history(None, actor, f"revision of #{tid}")))
            return tawr_out(_get_tawr(con, cur.lastrowid))
        return tawr_out(_get_tawr(con, tid))


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
        return tawr_out(_get_tawr(con, new_id))


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
        con.execute("DELETE FROM tawrs WHERE id = ?", (tid,))
        con.execute("DELETE FROM tawr_merges WHERE id = ?", (r["group_key"][len("merge:"):],))
        restored = []
        for m in members:
            back = m["status_before"] if m["status_before"] in ("draft", "submitted") else "draft"
            con.execute("UPDATE tawrs SET status = ?, status_before = NULL, merged_into = NULL, updated_by = ?, "
                        "updated_at = ?, history = ? WHERE id = ?",
                        (back, actor["id"], stamp, _history(m, actor, f"split back out of #{tid}"), m["id"]))
            restored.append(m["id"])
        return {"deleted": tid, "restored": restored}


# ------------------------------------------------------------ setup

SETTING_KEYS = {
    "requestor_name", "requestor_cell_phone", "requestor_signature",
    "person_in_charge_name", "person_in_charge_cell_phone", "project_rep_name", "project_rep_cell_phone",
    "category_default", "hours_day", "hours_swing", "hours_night", "hours_possession", "auto_lead_days",
    "template_info",
}


def get_settings(con, actor=None, workflow=None):
    """Phone numbers and a signature: the requester's and the manager's to read, not a viewer's."""
    if workflow is not None:
        require_write(actor, workflow)
    return {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM tawr_settings")}


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
