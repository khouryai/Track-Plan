/**
 * The four-week look-ahead, drawn and edited like the 4WLA it replaces.
 *
 * Six columns on the left — Activity ID, Description, Location, SSWP#, Party,
 * Work Hours — then a day per column for four (or five) weeks. A day is painted
 * in its shift's colour and carries the BART support it needs ("X.WIT"); the
 * Resource row under an activity names who is on it. It behaves like a
 * spreadsheet: click a day and type, drag across a week and press a colour,
 * Delete clears, Ctrl+Z undoes, copy and paste a block.
 *
 * **The Location column is linked to the track plan.** Right-click a Location
 * cell (or press its pin) and choose *Select on track plan*: the map opens on
 * that activity, a station, TCR or block of track is picked, and the cell says
 * where — and every TAWR raised from the activity takes its Area from it. A
 * location only typed is shown as such, and one the track plan cannot match is
 * marked: its TAWR cannot be submitted until it is linked.
 *
 * **The TAWR week is highlighted** — the week whose requests are due next
 * (seventeen days before its Monday), or the one picked — and each activity in
 * it shows the status of its request.
 *
 * Every change is an op (`lookahead.js`), applied here at once and saved in
 * order (`store.applyOps`); the inverse is kept for undo.
 *
 * Imports: lookahead, links, tawr, store, ui.
 */

import * as LA from './lookahead.js';
import { linkLabel, linkArea, hasLink, resolveLocationText } from './links.js';
import * as T from './tawr.js';
import * as S from './store.js';
import { el, esc, clear, toast, contextMenu, openModal, confirmDialog, dayLabel, saveFile, csvField } from './ui.js';
import { STATUS_COLOR } from './map.js';

const META = LA.FIELDS.length;
const LOC = LA.FIELDS.findIndex((f) => f.key === 'location');
/* The frozen columns' widths, which `.la-m0` … `.la-m5` in style.css are frozen at. */
const META_WIDTHS = [84, 250, 210, 56, 66, 84];
const META_WIDTH = META_WIDTHS.reduce((a, b) => a + b, 0);
const DAY_WIDTH = 46;

const V = {
  app: null,
  root: null,
  from: null,
  weeks: 4,
  hideQuiet: false,
  rows: [],
  days: [],
  cells: [], // [r][c] -> td
  sel: null, // { r0, c0, r1, c1 }
  cur: null, // { r, c }
  editing: null,
  dragging: false,
  undo: [],
  redo: [],
  queue: Promise.resolve(),
  pending: 0,
  status: 'saved',
  scroll: null,
};

/** Polling waits while somebody is typing or saves are on their way. */
export function busy() {
  return Boolean(V.editing) || V.pending > 0;
}

export function leave() {
  if (V.editing) commitEdit();
  // A hidden element forgets where it was scrolled to, so remember it now.
  if (V.scroll) V.saved = { top: V.scroll.scrollTop, left: V.scroll.scrollLeft };
}

const model = () => V.app.la.model;
const writer = () => S.writer();

/* ══════════════════════════════════════════════════════════════════════════
   Saving
   ═══════════════════════════════════════════════════════════════════════ */

function setStatus(status) {
  V.status = status;
  const s = V.root?.querySelector('.la-status');
  if (s) {
    s.className = `la-status la-status-${status}`;
    s.textContent = { saved: 'All changes saved', saving: 'Saving…', error: 'Not saved — reloaded' }[status];
  }
}

function send(ops) {
  if (!ops.length) return;
  V.pending++;
  setStatus('saving');
  V.queue = V.queue.then(async () => {
    try {
      const r = await S.applyOps(ops);
      V.app.la.version = r.version;
      V.pending--;
      if (!V.pending) setStatus('saved');
    } catch (err) {
      V.pending = 0;
      toast(`The look-ahead could not be saved: ${err.message}. It has been reloaded.`, 'bad');
      setStatus('error');
      V.undo = [];
      V.redo = [];
      await V.app.reloadLookahead();
      if (V.app.view === 'lookahead') render(V.root, V.app);
    }
  });
}

/** Apply ops, remember how to undo them, save them, redraw. */
function commit(ops, { redraw = true } = {}) {
  if (!ops.length) return;
  const inverse = LA.applyOps(model(), ops);
  V.undo.push({ ops, inverse });
  if (V.undo.length > 200) V.undo.shift();
  V.redo = [];
  send(ops);
  if (redraw) draw();
  V.app.lookaheadChanged();
}

function undo() {
  const step = V.undo.pop();
  if (!step) return;
  LA.applyOps(model(), step.inverse);
  V.redo.push(step);
  send(step.inverse);
  draw();
  V.app.lookaheadChanged();
}

function redo() {
  const step = V.redo.pop();
  if (!step) return;
  LA.applyOps(model(), step.ops);
  V.undo.push(step);
  send(step.ops);
  draw();
  V.app.lookaheadChanged();
}

/* ══════════════════════════════════════════════════════════════════════════
   The view
   ═══════════════════════════════════════════════════════════════════════ */

window.addEventListener('mouseup', () => { V.dragging = false; });

export function render(root, app) {
  V.app = app;
  V.root = root;
  if (!V.from) V.from = LA.mondayOf(app.today);
  clear(root);
  root.append(toolbar(), el('div', { class: 'la-wrap' }), legendStrip(), help());
  draw();
}

function windowDays() {
  return LA.windowDays(V.from, V.weeks);
}

function visibleRows() {
  return LA.rowsInWindow(model(), V.days, { all: !V.hideQuiet });
}

/* ── The toolbar ──────────────────────────────────────────────────────── */

function toolbar() {
  const bar = el('div', { class: 'la-toolbar' });
  const move = (n) => { V.from = LA.addDaysISO(V.from, 7 * n); draw(); };
  const weeksSel = el('select', { 'aria-label': 'Weeks shown', onChange: (e) => { V.weeks = Number(e.target.value); draw(); } },
    LA.WINDOW_WEEKS.map((n) => el('option', { value: String(n), text: `${n} weeks` })));
  weeksSel.value = String(V.weeks);
  const from = el('input', {
    type: 'date', 'aria-label': 'First week', value: V.from,
    onChange: (e) => { if (e.target.value) { V.from = LA.mondayOf(e.target.value); draw(); } },
  });
  bar.append(el('div', { class: 'la-group' }, [
    el('button', { type: 'button', class: 'secondary mini', title: 'A week earlier', text: '‹', onClick: () => move(-1) }),
    from,
    el('button', { type: 'button', class: 'secondary mini', title: 'A week later', text: '›', onClick: () => move(1) }),
    el('button', { type: 'button', class: 'secondary mini', text: 'This week', onClick: () => { V.from = LA.mondayOf(V.app.today); draw(); } }),
    weeksSel,
  ]));

  if (writer()) {
    bar.append(el('div', { class: 'la-group' }, [
      el('button', { type: 'button', class: 'mini', dataset: { action: 'add-activity' }, text: '+ Activity', onClick: () => insertRow('activity') }),
      el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'add-section' }, text: '+ Section', onClick: () => insertRow('section') }),
      el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'add-resource' }, text: '+ Resource row', title: 'Names under the selected activity', onClick: () => insertRow('resource') }),
    ]));
    const palette = el('div', { class: 'la-group la-palette', role: 'group', 'aria-label': 'Paint the selected days' });
    V.app.la.legend.filter((e) => (e.role || 'shift') === 'shift').forEach((entry, i) => {
      palette.append(el('button', {
        type: 'button', class: 'la-swatch', style: `background-color:#${entry.argb}`, dataset: { paint: entry.argb },
        title: `${entry.meaning}${i < 9 ? ` (Alt+${i + 1})` : ''}`, 'aria-label': `Paint ${entry.meaning}`,
        onClick: () => paint(entry.argb),
      }));
    });
    palette.append(el('button', { type: 'button', class: 'la-swatch la-swatch-none', title: 'No colour (Alt+0)', 'aria-label': 'Remove the colour', text: '×', onClick: () => paint(null) }));
    bar.append(palette);
    const codes = el('div', { class: 'la-group la-codes', role: 'group', 'aria-label': 'Add BART support to the selected days' });
    for (const c of V.app.la.codes.filter((x) => x.active !== false)) {
      codes.append(el('button', {
        type: 'button', class: 'la-code', dataset: { code: c.code }, text: c.code,
        title: `${c.name || c.code} (${c.party || 'BART'}) — click to add one, Shift+click to take one away`,
        onClick: (e) => addCode(c.code, e.shiftKey ? -1 : 1),
      }));
    }
    bar.append(codes);
    bar.append(el('div', { class: 'la-group' }, [
      el('button', { type: 'button', class: 'secondary mini', title: 'Undo (Ctrl+Z)', text: 'Undo', onClick: undo }),
      el('button', { type: 'button', class: 'secondary mini', title: 'Redo (Ctrl+Y)', text: 'Redo', onClick: redo }),
    ]));
  }
  const quiet = el('input', { type: 'checkbox', onChange: (e) => { V.hideQuiet = e.target.checked; draw(); } });
  quiet.checked = V.hideQuiet;
  bar.append(el('div', { class: 'la-group la-right' }, [
    el('label', { class: 'check' }, [quiet, ' Only rows with work these weeks']),
    writer() ? el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'import' }, text: 'Import 4WLA (.xlsx)…', onClick: importWorkbook }) : null,
    el('button', { type: 'button', class: 'secondary mini', text: 'CSV', title: 'The weeks on screen as a CSV', onClick: exportCsv }),
    writer() ? el('span', { class: 'la-status la-status-saved', role: 'status', text: 'All changes saved' }) : el('span', { class: 'small', text: 'Read only' }),
  ]));
  return bar;
}

function legendStrip() {
  const strip = el('div', { class: 'la-legend' });
  for (const e of V.app.la.legend) {
    strip.append(el('span', { class: 'la-key' }, [el('span', { class: 'la-key-sw', style: `background-color:#${e.argb}` }), e.meaning]));
  }
  strip.append(el('span', { class: 'la-key' }, [el('span', { class: 'la-key-sw la-key-week' }), 'TAWR week']));
  strip.append(el('span', { class: 'la-key' }, [el('span', { class: 'loc-pin-dot pin-linked' }), 'Location linked to the track plan']));
  strip.append(el('span', { class: 'la-key' }, [el('span', { class: 'loc-pin-dot pin-unlinked' }), 'Not linked — its TAWR cannot be submitted']));
  const codes = V.app.la.codes.filter((c) => c.active !== false).map((c) => `${c.code} ${c.name}`).join(' · ');
  strip.append(el('span', { class: 'la-key small' }, [`Support: ${codes}. "X.WIT" is an EIC and a witness; "~WIT" a witness cancelled.`]));
  return strip;
}

function help() {
  return el('p', {
    class: 'small la-help',
    text: writer()
      ? 'Click a day and type support codes; drag to select several days and press a colour. Right-click a Location cell → Select on track plan. Enter edits, Delete clears, Ctrl+Z undoes, Ctrl+C / Ctrl+V copy and paste.'
      : 'Read only. Right-click a linked Location to see it on the track plan.',
  });
}

/* ── The grid ─────────────────────────────────────────────────────────── */

function tawrIndex() {
  /* The request each activity is in for the highlighted week. */
  const out = new Map();
  for (const t of V.app.tawrs) {
    if (t.week_start !== V.app.week || ['superseded', 'consolidated'].includes(t.status)) continue;
    for (const a of t.source?.activities || []) out.set(a.row, t);
  }
  return out;
}

function weekSummary(week) {
  const live = V.app.tawrs.filter((t) => t.week_start === week && !['superseded', 'consolidated'].includes(t.status));
  const by = {};
  for (const t of live) by[t.status] = (by[t.status] || 0) + 1;
  return Object.entries(by).map(([s, n]) => `${n} ${s}`).join(' · ');
}

function draw() {
  const wrap = V.root.querySelector('.la-wrap');
  if (!wrap) return;
  const keepScroll = V.saved || (V.scroll?.isConnected && V.scroll.offsetParent ? { top: V.scroll.scrollTop, left: V.scroll.scrollLeft } : null);
  V.saved = null;
  const hadFocus = V.scroll && V.scroll.contains(document.activeElement);
  V.days = windowDays();
  V.rows = visibleRows();
  const from = V.root.querySelector('input[type=date]');
  if (from) from.value = V.from;
  const m = model();
  const legend = LA.legendMap(V.app.la.legend);
  const tawrOf = tawrIndex();
  const dueWeek = T.dueWeek(V.app.today);
  const weeks = [];
  for (let i = 0; i < V.days.length; i += 7) weeks.push(V.days[i]);

  /* Fixed layout takes its widths from here, not from the first row — which
     spans columns, and would leave the frozen columns narrower than the
     offsets they are frozen at. */
  const table = el('table', { class: 'la-grid', style: `width:${META_WIDTH + V.days.length * DAY_WIDTH}px` }, [
    el('colgroup', {}, [...META_WIDTHS.map((w) => el('col', { style: `width:${w}px` })), ...V.days.map(() => el('col', { style: `width:${DAY_WIDTH}px` }))]),
  ]);
  const head = el('thead');
  head.append(el('tr', { class: 'la-weeks' }, [
    el('th', { class: 'la-meta la-meta-all', colSpan: META, text: 'Four-week look-ahead' }),
    ...weeks.map((w) => {
      const deadline = T.tawrDeadline(w);
      const sum = weekSummary(w);
      const on = w === V.app.week;
      return el('th', {
        class: `la-week${on ? ' la-week-on' : ''}${w === dueWeek ? ' la-week-due' : ''}`, colSpan: 7, dataset: { week: w },
        title: `${dayLabel(w)} – ${dayLabel(LA.addDaysISO(w, 6))}. TAWRs due ${dayLabel(deadline)}. Click to make it the TAWR week.`,
        onClick: () => { V.app.setWeek(w); draw(); },
      }, [
        el('span', { class: 'la-week-dates', text: `${dayLabel(w)} – ${dayLabel(LA.addDaysISO(w, 6))}` }),
        el('span', { class: 'la-week-due-label', text: `${on ? 'TAWR week · ' : ''}due ${dayLabel(deadline)}${sum ? ` · ${sum}` : ''}` }),
        on ? el('button', {
          type: 'button', class: 'mini la-week-open', text: 'Open TAWRs',
          onClick: (e) => { e.stopPropagation(); V.app.go('tawr', { week: w }); },
        }) : null,
      ]);
    }),
  ]));
  const inWeek = (d) => d >= V.app.week && d <= LA.addDaysISO(V.app.week, 6);
  const dayClass = (d) => [
    LA.isWeekend(d) ? 'la-weekend' : '', d === V.app.today ? 'la-today' : '', inWeek(d) ? 'la-in-week' : '',
    LA.weekdayLetter(d) === 'M' ? 'la-monday' : '',
  ].filter(Boolean).join(' ');
  head.append(el('tr', {}, [
    ...LA.FIELDS.map((f, i) => el('th', { class: `la-meta la-m${i}`, rowSpan: 2, text: f.heading })),
    ...V.days.map((d) => el('th', { class: `la-num ${dayClass(d)}`, text: String(LA.dayNumber(d)), title: d })),
  ]));
  head.append(el('tr', {}, V.days.map((d) => el('th', { class: `la-wd ${dayClass(d)}`, text: LA.weekdayLetter(d) }))));
  table.append(head);

  const body = el('tbody');
  V.cells = [];
  V.rows.forEach((row, r) => {
    const tr = el('tr', { class: `la-row la-${row.kind}`, dataset: { row: row.id } });
    const line = [];
    if (row.kind === 'section') {
      const td = el('td', { class: 'la-meta la-section-title', colSpan: META, dataset: { r, c: 1 }, text: row.description || 'Section' });
      tr.append(td);
      for (let c = 0; c < META; c++) line.push(td);
    } else {
      LA.FIELDS.forEach((f, c) => {
        const td = el('td', { class: `la-meta la-m${c}`, dataset: { r, c } });
        if (row.kind === 'resource') td.textContent = c === 1 ? 'Resource' : '';
        else if (c === LOC) locationCell(td, row, tawrOf.get(row.id));
        else td.textContent = row[f.key] || '';
        if (row.kind === 'activity' && c === 1) td.title = LA.rowTitle(row);
        tr.append(td);
        line.push(td);
      });
    }
    V.days.forEach((d, i) => {
      const cell = LA.getCell(m, row.id, d);
      const td = el('td', { class: `la-day ${dayClass(d)}`, dataset: { r, c: META + i } });
      if (row.kind === 'section') td.classList.add('la-band');
      if (cell?.color) {
        const entry = legend.get(cell.color);
        td.style.backgroundColor = `#${cell.color}`;
        td.classList.add('la-painted');
        if (LA.isDark(cell.color)) td.classList.add('la-dark');
        if (!entry) td.classList.add('la-unmapped');
        else if (row.kind === 'activity' && LA.isCancelMeaning(entry.meaning)) td.classList.add('la-cancel');
        td.title = `${dayLabel(d)} · ${entry?.meaning || `unmapped colour #${cell.color}`}${cell.text ? ` · ${cell.text}` : ''}`;
      } else if (cell?.text) td.title = `${dayLabel(d)} · ${cell.text}`;
      if (cell?.text) {
        if (row.kind === 'activity') codeNodes(td, cell.text);
        else td.textContent = cell.text;
      }
      tr.append(td);
      line.push(td);
    });
    V.cells.push(line);
    body.append(tr);
  });
  if (!V.rows.length) {
    body.append(el('tr', {}, [el('td', { class: 'la-empty', colSpan: META + V.days.length }, [
      V.hideQuiet ? 'Nothing is scheduled in these weeks. ' : 'The look-ahead is empty. ',
      writer() ? el('button', { type: 'button', class: 'mini', text: 'Add the first activity', onClick: () => insertRow('activity') }) : null,
      writer() ? ' or ' : null,
      writer() ? el('button', { type: 'button', class: 'secondary mini', text: 'Import the 4WLA workbook', onClick: importWorkbook }) : null,
    ])]));
  }
  table.append(body);

  const scroll = el('div', { class: 'la-scroll', tabindex: '0', 'aria-label': 'Look-ahead grid' }, [table]);
  wire(scroll, table);
  clear(wrap);
  wrap.append(scroll);
  V.scroll = scroll;
  if (keepScroll) { scroll.scrollTop = keepScroll.top; scroll.scrollLeft = keepScroll.left; } else {
    /* The first time: the TAWR week in view, with the week before it for context. */
    const at = V.days.indexOf(V.app.week);
    if (at > 7) scroll.scrollLeft = (at - 7) * DAY_WIDTH;
  }
  clampSelection();
  paintSelection();
  if (hadFocus && !document.querySelector('.modal-back')) scroll.focus({ preventScroll: true });
  setStatus(V.pending ? 'saving' : V.status === 'error' ? 'error' : 'saved');
}

/** Codes as written, a struck-out one drawn struck through. */
function codeNodes(td, text) {
  if (!text.includes('~')) { td.textContent = text; return; }
  LA.cellTokens(text).forEach((t, i) => {
    if (i) td.append('.');
    td.append(t.cancelled ? el('span', { class: 'la-code-x', title: `${t.code} cancelled`, text: t.code }) : t.code);
  });
}

function locationCell(td, row, tawr) {
  const typed = String(row.location || '').trim();
  const linked = hasLink(row.link);
  const resolved = !linked && typed ? resolveLocationText(typed, V.app.locations) : null;
  const state = linked ? 'linked' : resolved ? 'typed' : typed ? 'unlinked' : 'empty';
  td.classList.add(`loc-${state}`);
  const text = typed || (linked ? linkLabel(row.link) : '');
  td.append(...[
    el('button', {
      type: 'button', class: `loc-pin-dot pin-${state === 'linked' || state === 'typed' ? 'linked' : state === 'unlinked' ? 'unlinked' : 'empty'}`,
      'aria-label': `Location options for ${LA.rowTitle(row)}`, tabindex: '-1',
      onClick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); locationMenu(row, r.left, r.bottom); },
    }),
    el('span', { class: 'loc-text', text: text || (writer() ? 'Select on track plan…' : '') }),
    tawr ? el('span', { class: 'loc-tawr', style: `--c:${STATUS_COLOR[tawr.status]}`, title: `TAWR #${tawr.id} for the week of ${tawr.week_start}: ${tawr.status}`, text: `#${tawr.id}` }) : null,
  ].filter(Boolean));
  td.title = linked ? `Linked to the track plan: ${linkArea(row.link)}`
    : resolved ? `Typed, and matched to ${resolved.name}. Select on track plan to add the block of track.`
      : typed ? `"${typed}" is not linked to the track plan. Right-click → Select on track plan.`
        : 'No location. Right-click → Select on track plan.';
}

/* ── Selection ────────────────────────────────────────────────────────── */

function clampSelection() {
  if (!V.cur) return;
  const maxR = V.rows.length - 1;
  const maxC = META + V.days.length - 1;
  if (maxR < 0) { V.cur = null; V.sel = null; return; }
  const cl = (v, hi) => Math.max(0, Math.min(hi, v));
  V.cur = { r: cl(V.cur.r, maxR), c: cl(V.cur.c, maxC) };
  if (V.sel) V.sel = { r0: cl(V.sel.r0, maxR), r1: cl(V.sel.r1, maxR), c0: cl(V.sel.c0, maxC), c1: cl(V.sel.c1, maxC) };
}

function selRect() {
  if (!V.sel) return null;
  return {
    r0: Math.min(V.sel.r0, V.sel.r1), r1: Math.max(V.sel.r0, V.sel.r1),
    c0: Math.min(V.sel.c0, V.sel.c1), c1: Math.max(V.sel.c0, V.sel.c1),
  };
}

function paintSelection() {
  V.root.querySelectorAll('.la-sel, .la-cur').forEach((n) => n.classList.remove('la-sel', 'la-cur'));
  const s = selRect();
  if (!s) return;
  for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) V.cells[r]?.[c]?.classList.add('la-sel');
  V.cells[V.cur.r]?.[V.cur.c]?.classList.add('la-cur');
}

function select(r, c, extend = false) {
  if (V.editing) commitEdit();
  if (extend && V.sel) V.sel = { ...V.sel, r1: r, c1: c };
  else V.sel = { r0: r, c0: c, r1: r, c1: c };
  V.cur = { r, c };
  paintSelection();
  const td = V.cells[r]?.[c];
  td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** The selected day cells on rows of the given kinds: `[{ row, day }]`. */
function selectedDays(kinds = ['activity']) {
  const s = selRect();
  if (!s) return [];
  const out = [];
  for (let r = s.r0; r <= s.r1; r++) {
    const row = V.rows[r];
    if (!kinds.includes(row.kind)) continue;
    for (let c = Math.max(s.c0, META); c <= s.c1; c++) out.push({ row, day: V.days[c - META] });
  }
  return out;
}

function selectedRows() {
  const s = selRect();
  if (!s) return [];
  return [...new Set(V.rows.slice(s.r0, s.r1 + 1))];
}

/* ── Editing ──────────────────────────────────────────────────────────── */

function editable(r, c) {
  const row = V.rows[r];
  if (!row || !writer()) return false;
  if (row.kind === 'section') return c < META ? true : false;
  if (row.kind === 'resource') return c >= META;
  return true;
}

function startEdit(seed = null) {
  if (!V.cur || !editable(V.cur.r, V.cur.c)) return;
  const { r, c } = V.cur;
  const row = V.rows[r];
  const td = V.cells[r][c];
  const current = c < META
    ? (row.kind === 'section' ? row.description : row[LA.FIELDS[c].key]) || ''
    : LA.getCell(model(), row.id, V.days[c - META])?.text || '';
  const input = el('input', { type: 'text', class: 'la-input', 'aria-label': 'Edit cell', spellcheck: 'false' });
  input.value = seed ?? current;
  const rect = td.getBoundingClientRect();
  const host = V.scroll.getBoundingClientRect();
  input.style.left = `${rect.left - host.left + V.scroll.scrollLeft}px`;
  input.style.top = `${rect.top - host.top + V.scroll.scrollTop}px`;
  input.style.minWidth = `${Math.max(rect.width, c < META ? rect.width : 120)}px`;
  input.style.height = `${rect.height}px`;
  V.editing = { r, c, input, row, original: current };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); } else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); move(0, e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => { if (V.editing?.input === input) commitEdit(); });
  V.scroll.append(input);
  input.focus();
  if (seed == null) input.select();
}

function cancelEdit() {
  const ed = V.editing;
  V.editing = null; // before removing: removing a focused input fires its blur
  ed?.input.remove();
  V.scroll?.focus({ preventScroll: true });
}

function commitEdit() {
  const ed = V.editing;
  if (!ed) return;
  V.editing = null;
  const value = ed.input.value;
  ed.input.remove();
  if (value === ed.original) { V.scroll?.focus({ preventScroll: true }); return; }
  const { row, c } = ed;
  if (c < META) {
    if (row.kind === 'section') commit([{ op: 'row', id: row.id, set: { description: value.trim() } }]);
    else {
      const key = LA.FIELDS[c].key;
      const set = { [key]: value.trim() };
      if (key === 'location' && hasLink(row.link)) {
        set.link = null;
        toast('The track plan link was removed with the typed location. Select it on the track plan again to link it.', 'warn');
      }
      commit([{ op: 'row', id: row.id, set }]);
    }
  } else {
    const day = V.days[c - META];
    const cell = LA.getCell(model(), row.id, day);
    const text = row.kind === 'activity' ? LA.normaliseSupportIfCodes(value) : value.trim();
    commit([{ op: 'cell', row_id: row.id, day, color: cell?.color || null, text }]);
    if (row.kind === 'activity') {
      const unknown = LA.unknownCodes(text, V.app.la.codes);
      if (unknown.length && /^[A-Z.~]+$/.test(text)) toast(`Not in the support code register: ${unknown.join(', ')}. Kept as typed; add it in TAWRs → Setup.`, 'warn');
    }
  }
  V.scroll?.focus({ preventScroll: true });
}

function move(dr, dc, extend = false) {
  if (!V.cur) { select(0, 0); return; }
  const r = Math.max(0, Math.min(V.rows.length - 1, V.cur.r + dr));
  const c = Math.max(0, Math.min(META + V.days.length - 1, V.cur.c + dc));
  if (extend) {
    V.sel = { ...(V.sel || { r0: V.cur.r, c0: V.cur.c }), r1: r, c1: c };
    V.cur = { r, c };
    paintSelection();
  } else select(r, c);
}

/* ── Actions on the selection ─────────────────────────────────────────── */

function paint(color) {
  if (!writer()) return;
  const days = selectedDays();
  if (!days.length) { toast('Select days on an activity row first.', 'warn'); return; }
  commit(days.map(({ row, day }) => ({ op: 'cell', row_id: row.id, day, color, text: LA.getCell(model(), row.id, day)?.text || '' })));
  V.scroll?.focus({ preventScroll: true }); // keep typing into the grid after pressing a colour
}

function addCode(code, delta) {
  if (!writer()) return;
  const days = selectedDays();
  if (!days.length) { toast('Select days on an activity row first.', 'warn'); return; }
  commit(days.map(({ row, day }) => {
    const cell = LA.getCell(model(), row.id, day);
    return { op: 'cell', row_id: row.id, day, color: cell?.color || null, text: LA.addCode(cell?.text || '', code, delta) };
  }));
  V.scroll?.focus({ preventScroll: true });
}

function clearSelection() {
  const s = selRect();
  if (!s || !writer()) return;
  const ops = [];
  for (let r = s.r0; r <= s.r1; r++) {
    const row = V.rows[r];
    for (let c = s.c0; c <= s.c1; c++) {
      if (!editable(r, c)) continue;
      if (c >= META) {
        const day = V.days[c - META];
        if (LA.getCell(model(), row.id, day)) ops.push({ op: 'cell', row_id: row.id, day, color: null, text: '' });
      } else if (row.kind === 'section') {
        if (c === 1 && row.description) ops.push({ op: 'row', id: row.id, set: { description: '' } });
      } else {
        const key = LA.FIELDS[c].key;
        if (row[key]) ops.push({ op: 'row', id: row.id, set: key === 'location' ? { location: '', link: null } : { [key]: '' } });
      }
    }
  }
  commit(ops);
}

function insertRow(kind) {
  if (!writer()) return;
  const m = model();
  const ordered = LA.orderedRows(m.rows);
  const at = V.cur ? V.rows[V.cur.r] : null;
  if (kind === 'resource') {
    const parent = at && (at.kind === 'activity' ? at : at.kind === 'resource' ? m.rows.find((x) => x.id === at.parent_id) : null);
    if (!parent) { toast('Select an activity to add a Resource row under it.', 'warn'); return; }
    const kids = LA.resourcesOf(m, parent.id);
    const id = LA.newId();
    commit([{ op: 'row', id, set: { kind: 'resource', parent_id: parent.id, description: 'Resource', sort: Math.max(0, ...kids.map((k) => k.sort)) + 1 } }]);
    focusRow(id, META);
    return;
  }
  /* Below the selected row's block (an activity with its names), else at the end. */
  const top = ordered.filter((r) => r.kind !== 'resource');
  let anchor = at;
  if (anchor?.kind === 'resource') anchor = m.rows.find((x) => x.id === anchor.parent_id);
  const i = anchor ? top.findIndex((r) => r.id === anchor.id) : top.length - 1;
  const before = top[i]?.sort ?? null;
  const after = top[i + 1]?.sort ?? null;
  const id = LA.newId();
  commit([{ op: 'row', id, set: { kind, sort: LA.sortBetween(before, after), description: kind === 'section' ? 'New section' : '' } }]);
  focusRow(id, 1, true);
}

function focusRow(id, c, edit = false) {
  const r = V.rows.findIndex((x) => x.id === id);
  if (r < 0) return;
  select(r, c);
  V.scroll.focus({ preventScroll: true });
  if (edit) startEdit();
}

function moveRow(row, dir) {
  const m = model();
  if (row.kind === 'resource') {
    const kids = LA.orderedRows(m.rows).filter((k) => k.kind === 'resource' && k.parent_id === row.parent_id);
    const i = kids.findIndex((k) => k.id === row.id);
    const other = kids[i + dir];
    if (!other) return;
    commit([{ op: 'row', id: row.id, set: { sort: other.sort } }, { op: 'row', id: other.id, set: { sort: row.sort } }]);
    return;
  }
  const top = LA.orderedRows(m.rows).filter((r) => r.kind !== 'resource');
  const i = top.findIndex((r) => r.id === row.id);
  const other = top[i + dir];
  if (!other) return;
  const a = row.sort === other.sort ? other.sort + dir * 0.5 : other.sort;
  commit([{ op: 'row', id: row.id, set: { sort: a } }, { op: 'row', id: other.id, set: { sort: row.sort } }]);
}

async function deleteRows(rows) {
  if (!rows.length || !writer()) return;
  const names = rows.filter((r) => r.kind !== 'resource').map((r) => LA.rowTitle(r));
  const ok = await confirmDialog({
    title: rows.length === 1 ? `Delete ${LA.rowTitle(rows[0])}?` : `Delete ${rows.length} rows?`,
    message: `${names.length ? `${names.join(', ')} — ` : ''}its days, its Resource rows and its track plan link go with it. Undo (Ctrl+Z) brings it all back.`,
    confirmLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  commit(LA.deleteOps(model(), rows.map((r) => r.id)));
}

/* ── The Location: linked to the track plan ───────────────────────────── */

async function selectOnTrackPlan(row) {
  if (V.editing) commitEdit();
  const picked = await V.app.pickLocation({ title: LA.rowTitle(row), link: row.link });
  if (!picked) return;
  const label = linkLabel(picked);
  commit([{ op: 'row', id: row.id, set: { link: picked, location: label } }]);
  toast(`${LA.rowTitle(row)}: ${linkArea(picked)}`, 'good');
}

function locationMenu(row, x, y) {
  if (row.kind !== 'activity') return;
  const linked = hasLink(row.link);
  contextMenu(x, y, [
    writer() ? { id: 'select-on-track-plan', label: 'Select on track plan…', hint: 'TCR, station or block of track', onClick: () => selectOnTrackPlan(row) } : null,
    linked ? { id: 'show-on-track-plan', label: 'Show on track plan', onClick: () => V.app.showOnMap(row.link) } : null,
    linked && writer() ? { id: 'unlink', label: 'Remove the track plan link', onClick: () => commit([{ op: 'row', id: row.id, set: { link: null } }]) } : null,
    !linked && row.location && !writer() ? { label: 'Not linked to the track plan', disabled: true } : null,
  ].filter(Boolean));
}

function cellMenu(r, c, x, y) {
  const row = V.rows[r];
  if (!row) return;
  if (!V.sel || !inSel(r, c)) select(r, c);
  if (c === LOC && row.kind === 'activity') { locationMenu(row, x, y); return; }
  if (!writer()) {
    contextMenu(x, y, [
      { id: 'copy', label: 'Copy', hint: 'Ctrl+C', onClick: () => copySelection() },
      row.kind === 'activity' && hasLink(row.link) ? { label: 'Show on track plan', onClick: () => V.app.showOnMap(row.link) } : null,
    ].filter(Boolean));
    return;
  }
  const items = [
    { id: 'copy', label: 'Copy', hint: 'Ctrl+C — shift colours too', onClick: () => copySelection() },
    { id: 'paste', label: 'Paste', hint: clip ? 'Ctrl+V — what was copied here' : 'Copy something first', disabled: !clip, onClick: () => pasteBlock(clip?.block) },
    '-',
  ];
  if (c >= META && row.kind === 'activity') {
    for (const e of V.app.la.legend.filter((x2) => (x2.role || 'shift') === 'shift')) items.push({ label: `Paint ${e.meaning}`, onClick: () => paint(e.argb) });
    items.push({ label: 'No colour', onClick: () => paint(null) }, '-');
  }
  if (row.kind === 'activity') {
    items.push({ id: 'select-on-track-plan', label: 'Select location on track plan…', onClick: () => selectOnTrackPlan(row) });
    items.push({ label: 'Add Resource row', onClick: () => insertRow('resource') }, '-');
  }
  items.push(
    { label: 'Insert activity below', onClick: () => insertRow('activity') },
    { label: 'Insert section below', onClick: () => insertRow('section') },
    { label: 'Move up', onClick: () => moveRow(row, -1) },
    { label: 'Move down', onClick: () => moveRow(row, 1) },
    '-',
    { id: 'delete-row', label: selectedRows().length > 1 ? `Delete ${selectedRows().length} rows` : 'Delete row', onClick: () => deleteRows(selectedRows()) },
  );
  contextMenu(x, y, items);
}

function inSel(r, c) {
  const s = selRect();
  return s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
}

/* ── Copy and paste ───────────────────────────────────────────────────── */

/*
 * A day is its colour as much as its text, so a copy carries both. The system
 * clipboard gets plain text and an HTML table with each day's background, which
 * Excel and Outlook keep; pasting back in here uses the block itself while the
 * clipboard still holds what was copied, and reads the colours out of the HTML
 * otherwise (a block copied from Excel). A colour the legend does not know is
 * never painted — it is left off and said.
 */
let clip = null; // { block, text }: the last block copied here

function copyBlock() {
  const s = selRect();
  if (!s) return null;
  const block = [];
  for (let r = s.r0; r <= s.r1; r++) {
    const row = V.rows[r];
    const line = [];
    for (let c = s.c0; c <= s.c1; c++) {
      if (c < META) {
        line.push({ meta: row.kind === 'section' ? (c === 1 ? row.description : '') : row.kind === 'resource' ? (c === 1 ? 'Resource' : '') : row[LA.FIELDS[c].key] || '' });
      } else {
        const cell = LA.getCell(model(), row.id, V.days[c - META]);
        line.push({ color: cell?.color || null, text: cell?.text || '' });
      }
    }
    block.push(line);
  }
  return block;
}

const blockText = (block) => block.map((line) => line.map((x) => ('meta' in x ? x.meta : x.text)).join('\t')).join('\n');

function blockHtml(block) {
  const td = (x) => {
    if ('meta' in x) return `<td>${esc(x.meta)}</td>`;
    const style = x.color ? ` style="background-color:#${x.color};${LA.isDark(x.color) ? 'color:#FFFFFF;' : ''}"` : '';
    return `<td${style}>${esc(x.text)}</td>`;
  };
  return `<table>${block.map((line) => `<tr>${line.map(td).join('')}</tr>`).join('')}</table>`;
}

function copySelection(clipboardData = null) {
  const block = copyBlock();
  if (!block) return;
  clip = { block, text: blockText(block) };
  if (clipboardData) {
    clipboardData.setData('text/plain', clip.text);
    clipboardData.setData('text/html', blockHtml(block));
  } else {
    try { navigator.clipboard?.writeText(clip.text)?.catch(() => {}); } catch { /* the block is kept here either way */ }
  }
  const n = block.length * block[0].length;
  toast(`Copied ${n} cell${n === 1 ? '' : 's'}, shift colours included.`, 'info', 1800);
}

/** "#ffff00", "rgb(255, 255, 0)" → "FFFF00"; anything else → null. */
function hexOf(css) {
  const t = String(css || '').trim();
  let m = t.match(/^#?([0-9a-f]{6})$/i);
  if (m) return m[1].toUpperCase();
  m = t.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}

/** A pasted HTML table as a block, colours read off each cell (inline, or Excel's class styles). */
function blockFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // builds a document that runs nothing
  const classes = new Map();
  for (const st of doc.querySelectorAll('style')) {
    for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const bg = m[2].match(/background(?:-color)?\s*:\s*([^;]+)/i);
      if (bg && hexOf(bg[1])) classes.set(m[1], hexOf(bg[1]));
    }
  }
  const rows = [...doc.querySelectorAll('tr')];
  if (!rows.length) return null;
  return rows.map((tr) => [...tr.cells].map((td) => {
    const own = hexOf(td.style.backgroundColor) || hexOf(td.getAttribute('bgcolor'));
    const byClass = [...td.classList].map((k) => classes.get(k)).find(Boolean) || null;
    const color = own || byClass;
    return { color: color === 'FFFFFF' ? null : color, text: td.textContent.replace(/\s+/g, ' ').trim() };
  }));
}

/**
 * Lay a block down from the selected cell — or, where more is selected than
 * was copied, repeat it across the selection, so one painted day copied fills
 * a week.
 */
function pasteBlock(block) {
  if (!V.cur || !writer() || !block?.length) return;
  const s = selRect();
  const h = block.length;
  const w = block[0].length;
  const r0 = s && (s.r1 - s.r0 + 1 > h || s.c1 - s.c0 + 1 > w) ? s.r0 : V.cur.r;
  const c0 = s && (s.r1 - s.r0 + 1 > h || s.c1 - s.c0 + 1 > w) ? s.c0 : V.cur.c;
  const rows = s && (s.r1 - s.r0 + 1 > h) ? s.r1 - s.r0 + 1 : h;
  const cols = s && (s.c1 - s.c0 + 1 > w) ? s.c1 - s.c0 + 1 : w;
  const shifts = new Set(V.app.la.legend.filter((e) => (e.role || 'shift') === 'shift').map((e) => String(e.argb).toUpperCase()));
  const unknown = new Set();
  const ops = [];
  for (let i = 0; i < rows; i++) {
    const r = r0 + i;
    const row = V.rows[r];
    if (!row) break;
    for (let j = 0; j < cols; j++) {
      const c = c0 + j;
      if (c >= META + V.days.length) break;
      const x = block[i % h][j % w];
      if (!editable(r, c)) continue;
      const value = 'meta' in x ? x.meta : x.text;
      if (c >= META) {
        const day = V.days[c - META];
        const cell = LA.getCell(model(), row.id, day);
        let color = cell?.color || null;
        if ('color' in x && row.kind === 'activity') {
          if (!x.color) color = null;
          else if (shifts.has(x.color)) color = x.color;
          else unknown.add(x.color);
        }
        ops.push({ op: 'cell', row_id: row.id, day, color, text: row.kind === 'activity' ? LA.normaliseSupportIfCodes(value) : String(value).trim() });
      } else if (row.kind === 'section') {
        if (c === 1) ops.push({ op: 'row', id: row.id, set: { description: String(value).trim() } });
      } else {
        const key = LA.FIELDS[c].key;
        ops.push({ op: 'row', id: row.id, set: key === 'location' && hasLink(row.link) ? { location: String(value).trim(), link: null } : { [key]: String(value).trim() } });
      }
    }
  }
  commit(ops);
  if (unknown.size) toast(`Not in the legend, so not painted: ${[...unknown].map((h2) => `#${h2}`).join(', ')}. Add it in TAWRs → Setup → Legend to use it.`, 'warn');
}

const same = (a, b) => String(a).replace(/\r/g, '').trim() === String(b).replace(/\r/g, '').trim();

function pasteFrom(clipboardData) {
  const text = clipboardData.getData('text/plain');
  const html = clipboardData.getData('text/html');
  if (clip && same(clip.text, text)) { pasteBlock(clip.block); return; }
  const fromHtml = html ? blockFromHtml(html) : null;
  if (fromHtml) { pasteBlock(fromHtml); return; }
  const grid = String(text).replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t').map((t) => ({ text: t })));
  pasteBlock(grid);
}

/* ── Events ───────────────────────────────────────────────────────────── */

function cellAt(target) {
  const td = target.closest?.('td[data-c]');
  if (!td) return null;
  return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
}

function wire(scroll, table) {
  table.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    const at = cellAt(e.target);
    if (!at) return;
    e.preventDefault();
    scroll.focus({ preventScroll: true });
    select(at.r, at.c, e.shiftKey);
    V.dragging = true;
  });
  table.addEventListener('mouseover', (e) => {
    if (!V.dragging) return;
    const at = cellAt(e.target);
    if (!at) return;
    V.sel = { ...V.sel, r1: at.r, c1: at.c };
    V.cur = at;
    paintSelection();
  });
  table.addEventListener('dblclick', (e) => {
    const at = cellAt(e.target);
    if (!at || e.target.closest('button')) return;
    select(at.r, at.c);
    if (at.c === LOC && V.rows[at.r]?.kind === 'activity' && writer() && !V.rows[at.r].location && !hasLink(V.rows[at.r].link)) { selectOnTrackPlan(V.rows[at.r]); return; }
    startEdit();
  });
  table.addEventListener('contextmenu', (e) => {
    const at = cellAt(e.target);
    if (!at) return;
    e.preventDefault();
    cellMenu(at.r, at.c, e.clientX, e.clientY);
  });
  scroll.addEventListener('keydown', onKey);
  scroll.addEventListener('copy', (e) => {
    if (V.editing) return;
    copySelection(e.clipboardData);
    e.preventDefault();
  });
  scroll.addEventListener('paste', (e) => {
    if (V.editing) return;
    pasteFrom(e.clipboardData);
    e.preventDefault();
  });
}

function onKey(e) {
  if (V.editing || e.target.tagName === 'INPUT') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.altKey && /^[0-9]$/.test(e.key)) {
    e.preventDefault();
    const shifts = V.app.la.legend.filter((x) => (x.role || 'shift') === 'shift');
    const n = Number(e.key);
    if (n === 0) paint(null); else if (shifts[n - 1]) paint(shifts[n - 1].argb);
    return;
  }
  const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrows[e.key]) { e.preventDefault(); move(...arrows[e.key], e.shiftKey); return; }
  if (!V.cur) return;
  if (e.key === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelection(); return; }
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const r = V.cells[V.cur.r][V.cur.c].getBoundingClientRect();
    cellMenu(V.cur.r, V.cur.c, r.left, r.bottom);
    return;
  }
  if (!ctrl && !e.altKey && e.key.length === 1 && writer()) {
    e.preventDefault();
    startEdit(e.key);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   The workbook
   ═══════════════════════════════════════════════════════════════════════ */

function importWorkbook() {
  const input = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    let read;
    try {
      read = LA.readWorkbook(await file.arrayBuffer(), { legend: V.app.la.legend, anchorISO: V.app.today });
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
    importDialog(file.name, read);
  });
  document.body.append(input);
  input.click();
}

function importDialog(name, read) {
  const days = read.view.days.filter((d) => d.date);
  const shifts = V.app.la.legend.filter((e) => (e.role || 'shift') === 'shift');
  const choices = new Map();
  const fromInput = el('input', { type: 'date', value: LA.mondayOf(V.app.today) });
  const unknown = el('div', { class: 'la-unknown' }, read.unknown.map((u) => {
    const sel = el('select', { 'aria-label': `What #${u.hex} is` }, [
      el('option', { value: '', text: 'Not work — leave it behind' }),
      ...shifts.map((s) => el('option', { value: s.argb, text: s.meaning })),
    ]);
    sel.addEventListener('change', () => choices.set(u.hex, sel.value));
    return el('div', { class: 'row' }, [
      el('span', { class: 'la-key-sw', style: `background-color:#${u.hex}` }),
      el('span', { text: `#${u.hex} · ${u.count} cell${u.count === 1 ? '' : 's'} (${u.samples.join(', ')})` }),
      sel,
    ]);
  }));
  const existing = model().rows.length;
  const body = el('div', { class: 'form-grid' }, [
    el('p', { text: `${name}: sheet "${read.sheet}", ${read.view.activities.filter((a) => !a.heading && !a.absence).length} rows, ${days.length ? `${days[0].date} to ${days[days.length - 1].date}` : 'no dates'}.` }),
    read.dated ? null : el('p', { class: 'msg err', text: 'The weekday letters do not agree with any year, so the days cannot be dated. Nothing can be imported from this sheet.' }),
    read.fromKey.length ? el('p', { text: `The workbook's own key adds: ${read.fromKey.map((k) => `#${k.argb} ${k.meaning}`).join(', ')}.` }) : null,
    read.unknown.length ? el('p', { text: 'Colours neither the legend nor the workbook\'s key names — say what each one is, or leave it behind:' }) : null,
    unknown,
    el('label', {}, ['Bring in what is planned from', fromInput]),
    existing ? el('p', { class: 'msg err', text: `This replaces the ${existing} rows on the look-ahead now, and their track plan links. Locations typed in the workbook that match a station or TCR exactly are recognised; the rest need linking on the track plan.` }) : null,
  ]);
  openModal({
    title: 'Import the 4WLA workbook',
    body,
    size: 'lg',
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import', kind: 'primary', id: 'import-confirm',
        onClick: async () => {
          if (!read.dated) return;
          const { model: m, report } = LA.modelFromView(read.view, {
            fromISO: fromInput.value || V.app.today, legend: read.legend, choices: Object.fromEntries(choices),
          });
          const data = LA.serialise(m);
          try {
            await S.replaceLookahead(data.rows, data.cells, read.legend);
          } catch (err) { toast(err.message, 'bad'); return; }
          await V.app.reloadLookahead();
          V.undo = [];
          V.redo = [];
          V.from = LA.mondayOf(fromInput.value || V.app.today);
          render(V.root, V.app);
          V.app.lookaheadChanged();
          const linked = m.rows.filter((r) => r.kind === 'activity' && resolveLocationText(r.location, V.app.locations)).length;
          toast(`Imported ${report.activities} activities, ${report.sections} sections, ${report.resources} Resource rows and ${report.cells} days. ${linked} location${linked === 1 ? '' : 's'} recognised; link the rest on the track plan.`, 'good', 9000);
        },
      },
    ],
  });
}

function exportCsv() {
  const rows = V.rows;
  const lines = [[...LA.FIELDS.map((f) => f.heading), 'Track plan area', ...V.days].map(csvField).join(',')];
  for (const row of rows) {
    const meta = row.kind === 'section' ? ['', row.description, '', '', '', '']
      : row.kind === 'resource' ? ['', 'Resource', '', '', '', ''] : LA.FIELDS.map((f) => row[f.key] || '');
    const legend = LA.legendMap(V.app.la.legend);
    const days = V.days.map((d) => {
      const c = LA.getCell(model(), row.id, d);
      if (!c) return '';
      const shift = c.color ? legend.get(c.color)?.meaning || `#${c.color}` : '';
      return [shift, c.text].filter(Boolean).join(': ');
    });
    lines.push([...meta, row.kind === 'activity' && hasLink(row.link) ? linkArea(row.link) : '', ...days].map(csvField).join(','));
  }
  saveFile(`Look-ahead ${V.days[0]}.csv`, `${lines.join('\r\n')}\r\n`, 'text/csv');
}
