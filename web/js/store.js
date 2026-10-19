/**
 * Where the look-ahead, the TAWRs and the accounts live.
 *
 * Two shapes, one interface:
 *
 * **server** — `server.py` is running. Everything is in its database, people
 * sign in, and the server decides what each role may do (`operations.py`).
 *
 * **local** — a static host (GitHub Pages) with no server. Everything is kept
 * in this browser (localStorage, and IndexedDB for BART's form), and the
 * person says which role they are acting as. The same workflow table is
 * applied here, so the screen behaves the same — but nothing on a static site
 * can stop somebody choosing another role, and the page says so.
 *
 * Imports: lookahead, tawr.
 */

import { DEFAULT_LEGEND, DEFAULT_CODES } from './lookahead.js';
import { may, canEdit, canWrite } from './tawr.js';
import { entriesFor } from './learn.js';

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
  };
}

let memory = null;
function readLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (s && Array.isArray(s.rows)) return { ...blankLocal(), ...s };
  } catch { /* storage blocked: memory only */ }
  return memory || (memory = blankLocal());
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

/** The look-ahead's ops on the stored rows and cells: the same as `operations.apply_ops`. */
function localOps(s, ops) {
  const rows = new Map(s.rows.map((r) => [r.id, r]));
  const cells = new Map(s.cells.map((c) => [`${c.row_id}|${c.day}`, c]));
  for (const op of ops) {
    if (op.op === 'row') {
      const held = rows.get(op.id);
      rows.set(op.id, { ...(held || { id: op.id, kind: 'activity', parent_id: null, sort: 0, activity_id: '', description: '', location: '', sswp: '', party: '', work_hours: '', link: null }), ...clone(op.set || {}), id: op.id });
    } else if (op.op === 'delete_row') {
      rows.delete(op.id);
      for (const k of [...cells.keys()]) if (k.startsWith(`${op.id}|`)) cells.delete(k);
    } else if (op.op === 'cell') {
      const k = `${op.row_id}|${op.day}`;
      if (!op.color && !op.text) cells.delete(k);
      else {
        if (!rows.has(op.row_id)) throw new Refused('that row is not on the look-ahead', 409);
        cells.set(k, { row_id: op.row_id, day: op.day, color: op.color ? String(op.color).toUpperCase() : null, text: op.text || '' });
      }
    }
  }
  s.rows = [...rows.values()];
  s.cells = [...cells.values()];
  s.version += 1;
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
    s.rows = clone(rows);
    s.cells = clone(cells);
    if (legend) s.legend = clone(legend);
    s.version += 1;
    writeLocal(s);
    return { version: s.version };
  }
  return http('POST', 'api/lookahead/replace', { rows, cells, legend });
}

export async function setLegend(legend) {
  if (local()) { requireWrite(); const s = readLocal(); s.legend = clone(legend); s.version += 1; writeLocal(s); return s.legend; }
  return http('PUT', 'api/lookahead/legend', { legend });
}

export async function setCodes(codes) {
  if (local()) { requireWrite(); const s = readLocal(); s.codes = clone(codes); s.version += 1; writeLocal(s); return s.codes; }
  return http('PUT', 'api/lookahead/codes', { codes });
}

// ── TAWRs
export async function listTawrs(since = null) {
  if (local()) return clone(readLocal().tawrs.filter((t) => !since || t.week_start >= since));
  return http('GET', `api/tawrs${since ? `?since=${since}` : ''}`);
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
 * is `[[id, action], …]`, all or none.
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
  for (const [id, action] of steps) localAct(s, localTawr(s, id), action, null);
  // And what happened with BART once they were approved.
  for (const [id, bart] of Object.entries(barts)) {
    const r = localTawr(s, Number(id));
    r.bart = { ...clone(bart), by: store.user.name };
    r.history = history(r, [`sent to BART ${bart.sent_on}`, bart.ref && `BART reference ${bart.ref}`, bart.answer === 'granted' && 'BART granted it'].filter(Boolean).join('; '));
  }
  writeLocal(s);
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
      supersedes: null, merged_into: null, decision_note: null,
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
    }
    writeLocal(s);
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

// ── BART's blank form: never published with the site
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('trackplan', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

/** On the static site: forget every TAWR and consolidation in this browser (sample data, a fresh start). */
export function clearLocalTawrs() {
  if (!local()) throw new Refused('only the copy in this browser can be cleared');
  requireWrite();
  const s = readLocal();
  s.tawrs = [];
  s.merges = [];
  s.nextTawr = 1;
  s.memory = []; // what was learned from them goes with them: request numbers start again
  writeLocal(s);
}

// ── backing up the browser's copy
export function exportLocal() {
  return JSON.stringify(readLocal(), null, 1);
}

export function importLocal(text) {
  const s = JSON.parse(text);
  if (!s || !Array.isArray(s.rows) || !Array.isArray(s.tawrs)) throw new Error('That is not a Track-Plan backup.');
  writeLocal({ ...blankLocal(), ...s });
}
