/**
 * The four-week look-ahead (4WLA), as Track-Plan keeps it.
 *
 * Rebuilt from cx-timeline's editor model (src/core/la_edit.js): the same rows
 * and cells, the same six columns left of the calendar, the same shift colours
 * and the same way BART support is typed into a day ("X.WIT" is an EIC and a
 * witness). What Track-Plan adds is the **track plan link**: an activity's
 * Location can be picked on the map — a station, its train control room (TCR),
 * a yard, or a block of track with its milepost limits — and that link is what
 * the TAWR's Area is written from (`tawr.js`).
 *
 * The model is two lists:
 *
 *   rows   { id, kind, parent_id, sort, activity_id, description, location,
 *            sswp, party, work_hours, link }
 *   cells  { row_id, day, color, text }          (keyed `row_id|day`)
 *
 * `kind` is section (a heading band), activity (a line of work, painted by
 * day, with the support typed in the cell) or resource (the names under an
 * activity — `parent_id` is that activity, and it moves with it).
 *
 * Every edit is an op, and `applyOps()` returns the ops that undo it. The same
 * ops are what the server stores (`server.py`, `/api/lookahead/ops`).
 *
 * Pure: no DOM, no network, so `tests/test_lookahead.mjs` runs it in Node.
 *
 * Imports: la_read, xlsx.
 */

import { readGrid, cellTokens, isCancelMeaning, resourceNames, absenceKind, ABSENCE_LABELS } from './la_read.js';
import { parseSheet, readSheets, readZip, readLegend, applyLegend, isDark } from './xlsx.js';

export { cellTokens, isCancelMeaning, resourceNames, isDark };

/* ══════════════════════════════════════════════════════════════════════════
   The legend and the support codes
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * BART's 4WLA colours. A cell is painted with one of these and nothing else;
 * the meaning decides the shift (`shiftOfMeaning`), and a cancellation is a
 * day that asks for nothing.
 */
export const DEFAULT_LEGEND = [
  { argb: 'FFFF00', meaning: 'Day Shift', role: 'shift' },
  { argb: 'FFC000', meaning: 'Swing Shift', role: 'shift' },
  { argb: '0070C0', meaning: 'Night Shift', role: 'shift' },
  { argb: '000000', meaning: 'Blanket Shift', role: 'shift' },
  { argb: 'FF0000', meaning: 'Cancellation', role: 'shift' },
];

/**
 * What each code typed in a day asks BART for, and which line of the TAWR it
 * goes on (`tawr_line`): Technical Support (Systems), OCC Support, or not on
 * the form at all — a witness never is.
 */
export const DEFAULT_CODES = [
  { code: 'X', name: 'EIC', party: 'BART', sort: 10, tawr_line: 'systems', active: true },
  { code: 'WIT', name: 'BART witness', party: 'BART', sort: 20, tawr_line: 'none', active: true },
  { code: 'TCE', name: 'TCE', party: 'BART', sort: 30, tawr_line: 'systems', active: true },
  { code: 'ROC', name: 'ROC', party: 'BART', sort: 40, tawr_line: 'occ', active: true },
];

/** The legend as `ARGB -> entry`. */
export function legendMap(legend) {
  return new Map((legend || []).map((e) => [String(e.argb).toUpperCase(), e]));
}

/**
 * Which shift a legend meaning names: day, swing, night or possession (the
 * Blanket shift). Null for a colour the legend does not know — that is a fact
 * to report, not a day shift to assume.
 */
export function shiftOfMeaning(meaning) {
  if (meaning == null || meaning === '') return null;
  const said = String(meaning).toLowerCase();
  if (/night/.test(said)) return 'night';
  if (/blanket|possession/.test(said)) return 'possession';
  if (/swing/.test(said)) return 'swing';
  return 'day';
}

/* ══════════════════════════════════════════════════════════════════════════
   Days
   ═══════════════════════════════════════════════════════════════════════ */

const MS_DAY = 86400000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_LETTERS = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];

/** The look-ahead shows four weeks by default and five at most. */
export const WINDOW_WEEKS = [4, 5];

const isoMs = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const msIso = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDaysISO(iso, n) {
  return msIso(isoMs(iso) + n * MS_DAY);
}

/** The Monday on or before a date. */
export function mondayOf(iso) {
  const dow = new Date(isoMs(iso)).getUTCDay();
  return addDaysISO(iso, -((dow + 6) % 7));
}

/** Seven days a week for `weeks` weeks, from the Monday of `fromISO`. */
export function windowDays(fromISO, weeks = 4) {
  const start = mondayOf(fromISO);
  return Array.from({ length: weeks * 7 }, (_, i) => addDaysISO(start, i));
}

export function isWeekend(iso) {
  const dow = new Date(isoMs(iso)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function weekdayLetter(iso) {
  return WEEKDAY_LETTERS[new Date(isoMs(iso)).getUTCDay()];
}

export function monthLabel(iso) {
  return MONTHS[new Date(isoMs(iso)).getUTCMonth()];
}

export function dayNumber(iso) {
  return new Date(isoMs(iso)).getUTCDate();
}

/**
 * Today as the person reading it sees it. Never `toISOString()` of now, which
 * is Greenwich's date — tomorrow in California from five in the afternoon.
 */
export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Rows
   ═══════════════════════════════════════════════════════════════════════ */

export const KINDS = ['section', 'activity', 'resource'];

/** The six columns left of the calendar, in the order the 4WLA prints them. */
export const FIELDS = [
  { key: 'activity_id', heading: 'Activity ID' },
  { key: 'description', heading: 'Description of Work Activity' },
  { key: 'location', heading: 'Location' },
  { key: 'sswp', heading: 'SSWP#' },
  { key: 'party', heading: 'Party to Action' },
  { key: 'work_hours', heading: 'Work Hours' },
];

export const ROW_FIELDS = ['kind', 'parent_id', 'sort', 'activity_id', 'description', 'location',
  'sswp', 'party', 'work_hours', 'link'];

export function blankRow(kind, extra = {}) {
  return {
    id: extra.id || newId(),
    kind,
    parent_id: null,
    sort: 0,
    activity_id: '',
    description: kind === 'resource' ? 'Resource' : '',
    location: '',
    sswp: '',
    party: '',
    work_hours: '',
    link: null,
    ...extra,
  };
}

/** A uuid made here, so a row exists — and can be undone — before the server has it. */
export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/**
 * The rows in the order the sheet shows them: top-level rows by `sort`, each
 * activity followed by its Resource rows, so moving an activity carries its
 * names with it.
 */
export function orderedRows(rows) {
  const bySort = (a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id));
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map();
  for (const r of rows) {
    if (r.kind === 'resource' && r.parent_id && ids.has(r.parent_id)) {
      if (!children.has(r.parent_id)) children.set(r.parent_id, []);
      children.get(r.parent_id).push(r);
    }
  }
  const top = rows.filter((r) => !(r.kind === 'resource' && r.parent_id && ids.has(r.parent_id)));
  const out = [];
  for (const r of top.sort(bySort)) {
    out.push(r);
    for (const c of (children.get(r.id) || []).sort(bySort)) out.push(c);
  }
  return out;
}

/** An activity with its Resource rows; any other row alone. */
export function rowBlock(ordered, index) {
  const row = ordered[index];
  if (!row) return [index, index];
  let end = index;
  if (row.kind === 'activity') {
    while (ordered[end + 1]?.kind === 'resource' && ordered[end + 1].parent_id === row.id) end++;
  }
  return [index, end];
}

/** A sort key between two neighbours: midpoints, plain numbers. */
export function sortBetween(before, after) {
  if (before == null && after == null) return 1024;
  if (before == null) return after - 1024;
  if (after == null) return before + 1024;
  return (before + after) / 2;
}

/* ══════════════════════════════════════════════════════════════════════════
   Support written in a day
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The support written in one cell: "X.WIT" is an EIC and a BART witness, "X.X"
 * is two EICs. A struck-out code ("~WIT") is no longer asked for.
 */
export function supportTokens(text) {
  return cellTokens(text).filter((t) => !t.cancelled).map((t) => t.code);
}

/** Tokens back into the sheet's form. */
export function writeTokens(tokens) {
  return tokens.map((t) => `${t.cancelled ? '~' : ''}${t.code}`).join('.');
}

/** Tidy what was typed into the form the sheet writes: "x . wit" → "X.WIT". */
export function normaliseSupport(text) {
  return writeTokens(cellTokens(text));
}

/** "X " → "X", "x.wit" → "X.WIT" — but only when it *looks* like codes, so a note survives. */
export function normaliseSupportIfCodes(text) {
  const t = String(text ?? '').trim();
  return /^~?\s*[A-Za-z]{1,6}(\s*\.\s*~?\s*[A-Za-z]{1,6})*\.?$/.test(t) ? normaliseSupport(t) : t;
}

/** One more of `code` in a cell, or one fewer (`delta` −1). */
export function addCode(text, code, delta = 1) {
  const tokens = cellTokens(text);
  if (delta > 0) tokens.push({ code: String(code).toUpperCase(), cancelled: false });
  else {
    const at = tokens.map((t) => t.code).lastIndexOf(String(code).toUpperCase());
    if (at >= 0) tokens.splice(at, 1);
  }
  return writeTokens(tokens);
}

/** The codes nobody has registered, in one cell's text. */
export function unknownCodes(text, codes) {
  const known = new Set((codes || []).filter((c) => c.active !== false).map((c) => String(c.code).toUpperCase()));
  return [...new Set(supportTokens(text).filter((c) => !known.has(c)))];
}

/* ══════════════════════════════════════════════════════════════════════════
   The model, and ops on it
   ═══════════════════════════════════════════════════════════════════════ */

export const cellKey = (rowId, day) => `${rowId}|${day}`;

export function makeModel(rows = [], cells = []) {
  const map = new Map();
  for (const c of cells) map.set(cellKey(c.row_id, c.day), { row_id: c.row_id, day: c.day, color: c.color || null, text: c.text || '' });
  return { rows: rows.map((r) => ({ ...blankRow(r.kind || 'activity', { id: r.id }), ...r })), cells: map };
}

export function cellList(model) {
  return [...model.cells.values()];
}

export function getCell(model, rowId, day) {
  return model.cells.get(cellKey(rowId, day)) || null;
}

/** The model as plain JSON: what is stored and sent. */
export function serialise(model) {
  return { rows: model.rows.map((r) => ({ ...r })), cells: cellList(model).map((c) => ({ ...c })) };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * Apply ops to the model in place, and return the ops that undo them.
 *
 *   { op: 'row', id, set: {…fields} }          create (with `kind`) or change a row
 *   { op: 'delete_row', id }                    remove a row (its cells go with it)
 *   { op: 'cell', row_id, day, color, text }    set a cell; blank both to clear it
 *
 * The inverse of a batch is its ops' inverses in reverse order, so an undo puts
 * back exactly what was there.
 */
export function applyOps(model, ops) {
  const inverse = [];
  for (const op of ops) {
    if (op.op === 'row') {
      const at = model.rows.findIndex((r) => r.id === op.id);
      if (at < 0) {
        model.rows.push({ ...blankRow(op.set?.kind || 'activity', { id: op.id }), ...clone(pick(op.set, ROW_FIELDS)) });
        inverse.push({ op: 'delete_row', id: op.id });
      } else {
        const row = model.rows[at];
        const before = {};
        for (const k of Object.keys(op.set || {})) if (ROW_FIELDS.includes(k)) before[k] = clone(row[k]);
        model.rows[at] = { ...row, ...clone(pick(op.set, ROW_FIELDS)) };
        inverse.push({ op: 'row', id: op.id, set: before });
      }
    } else if (op.op === 'delete_row') {
      const at = model.rows.findIndex((r) => r.id === op.id);
      if (at < 0) continue;
      const row = model.rows[at];
      const cells = cellList(model).filter((c) => c.row_id === op.id);
      for (const c of cells) model.cells.delete(cellKey(c.row_id, c.day));
      model.rows.splice(at, 1);
      const restore = [{ op: 'row', id: row.id, set: clone(pick(row, ROW_FIELDS)) }];
      for (const c of cells) restore.push({ op: 'cell', row_id: c.row_id, day: c.day, color: c.color || null, text: c.text || '' });
      inverse.push(...restore.reverse());
    } else if (op.op === 'cell') {
      const key = cellKey(op.row_id, op.day);
      const was = model.cells.get(key) || null;
      const color = op.color ? String(op.color).toUpperCase() : null;
      const text = String(op.text ?? '');
      if (!color && !text) model.cells.delete(key);
      else model.cells.set(key, { row_id: op.row_id, day: op.day, color, text });
      inverse.push({ op: 'cell', row_id: op.row_id, day: op.day, color: was?.color || null, text: was?.text || '' });
    }
  }
  return inverse.reverse();
}

/** Ops that delete rows and everything that belongs to them, cells first. */
export function deleteOps(model, ids) {
  const want = new Set(ids);
  for (const r of model.rows) if (r.kind === 'resource' && want.has(r.parent_id)) want.add(r.id);
  const ops = [];
  for (const c of cellList(model)) {
    if (want.has(c.row_id)) ops.push({ op: 'cell', row_id: c.row_id, day: c.day, color: null, text: '' });
  }
  const rows = model.rows.filter((r) => want.has(r.id)).sort((a, b) => Number(b.kind === 'resource') - Number(a.kind === 'resource'));
  for (const r of rows) ops.push({ op: 'delete_row', id: r.id });
  return ops;
}

/* ══════════════════════════════════════════════════════════════════════════
   What a row says
   ═══════════════════════════════════════════════════════════════════════ */

/** What a row is called, for a list or a heading. */
export function rowTitle(row) {
  if (!row) return '';
  const title = String(row.description || '').trim() || String(row.activity_id || '').trim();
  if (row.kind === 'activity' && row.activity_id && row.description) return `${row.activity_id} · ${row.description}`;
  return title || (row.kind === 'section' ? 'Section' : 'Activity');
}

/** The Resource rows under an activity. */
export function resourcesOf(model, activityId) {
  return model.rows.filter((r) => r.kind === 'resource' && r.parent_id === activityId);
}

/**
 * The rows worth showing for a window of days: activities with paint, a code
 * or a name on one of those days (their own cells or their Resource rows'), the
 * sections above them, and — with `all` — everything.
 */
export function rowsInWindow(model, days, { all = false } = {}) {
  const ordered = orderedRows(model.rows);
  if (all) return ordered;
  const inDays = new Set(days);
  const busy = new Set(cellList(model).filter((c) => inDays.has(c.day) && (c.text || c.color)).map((c) => c.row_id));
  const keep = new Array(ordered.length).fill(false);
  let liveBelow = false;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    if (r.kind === 'resource') continue;
    if (r.kind === 'activity') {
      const kids = ordered.filter((k) => k.kind === 'resource' && k.parent_id === r.id);
      keep[i] = busy.has(r.id) || kids.some((k) => busy.has(k.id));
      if (keep[i]) liveBelow = true;
      continue;
    }
    keep[i] = liveBelow;
    liveBelow = false;
  }
  return ordered.filter((r, i) => (r.kind === 'resource'
    ? keep[ordered.findIndex((p) => p.id === r.parent_id)]
    : keep[i]));
}

/* ══════════════════════════════════════════════════════════════════════════
   Starting from the workbook
   ═══════════════════════════════════════════════════════════════════════ */

/** Which of the sheet's activity columns is which field, off their headings. */
function fieldIndexes(headings) {
  const tests = {
    activity_id: /activity\s*id/i,
    description: /descr|activity/i,
    location: /location|site/i,
    sswp: /sswp/i,
    party: /party/i,
    work_hours: /hour/i,
  };
  const out = {};
  const used = new Set();
  for (const key of ['activity_id', 'location', 'sswp', 'party', 'work_hours', 'description']) {
    const i = (headings || []).findIndex((h, idx) => !used.has(idx) && tests[key].test(String(h || '')));
    if (i >= 0) { out[key] = i; used.add(i); }
  }
  /* A sheet without headings: the 4WLA's own order. With only a description
     and a location named, the others stay empty rather than take a column
     somebody else's heading already claimed. */
  if (!Object.keys(out).length) {
    FIELDS.forEach((f, pos) => { if (pos < (headings || []).length) out[f.key] = pos; });
  }
  return out;
}

/**
 * The sheets of a workbook that hold a calendar — a row of weekday letters —
 * the `4WLA` one first.
 */
export function lookaheadSheets(buffer) {
  const files = readZip(buffer);
  const sheets = readSheets(files).filter((s) => s.state === 'visible' && s.zipPath);
  const out = [];
  for (const s of sheets) {
    try {
      const view = readGrid(parseSheet(buffer, s.name));
      if (view.days.length >= 7) out.push(s.name);
    } catch { /* not a calendar */ }
  }
  return out.sort((a, b) => Number(!/4\s*wla/i.test(a)) - Number(!/4\s*wla/i.test(b)));
}

/**
 * What a workbook would bring in, before anything is changed: its sheet read
 * as a calendar, the colours its own key names, and the colours it uses that
 * neither its key nor the legend knows — for somebody to say what they are.
 */
export function readWorkbook(buffer, { sheetName = null, legend = DEFAULT_LEGEND, anchorISO = null } = {}) {
  const names = sheetName ? [sheetName] : lookaheadSheets(buffer);
  if (!names.length) throw new Error('No sheet in that workbook has a row of weekday letters (M Tu W Th F Sa Su), so there is no calendar to read.');
  const grid = parseSheet(buffer, names[0]);
  const key = readLegend(grid);
  const known = legendMap(legend);
  const fromKey = key.filter((k) => !known.has(String(k.argb).toUpperCase()))
    .map((k) => ({ argb: String(k.argb).toUpperCase(), meaning: k.meaning, role: 'shift' }));
  const merged = [...(legend || []), ...fromKey];
  const applied = applyLegend(grid, merged);
  const view = readGrid(applied, { anchorISO });
  return {
    sheet: names[0],
    sheets: names,
    view,
    legend: merged,
    fromKey,
    unknown: applied.unknown.map((u) => ({ hex: u.hex, count: u.count, samples: u.samples })),
    dated: view.days.every((d) => d.date),
  };
}

/**
 * The look-ahead's rows and cells, from a reading of the workbook.
 *
 * What comes across is what is still ahead: an activity with a shift, a
 * support code or a name from `fromISO` on, and the sections with such
 * activities under them. Only paint the legend calls a **shift** is carried;
 * shading and colours nobody has named are counted in the report and left
 * behind, never guessed at. `choices` says what somebody decided an unknown
 * colour is: `hex → argb` of a legend shift, or nothing to leave it behind.
 *
 * PTO / Office / Other group rows are not site work and are not brought in:
 * this look-ahead is for track access.
 */
export function modelFromView(view, { fromISO, toISO = null, legend = [], choices = {} } = {}) {
  const shift = new Map();
  for (const e of legend || []) {
    if ((e.role || 'shift') === 'shift' && e.meaning) shift.set(String(e.argb).toUpperCase(), String(e.argb).toUpperCase());
  }
  for (const [hex, target] of Object.entries(choices || {})) {
    if (target) shift.set(String(hex).toUpperCase(), String(target).toUpperCase());
  }
  const report = { activities: 0, sections: 0, resources: 0, cells: 0, droppedColours: 0, past: 0, absences: 0 };
  const dayOf = new Map((view.days || []).filter((d) => d.date).map((d) => [d.col, d.date]));
  const inWindow = (date) => date && (!fromISO || date >= fromISO) && (!toISO || date <= toISO);
  const idx = fieldIndexes(view.headings);

  const pending = [];
  const cellsOf = (marks, keepColour) => {
    const out = [];
    for (const m of marks || []) {
      const day = dayOf.get(m.col);
      if (!day) continue;
      if (!inWindow(day)) { report.past++; continue; }
      let color = m.hex ? String(m.hex).toUpperCase() : null;
      if (color) {
        if (keepColour && shift.has(color)) color = shift.get(color);
        else { report.droppedColours++; color = null; }
      }
      const text = String(m.value ?? '').trim();
      if (!color && !text) continue;
      out.push({ day, color, text });
    }
    return out;
  };

  for (const a of view.activities || []) {
    if (a.heading) {
      pending.push({ kind: 'section', description: a.meta.find(Boolean) || '', cells: [] });
      continue;
    }
    if (a.absence) { report.absences++; continue; }
    const fields = {};
    for (const f of FIELDS) fields[f.key] = idx[f.key] != null ? (a.meta[idx[f.key]] || '') : '';
    if (!fields.description && !fields.activity_id) fields.description = a.meta.find(Boolean) || '';
    const cells = cellsOf(a.marks, true);
    const names = a.resource ? cellsOf(a.resource.marks, false) : [];
    pending.push({ kind: 'activity', ...fields, cells, resource: a.resource ? names : null, live: cells.length > 0 || names.length > 0 });
  }

  const keep = new Array(pending.length).fill(false);
  let liveBelow = false;
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (p.kind === 'activity') {
      keep[i] = p.live;
      if (p.live) liveBelow = true;
    } else {
      keep[i] = liveBelow || (pending[i + 1]?.kind === 'section' && keep[i + 1]);
      liveBelow = false;
    }
  }

  const rows = [];
  const cells = [];
  let sort = 0;
  pending.forEach((p, i) => {
    if (!keep[i]) return;
    sort += 1024;
    const row = blankRow(p.kind, { sort, description: p.description || '' });
    if (p.kind === 'activity') for (const f of FIELDS) row[f.key] = p[f.key] || '';
    rows.push(row);
    report[p.kind === 'section' ? 'sections' : 'activities']++;
    for (const c of p.cells) cells.push({ row_id: row.id, day: c.day, color: c.color, text: normaliseSupportIfCodes(c.text) });
    if (p.resource) {
      const res = blankRow('resource', { parent_id: row.id, sort: sort + 1 });
      rows.push(res);
      report.resources++;
      for (const c of p.resource) cells.push({ row_id: res.id, day: c.day, color: null, text: c.text });
    }
  });
  report.cells = cells.length;
  return { model: makeModel(rows, cells), report };
}

export { absenceKind, ABSENCE_LABELS };
