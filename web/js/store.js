/**
 * Where the look-ahead, the TAWRs and the accounts live.
 *
 * Two shapes, one interface:
 *
 * **server** — `server.py` is running. Everything is in its database, people
 * sign in, and the server decides what each role may do (`operations.py`).
 *
 * **local** — a static host (GitHub Pages) with no server. Everything is kept
 * in this browser (localStorage, and IndexedDB for BART's form and the files
 * sent with requests), and the person says which role they are acting as. The
 * same workflow table is applied here, so the screen behaves the same — but
 * nothing on a static site can stop somebody choosing another role, and the
 * page says so.
 *
 * Both keep the look-ahead's history the same way (`la_history.js`): every
 * change, who made it, when, and what it said before.
 *
 * Imports: lookahead, tawr, learn, la_history, attachments.
 */

import { DEFAULT_LEGEND, DEFAULT_CODES } from './lookahead.js';
import { may, canEdit, canWrite } from './tawr.js';
import { entriesFor } from './learn.js';
import { rowEdit, cellEdit, rowLabel, LOCAL_EDITS_MAX } from './la_history.js';
import { cleanFileName, fileType, attachProblem } from './attachments.js';

const LOCAL_KEY = 'trackplan.ops.v1';
const ACTING_KEY = 'trackplan.acting.v1';

export class Refused extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

export const store = {
  mode: null,
  user: null,
  setupNeeded: false,
  workflow: null,
  /** Signing out: a request refused meanwhile is this, not a session that lapsed. */
  leaving: false,
};

/* ══════════════════════════════════════════════════════════════════════════
   Finding out which shape this is
   ═══════════════════════════════════════════════════════════════════════ */

export async function init() {
  if (!location.hostname.endsWith('github.io')) {
    try {
      const res = await fetch('api/me', { cache: 'no-store' });
      const j = res.ok ? await res.json() : null;
      if (j && j.mode === 'server') {
        store.mode = 'server';
        store.user = j.user;
        store.setupNeeded = j.setup_needed;
        store.workflow = j.workflow;
        return store;
      }
    } catch { /* no server: a static host, or a file */ }
  }
  store.mode = 'local';
  store.workflow = await fetch('data/tawr_workflow.json').then((r) => r.json());
  store.user = readActing();
  return store;
}

export const role = () => store.user?.role || null;
export const writer = () => canWrite(store.workflow, role());
export const isManager = () => role() === 'manager';

/* ══════════════════════════════════════════════════════════════════════════
   The server
   ═══════════════════════════════════════════════════════════════════════ */

async function http(method, url, body, { raw = null, type = 'application/json', bytes = false } = {}) {
  const headers = { 'X-Requested-With': 'trackplan' };
  if (body !== undefined || raw) headers['Content-Type'] = type;
  const res = await fetch(url, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (bytes && res.ok) return new Uint8Array(await res.arrayBuffer());
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && store.user && !store.leaving) {
    store.user = null;
    window.dispatchEvent(new CustomEvent('tp:signed-out'));
  }
  if (!res.ok) throw new Refused(j.error || res.statusText, res.status);
  return j;
}

/* ══════════════════════════════════════════════════════════════════════════
   This browser
   ═══════════════════════════════════════════════════════════════════════ */

function blankLocal() {
  return {
    rows: [], cells: [], legend: DEFAULT_LEGEND, codes: DEFAULT_CODES, version: 0,
    tawrs: [], merges: [], nextTawr: 1, settings: {}, descriptions: [], nextDescription: 1,
    memory: [], nextMemory: 1,
    edits: [], nextEdit: 1, editsSince: null, // the look-ahead's history, from editsSince
    seen: {}, nextComment: 1, nextAttachment: 1, // who has read which conversation; the ids of what was said and sent
  };
}

let memory = null;
function readLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (s && Array.isArray(s.rows)) {
      const out = { ...blankLocal(), ...s };
      // A copy made before the history was kept: it is kept from now.
      if (!out.editsSince) { out.editsSince = nowIso(); writeLocal(out); }
      return out;
    }
  } catch { /* storage blocked: memory only */ }
  return memory || (memory = { ...blankLocal(), editsSince: nowIso() });
}
function writeLocal(s) {
  memory = s;
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch { /* kept in memory only */ }
}

function readActing() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTING_KEY));
    if (a && a.name && ['requester', 'manager', 'viewer'].includes(a.role)) return { id: `local:${a.name}`, name: a.name, role: a.role };
  } catch { /* no choice yet */ }
  return null;
}

/** On the static site: who is using it, and in which role. */
export function setActing(name, roleId) {
  const a = { name: String(name || '').trim() || 'Me', role: roleId };
  try { localStorage.setItem(ACTING_KEY, JSON.stringify(a)); } catch { /* memory only */ }
  store.user = { id: `local:${a.name}`, name: a.name, role: a.role };
  return store.user;
}

const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
const clone = (v) => JSON.parse(JSON.stringify(v));

function requireWrite() {
  if (!store.user) throw new Refused('choose who you are first', 401);
  if (!writer()) throw new Refused('a viewer cannot change anything');
}

function history(r, action, note) {
  return [...(r?.history || []), { at: nowIso(), by: store.user.name, by_id: store.user.id, action, ...(note ? { note } : {}) }];
}

const LIVE_EXCLUDED = ['superseded', 'consolidated'];

/**
 * The look-ahead's ops on the stored rows and cells, and the history they make:
 * the same as `operations.apply_ops`. `log` may instead be the lines to keep in
 * their place — an import says what it replaced, once.
 */
function localOps(s, ops, log = true) {
  const rows = new Map(s.rows.map((r) => [r.id, r]));
  const cells = new Map(s.cells.map((c) => [`${c.row_id}|${c.day}`, c]));
  const edits = [];
  const label = (id) => rowLabel(rows.get(id), rows);
  const keep = (e) => { if (e) edits.push(e); };
  for (const op of ops) {
    if (op.op === 'row') {
      const held = rows.get(op.id);
      const next = { ...(held || { id: op.id, kind: 'activity', parent_id: null, sort: 0, activity_id: '', description: '', location: '', sswp: '', party: '', work_hours: '', link: null }), ...clone(op.set || {}), id: op.id };
      rows.set(op.id, next);
      keep(rowEdit(held || null, next, label(op.id)));
    } else if (op.op === 'delete_row') {
      const held = rows.get(op.id);
      if (held) keep(rowEdit(held, null, label(op.id)));
      rows.delete(op.id);
      for (const k of [...cells.keys()]) if (k.startsWith(`${op.id}|`)) cells.delete(k);
    } else if (op.op === 'cell') {
      const k = `${op.row_id}|${op.day}`;
      const was = cells.get(k) || null;
      if (!op.color && !op.text) cells.delete(k);
      else {
        if (!rows.has(op.row_id)) throw new Refused('that row is not on the look-ahead', 409);
        cells.set(k, { row_id: op.row_id, day: op.day, color: op.color ? String(op.color).toUpperCase() : null, text: op.text || '' });
      }
      keep(cellEdit(was, cells.get(k) || null, op.row_id, op.day, label(op.row_id)));
    }
  }
  s.rows = [...rows.values()];
  s.cells = [...cells.values()];
  s.version += 1;
  keepEdits(s, log === true ? edits : log || []);
}

/** Lines of the look-ahead's history, stamped with who and when, the batch being the version they made. */
function keepEdits(s, edits) {
  if (!edits.length) return;
  const at = nowIso();
  s.edits = s.edits || [];
  s.nextEdit = s.nextEdit || s.edits.reduce((m, e) => Math.max(m, e.id + 1), 1);
  for (const e of edits) s.edits.push({ id: s.nextEdit++, batch: s.version, at, by: store.user?.name || '', by_id: store.user?.id ?? null, ...e });
  if (s.edits.length > LOCAL_EDITS_MAX) s.edits = s.edits.slice(-LOCAL_EDITS_MAX);
}

function localTawr(s, id) {
  const r = s.tawrs.find((t) => t.id === id);
  if (!r) throw new Refused('no such request', 404);
  return r;
}

/* ══════════════════════════════════════════════════════════════════════════
   The interface
   ═══════════════════════════════════════════════════════════════════════ */

const local = () => store.mode === 'local';

// ── accounts (server only)
export async function login(username, password) {
  const j = await http('POST', 'api/login', { username, password });
  store.user = j.user;
  return j.user;
}
export async function setupFirst(username, name, password) {
  const j = await http('POST', 'api/setup', { username, name, password });
  store.user = j.user;
  store.setupNeeded = false;
  return j.user;
}
export async function logout() {
  if (local()) { store.user = null; try { localStorage.removeItem(ACTING_KEY); } catch { /* */ } return; }
  store.leaving = true;
  try {
    await http('POST', 'api/logout', {});
  } finally {
    store.leaving = false;
  }
  store.user = null;
}
export const listUsers = () => http('GET', 'api/users');
export const addUser = (u) => http('POST', 'api/users', u);
export const updateUser = (id, changes) => http('PUT', `api/users/${id}`, changes);

// ── the look-ahead
export async function getLookahead() {
  if (local()) {
    const s = readLocal();
    return clone({ rows: s.rows, cells: s.cells, legend: s.legend, codes: s.codes, version: s.version });
  }
  return http('GET', 'api/lookahead');
}

export async function lookaheadVersion() {
  if (local()) return readLocal().version;
  return (await http('GET', 'api/lookahead/version')).version;
}

export async function applyOps(ops) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    localOps(s, ops);
    writeLocal(s);
    return { version: s.version };
  }
  return http('POST', 'api/lookahead/ops', { ops });
}

export async function replaceLookahead(rows, cells, legend) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    const had = { rows: s.rows.length, cells: s.cells.length };
    s.rows = clone(rows);
    s.cells = clone(cells);
    s.version += 1;
    keepEdits(s, [{ target: 'import', action: 'replace', row_id: null, day: null, label: '', before: had, after: { rows: rows.length, cells: cells.length } }]);
    if (legend) setLocalList(s, 'legend', legend);
    writeLocal(s);
    return { version: s.version };
  }
  return http('POST', 'api/lookahead/replace', { rows, cells, legend });
}

/** The legend or the support codes replaced in this browser, and the change kept in the history. */
function setLocalList(s, key, value) {
  const was = s[key];
  s[key] = clone(value);
  s.version += 1;
  if (JSON.stringify(was) !== JSON.stringify(s[key])) keepEdits(s, [{ target: key, action: 'update', row_id: null, day: null, label: '', before: clone(was), after: clone(value) }]);
}

export async function setLegend(legend) {
  if (local()) { requireWrite(); const s = readLocal(); setLocalList(s, 'legend', legend); writeLocal(s); return s.legend; }
  return http('PUT', 'api/lookahead/legend', { legend });
}

/**
 * The look-ahead's history, newest first: `{ edits, more, since }`. One day of
 * a row (`row`, `day`), a row (`row`), several rows since a moment (`rows`,
 * `since`), the days `start`…`end` with every change that is not to a day, or
 * older than an edit (`before`) for the next page. As operations.list_edits.
 */
export async function listEdits({ row = null, day = null, rows = null, since = null, start = null, end = null, before = null, limit = 200 } = {}) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const want = rows ? new Set(rows) : null;
    const after = since ? Date.parse(since) : null;
    const found = (s.edits || []).filter((e) => (!row || e.row_id === row) && (!want || want.has(e.row_id)) && (!day || e.day === day)
      && (!start || !e.day || e.day >= start) && (!end || !e.day || e.day <= end)
      && (after == null || Date.parse(e.at) > after) && (before == null || e.id < before)).sort((a, b) => b.id - a.id);
    return { edits: clone(found.slice(0, limit)), more: found.length > limit, since: s.editsSince };
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ row, day, since, start, end, before, limit })) if (v != null && v !== '') q.set(k, String(v));
  if (rows?.length) q.set('rows', rows.join(','));
  return http('GET', `api/lookahead/edits?${q}`);
}

export async function setCodes(codes) {
  if (local()) { requireWrite(); const s = readLocal(); setLocalList(s, 'codes', codes); writeLocal(s); return s.codes; }
  return http('PUT', 'api/lookahead/codes', { codes });
}

// ── TAWRs
export async function listTawrs(since = null) {
  if (local()) {
    const s = readLocal();
    return s.tawrs.filter((t) => !since || t.week_start >= since).map((t) => localOut(s, t));
  }
  return http('GET', `api/tawrs${since ? `?since=${since}` : ''}`);
}

/** A request from this browser's copy as the server answers with one: its talk, and how far the reader has read it. */
function localOut(s, r) {
  return { ...clone(r), comments: clone(r.comments || []), attachments: clone(r.attachments || []), seen_comment: s.seen?.[store.user?.id]?.[r.id] || 0 };
}

export async function listMerges() {
  if (local()) return clone(readLocal().merges);
  return http('GET', 'api/tawrs/merges');
}

export async function createTawr(rec) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    if (s.tawrs.some((t) => t.week_start === rec.week_start && t.group_key === rec.group_key && !LIVE_EXCLUDED.includes(t.status))) {
      throw new Refused('there is already a request for that place and shift this week', 409);
    }
    const t = {
      id: s.nextTawr++, week_start: rec.week_start, group_key: rec.group_key, shift: rec.shift,
      location_name: rec.location_name || '', first_day: rec.first_day || null, status: 'draft', status_before: null,
      fields: clone(rec.fields || {}), generated: clone(rec.generated || {}), source: clone(rec.source || {}),
      supersedes: null, merged_into: null, decision_note: null, history: history(null, 'created'),
      created_by: store.user.id, created_at: nowIso(), updated_by: null, updated_at: null,
      submitted_by: null, submitted_at: null, decided_by: null, decided_at: null,
    };
    s.tawrs.push(t);
    writeLocal(s);
    return clone(t);
  }
  return http('POST', 'api/tawrs', rec);
}

export async function updateTawr(id, changes) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const r = localTawr(s, id);
    if ('fields' in changes) {
      if (!canEdit(store.workflow, role(), r.status)) throw new Refused(`a ${r.status} request cannot be changed in this role`);
      r.fields = clone(changes.fields);
      r.history = history(r, 'edited');
    }
    const regen = ['generated', 'source', 'location_name', 'first_day'].filter((k) => k in changes);
    if (regen.length) {
      requireWrite();
      if (r.status !== 'draft') throw new Refused(`only a draft follows the look-ahead; this one is ${r.status}`, 409);
      for (const k of regen) r[k] = clone(changes[k]);
    }
    r.updated_by = store.user.id;
    r.updated_at = nowIso();
    writeLocal(s);
    return clone(r);
  }
  return http('PUT', `api/tawrs/${id}`, changes);
}

/**
 * One step of the workflow. After approval, `deny` takes BART's reason as the
 * note and `cancel` the reason it was cancelled; `on` is the day it happened
 * and `released` that BART has been told the track is free.
 */
export async function act(id, action, note = null, { on = null, released = false } = {}) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const r = localTawr(s, id);
    if (!may(store.workflow, role(), action)) throw new Refused(`a ${store.workflow.roles[role()].toLowerCase()} cannot ${action} a request`);
    const out = localAct(s, r, action, note, { on, released });
    writeLocal(s);
    if (action === 'discard') await sweepFiles();
    return out;
  }
  const out = await http('POST', `api/tawrs/${id}/${action}`, { note, on, released });
  /* What the step leaves in the learning memory. The step stands whether or
     not that is written: the memory is advice, the request is the record. */
  const entries = entriesFor(out, action, note);
  if (entries.length) await remember(entries).catch(() => null);
  return out;
}

/** One step of the workflow on the browser's copy, once the role may take it. */
function localAct(s, r, action, note, { on = null, released = false } = {}) {
  const rule = store.workflow.actions[action];
  if (!rule.from.includes(r.status)) throw new Refused(`a ${r.status} request cannot be ${action}ed`, 409);
  if (rule.unblocked) {
    const blocking = (r.source?.flags || []).filter((f) => f.blocking);
    if (blocking.length) throw new Refused(`fix what is flagged first: ${blocking.map((f) => f.message).join(' ')}`, 409);
  }
  if (rule.note && !String(note || '').trim()) throw new Refused('say why', 400);
  if (action === 'discard') {
    s.tawrs = s.tawrs.filter((t) => t.id !== r.id);
    return { deleted: r.id };
  }
  const stamp = nowIso();
  r.status = rule.to;
  r.history = history(r, action, String(note || '').trim() || null);
  r.updated_by = store.user.id;
  r.updated_at = stamp;
  if (action === 'submit') Object.assign(r, { submitted_by: store.user.id, submitted_at: stamp, decision_note: null });
  if (action === 'approve' || action === 'reject') Object.assign(r, { decided_by: store.user.id, decided_at: stamp, decision_note: String(note || '').trim() || null });
  if (action === 'deny' || action === 'cancel') {
    const day = dayOf(on, 'on') || localDay();
    const bart = { ...(r.bart || {}) };
    if (action === 'deny') Object.assign(bart, { answer: 'denied', answered_on: day, note: String(note).trim().slice(0, 1000) });
    else if (released) bart.released_on = day;
    r.bart = { ...bart, by: store.user.name };
  }
  keepLocalMemory(s, entriesFor(r, action, note));
  let out = r;
  if (rule.creates) {
    out = {
      ...clone(r), id: s.nextTawr++, status: 'draft', supersedes: r.id, merged_into: null, decision_note: null,
      history: history(null, `revision of #${r.id}`), created_by: store.user.id, created_at: stamp,
      submitted_by: null, submitted_at: null, decided_by: null, decided_at: null,
      // As on a server: its files go with it; what was said, and BART's answer, stay with the request they were about.
      comments: [], attachments: carryFiles(s, r.attachments), bart: null, access: null,
    };
    s.tawrs.push(out);
  }
  return clone(out);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayOf(v, name) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !DAY_RE.test(v)) throw new Refused(`${name} must be YYYY-MM-DD`, 400);
  return v;
}
/** Today in this computer's own time zone, as a person would write it. */
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mayRecord(r, kind) {
  const rule = store.workflow.records?.[kind];
  if (!rule) throw new Refused(`nothing called ${kind} is recorded on a request`, 400);
  if (!rule.roles.includes(role())) throw new Refused(`a ${store.workflow.roles[role()].toLowerCase()} cannot record that`);
  if (!rule.on.includes(r.status)) throw new Refused(`that is recorded on an approved request; this one is ${r.status}`, 409);
}

/**
 * What happened with BART after approval — `{ sent_on, ref, answer, answered_on,
 * released_on }`, only the keys given changing. As operations.record_bart.
 */
export async function recordBart(id, body) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const r = localTawr(s, id);
    mayRecord(r, 'bart');
    const bart = { ...(r.bart || {}) };
    for (const k of ['sent_on', 'answered_on', 'released_on']) {
      if (!(k in body)) continue;
      if (k === 'released_on' && r.status !== 'cancelled') throw new Refused('the track is released once the request is cancelled', 409);
      bart[k] = dayOf(body[k], k);
    }
    if ('ref' in body) {
      if (body.ref != null && (typeof body.ref !== 'string' || body.ref.length > 60)) throw new Refused('BART\'s reference is at most 60 characters', 400);
      bart.ref = String(body.ref || '').trim() || null;
    }
    if ('answer' in body) {
      if (![null, 'granted'].includes(body.answer)) throw new Refused('BART\'s answer is granted, or nothing yet — a denial is recorded with its reason', 400);
      if (r.status !== 'approved' && body.answer) throw new Refused('only an approved request is granted', 409);
      bart.answer = body.answer;
      if (body.answer && !bart.answered_on) bart.answered_on = localDay();
    }
    const said = [
      bart.sent_on && 'sent_on' in body ? `sent to BART ${bart.sent_on}` : null,
      bart.ref && 'ref' in body ? `BART reference ${bart.ref}` : null,
      bart.answer === 'granted' && 'answer' in body ? 'BART granted it' : null,
      bart.released_on && 'released_on' in body ? `BART told the track is released ${bart.released_on}` : null,
    ].filter(Boolean);
    r.bart = { ...bart, by: store.user.name };
    r.history = history(r, said.join('; ') || 'BART details changed');
    r.updated_by = store.user.id;
    r.updated_at = nowIso();
    writeLocal(s);
    return clone(r);
  }
  return http('PUT', `api/tawrs/${id}/bart`, body);
}

/** Whether each day's access was used: `{ days: { date: true|false }, note }`. As operations.record_access. */
export async function recordAccess(id, body) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const r = localTawr(s, id);
    mayRecord(r, 'access');
    const asked = new Set((r.source?.days || []).map((d) => d.date));
    const entries = Object.entries(body?.days || {});
    if (!entries.length) throw new Refused('say which days the access was used', 400);
    for (const [day, used] of entries) {
      if (!asked.has(day)) throw new Refused(`${day} is not one of the days this request asked for`, 400);
      if (typeof used !== 'boolean') throw new Refused('each day is used (true) or not (false)', 400);
    }
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 1000)) throw new Refused('the note is at most 1,000 characters', 400);
    const days = Object.fromEntries(entries);
    r.access = { days, note: String(body.note || '').trim() || null, on: dayOf(body.on, 'on') || localDay(), by: store.user.name };
    const used = entries.filter(([, u]) => u).length;
    r.history = history(r, `access recorded: used on ${used} of ${entries.length} day${entries.length === 1 ? '' : 's'}`, r.access.note);
    r.updated_by = store.user.id;
    r.updated_at = nowIso();
    writeLocal(s);
    return clone(r);
  }
  return http('PUT', `api/tawrs/${id}/access`, body);
}

/**
 * The sample's weeks as they would stand by now, in this browser: each step
 * taken as `act` takes it but in no one's role — the static site's roles are
 * chosen, not checked, and these stand for weeks already dealt with. `steps`
 * is `[[id, action, at?], …]`, all or none; `at` stamps the step when the
 * sample's story says it was taken.
 */
export function settleLocalSample(steps, fills = {}, barts = {}) {
  if (!local()) throw new Refused('only the copy in this browser can be settled like this');
  requireWrite();
  const s = readLocal();
  // What the requester typed into them before they were sent: hand edits, over what was generated.
  for (const [id, fields] of Object.entries(fills)) {
    const r = localTawr(s, Number(id));
    r.fields = { ...r.fields, ...clone(fields) };
  }
  // Each step stamped when the sample's story says it was taken, where it says.
  for (const [id, action, at] of steps) {
    const r = localTawr(s, id);
    localAct(s, r, action, null);
    if (at) backdate(r, action, at);
  }
  // And what happened with BART once they were approved: noted on the day of its latest news.
  for (const [id, bart] of Object.entries(barts)) {
    const r = localTawr(s, Number(id));
    r.bart = { ...clone(bart), by: store.user.name };
    r.history = history(r, [`sent to BART ${bart.sent_on}`, bart.ref && `BART reference ${bart.ref}`, bart.answer === 'granted' && 'BART granted it'].filter(Boolean).join('; '));
    const day = bart.answered_on || bart.sent_on;
    if (day) r.history[r.history.length - 1].at = new Date(`${day}T16:00:00`).toISOString();
  }
  writeLocal(s);
}

/** A sample's step stamped when its story says it was taken, not when the sample was loaded — and raised before it. */
function backdate(r, action, at) {
  r.history[r.history.length - 1].at = at;
  r.updated_at = at;
  if (action === 'submit') r.submitted_at = at;
  if (action === 'approve' || action === 'reject') r.decided_at = at;
  const made = r.history[0];
  if (made?.action === 'created' && Date.parse(made.at) > Date.parse(at)) made.at = r.created_at = new Date(Date.parse(at) - 3600e3).toISOString();
}

export async function consolidate(ids, merge, record, note = null) {
  if (local()) {
    if (!may(store.workflow, role(), 'consolidate')) throw new Refused('only the track allocation manager consolidates requests');
    const s = readLocal();
    const rows = ids.map((i) => localTawr(s, i));
    if (new Set(rows.map((r) => r.week_start)).size !== 1 || new Set(rows.map((r) => r.shift)).size !== 1) {
      throw new Refused('only requests in the same week and shift can be consolidated', 409);
    }
    if (new Set(rows.map((r) => r.source?.kind)).size !== 1) {
      throw new Refused('a TCR request and a track request cannot be consolidated — they are different categories of work', 409);
    }
    const from = store.workflow.actions.consolidate.from;
    for (const r of rows) if (!from.includes(r.status)) throw new Refused(`#${r.id} is ${r.status}; only drafts and submitted requests can be consolidated`, 409);
    const stamp = nowIso();
    const status = rows.every((r) => r.status === 'submitted') ? 'submitted' : 'draft';
    s.merges.push({ id: merge.id, week_start: rows[0].week_start, shift: rows[0].shift, keys: rows.map((r) => r.group_key).sort(), created_by: store.user.id, created_at: stamp });
    const t = {
      id: s.nextTawr++, week_start: record.week_start, group_key: record.group_key, shift: record.shift,
      location_name: record.location_name || '', first_day: record.first_day || null, status, status_before: null,
      fields: clone(record.fields || {}), generated: clone(record.generated || {}), source: clone(record.source || {}),
      supersedes: null, merged_into: null, decision_note: null, comments: [],
      attachments: rows.flatMap((r) => carryFiles(s, r.attachments)),
      history: history(null, `consolidated from ${rows.map((r) => `#${r.id}`).join(', ')}`, note),
      created_by: store.user.id, created_at: stamp, updated_by: null, updated_at: null,
      submitted_by: status === 'submitted' ? store.user.id : null, submitted_at: status === 'submitted' ? stamp : null,
      decided_by: null, decided_at: null,
    };
    s.tawrs.push(t);
    for (const r of rows) Object.assign(r, { status_before: r.status, status: 'consolidated', merged_into: t.id, updated_at: stamp, history: history(r, `consolidated into #${t.id}`, note) });
    writeLocal(s);
    return clone(t);
  }
  return http('POST', 'api/tawrs/consolidate', { ids, merge, record, note });
}

export async function split(id) {
  if (local()) {
    if (!may(store.workflow, role(), 'split')) throw new Refused('only the track allocation manager splits a consolidated request');
    const s = readLocal();
    const r = localTawr(s, id);
    if (!String(r.group_key).startsWith('merge:')) throw new Refused('that request was not consolidated', 409);
    if (!store.workflow.actions.split.from.includes(r.status)) throw new Refused(`a ${r.status} request cannot be split; revise it first`, 409);
    const mergeId = r.group_key.slice('merge:'.length);
    s.tawrs = s.tawrs.filter((t) => t.id !== id);
    s.merges = s.merges.filter((m) => m.id !== mergeId);
    for (const m of s.tawrs.filter((t) => t.merged_into === id && t.status === 'consolidated')) {
      Object.assign(m, { status: ['draft', 'submitted'].includes(m.status_before) ? m.status_before : 'draft', status_before: null, merged_into: null, history: history(m, `split back out of #${id}`) });
      // Nothing said or sent about the merged request is lost: it goes back to every member.
      m.comments = [...(m.comments || []), ...(r.comments || []).map((c) => ({ ...clone(c), id: nextLocalId(s, 'nextComment', 'comments') }))];
      m.attachments = [...(m.attachments || []), ...carryFiles(s, (r.attachments || []).filter((a) => a.copied_from == null))];
    }
    writeLocal(s);
    await sweepFiles();
    return { deleted: id };
  }
  return http('POST', `api/tawrs/${id}/split`, {});
}

// ── setup
export async function getSettings() {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const all = clone(readLocal().settings);
    return writer() ? all : Object.fromEntries(Object.entries(all).filter(([k]) => PUBLIC_SETTINGS.includes(k)));
  }
  return http('GET', 'api/tawr/settings');
}
/** What a viewer may read of the setup, as on the server (operations.PUBLIC_SETTING_KEYS). */
const PUBLIC_SETTINGS = ['phases'];

// ── the learning memory (learn.js reads it; operations.py keeps it on a server)
const LOCAL_MEMORY_MAX = 3000;

function keepLocalMemory(s, entries) {
  if (!entries.length) return [];
  const at = nowIso();
  s.memory = s.memory || [];
  s.nextMemory = s.nextMemory || s.memory.reduce((m, e) => Math.max(m, e.id + 1), 1);
  const kept = entries.map((e) => ({ id: s.nextMemory++, kind: e.kind, tawr_id: e.tawr_id ?? null, data: clone(e.data), at, by: store.user?.name || '', by_id: store.user?.id || null }));
  s.memory = [...s.memory, ...kept].slice(-LOCAL_MEMORY_MAX);
  return kept;
}

export async function listMemory() {
  if (local()) { requireWrite(); return clone(readLocal().memory || []); }
  return http('GET', 'api/memory');
}

/** Write entries into the memory: what learn.js made of a step, or a link. */
export async function remember(entries) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    const kept = keepLocalMemory(s, entries);
    writeLocal(s);
    return clone(kept);
  }
  return http('POST', 'api/memory', { entries });
}

export async function forgetMemory(id) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    const before = (s.memory || []).length;
    s.memory = (s.memory || []).filter((e) => e.id !== id);
    if (s.memory.length === before) throw new Refused('no such memory', 404);
    writeLocal(s);
    return { forgotten: id };
  }
  return http('DELETE', `api/memory/${id}`);
}

export async function clearMemory() {
  if (local()) {
    requireWrite();
    const s = readLocal();
    const n = (s.memory || []).length;
    s.memory = [];
    writeLocal(s);
    return { forgotten: n };
  }
  return http('POST', 'api/memory/clear', {});
}

// ── the deadlines as a calendar (server only: a calendar subscribes to a link)

/** A new calendar link for whoever is signed in, replacing any before it: the URL to subscribe to. */
export async function calendarLink() {
  if (local()) throw new Refused('a calendar link needs the server; download the calendar instead', 409);
  const { token } = await http('POST', 'api/calendar/token', {});
  return new URL(`api/calendar.ics?token=${encodeURIComponent(token)}`, document.baseURI).href;
}

export async function stopCalendarLink() {
  if (local()) return { stopped: false };
  return http('DELETE', 'api/calendar/token');
}

export async function setSettings(values) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    for (const [k, v] of Object.entries(values)) s.settings[k] = v;
    writeLocal(s);
    return clone(s.settings);
  }
  return http('PUT', 'api/tawr/settings', values);
}

export async function listDescriptions() {
  if (local()) return clone(readLocal().descriptions);
  return http('GET', 'api/tawr/descriptions');
}

export async function saveDescription(id, body) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    const fold = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const clash = s.descriptions.find((d) => fold(d.activity) === fold(body.activity) && d.id !== id);
    if (clash) throw new Refused(`"${clash.activity}" already has wording — edit that one`, 409);
    if (id == null) {
      const d = { id: s.nextDescription++, activity: body.activity.trim(), description: (body.description || '').trim() };
      s.descriptions.push(d);
      writeLocal(s);
      return d;
    }
    const d = s.descriptions.find((x) => x.id === id);
    if (!d) throw new Refused('no such wording', 404);
    Object.assign(d, { activity: body.activity.trim(), description: (body.description || '').trim() });
    writeLocal(s);
    return d;
  }
  return id == null ? http('POST', 'api/tawr/descriptions', body) : http('PUT', `api/tawr/descriptions/${id}`, body);
}

export async function deleteDescription(id) {
  if (local()) {
    requireWrite();
    const s = readLocal();
    s.descriptions = s.descriptions.filter((d) => d.id !== id);
    writeLocal(s);
    return { deleted: id };
  }
  return http('DELETE', `api/tawr/descriptions/${id}`);
}

// ── Files in this browser: BART's blank form, and what is sent with requests (`file:<sha256>`)
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('trackplan', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const idbGet = (key) => idbDo('readonly', (os) => os.get(key));
const idbPut = (key, bytes) => idbDo('readwrite', (os) => os.put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key));
const idbKeys = () => idbDo('readonly', (os) => os.getAllKeys());
const idbDelete = (key) => idbDo('readwrite', (os) => os.delete(key));

/** A file's SHA-256, its name in this browser's store: the same file sent twice is kept once. */
async function sha256Hex(bytes) {
  if (!crypto?.subtle) return `x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`; // not a secure page: no digest to share by
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Files no request carries any more, forgotten: after a discard, a split, a removal, a fresh start. */
async function sweepFiles() {
  try {
    const held = new Set(readLocal().tawrs.flatMap((t) => (t.attachments || []).map((a) => `file:${a.sha256}`)));
    for (const k of await idbKeys()) if (String(k).startsWith('file:') && !held.has(k)) await idbDelete(k);
  } catch { /* storage blocked: nothing kept to forget */ }
}

export async function getTemplate() {
  if (local()) {
    if (role() === 'viewer') return null;
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('files').objectStore('files').get('tawr_template');
        req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }
  const bytes = await http('GET', 'api/tawr/template', undefined, { bytes: true });
  return bytes.length ? bytes : null; // 204: not uploaded yet
}

export async function putTemplate(bytes) {
  if (local()) {
    requireWrite();
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'tawr_template');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return { size: bytes.length };
  }
  return http('PUT', 'api/tawr/template', undefined, { raw: bytes, type: 'application/pdf' });
}

// ── What is said and sent with a request (conversation.js reads the first, attachments.js rules the second)
const COMMENT_LIMIT = 2000;

/** The next id of something kept on requests in this browser: comments, or files. */
function nextLocalId(s, counter, list) {
  if (!s[counter]) s[counter] = s.tawrs.flatMap((t) => t[list] || []).reduce((m, x) => Math.max(m, x.id + 1), 1);
  return s[counter]++;
}

/** A request's files onto another (a revision, a consolidation, a split): the bytes are shared, never copied. */
function carryFiles(s, list) {
  return (list || []).map((a) => ({ ...clone(a), id: nextLocalId(s, 'nextAttachment', 'attachments'), copied_from: a.id }));
}

function seenLocal(s, tawrId, upto) {
  const mine = s.seen[store.user.id] || (s.seen[store.user.id] = {});
  mine[tawrId] = Math.max(mine[tawrId] || 0, upto);
}

/** Say something on a request: any request, at any point in its life. As operations.add_comment. */
export async function addComment(id, text) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    if (!(store.workflow.comment || store.workflow.write).includes(role())) throw new Refused(`a ${store.workflow.roles[role()].toLowerCase()} cannot comment`);
    const t = String(text ?? '').trim();
    if (!t) throw new Refused('write something first', 400);
    if (t.length > COMMENT_LIMIT) throw new Refused('a comment is at most 2,000 characters', 400);
    const s = readLocal();
    const r = localTawr(s, id);
    const c = { id: nextLocalId(s, 'nextComment', 'comments'), at: nowIso(), by: store.user.name, by_id: store.user.id, text: t };
    r.comments = [...(r.comments || []), c];
    seenLocal(s, id, c.id); // what you wrote, you have read
    writeLocal(s);
    return localOut(s, r);
  }
  return http('POST', `api/tawrs/${id}/comments`, { text });
}

/** A request's conversation as it stands now — opened, it is current, whatever was loaded before. */
export async function listComments(id) {
  if (local()) return clone(localTawr(readLocal(), id).comments || []);
  return http('GET', `api/tawrs/${id}/comments`);
}

/** Shown the conversation up to comment `upto`: nothing older is new to whoever is reading. */
export async function markSeen(id, upto) {
  if (local()) {
    if (!store.user) return { seen_comment: 0 };
    const s = readLocal();
    seenLocal(s, id, upto);
    writeLocal(s);
    return { tawr_id: id, seen_comment: upto };
  }
  return http('POST', `api/tawrs/${id}/seen`, { upto });
}

function mayAttach(r) {
  if (!store.user) throw new Refused('choose who you are first', 401);
  if (!canEdit(store.workflow, role(), r.status)) {
    throw new Refused(`the files on a ${r.status} request cannot be changed by a ${store.workflow.roles[role()].toLowerCase()}`, writer() ? 409 : 403);
  }
}

/** Send a file with a request — the SSWP, a drawing, a permit — where its fields may change. As operations.add_attachment. */
export async function addAttachment(id, file) {
  const name = cleanFileName(file.name);
  const bytes = file.bytes || new Uint8Array(await file.arrayBuffer());
  if (local()) {
    const before = localTawr(readLocal(), id);
    mayAttach(before);
    const problem = attachProblem(name, bytes.length, (before.attachments || []).length);
    if (problem) throw new Refused(problem.message, problem.status);
    const sha = await sha256Hex(bytes);
    try { await idbPut(`file:${sha}`, bytes); } catch { throw new Refused('this browser would not keep the file (private window, or storage full)', 507); }
    const s = readLocal(); // read again: the file took a moment to keep
    const r = localTawr(s, id);
    mayAttach(r);
    r.attachments = [...(r.attachments || []), {
      id: nextLocalId(s, 'nextAttachment', 'attachments'), name, type: fileType(name), size: bytes.length, sha256: sha,
      at: nowIso(), by: store.user.name, by_id: store.user.id, copied_from: null,
    }];
    r.history = history(r, `attached ${name}`);
    r.updated_by = store.user.id;
    r.updated_at = nowIso();
    writeLocal(s);
    return localOut(s, r);
  }
  return http('POST', `api/tawrs/${id}/attachments?name=${encodeURIComponent(name)}`, undefined, { raw: bytes, type: fileType(name) || 'application/octet-stream' });
}

/** The bytes of a file sent with a request. */
export async function attachmentBytes(a) {
  if (local()) {
    const got = await idbGet(`file:${a.sha256}`).catch(() => null);
    if (!got) throw new Refused('this browser no longer has that file', 404);
    return new Uint8Array(got);
  }
  return http('GET', `api/attachments/${a.id}`, undefined, { bytes: true });
}

export async function removeAttachment(id, aid) {
  if (local()) {
    const s = readLocal();
    const r = localTawr(s, id);
    const a = (r.attachments || []).find((x) => x.id === aid);
    if (!a) throw new Refused('no such file on that request', 404);
    mayAttach(r);
    r.attachments = r.attachments.filter((x) => x.id !== aid);
    r.history = history(r, `removed ${a.name}`);
    r.updated_by = store.user.id;
    r.updated_at = nowIso();
    writeLocal(s);
    await sweepFiles();
    return localOut(s, r);
  }
  return http('DELETE', `api/tawrs/${id}/attachments/${aid}`);
}

/** On the static site: forget every TAWR and consolidation in this browser (sample data, a fresh start). */
export function clearLocalTawrs() {
  if (!local()) throw new Refused('only the copy in this browser can be cleared');
  requireWrite();
  const s = readLocal();
  s.tawrs = [];
  s.merges = [];
  s.nextTawr = 1;
  s.memory = []; // what was learned from them goes with them: request numbers start again
  s.seen = {};
  writeLocal(s);
  sweepFiles(); // and the files sent with them
}

// ── backing up the browser's copy, with the files sent with requests (base64, under `files`)
const toBase64 = (bytes) => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export async function exportLocal() {
  const s = readLocal();
  const files = {};
  for (const sha of new Set(s.tawrs.flatMap((t) => (t.attachments || []).map((a) => a.sha256)))) {
    const got = await idbGet(`file:${sha}`).catch(() => null);
    if (got) files[sha] = toBase64(new Uint8Array(got));
  }
  return JSON.stringify({ ...s, files }, null, 1);
}

export async function importLocal(text) {
  const { files = {}, ...s } = JSON.parse(text);
  if (!s || !Array.isArray(s.rows) || !Array.isArray(s.tawrs)) throw new Error('That is not a Track-Plan backup.');
  for (const [sha, b64] of Object.entries(files)) await idbPut(`file:${sha}`, fromBase64(b64));
  writeLocal({ ...blankLocal(), ...s });
}
