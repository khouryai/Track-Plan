/**
 * Reports: what the requests came to over the weeks chosen (`reports.js`
 * works the numbers out) — a row of figures, three column charts, the weekly
 * table they are drawn from (with its CSV), and the reasons requests were
 * rejected or denied.
 *
 * The charts are SVG drawn here to the project's data-viz rules: columns at
 * most 24 px wide, a 4 px rounded data end and a square foot on the baseline,
 * a 2 px surface gap between stacked segments, hairline solid gridlines, a
 * legend for two or more series, text in text colours (never a series colour),
 * a tooltip on every column that the keyboard reaches too — and every value
 * also in the table, so nothing is reachable by hovering alone.
 *
 * Imports: reports, tawr, store, ui.
 */

import { report, OUTCOMES, OUTCOME_LABEL, LEAD_BINS, percent } from './reports.js';
import * as T from './tawr.js';
import * as S from './store.js';
import { el, clear, dayLabel, dateLabel, stampLabel, saveFile, csvField } from './ui.js';

const RANGES = [4, 8, 12, 26];
const R = { weeks: 8 };

/* The series, by the job each does: outcomes are identities, in the palette's
   fixed order; what is not decided yet, and hours approved, are context grey. */
const OUTCOME_COLOR = { approved: 'var(--series-1)', rejected: 'var(--series-2)', denied: 'var(--series-3)', cancelled: 'var(--series-4)', waiting: 'var(--series-context)' };

export async function render(host, app) {
  const from = T.addDaysISO(T.mondayOf(app.today), -7 * (R.weeks - 1));
  const to = T.addDaysISO(T.mondayOf(app.today), 7 * 4);
  const head = el('div', { class: 'reports-head' }, [
    el('h2', { text: 'Reports' }),
    el('label', { class: 'inline' }, ['Weeks ', el('select', {
      'aria-label': 'Weeks reported', dataset: { report: 'range' },
      onChange: (e) => { R.weeks = Number(e.target.value); clear(host); render(host, app); },
    }, RANGES.map((n) => el('option', { value: String(n), text: `the last ${n}, and the 4 ahead`, selected: n === R.weeks || null })))]),
  ]);
  const body = el('div', { class: 'reports', 'aria-busy': 'true' });
  host.append(head, body);
  let records;
  try { records = await S.listTawrs(from); } catch (err) { body.append(el('p', { class: 'msg err', text: err.message })); return; }
  body.removeAttribute('aria-busy');
  const rep = report(records, { from, to });
  const t = rep.totals;

  body.append(el('p', { class: 'small', text: `The weeks of ${dateLabel(from)} to ${dateLabel(to)}: ${t.raised} request${t.raised === 1 ? '' : 's'} raised. A request revised or consolidated counts once; what was decided on it before still counts.` }));
  const tile = (label, value, sub) => el('div', { class: 'stat-tile' }, [el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value', text: value }), sub ? el('div', { class: 'stat-sub', text: sub }) : null]);
  const hours = (n) => `${Math.round(n)} h`;
  body.append(el('div', { class: 'stat-row', dataset: { report: 'figures' } }, [
    tile('Approved by the Track Allocation Manager', percent(t.approvals, t.approvals + t.rejections), `${t.approvals} approved · ${t.rejections} rejected`),
    tile('Granted by BART', percent(t.granted, t.granted + t.denied), t.granted + t.denied ? `${t.granted} granted · ${t.denied} denied` : 'no answers recorded yet'),
    tile('Sent in on time', percent(t.onTime, t.sent), t.sent ? `${t.onTime} of ${t.sent} by their deadline · ${t.late} late` : 'none sent in yet'),
    tile('Track hours used', percent(t.hoursUsed, t.hoursRecorded), t.hoursRecorded ? `${hours(t.hoursUsed)} of ${hours(t.hoursRecorded)} approved, where recorded` : 'recorded once the days have gone by'),
  ]));

  const weekLabels = rep.weeks.map((w) => dayLabel(w.week).slice(4));
  const charts = [
    {
      title: 'Requests by week, and how each ended',
      empty: !t.raised,
      draw: (width, label) => columnChart({
        label, width, stacked: true, categories: weekLabels, unit: 'request',
        series: OUTCOMES.map((o) => ({ key: o, label: OUTCOME_LABEL[o], color: OUTCOME_COLOR[o], values: rep.weeks.map((w) => w.counts[o]) })),
      }),
    },
    {
      title: 'How early requests went in, against their deadline',
      empty: !t.sent,
      draw: (width, label) => columnChart({
        label, width, categories: LEAD_BINS.map((b) => b.label), unit: 'request',
        series: [{ key: 'sent', label: 'Requests', color: 'var(--series-1)', values: LEAD_BINS.map((b) => rep.lead[b.key]) }],
      }),
      table: [['How early', 'Requests'], ...LEAD_BINS.map((b) => [b.label, rep.lead[b.key]])],
    },
    {
      title: 'Track hours by week: approved, and used where recorded',
      empty: !t.hoursApproved,
      draw: (width, label) => columnChart({
        label, width, categories: weekLabels, unit: 'hour', format: (v) => `${Math.round(v)} h`,
        series: [
          { key: 'approved', label: 'Approved', color: 'var(--series-context)', values: rep.weeks.map((w) => w.hoursApproved) },
          { key: 'used', label: 'Used', color: 'var(--series-1)', values: rep.weeks.map((w) => w.hoursUsed) },
        ],
      }),
    },
  ];
  const cards = charts.map((c) => {
    const card = el('section', { class: 'chart-card' }, [el('h3', { text: c.title })]);
    body.append(card);
    return { c, card };
  });
  for (const { c, card } of cards) {
    if (c.empty) { card.append(el('p', { class: 'empty', text: 'Nothing to show for these weeks yet.' })); continue; }
    const room = card.clientWidth ? card.clientWidth - 26 : 640;
    card.append(c.draw(Math.max(300, Math.min(1000, room)), c.title));
    if (c.table) {
      card.append(el('details', { class: 'chart-table' }, [el('summary', { text: 'As a table' }), el('table', { class: 'grid-table' }, [
        el('thead', {}, [el('tr', {}, c.table[0].map((h) => el('th', { text: h })))]),
        el('tbody', {}, c.table.slice(1).map((row) => el('tr', {}, row.map((v) => el('td', { text: String(v) }))))),
      ])]));
    }
  }

  /* The weekly table: every value the charts draw, and the CSV. */
  const head2 = ['Week of', 'Raised', ...OUTCOMES.map((o) => OUTCOME_LABEL[o]), 'Sent in', 'On time', 'Late', 'Hours approved', 'Hours used'];
  const rows = rep.weeks.map((w) => [w.week, w.raised, ...OUTCOMES.map((o) => w.counts[o]), w.sent, w.onTime, w.late, Math.round(w.hoursApproved), w.hoursRecorded ? Math.round(w.hoursUsed) : '']);
  body.append(el('section', { class: 'chart-card' }, [
    el('div', { class: 'inline spread' }, [
      el('h3', { text: 'Week by week' }),
      el('button', {
        type: 'button', class: 'secondary mini', dataset: { action: 'report-csv' }, text: 'CSV',
        onClick: () => saveFile(`TAWR report ${from} to ${to}.csv`, `${[head2, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`, 'text/csv'),
      }),
    ]),
    el('div', { class: 'scroll-x' }, [el('table', { class: 'grid-table report-table', dataset: { report: 'weeks' } }, [
      el('thead', {}, [el('tr', {}, head2.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((v, i) => el('td', { class: i ? 'num' : '', text: i ? String(v) : dayLabel(v) }))))),
    ])]),
  ]));

  body.append(el('section', { class: 'chart-card' }, [
    el('h3', { text: 'Why requests were rejected or denied' }),
    rep.reasons.length ? el('table', { class: 'grid-table', dataset: { report: 'reasons' } }, [
      el('thead', {}, [el('tr', {}, ['When', 'Request', 'Week of', 'By', 'Reason'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rep.reasons.map((x) => el('tr', {}, [
        el('td', { text: stampLabel(x.at) }),
        el('td', { text: `#${x.id} ${x.location} · ${T.tawrShiftLabel(x.shift)}` }),
        el('td', { text: dayLabel(x.week) }),
        el('td', { text: x.kind === 'denied' ? `BART (recorded by ${x.by})` : x.by }),
        el('td', { text: x.note }),
      ]))),
    ]) : el('p', { class: 'empty', text: 'No request was rejected or denied in these weeks.' }),
  ]));
}

/* ── Column charts ─────────────────────────────────────────────────────── */

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of children) if (c) n.append(c);
  return n;
}

/** A column with its data end (the top) rounded and its foot square on the baseline. */
function columnPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** A clean top for the scale and the ticks under it: whole steps of 1, 2 or 5 (times ten), five at most — a count is never 2.5. */
function scale(max) {
  const m = Math.max(1, max);
  for (let mag = 1; ; mag *= 10) {
    for (const k of [1, 2, 5]) {
      const n = Math.ceil(m / (k * mag));
      if (n <= 5) return { top: n * k * mag, ticks: Array.from({ length: n + 1 }, (_, i) => i * k * mag) };
    }
  }
}

/**
 * Columns, one group per category: `series` stacked or side by side. Each
 * group is one hit target, the whole height of the plot, that shows every
 * series' value in a tooltip — by pointer or by keyboard.
 */
function columnChart({ categories, series, label, stacked = false, width = 640, height = 230, format = (v) => String(v), unit = '' }) {
  const pad = { top: 22, right: 12, bottom: 32, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const totals = categories.map((_, i) => (stacked ? series.reduce((n, s) => n + (s.values[i] || 0), 0) : Math.max(...series.map((s) => s.values[i] || 0))));
  const { top, ticks } = scale(Math.max(...totals));
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / categories.length;
  const gap = 2;
  const barW = stacked ? Math.min(24, band * 0.6) : Math.min(24, (band * 0.7 - gap * (series.length - 1)) / series.length);
  const groupW = stacked ? barW : barW * series.length + gap * (series.length - 1);

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'viz', role: 'group', 'aria-label': label });
  for (const t of ticks) {
    root.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(t), y2: y(t), class: t ? 'viz-grid' : 'viz-axis' }));
    root.append(svg('text', { x: pad.left - 6, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' }, [document.createTextNode(format(t))]));
  }
  const every = Math.ceil(categories.length / Math.max(1, Math.floor(plotW / 64)));
  categories.forEach((c, i) => {
    if (i % every) return;
    root.append(svg('text', { x: pad.left + band * i + band / 2, y: height - 10, class: 'viz-tick', 'text-anchor': 'middle' }, [document.createTextNode(c)]));
  });

  const tip = el('div', { class: 'viz-tip', role: 'tooltip', hidden: true });
  const wrap = el('div', { class: 'viz-wrap' });
  const show = (i, hit) => {
    clear(tip);
    tip.append(el('div', { class: 'viz-tip-head', text: categories[i] }));
    for (const s of series) {
      tip.append(el('div', { class: 'viz-tip-row' }, [
        el('span', { class: 'viz-key', style: `--c:${s.color}` }),
        el('strong', { text: format(s.values[i] || 0) }), ' ', el('span', { text: s.label }),
      ]));
    }
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const at = hit.getBoundingClientRect();
    const x = at.left - box.left + at.width / 2;
    tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, x - tip.offsetWidth / 2))}px`;
  };

  categories.forEach((c, i) => {
    const x0 = pad.left + band * i + (band - groupW) / 2;
    const g = svg('g', { class: 'viz-col' });
    if (stacked) {
      let base = 0;
      const live = series.filter((s) => (s.values[i] || 0) > 0);
      live.forEach((s, k) => {
        const v = s.values[i];
        const yTop = y(base + v);
        const h = y(base) - yTop;
        const isTop = k === live.length - 1;
        const hh = isTop ? h : Math.max(0, h - gap); // the surface gap sits on top of each segment below another
        g.append(isTop ? svg('path', { d: columnPath(x0, yTop, barW, hh), fill: s.color }) : svg('rect', { x: x0, y: yTop + gap, width: barW, height: hh, fill: s.color }));
        base += v;
      });
    } else {
      series.forEach((s, k) => {
        const v = s.values[i] || 0;
        if (v <= 0) return;
        g.append(svg('path', { d: columnPath(x0 + k * (barW + gap), y(v), barW, y(0) - y(v)), fill: s.color }));
      });
    }
    // The total on each column, where a column is one number: stacked, or a single series — never one of a pair.
    if ((stacked || series.length === 1) && categories.length <= 12 && totals[i] > 0) {
      g.append(svg('text', { x: x0 + groupW / 2, y: y(totals[i]) - 6, class: 'viz-cap', 'text-anchor': 'middle' }, [document.createTextNode(format(totals[i]))]));
    }
    const said = `${c}: ${series.map((s) => `${format(s.values[i] || 0)} ${s.label}`).join(', ')}`;
    const hit = svg('rect', { x: pad.left + band * i, y: pad.top, width: band, height: plotH, class: 'viz-hit', tabindex: 0, role: 'img', 'aria-label': said });
    const on = () => { g.classList.add('on'); show(i, hit); };
    const off = () => { g.classList.remove('on'); tip.hidden = true; };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('focus', on);
    hit.addEventListener('blur', off);
    root.append(g, hit);
  });

  wrap.append(root, tip);
  const legend = series.length > 1 ? el('div', { class: 'viz-legend' }, series.map((s) => el('span', { class: 'viz-legend-item' }, [el('span', { class: 'viz-swatch', style: `--c:${s.color}` }), s.label]))) : null;
  return el('div', { class: 'viz-chart', dataset: { unit } }, [legend, wrap]);
}
