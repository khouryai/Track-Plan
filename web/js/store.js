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

export async function act(id, action, note = null) {
  if (local()) {
    if (!store.user) throw new Refused('choose who you are first', 401);
    const s = readLocal();
    const r = localTawr(s, id);
    if (!may(store.workflow, role(), action)) throw new Refused(`a ${store.workflow.roles[role()].toLowerCase()} cannot ${action} a request`);
    const out = localAct(s, r, action, note);
    writeLocal(s);
    return out;
  }
  return http('POST', `api/tawrs/${id}/${action}`, { note });
}

/** One step of the workflow on the browser's copy, once the role may take it. */
function localAct(s, r, action, note) {
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

/**
 * The sample's weeks as they would stand by now, in this browser: each step
 * taken as `act` takes it but in no one's role — the static site's roles are
 * chosen, not checked, and these stand for weeks already dealt with. `steps`
 * is `[[id, action], …]`, all or none.
 */
export function settleLocalSample(steps) {
  if (!local()) throw new Refused('only the copy in this browser can be settled like this');
  requireWrite();
  const s = readLocal();
  for (const [id, action] of steps) localAct(s, localTawr(s, id), action, null);
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
  if (local()) { requireWrite(); return clone(readLocal().settings); }
  return http('GET', 'api/tawr/settings');
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
