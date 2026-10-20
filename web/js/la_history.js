/**
 * The look-ahead's history in words: who changed which day or row, when, and
 * what it said before.
 *
 * The edits are what the server keeps in `la_edits` (operations.apply_ops) —
 * or, on the static site, the browser's copy kept the same way by `store.js` —
 * one entry for each thing changed:
 *
 *   { id, batch, at, by, by_id, target: 'cell' | 'row' | 'import' | 'legend' | 'codes',
 *     action: 'insert' | 'update' | 'delete' | 'replace', row_id, day, label, before, after }
 *
 * A day's `before` and `after` are `{ color, text }`; a row's are the fields
 * that changed, its link kept as where it is (`linkBrief`), never the drawing's
 * geometry. `label` is what the row was called then, so a deleted row's history
 * still says what it was. Nothing is reconstructed: a day's history is its
 * entries, read in order, and an undo is new entries like any other.
 *
 * A request uses it too: which edits lie behind a change to the look-ahead since
 * it was submitted (`editsFor`), said as who and when (`whoText`).
 *
 * Pure: no DOM — tests/test_tawr.mjs reads it.
 *
 * Imports: lookahead, links.
 */

import { cellTokens, resourceNames } from './lookahead.js';
import { linkLabel } from './links.js';

/** A row's own fields as its history tells them; where it sits (`sort`) is not what it says. */
export const LOGGED_ROW_FIELDS = ['kind', 'parent_id', 'activity_id', 'description', 'location', 'sswp', 'party', 'work_hours', 'link'];
const LINK_BRIEF = ['location_id', 'location_name', 'location_kind', 'limits'];
const FIELD_NAME = {
  activity_id: 'Activity ID', description: 'Description', location: 'Location', sswp: 'SSWP #',
  party: 'Party to action', work_hours: 'Work hours', link: 'Track plan link', kind: 'Kind', parent_id: 'Activity it is under',
};
/** How many entries the browser keeps on the static site; a server keeps them all. */
export const LOCAL_EDITS_MAX = 5000;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** What a link's history keeps of it: where it is, never the drawing's geometry. */
export function linkBrief(link) {
  if (!link) return null;
  const out = {};
  for (const k of LINK_BRIEF) if (link[k] != null) out[k] = clone(link[k]);
  return out;
}

/** A row as its history keeps it: what it says, never where it sits. */
export function rowBrief(row) {
  const out = {};
  for (const k of LOGGED_ROW_FIELDS) out[k] = k === 'link' ? linkBrief(row?.link) : row?.[k] ?? (k === 'parent_id' ? null : '');
  return out;
}

/** What a row was called when it changed: "C-W101 · Cable trough"; a names row by its activity. As operations._row_label. */
export function rowLabel(row, rowsById = new Map()) {
  if (!row) return '';
  if (row.kind === 'resource') {
    const parent = row.parent_id ? rowsById.get(row.parent_id) : null;
    return parent ? `Names under ${rowLabel(parent, rowsById)}` : 'Names';
  }
  const aid = String(row.activity_id || '').trim();
  const desc = String(row.description || '').trim();
  return [aid, desc].filter(Boolean).join(' · ') || (row.kind === 'section' ? 'Section' : 'Activity');
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The entry for one row changed by an op, or null when nothing it says
 * changed: `old` is the row before (null for a new row), `next` after (null
 * for a deleted one). As operations.apply_ops.
 */
export function rowEdit(old, next, label) {
  if (!old && next) return { target: 'row', action: 'insert', row_id: next.id, day: null, label, before: null, after: rowBrief(next) };
  if (old && !next) return { target: 'row', action: 'delete', row_id: old.id, day: null, label, before: rowBrief(old), after: null };
  const before = {};
  const after = {};
  for (const k of LOGGED_ROW_FIELDS) {
    if (k === 'link') {
      if (!sameJson(old.link || null, next.link || null)) { before.link = linkBrief(old.link); after.link = linkBrief(next.link); }
    } else if (String(old[k] ?? '') !== String(next[k] ?? '')) {
      before[k] = old[k] ?? (k === 'parent_id' ? null : '');
      after[k] = next[k] ?? (k === 'parent_id' ? null : '');
    }
  }
  return Object.keys(after).length ? { target: 'row', action: 'update', row_id: next.id, day: null, label, before, after } : null;
}

/** The entry for one day changed by an op, or null when it says what it said. */
export function cellEdit(was, now, rowId, day, label) {
  const value = (c) => (c && (c.color || c.text) ? { color: c.color ? String(c.color).toUpperCase() : null, text: String(c.text ?? '') } : null);
  const before = value(was);
  const after = value(now);
  if (sameJson(before, after)) return null;
  return { target: 'cell', action: !before ? 'insert' : !after ? 'delete' : 'update', row_id: rowId, day, label, before, after };
}

/* ── In words ─────────────────────────────────────────────────────────── */

function counts(text, struck) {
  const m = new Map();
  for (const t of cellTokens(text)) if (Boolean(t.cancelled) === struck) m.set(t.code, (m.get(t.code) || 0) + 1);
  return m;
}
/** What `b` has more of than `a`, one entry per extra code. */
function more(a, b) {
  const out = [];
  for (const [code, n] of b) for (let i = a.get(code) || 0; i < n; i++) out.push(code);
  return out;
}
function minus(list, take) {
  const left = [...list];
  for (const t of take) { const at = left.indexOf(t); if (at >= 0) left.splice(at, 1); }
  return left;
}

/** Whether a day's text is support codes ("X.~WIT") rather than a note: as lookahead.normaliseSupportIfCodes reads it. */
const looksLikeCodes = (text) => !String(text).trim() || /^~?\s*[A-Za-z]{1,6}(\s*\.\s*~?\s*[A-Za-z]{1,6})*\.?$/.test(String(text).trim());

/**
 * How the support typed in a day changed: codes added, taken off, struck out
 * ("~WIT": asked for, then cancelled) and put back — one entry per code, so
 * "X" → "X.X" is one more X.
 */
export function codesDiff(was, now) {
  const liveA = counts(was, false);
  const liveB = counts(now, false);
  const struckA = counts(was, true);
  const struckB = counts(now, true);
  const struck = more(struckA, struckB);
  const unstruck = more(struckB, struckA);
  let added = more(liveA, liveB);
  const reinstated = unstruck.filter((c) => added.includes(c));
  added = minus(added, reinstated);
  const removed = minus(more(liveB, liveA), struck);
  return { added, removed, struck, reinstated };
}

/** Who was put on a names row and who was taken off. */
export function namesDiff(was, now) {
  const a = resourceNames(was);
  const b = resourceNames(now);
  const fold = (s) => s.toLowerCase();
  return { added: b.filter((n) => !a.some((x) => fold(x) === fold(n))), removed: a.filter((n) => !b.some((x) => fold(x) === fold(n))) };
}

/**
 * What one edit to an activity's day did, in words: the shift and the support,
 * each only if it changed — "Night → Swing · support taken off WIT".
 */
export function dayChange(before, after, meaningOf = () => '') {
  const shift = (v) => (v?.color ? meaningOf(v.color) || `#${v.color}` : '');
  const parts = [];
  const was = shift(before);
  const now = shift(after);
  if (was !== now) parts.push(!was ? `painted ${now}` : !now ? `${was} cleared` : `${was} → ${now}`);
  const tb = String(before?.text ?? '');
  const ta = String(after?.text ?? '');
  if (tb !== ta) {
    const d = looksLikeCodes(tb) && looksLikeCodes(ta) ? codesDiff(tb, ta) : { added: [], removed: [], struck: [], reinstated: [] };
    const said = [];
    if (d.added.length) said.push(`support added ${d.added.join(', ')}`);
    if (d.removed.length) said.push(`support taken off ${d.removed.join(', ')}`);
    if (d.struck.length) said.push(`${d.struck.join(', ')} struck out`);
    if (d.reinstated.length) said.push(`${d.reinstated.join(', ')} put back`);
    if (!said.length) said.push(`"${tb || 'empty'}" → "${ta || 'empty'}"`); // not codes, or the same codes rewritten
    parts.push(...said);
  }
  return cap(parts.join(' · ')) || 'Written again, unchanged';
}

/** What one edit to a names row's day did: who went on and who came off. */
export function namesChange(before, after) {
  const d = namesDiff(before?.text, after?.text);
  const parts = [];
  if (d.added.length) parts.push(`${d.added.join(', ')} put on`);
  if (d.removed.length) parts.push(`${d.removed.join(', ')} taken off`);
  return cap(parts.join(' · ') || `"${before?.text || 'empty'}" → "${after?.text || 'empty'}"`);
}

const isNames = (e) => /^Names\b/.test(e.label || '');
const fieldText = (k, v) => (k === 'link' ? linkLabel(v) || 'none' : `"${String(v ?? '') || 'empty'}"`);

/** A list of things by a key, said as "3 added (A, B, C)". */
function listDiff(was = [], now = [], key, name) {
  const a = new Map(was.map((x) => [x[key], x]));
  const b = new Map(now.map((x) => [x[key], x]));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && !sameJson(a.get(k), b.get(k)));
  const parts = [];
  if (added.length) parts.push(`${added.map(name).join(', ')} added`);
  if (removed.length) parts.push(`${removed.map(name).join(', ')} removed`);
  if (changed.length) parts.push(`${changed.map(name).join(', ')} changed`);
  return parts.join(' · ');
}

/** One entry in words, without who, when or where: what changed. `meaningOf(hex)` names a shift colour. */
export function editText(e, { meaningOf = () => '' } = {}) {
  if (e.target === 'cell') return isNames(e) ? namesChange(e.before, e.after) : dayChange(e.before, e.after, meaningOf);
  if (e.target === 'row') {
    const what = e.label || 'a row';
    if (e.action === 'insert') return `Added ${what}`;
    if (e.action === 'delete') return `Deleted ${what}`;
    const parts = Object.keys(e.after || {}).map((k) => (k === 'parent_id' ? 'Moved under another activity'
      : `${FIELD_NAME[k] || k} ${fieldText(k, e.before?.[k])} → ${fieldText(k, e.after?.[k])}`));
    return parts.join(' · ') || 'Changed';
  }
  if (e.target === 'import') {
    const b = e.before || {};
    const a = e.after || {};
    return `Imported a workbook: ${a.rows ?? '?'} rows and ${a.cells ?? '?'} days, in place of ${b.rows ?? '?'} rows and ${b.cells ?? '?'} days`;
  }
  if (e.target === 'legend') return `Legend: ${listDiff(e.before, e.after, 'argb', (k) => `#${k}`) || 'rewritten'}`;
  if (e.target === 'codes') return `Support codes: ${listDiff(e.before, e.after, 'code', (k) => k) || 'rewritten'}`;
  return 'Changed';
}

/** Where an entry is: the row it was called then, and the day. */
export function editWhere(e, { dayLabel = (d) => d } = {}) {
  if (e.target === 'import') return 'The whole look-ahead';
  if (e.target === 'legend' || e.target === 'codes') return 'Setup';
  return [e.label || '(a row since deleted)', e.day ? dayLabel(e.day) : null].filter(Boolean).join(' · ');
}

/* ── Reading the log ──────────────────────────────────────────────────── */

const newestFirst = (a, b) => Number(b.id) - Number(a.id);

/** One day of one row, newest first. */
export function cellHistory(edits, rowId, day) {
  return (edits || []).filter((e) => e.target === 'cell' && e.row_id === rowId && e.day === day).sort(newestFirst);
}

/** A row — what it says and every day of it — newest first. */
export function rowHistory(edits, rowId) {
  return (edits || []).filter((e) => e.row_id === rowId).sort(newestFirst);
}

/** Entries as the actions that made them, newest first: `[{ batch, at, by, edits }]`. */
export function batches(edits) {
  const out = [];
  for (const e of [...(edits || [])].sort(newestFirst)) {
    const last = out[out.length - 1];
    if (last && last.batch === e.batch && last.by === e.by) last.edits.push(e);
    else out.push({ batch: e.batch, at: e.at, by: e.by, edits: [e] });
  }
  for (const b of out) b.edits.reverse(); // within an action, in the order it was done
  return out;
}

/**
 * The edits behind one change to a request (`T.sourceChanges`): its days on its
 * rows, and its rows' own fields when it is about what an activity says.
 */
export function editsFor(change, edits) {
  const rows = new Set(change.rows || []);
  const days = new Set(change.days || []);
  return (edits || []).filter((e) => rows.has(e.row_id)
    && (e.target === 'cell' ? days.has(e.day) : e.target === 'row' && Boolean(change.rowFields)));
}

/**
 * Who made some edits, and when, in a few words: "Rae Requester, 18 Oct 09:12"
 * or "Rae Requester and Sam Scheduler, 18 Oct 09:12 – 19 Oct 10:30".
 */
export function whoText(edits, { stamp = (iso) => iso } = {}) {
  if (!edits?.length) return '';
  const sorted = [...edits].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const names = [...new Set(sorted.map((e) => e.by || 'somebody'))];
  const people = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ');
  const first = stamp(sorted[0].at);
  const last = stamp(sorted[sorted.length - 1].at);
  return `${people}, ${first === last ? first : `${first} – ${last}`}`;
}
