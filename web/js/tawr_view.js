/**
 * TAWRs — track access work requests, raised from the look-ahead, placed by
 * the track plan, approved by the Track Allocation Manager.
 *
 * Pick a week; every place the look-ahead works that week is a request, one
 * per place and shift (`tawr.js`), and its Area is the track plan link on the
 * activities. Drafts are raised by themselves ahead of the deadline
 * (`tawr_sync.js`) and follow the look-ahead until they are submitted.
 *
 * Two roles, one table (`data/tawr_workflow.json`), enforced by the server:
 *
 *   Requester                  reviews a draft, submits it; withdraws, reopens
 *                              a rejected one, revises an approved one
 *   Track Allocation Manager   approves or rejects what is submitted — one at
 *                              a time or several at once — and **consolidates**
 *                              requests whose places overlap into one, so what
 *                              goes to BART says each thing once
 *
 * An approved request is final, downloaded as BART's own form filled and
 * signed (`tawr_pdf.js`), or all of a week's together as one .zip.
 *
 * Imports: tawr, tawr_sync, tawr_pdf, zip, store, lookahead, links, ui, map.
 */

import * as T from './tawr.js';
import { syncWeek, consolidation, extract, freshValues, recordOf } from './tawr_sync.js';
import { readForm, missingFields, fillForm, FILLER_VERSION } from './tawr_pdf.js';
import { zipStore } from './zip.js';
import * as S from './store.js';
import * as LA from './lookahead.js';
import { linkArea, linkLabel } from './links.js';
import {
  el, clear, toast, openModal, confirmDialog, promptDialog, dayLabel, stampLabel, saveFile, csvField,
} from './ui.js';
import { STATUS_COLOR } from './map.js';
import { parsePhases, phasesText, newPhaseId, coversText } from './phases.js';
import * as Learn from './learn.js';

const V = { app: null, root: null, section: 'requests', picked: new Set(), open: new Set(), history: false, focus: null, setupAt: null };

/** Open with one request in view (from the map). */
export function focus(id) { V.focus = id; }

/** Open Setup at one of its sections (`phases`). */
export function openSetup(section) { V.section = 'setup'; V.setupAt = section; }

const live = (r) => !['superseded', 'consolidated'].includes(r.status);
const label = (name) => T.FIELD_LABEL.get(name) || name;
const statusName = (s) => (s === 'none' ? 'Not raised' : S.store.workflow.statuses[s] || s);

/* ── BART's blank form, once per session ───────────────────────────────── */

let template = null;
async function getTemplate() {
  if (template) return template;
  template = await S.getTemplate();
  return template;
}

/* ══════════════════════════════════════════════════════════════════════════
   The view
   ═══════════════════════════════════════════════════════════════════════ */

export function render(root, app) {
  V.app = app;
  V.root = root;
  clear(root);
  const nav = el('div', { class: 'subtabs', role: 'tablist' }, [['requests', 'Requests'], ['setup', 'Setup']].map(([id, text]) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(V.section === id), dataset: { section: id }, text,
    onClick: () => { V.section = id; render(root, app); },
  })));
  root.append(nav);
  const host = el('div', { class: 'tawr' });
  root.append(host);
  if (V.section === 'setup') renderSetup(host);
  else renderRequests(host);
}

const rerender = () => render(V.root, V.app);

async function refresh() {
  await V.app.reloadTawrs();
  rerender();
}

/* ══════════════════════════════════════════════════════════════════════════
   Requests
   ═══════════════════════════════════════════════════════════════════════ */

function renderRequests(host) {
  const app = V.app;
  const week = app.week || T.dueWeek(app.today);
  const settings = app.settings || {};

  host.append(el('div', { class: 'tawr-head' }, [
    el('h2', { text: 'Track access work requests' }),
    el('p', { class: 'small', text: `One TAWR per place and shift each week, made from the look-ahead, with its limits from the track plan. Each is due ${T.TAWR_LEAD_DAYS} days before its first day.` }),
    flowStrip(),
  ]));

  if (S.writer()) {
    if (!settings.template_info) host.append(notice('warn', 'BART\'s blank form has not been uploaded yet.', 'Requests can be raised, submitted and approved, but not downloaded as the form until it is.', 'Open Setup'));
    else if (!settings.requestor_name || !settings.requestor_signature) host.append(notice('info', 'The requester\'s name, cell phone or signature is not saved yet.', 'Every request goes out with them. Save them in Setup.', 'Open Setup'));
  }

  /* The weeks, each saying where its requests stand. */
  const weeks = app.weeks();
  const due = T.dueWeek(app.today);
  host.append(el('div', { class: 'week-picker', role: 'group', 'aria-label': 'Week' }, weeks.map((w) => {
    const sum = weekSummary(app.tawrs, w);
    return el('button', {
      type: 'button', class: `week-btn${w === week ? ' on' : ''}${w === due ? ' due' : ''}`, dataset: { week: w },
      'aria-pressed': String(w === week), title: `${dayLabel(w)} – ${dayLabel(T.addDaysISO(w, 6))}. Its TAWRs are due ${T.TAWR_LEAD_DAYS} days before their first day, from ${dayLabel(T.tawrDeadline(w))}.`,
      onClick: () => { app.setWeek(w); V.picked.clear(); rerender(); },
    }, [
      el('span', { class: 'wk-date' }, [`Week of ${dayLabel(w).slice(4)}`, w === due ? el('span', { class: 'tag', text: 'due now' }) : null]),
      el('span', { class: 'wk-sum', text: sum || 'nothing raised' }),
    ]);
  })));

  /* What the look-ahead says this week, and what has been saved. */
  const groups = extract(app, week);
  const records = app.tawrs.filter((r) => r.week_start === week);
  const items = [];
  for (const g of groups) items.push({ group: g, record: records.find((r) => r.group_key === g.key && live(r)) || null });
  for (const r of records.filter(live)) if (!groups.some((g) => g.key === r.group_key)) items.push({ group: null, record: r });
  const order = { submitted: 0, draft: 1, rejected: 2, denied: 3, none: 4, approved: 5, cancelled: 6 };
  items.sort((a, b) => (order[a.record?.status || 'none'] - order[b.record?.status || 'none'])
    || (a.group?.locationName || a.record?.location_name || '').localeCompare(b.group?.locationName || b.record?.location_name || ''));

  /* Each request is due ${T.TAWR_LEAD_DAYS} days before its own first day: the week says the soonest still open. */
  const open = items.filter((i) => ['none', 'draft', 'rejected'].includes(i.record?.status || 'none'))
    .map((i) => i.group?.firstDay || i.record?.first_day || week).sort();
  const deadline = open.length ? T.deadlineState(open[0], app.today) : null;
  const approved = items.filter((i) => i.record?.status === 'approved').map((i) => i.record);
  const notRaised = items.filter((i) => !i.record && i.group);
  const drafts = items.filter((i) => i.record?.status === 'draft');
  const picked = items.filter((i) => i.record && V.picked.has(i.record.id)).map((i) => i.record);

  const bar = el('div', { class: 'tawr-toolbar' }, [
    el('div', {}, [
      el('strong', { text: `${dayLabel(week)} – ${dayLabel(T.addDaysISO(week, 6))} ${week.slice(0, 4)}` }),
      deadline ? el('span', { class: `badge tone-${deadline.tone}`, title: `TAWRs are due ${T.TAWR_LEAD_DAYS} days before their first day.`, text: `Next due ${dayLabel(deadline.deadline)} · ${deadline.label}` })
        : items.length ? el('span', { class: 'badge tone-ok', text: 'Nothing left to submit' }) : null,
    ]),
    el('div', { class: 'tawr-actions' }, [
      S.writer() && (groups.length || drafts.length) ? el('button', {
        type: 'button', class: 'mini', dataset: { action: 'tawr-sync' },
        text: notRaised.length ? `Raise ${notRaised.length} draft${notRaised.length === 1 ? '' : 's'} from the look-ahead` : 'Refresh from the look-ahead',
        title: 'One draft per place and shift. Drafts keep every change typed into them; submitted and approved requests are left alone.',
        onClick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await syncWeek(app, week);
            toast(`TAWRs: ${[r.made && `${r.made} raised`, r.updated && `${r.updated} brought up to date`, r.kept && `${r.kept} submitted or decided, left as they are`].filter(Boolean).join(', ') || 'nothing to do'}.`, 'good');
          } catch (err) { toast(err.message, 'bad'); }
          refresh();
        },
      }) : null,
      el('button', { type: 'button', class: 'secondary mini', text: 'Show on track plan', onClick: () => app.go('map') }),
      el('button', { type: 'button', class: 'secondary mini', text: 'Look-ahead', onClick: () => app.go('lookahead') }),
      approved.length ? el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'tawr-register' }, text: 'Submittal register (CSV)', onClick: () => register(week, approved) }) : null,
      approved.length && S.writer() ? el('button', { type: 'button', class: 'mini', dataset: { action: 'tawr-download-all' }, text: `Download approved (${approved.length})`, onClick: () => downloadAll(week, approved) }) : null,
    ]),
  ]);
  host.append(bar);

  /* Bulk: what the role can do to every request picked. */
  if (picked.length) {
    const can = (action) => picked.every((r) => T.may(S.store.workflow, S.role(), action, r.status));
    host.append(el('div', { class: 'bulk', role: 'region', 'aria-label': 'Picked requests' }, [
      el('span', { text: `${picked.length} picked` }),
      can('submit') ? el('button', { type: 'button', class: 'mini', dataset: { action: 'bulk-submit' }, text: 'Submit', onClick: () => bulk(picked, 'submit') }) : null,
      can('approve') ? el('button', { type: 'button', class: 'mini', dataset: { action: 'bulk-approve' }, text: 'Approve', onClick: () => bulk(picked, 'approve') }) : null,
      can('reject') ? el('button', { type: 'button', class: 'mini danger', dataset: { action: 'bulk-reject' }, text: 'Reject', onClick: () => bulk(picked, 'reject') }) : null,
      picked.length > 1 && can('consolidate') ? el('button', { type: 'button', class: 'mini', dataset: { action: 'consolidate' }, text: 'Consolidate into one', onClick: () => consolidate(picked) }) : null,
      el('button', { type: 'button', class: 'secondary mini', text: 'Clear', onClick: () => { V.picked.clear(); rerender(); } }),
    ]));
  }

  /* Approved twice for the same thing: what consolidating exists to prevent. */
  for (const rep of T.repetitions(approved)) {
    host.append(notice('bad', `#${rep.a.id} ${rep.a.location_name} and #${rep.b.id} ${rep.b.location_name} are both approved for the same track on ${rep.days.map(dayLabel).join(', ')}.`,
      'BART would be asked twice. Revise one of them and consolidate them before submittal.'));
  }

  if (!items.length) {
    host.append(el('div', { class: 'empty' }, [
      el('p', { text: 'Nothing is painted on the look-ahead this week, so there is nothing to request.' }),
      el('button', { type: 'button', class: 'mini', text: 'Go to the look-ahead', onClick: () => app.go('lookahead') }),
    ]));
  } else {
    const pickable = items.filter((i) => i.record && live(i.record)).map((i) => i.record.id);
    const all = el('input', {
      type: 'checkbox', class: 'pick-all', 'aria-label': 'Pick every request this week',
      onChange: (e) => { for (const id of pickable) { if (e.target.checked) V.picked.add(id); else V.picked.delete(id); } rerender(); },
    });
    all.checked = pickable.length > 0 && pickable.every((id) => V.picked.has(id));
    const clashes = T.conflicts(records.filter(live));
    const table = el('table', { class: 'tawr-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'c-pick' }, [pickable.length ? all : null]),
        ...['Request', 'When', 'Work', 'BART support', 'Status and next step'].map((h) => el('th', { text: h })),
        el('th', { class: 'c-act' }, [el('span', { class: 'sr-only', text: 'Actions' })]),
      ])]),
      ...items.map((item) => card(item, items, clashes)),
    ]);
    host.append(el('div', { class: 'scroll-x' }, [table]));
  }

  /* Said once for the week, quietly, not on every request. */
  const unexpanded = [...new Set(items.filter((i) => i.group && (!i.record || i.record.status === 'draft')).flatMap((i) => i.group.unexpanded || []))];
  if (S.writer() && unexpanded.length) {
    host.append(el('p', { class: 'small tawr-aside' }, [
      `The form's Work Description gives only the activity's name for ${unexpanded.length === 1 ? unexpanded[0] : `${unexpanded.length} activities this week`}. `,
      el('button', { type: 'button', class: 'link', text: 'Add fuller wording in Setup', onClick: () => { V.section = 'setup'; rerender(); } }),
      ' if BART needs more.',
    ]));
  }

  const old = records.filter((r) => !live(r));
  if (old.length) {
    const det = el('details', { class: 'tawr-history', open: V.history || null }, [
      el('summary', { text: `Consolidated and superseded (${old.length})` }),
      ...old.map((r) => el('div', { class: 'tawr-old' }, [
        el('span', { class: 'pill', style: `--c:${STATUS_COLOR[r.status]}`, text: statusName(r.status) }),
        ` #${r.id} ${r.location_name} · ${T.tawrShiftLabel(r.shift)}`,
        r.merged_into ? ` → consolidated into #${r.merged_into}` : '',
        r.status === 'superseded' ? ' → revised' : '',
      ])),
    ]);
    det.addEventListener('toggle', () => { V.history = det.open; });
    host.append(det);
  }

  if (V.focus) {
    const node = host.querySelector(`[data-tawr-id="${V.focus}"]`);
    if (node) {
      setOpen(node, true);
      node.classList.add('flash');
      requestAnimationFrame(() => node.scrollIntoView({ block: 'center' }));
    }
    V.focus = null;
  }
}

/** Where a request goes, step by step, with this account's step marked. */
function flowStrip() {
  const role = S.role();
  const steps = [
    ['Look-ahead', 'the work is painted', null],
    ['Draft', 'the requester reviews and submits', 'requester'],
    ['Submitted', 'the Track Allocation Manager approves', 'manager'],
    ['Approved', 'downloaded as BART\'s form', null],
  ];
  return el('ol', { class: 'flow', 'aria-label': 'How a TAWR moves along' }, steps.map(([name, what, who]) => el('li', { class: who && who === role ? 'mine' : '' }, [
    el('b', { text: name }), ` ${what}`, who && who === role ? el('span', { class: 'you', text: ' — you' }) : null,
  ])));
}

/** "2 approved · 4 drafts": where a week's requests stand. */
function weekSummary(tawrs, week) {
  const by = {};
  for (const t of tawrs) if (t.week_start === week && live(t)) by[t.status] = (by[t.status] || 0) + 1;
  const plural = { draft: 'drafts', submitted: 'submitted', approved: 'approved', rejected: 'rejected', denied: 'denied by BART', cancelled: 'cancelled' };
  return ['draft', 'submitted', 'approved', 'rejected', 'denied', 'cancelled'].filter((s) => by[s]).map((s) => `${by[s]} ${by[s] === 1 ? statusName(s).toLowerCase() : plural[s]}`).join(' · ');
}

function notice(tone, title, detail, action = null) {
  return el('div', { class: `notice notice-${tone}`, role: 'status' }, [
    el('div', {}, [el('strong', { text: title }), ' ', el('span', { text: detail })]),
    action ? el('button', { type: 'button', class: 'secondary mini', text: action, onClick: () => { V.section = 'setup'; rerender(); } }) : null,
  ]);
}

/* ── One request ──────────────────────────────────────────────────────── */

const KIND_WORD = { tcr: 'TCR', track: 'track', place: 'station or yard' };

/** The predictions still standing on a record: those nobody has typed over. */
function standing(record) {
  const predicted = record?.source?.predicted || {};
  const edited = new Set(T.editedKeys(record?.fields, record?.generated));
  return Object.entries(predicted)
    .filter(([key]) => !Learn.fieldsOf(key, record.fields).some((f) => edited.has(f)))
    .map(([key, p]) => ({ key, ...p }));
}

/** "Power status: OFF — 6 of 8 similar requests (#3, #7, #12)". */
function predictedLine(p) {
  return `${Learn.unitLabel(p.key)}: ${Learn.answerText(p.key, p.value)} — ${p.support} of ${p.of} similar request${p.of === 1 ? '' : 's'}${p.from?.length ? ` (${p.from.map((x) => `#${x}`).join(', ')})` : ''}`;
}

/**
 * Rejected requests that looked like this one — or were this one, sent before
 * and reopened — for a request still to be sent. A rejected request is not
 * warned of its own rejection: it says that already.
 */
function rejectedLike(view, shift, record = null) {
  if (!V.app.learning) return [];
  return Learn.rejectionsLike(V.app.learning, { ...view, shift }).filter((r) => !(['rejected', 'denied'].includes(record?.status) && r.id === record.id));
}

/** A rejection remembered, said to the request it is like. */
function rejectedText(r, record) {
  const when = r.at ? ` on ${stampLabel(r.at)}` : '';
  const what = r.bart ? 'denied by BART' : 'rejected';
  return record && r.id === record.id
    ? `When this request was sent before, it was ${what}${when}: “${r.reason}”. Check that is put right before it is sent again.`
    : `A request like this one${r.id ? ` (#${r.id})` : ''} was ${what}${when}: “${r.reason}”. Check this one for the same before it is sent.`;
}

/* What a blocking flag comes to, in the few words the row has room for. */
const BLOCKER = {
  no_location: 'an activity has no location',
  location_unlinked: 'a location is not linked to the track plan',
  colour_unmapped: 'painted in a colour the legend does not know',
  gone: 'it is no longer on the look-ahead',
};

/**
 * Whose turn it is, and by when, in words: `{ text, tone }` where tone is
 * `you` (this account's move), `wait`, `done` or `bad`.
 */
function nextStep(record, blocking, due, conflicted = false) {
  const wf = S.store.workflow;
  const role = S.role();
  const status = record?.status || 'none';
  const by = due.daysLeft < 0 ? `— it was due ${dayLabel(due.deadline)}` : `by ${dayLabel(due.deadline)}`;
  if (status === 'none') return S.writer() ? { tone: 'you', text: 'Not raised yet: raise a draft' } : { tone: 'wait', text: 'Not raised yet' };
  if (status === 'draft') {
    if (blocking.length) return { tone: 'bad', text: `Fix first: ${BLOCKER[blocking[0].kind] || blocking[0].message}${blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : ''}` };
    if (T.may(wf, role, 'submit', status)) return { tone: due.daysLeft < 0 ? 'bad' : 'you', text: `Your turn: review and submit ${by}` };
    return { tone: 'wait', text: 'With the requester, not submitted yet' };
  }
  if (status === 'submitted') {
    if (!T.may(wf, role, 'approve', status)) return { tone: 'wait', text: 'Waiting for the Track Allocation Manager' };
    return { tone: 'you', text: conflicted ? 'Your turn: settle the conflict, then approve or reject' : 'Your turn: approve or reject' };
  }
  if (status === 'rejected') return role === 'requester' ? { tone: 'you', text: 'Rejected: reopen, correct and submit again' } : { tone: 'wait', text: 'Rejected: back with the requester' };
  const bart = record.bart || {};
  const writer = S.writer();
  switch (T.afterApproval(record, V.app.today)) {
    case 'unsent': return writer ? { tone: 'you', text: 'Approved: send BART\'s form to BART, then record it as sent' } : { tone: 'wait', text: 'Approved: to be sent to BART' };
    case 'sent': return { tone: 'wait', text: `Sent to BART ${dayLabel(bart.sent_on)}: waiting for BART's answer` };
    case 'granted': return { tone: 'done', text: `Granted by BART${bart.ref ? ` · ${bart.ref}` : ''}` };
    case 'access-due': return writer ? { tone: 'you', text: 'Granted: say whether the access was used' } : { tone: 'wait', text: 'Granted: the access used is still to be recorded' };
    case 'recorded': { const a = T.accessOf(record); return { tone: 'done', text: `Access used on ${a.used} of ${a.days} day${a.days === 1 ? '' : 's'}` }; }
    case 'denied': return T.may(wf, role, 'reopen', status) ? { tone: 'bad', text: 'Denied by BART: reopen, correct and submit again' } : { tone: 'bad', text: 'Denied by BART' };
    case 'unreleased': return writer ? { tone: 'you', text: 'Cancelled: tell BART the track is released' } : { tone: 'wait', text: 'Cancelled: BART still to be told' };
    case 'released': return { tone: 'done', text: 'Cancelled: the track is released' };
    default: break;
  }
  return { tone: 'wait', text: statusName(status) };
}

/** "Mon 9, Tue 10 Nov": the days, short. */
function daysShort(days) {
  if (!days.length) return '—';
  const labels = days.map((d) => dayLabel(d.date));
  const months = new Set(labels.map((l) => l.slice(-3)));
  return months.size === 1 ? `${labels.map((l) => l.slice(0, -4)).join(', ')} ${[...months][0]}` : labels.join(', ');
}

/** "2300–0500", or that the hours differ from day to day. */
function hoursShort(days) {
  const hours = [...new Set(days.map((d) => `${d.start || '?'}–${d.end || '?'}`))];
  return hours.length === 1 ? hours[0] : hours.length ? 'hours differ by day' : '';
}

function supportText(support) {
  return [
    support.filter((s) => s.line === 'systems').map((s) => (s.count > 1 ? `${s.count} x ${s.label}` : s.label)).join(', '),
    support.filter((s) => s.line === 'occ').map((s) => `OCC: ${s.label}`).join(', '),
  ].filter(Boolean).join(' · ') || 'None';
}

/** The other requests made from the same activities, as the other kind of work: a TCR's track request, and back. */
function partners(item, kind, items) {
  const rows = new Set((item.group?.activities || item.record?.source?.activities || []).map((a) => a.row).filter(Boolean));
  if (!rows.size) return [];
  return items.filter((o) => o !== item && (o.group?.kind || o.record?.source?.kind) !== kind
    && (o.group?.activities || o.record?.source?.activities || []).some((a) => rows.has(a.row)));
}

function setOpen(node, open) {
  node.classList.toggle('open', open);
  node.querySelector('.tawr-detail').hidden = !open;
  const toggle = node.querySelector('.tawr-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Hide details' : 'Details';
  const key = node.dataset.tawrKey || node.dataset.tawrId;
  if (open) V.open.add(key); else V.open.delete(key);
}

function card(item, items, clashes = []) {
  const { group, record } = item;
  const app = V.app;
  const status = record?.status || 'none';
  const src = group ? null : record?.source || {};
  const name = group?.locationName || record?.location_name || '(no location)';
  const shift = group?.shift || record?.shift;
  const kind = group?.kind || record?.source?.kind || 'unlinked';
  const firstDay = group?.firstDay || record?.first_day || record?.week_start;
  const due = T.deadlineState(firstDay, app.today);
  const fresh = group ? freshValues(app, group) : null;
  /* Read off the look-ahead now while it can still follow it; as it was sent
     once it has been submitted or decided. */
  const frozen = record && record.status !== 'draft';
  const view = frozen ? { ...(record.source || {}) } : group || src;
  const flags = group ? (frozen ? record.source?.flags || [] : group.flags) : [...goneFlag(record), ...(record?.source?.flags || [])];
  const blocking = flags.filter((f) => f.blocking);
  const changed = frozen && fresh ? T.changedSince(record.generated, fresh) : [];
  const edited = record ? T.editedKeys(record.fields, record.generated) : [];
  const overlaps = (group?.overlaps || []).map((o) => ({ ...o, item: items.find((i) => i.group?.key === o.key) })).filter((o) => o.item);
  const merged = String(record?.group_key || group?.key || '').startsWith('merge:');
  const mine = clashes.filter((x) => record && (x.a.id === record.id || x.b.id === record.id));
  const next = nextStep(record, blocking, due, mine.length > 0);
  const after = record ? T.afterApproval(record, app.today) : null;
  const predictions = record ? standing(record) : [];
  const pairs = partners(item, kind, items);
  const key = group?.key || record?.group_key || '';
  const open = V.open.has(key || String(record?.id || ''));

  const node = el('tbody', {
    class: `tawr-card st-${status}${open ? ' open' : ''}`, style: `--c:${STATUS_COLOR[status] || '#9ca3af'}`,
    dataset: { tawrKey: key, tawrStatus: status, tawrId: record?.id || '' },
    'aria-label': `${name}, ${T.tawrShiftLabel(shift)} shift — ${statusName(status)}`,
  });

  /* The row: enough to know what it is and what happens next. */
  const pick = record && live(record) ? el('input', {
    type: 'checkbox', class: 'pick', 'aria-label': `Pick #${record.id}`,
    onChange: (e) => { if (e.target.checked) V.picked.add(record.id); else V.picked.delete(record.id); rerender(); },
  }) : null;
  if (pick) pick.checked = V.picked.has(record.id);
  const days = view.days || [];
  const activities = view.activities || [];
  const support = view.support || [];
  const parties = [...new Set(activities.map((a) => a.party).filter(Boolean))];

  const wf = S.store.workflow;
  const role = S.role();
  const available = record ? T.actionsFor(wf, role, record.status).filter((a) => !['consolidate', 'split'].includes(a) && !(a === 'discard' && merged)) : [];
  const primary = !record ? (group && S.writer() ? 'raise' : null)
    : ['submit', 'approve', 'reopen'].find((a) => available.includes(a) && !(a === 'reopen' && record.status === 'cancelled')) || (after === 'unsent' && S.writer() ? 'download' : null);
  const stepButton = (action, text = wf.actions[action].label) => {
    const rule = wf.actions[action];
    const stopped = rule.unblocked && blocking.length;
    return button(text, `tawr-${action}`, () => act(record, action), {
      primary: ['submit', 'approve'].includes(action), danger: ['reject', 'discard', 'cancel'].includes(action), disabled: stopped,
      title: stopped ? `Cannot be ${action === 'submit' ? 'submitted' : 'approved'} yet: ${blocking.map((f) => f.message).join(' ')}` : '',
    });
  };
  const rowActions = [];
  if (record) {
    const editable = T.canEdit(wf, role, record.status);
    rowActions.push(button(editable ? 'Review' : 'View', editable ? 'tawr-review' : 'tawr-view', () => openReview(record, group, { readOnly: !editable, blocking })));
  }
  if (primary === 'raise') {
    rowActions.push(button('Raise draft', 'tawr-raise', async () => {
      try { await S.createTawr(recordOf(app, group)); } catch (err) { toast(err.message, 'bad'); }
      refresh();
    }, { primary: true }));
  } else if (primary === 'download') {
    rowActions.push(button('Download PDF', 'tawr-download', () => downloadOne(record), { primary: true }));
  } else if (primary) rowActions.push(stepButton(primary, { submit: 'Submit', approve: 'Approve', reopen: 'Reopen' }[primary]));
  /* After approval: the next thing to record about BART, or the access. */
  if (record && S.writer()) {
    if (after === 'unsent') rowActions.push(button('Sent to BART…', 'tawr-bart', () => bartDialog(record)));
    else if (after === 'sent') rowActions.push(button('BART\'s answer…', 'tawr-bart', () => bartDialog(record), { primary: true }));
    else if (after === 'access-due') rowActions.push(button('Access used…', 'tawr-access', () => accessDialog(record), { primary: true }));
    else if (after === 'unreleased') rowActions.push(button('BART told…', 'tawr-released', () => releasedDialog(record), { primary: true }));
  }
  if ((view.place?.geometry?.length || view.place?.places?.length) && record) {
    rowActions.push(button('Map', 'tawr-map', () => app.showTawrOnMap(record), { title: 'Show it on the track plan' }));
  }
  const toggle = el('button', { type: 'button', class: 'mini secondary tawr-toggle', 'aria-expanded': String(open), text: open ? 'Hide details' : 'Details', onClick: () => setOpen(node, !node.classList.contains('open')) });
  rowActions.push(toggle);

  const attention = [];
  for (const c of mine) attention.push(el('span', { class: 'chip-bad', text: `Conflict with #${(c.a.id === record.id ? c.b : c.a).id}` }));
  if (changed.length) attention.push(el('span', { class: 'chip-bad', text: 'Look-ahead has changed' }));
  if (overlaps.length && S.isManager()) attention.push(el('span', { class: 'chip-info', text: `Overlaps ${overlaps.map((o) => (o.item.record ? `#${o.item.record.id}` : o.locationName)).join(', ')} — can consolidate` }));

  const row = el('tr', {
    class: 'tawr-row',
    onClick: (e) => { if (!e.target.closest('button, input, a, select, label')) setOpen(node, !node.classList.contains('open')); },
  }, [
    el('td', { class: 'c-pick' }, [pick]),
    el('td', { class: 'c-req' }, [
      el('h3', { text: `${record ? `#${record.id} ` : ''}${name}` }),
      el('div', { class: 'chips' }, [
        el('span', { class: `badge kind-${kind}`, title: kind === 'tcr' ? 'Work in the train control room — never on the same request as track' : kind === 'track' ? 'Work on the track, between these limits' : '', text: T.PART_KINDS[kind] || kind }),
        merged ? el('span', { class: 'badge', text: `Consolidated from ${(view.members || group?.members || []).length}` }) : null,
      ]),
      pairs.length ? el('div', { class: 'small pair', title: 'A TCR and track are separate categories of work, so the same activity makes one request for each.', text: `Goes with ${pairs.map((p) => `${p.record ? `#${p.record.id}` : p.group?.locationName} (${KIND_WORD[p.group?.kind || p.record?.source?.kind] || 'other'})`).join(', ')} — same activity` }) : null,
    ]),
    el('td', { class: 'c-when' }, [
      el('span', { class: 'badge', text: `${T.tawrShiftLabel(shift)} shift` }),
      el('div', { text: daysShort(days) }),
      el('div', { class: 'small', text: hoursShort(days) }),
    ]),
    el('td', { class: 'c-work' }, [
      activities[0] ? el('div', { text: [activities[0].activityId, activities[0].title].filter(Boolean).join(' · ') }) : el('div', { text: '—' }),
      activities.length > 1 ? el('div', { class: 'small', text: `and ${activities.length - 1} more` }) : null,
      parties.length ? el('div', { class: 'small', text: parties.join(', ') }) : null,
    ]),
    el('td', { class: 'c-sup', text: supportText(support) }),
    el('td', { class: 'c-status' }, [
      el('span', { class: 'pill', style: `--c:${STATUS_COLOR[status] || '#9ca3af'}`, text: statusName(status) }),
      el('div', { class: `next tone-${next.tone}`, text: next.text }),
      attention.length ? el('div', {}, attention) : null,
      predictions.length && ['draft', 'submitted'].includes(status)
        ? el('div', {}, [el('span', { class: 'chip-learn', title: `Predicted from similar requests sent before:\n${predictions.map(predictedLine).join('\n')}`, text: `✦ ${predictions.length} predicted` })])
        : null,
    ]),
    el('td', { class: 'c-act' }, rowActions),
  ]);

  /* The details: everything it says, what needs attention, and the rest of what can be done. */
  const area = (frozen ? record.fields?.row1_area : null) || view.area || name;
  const sswp = view.sswp || [];
  const facts = el('dl', { class: 'facts' }, [
    el('dt', { text: 'Where' }), el('dd', { class: 'area', text: area }),
    el('dt', { text: 'Days' }),
    el('dd', { text: days.map((d) => `${dayLabel(d.date)} ${d.start || '?'}–${d.end || '?'}${d.fromShift ? ' (shift hours)' : ''}`).join(' · ') || '—' }),
    el('dt', { text: 'Work' }),
    el('dd', {}, activities.map((a) => el('div', {}, [
      el('b', { text: [a.activityId, a.title].filter(Boolean).join(' · ') }),
      a.link ? el('span', { class: 'small', text: ` — ${linkArea(a.link)}${a.how === 'typed' ? ' (typed)' : ''}` }) : el('span', { class: 'warn', text: ` — ${a.rawLocation ? `"${a.rawLocation}" not linked` : 'no location'}` }),
      a.party ? el('div', { class: 'small', text: `Party to action: ${a.party}` }) : null,
      a.crew?.length ? el('div', { class: 'small', text: `Crew: ${a.crew.join(', ')}` }) : null,
    ]))),
    el('dt', { text: 'BART support' }), el('dd', { text: supportText(support) }),
    sswp.length ? el('dt', { text: 'SSWP #' }) : null,
    sswp.length ? el('dd', { text: sswp.join(', ') }) : null,
    after ? el('dt', { text: 'With BART' }) : null,
    after ? el('dd', { class: 'bart-facts', text: bartLine(record) }) : null,
    record?.access?.days ? el('dt', { text: 'Access' }) : null,
    record?.access?.days ? el('dd', { class: 'access-facts', text: accessLine(record) }) : null,
  ]);

  const needs = el('ul', { class: 'flags attention' });
  for (const f of blocking) {
    needs.append(el('li', { class: 'block' }, [
      f.message,
      f.kind === 'gone' && T.may(wf, role, 'cancel', record?.status) ? el('button', { type: 'button', class: 'mini danger', dataset: { action: 'tawr-cancel-gone' }, text: 'Cancel and release the track', onClick: () => act(record, 'cancel') }) : null,
    ]));
  }
  for (const c of mine) {
    const other = c.a.id === record.id ? c.b : c.a;
    needs.append(el('li', { class: 'block clash' }, [
      `Conflicts with #${other.id} ${other.location_name} (${statusName(other.status).toLowerCase()}): the same ${record.source?.kind === 'tcr' ? 'room' : 'track'} at the same time on ${c.when.map((w) => `${dayLabel(w.date)} (${w.a} / ${w.b})`).join(', ')}. `,
      el('button', { type: 'button', class: 'mini secondary', text: 'See it on the track plan', onClick: () => app.showTawrOnMap(record) }),
    ]));
  }
  if (changed.length) needs.append(el('li', { class: 'block', text: `The look-ahead has changed since this was ${status} (${changed.map(label).join(', ')}). ${status === 'approved' ? 'Revise it if the request should follow, or cancel it and release the track if the work is off.' : status === 'submitted' ? 'Withdraw it to bring it up to date.' : 'Reopen it to bring it up to date.'}` }));
  if (record?.decision_note && record.status === 'rejected') needs.append(el('li', { class: 'block', text: `Rejected: ${record.decision_note}` }));
  for (const o of overlaps) {
    const other = o.item.record;
    needs.append(el('li', { class: 'overlap' }, [
      `Overlaps ${other ? `#${other.id} ` : ''}${o.locationName} on the drawing${o.days.length ? `, on ${o.days.map(dayLabel).join(', ')}` : ' this week'}. `,
      record && other && T.may(wf, role, 'consolidate', record.status) && T.may(wf, role, 'consolidate', other.status)
        ? el('button', { type: 'button', class: 'mini', dataset: { action: 'consolidate-pair' }, text: `Consolidate with #${other.id}`, onClick: () => consolidate([record, other]) })
        : el('span', { class: 'small', text: S.isManager() ? '' : 'The Track Allocation Manager can consolidate them into one.' }),
    ]));
  }

  if (['none', 'draft', 'rejected', 'denied'].includes(status)) {
    for (const r of rejectedLike(view, shift, record).slice(0, 2)) needs.append(el('li', { class: 'warn learned', text: rejectedText(r, record) }));
  }

  const notes = flags.filter((f) => !f.blocking).map((f) => f.message);
  if (record?.status === 'draft' && record.source?.conflicts?.length) notes.push(`Kept your change where the look-ahead now says something else: ${record.source.conflicts.map(label).join(', ')}.`);

  const meta = [];
  if (record) {
    meta.push(`Raised ${stampLabel(record.created_at)}`);
    if (record.submitted_at && record.status !== 'draft') meta.push(`submitted ${stampLabel(record.submitted_at)}`);
    if (record.decided_at && ['approved', 'rejected', 'denied', 'cancelled'].includes(record.status)) meta.push(`${record.status === 'rejected' ? 'rejected' : 'approved'} ${stampLabel(record.decided_at)}`);
    if (edited.length) meta.push(`${edited.length} field${edited.length === 1 ? '' : 's'} changed by hand`);
  } else meta.push('Not raised yet.');

  const more = el('div', { class: 'card-actions' });
  // A denial is BART's answer, recorded with it; a request whose access is accounted for is not cancelled.
  for (const action of available) if (action !== primary && action !== 'deny' && !(action === 'cancel' && after === 'recorded')) more.append(stepButton(action));
  if (record && merged && T.may(wf, role, 'split', record.status)) more.append(button('Split back up', 'tawr-split', () => splitUp(record)));
  if (record && S.writer()) {
    if (['approved', 'cancelled'].includes(record.status) && primary !== 'download') more.append(button('Download PDF', 'tawr-download', () => downloadOne(record)));
    if (['granted', 'recorded'].includes(after)) more.append(button(after === 'recorded' ? 'Change the access used…' : 'Access used…', 'tawr-access', () => accessDialog(record)));
    if (['granted', 'recorded', 'access-due'].includes(after)) more.append(button('BART…', 'tawr-bart', () => bartDialog(record)));
    if (!after) more.append(button('Preview PDF', 'tawr-preview', () => downloadOne(record, { draft: true })));
  }

  const detail = el('tr', { class: 'tawr-detail', hidden: !open || null }, [el('td', { colSpan: 7 }, [
    facts,
    predictions.length ? el('div', { class: 'learned-list' }, [
      el('div', { class: 'learned-head', text: `✦ Predicted from similar requests sent before${record?.status === 'draft' ? ' — change any in Review; what is sent is learned from' : ''}` }),
      el('ul', {}, predictions.map((p) => el('li', { text: predictedLine(p) }))),
    ]) : null,
    needs.childNodes.length ? needs : null,
    notes.length ? el('details', { class: 'notes' }, [
      el('summary', { text: `${notes.length} note${notes.length === 1 ? '' : 's'}` }),
      el('ul', { class: 'flags' }, notes.map((n) => el('li', { class: 'note', text: n }))),
    ]) : null,
    el('p', { class: 'small meta', text: meta.join(' · ') }),
    record?.history?.length ? el('details', { class: 'history' }, [
      el('summary', { text: 'History' }),
      el('ol', {}, record.history.map((h) => el('li', { text: `${stampLabel(h.at)} — ${h.by}: ${h.action}${h.note ? ` (“${h.note}”)` : ''}` }))),
    ]) : null,
    more.childNodes.length ? more : null,
  ])]);

  node.append(row, detail);
  return node;
}

function button(text, action, onClick, { primary = false, danger = false, disabled = false, title = '' } = {}) {
  return el('button', {
    type: 'button', class: `mini${primary ? '' : danger ? ' danger' : ' secondary'}`, dataset: { action }, disabled: disabled || null, title: title || null, text,
    onClick,
  });
}

/* ── Moving a request along ───────────────────────────────────────────── */

const CONFIRM = {
  submit: (r) => [`Submit the ${r.location_name} request?`, 'It goes to the Track Allocation Manager for approval, as it stands. You can withdraw it until it is decided.'],
  withdraw: (r) => [`Withdraw the ${r.location_name} request?`, 'It goes back to being a draft, and follows the look-ahead again.'],
  approve: (r) => [`Approve the ${r.location_name} request?`, 'Approved is final: it is downloaded as it stands and cannot be edited. If it has to change, it is revised — the approved version is kept.'],
  reopen: (r) => [`Reopen the ${r.location_name} request?`, 'It goes back to being a draft, to be corrected and submitted again.'],
  revise: (r) => [`Revise the ${r.location_name} request?`, 'A new draft takes its place, carrying everything it said. The approved version is kept on record as superseded.'],
  discard: (r) => [`Discard the ${r.location_name} request?`, 'Changes typed into it go with it. Updating the drafts makes a fresh one from the look-ahead.'],
};

async function act(record, action, { quiet = false, note = null } = {}) {
  let extra = {};
  if (action === 'cancel' && note == null) {
    const got = await cancelDialog(record);
    if (!got) return false;
    ({ note } = got);
    extra = { on: got.on, released: got.released };
  } else if ((action === 'reject' || action === 'deny') && note == null) {
    note = await promptDialog(action === 'reject'
      ? { title: `Reject the ${record.location_name} request?`, label: 'Why — the requester sees this', required: true, multiline: true, confirmLabel: 'Reject' }
      : { title: `BART denied the ${record.location_name} request?`, label: 'BART\'s reason', required: true, multiline: true, confirmLabel: 'Record the denial' });
    if (note == null) return false;
    if (action === 'deny') extra = { on: V.app.today };
  } else if (!quiet && CONFIRM[action]) {
    const [title, message] = CONFIRM[action](record);
    if (!(await confirmDialog({ title, message, confirmLabel: S.store.workflow.actions[action].label, danger: action === 'discard' }))) return false;
  }
  try {
    await S.act(record.id, action, note, extra);
    if (!quiet) toast(`#${record.id} ${record.location_name}: ${S.store.workflow.actions[action].label.toLowerCase()} — done.`, 'good');
    V.picked.delete(record.id);
  } catch (err) {
    toast(`#${record.id}: ${err.message}`, 'bad');
    if (!quiet) refresh();
    return false;
  }
  if (!quiet) refresh();
  return true;
}

async function bulk(records, action) {
  let note = null;
  if (action === 'reject') {
    note = await promptDialog({ title: `Reject ${records.length} request${records.length === 1 ? '' : 's'}?`, label: 'Why — the requester sees this', required: true, multiline: true, confirmLabel: 'Reject' });
    if (note == null) return;
  } else if (!(await confirmDialog({
    title: `${S.store.workflow.actions[action].label}: ${records.length} request${records.length === 1 ? '' : 's'}?`,
    message: records.map((r) => `#${r.id} ${r.location_name} (${T.tawrShiftLabel(r.shift)})`).join(', '),
    confirmLabel: S.store.workflow.actions[action].label,
  }))) return;
  let done = 0;
  for (const r of records) if (await act(r, action, { quiet: true, note })) done++;
  toast(`${done} of ${records.length}: ${S.store.workflow.actions[action].label.toLowerCase()} — done.`, done === records.length ? 'good' : 'warn');
  refresh();
}

async function consolidate(records) {
  const shifts = new Set(records.map((r) => r.shift));
  if (shifts.size > 1) { toast('Only requests on the same shift can be one request — a form row is one start and finish a day.', 'warn'); return; }
  if (new Set(records.map((r) => r.source?.kind)).size > 1) { toast('A TCR request and a track request stay separate — they are different categories of work.', 'warn'); return; }
  let built;
  try { built = consolidation(V.app, records); } catch (err) { toast(err.message, 'bad'); return; }
  const note = await promptDialog({
    title: `Consolidate ${records.length} requests into one?`,
    message: `${records.map((r) => `#${r.id} ${r.location_name}`).join(' + ')} → one request for ${built.record.location_name}. Area: ${built.record.source.area}. ${records.every((r) => r.status === 'submitted') ? 'It stays submitted, ready to approve.' : 'It is a draft until it is submitted.'} Split it back up any time before it is approved.`,
    label: 'Note (optional)', confirmLabel: 'Consolidate',
  });
  if (note == null) return;
  try {
    const t = await S.consolidate(records.map((r) => r.id), built.merge, built.record, note || null);
    toast(`Consolidated into #${t.id}.`, 'good');
    V.picked.clear();
    V.focus = t.id;
  } catch (err) { toast(err.message, 'bad'); }
  refresh();
}

/* ── After approval: BART, and the access ─────────────────────────────── */

/** "No longer on the look-ahead": what to do about it depends on where the request stands. */
function goneFlag(record) {
  const say = {
    draft: 'Discard the draft, or check the sheet.',
    submitted: 'Withdraw and discard it, or check the sheet.',
    rejected: 'Discard it, or check the sheet.',
    approved: 'Cancel it and release the track, or check the sheet.',
  }[record?.status];
  return say ? [{ kind: 'gone', blocking: true, message: `No longer on the look-ahead this week. ${say}` }] : [];
}

/** "Sent Wed 14 Oct · BT-4471 · granted Fri 16 Oct", in a sentence. */
function bartLine(record) {
  const b = record.bart || {};
  const parts = [
    b.sent_on ? `Sent ${dayLabel(b.sent_on)}` : record.status === 'approved' ? 'Not sent yet' : null,
    b.ref ? `BART reference ${b.ref}` : null,
    b.answer === 'granted' ? `granted${b.answered_on ? ` ${dayLabel(b.answered_on)}` : ''}` : null,
    b.answer === 'denied' ? `denied${b.answered_on ? ` ${dayLabel(b.answered_on)}` : ''}: “${b.note}”` : null,
    record.status === 'approved' && b.sent_on && !b.answer ? 'waiting for BART\'s answer' : null,
    record.status === 'cancelled' ? (b.released_on ? `cancelled; BART told the track is released ${dayLabel(b.released_on)}` : 'cancelled; BART not told yet') : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** "Used Mon 2, Tue 3 Nov; not used Wed 4 Nov — 12 of 18 hours. Rained off." */
function accessLine(record) {
  const said = record.access?.days || {};
  const days = record.source?.days || [];
  const used = days.filter((d) => said[d.date] === true);
  const unused = days.filter((d) => said[d.date] === false);
  const a = T.accessOf(record);
  const hours = (n) => `${Math.round(n * 10) / 10}`;
  return [
    used.length ? `Used ${daysShort(used)}` : 'Not used',
    unused.length && used.length ? `; not used ${daysShort(unused)}` : '',
    a.hoursAsked ? ` — ${hours(a.hoursUsed)} of ${hours(a.hoursAsked)} hours` : '',
    record.access?.note ? `. ${record.access.note}` : '',
  ].join('');
}

/** When it went to BART, BART's reference, and BART's answer. A denial ends the request. */
function bartDialog(record) {
  const b = record.bart || {};
  const today = V.app.today;
  const sent = el('input', { type: 'date', value: b.sent_on || today, 'aria-label': 'Sent to BART on', dataset: { bart: 'sent_on' } });
  const ref = el('input', { type: 'text', value: b.ref || '', maxlength: '60', placeholder: 'Reference or permit number', 'aria-label': 'BART\'s reference', dataset: { bart: 'ref' } });
  const answer = el('select', { 'aria-label': 'BART\'s answer', dataset: { bart: 'answer' } },
    [['', 'Waiting for BART'], ['granted', 'Granted'], ['denied', 'Denied']].map(([value, text]) => el('option', { value, text })));
  answer.value = b.answer === 'granted' ? 'granted' : '';
  const on = el('input', { type: 'date', value: b.answered_on || today, 'aria-label': 'Answered on', dataset: { bart: 'answered_on' } });
  const reason = el('textarea', { rows: '2', 'aria-label': 'BART\'s reason', dataset: { bart: 'reason' } });
  const why = el('label', { class: 'span2' }, ['BART\'s reason — the request ends as denied, and can be reopened to correct and send again', reason]);
  const sync = () => { why.hidden = answer.value !== 'denied'; on.disabled = !answer.value; };
  answer.addEventListener('change', sync);
  sync();
  const err = el('p', { class: 'msg err' });
  openModal({
    title: `#${record.id} ${record.location_name} — with BART`,
    subtitle: 'What happened once it was approved. BART\'s answer comes back by email or phone; record it here so everybody sees it.',
    body: el('div', { class: 'form-grid two bart-form' }, [
      el('label', {}, ['Sent to BART on', sent]),
      el('label', {}, ['BART\'s reference', ref]),
      el('label', {}, ['BART\'s answer', answer]),
      el('label', {}, ['Answered on', on]),
      why, err,
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', id: 'bart-save', keepOpen: true,
        onClick: async (h) => {
          if (answer.value === 'denied' && !reason.value.trim()) { err.textContent = 'Say BART\'s reason.'; return; }
          try {
            await S.recordBart(record.id, {
              sent_on: sent.value || null, ref: ref.value.trim() || null,
              ...(answer.value === 'granted' ? { answer: 'granted', answered_on: on.value || null } : answer.value === '' ? { answer: null, answered_on: null } : {}),
            });
            if (answer.value === 'denied') await S.act(record.id, 'deny', reason.value.trim(), { on: on.value || today });
          } catch (e) { err.textContent = e.message; return; }
          toast(`#${record.id}: ${answer.value === 'denied' ? 'denied by BART — reopen it to correct and send it again' : answer.value === 'granted' ? 'granted by BART' : 'sent to BART'}.`, answer.value === 'denied' ? 'warn' : 'good');
          h.close();
          refresh();
        },
      },
    ],
  });
}

/** Whether each day's access was used, once the days have come. */
function accessDialog(record) {
  const said = record.access?.days || {};
  const days = (record.source?.days || []).map((d) => {
    const box = el('input', { type: 'checkbox', 'aria-label': `Used on ${dayLabel(d.date)}`, dataset: { day: d.date } });
    box.checked = said[d.date] ?? d.date < V.app.today;
    const h = T.dayHours(d);
    return { d, box, row: el('label', { class: 'check access-day' }, [box, ` ${dayLabel(d.date)} · ${d.start || '?'}–${d.end || '?'}${h != null ? ` · ${Math.round(h * 10) / 10} h` : ''}`]) };
  });
  const note = el('textarea', { rows: '2', placeholder: 'Rained off, BART took the night back, finished early…', 'aria-label': 'What happened' });
  note.value = record.access?.note || '';
  const err = el('p', { class: 'msg err' });
  openModal({
    title: `#${record.id} ${record.location_name} — the access used`,
    subtitle: 'Tick the days the track was actually used. The reports count the hours.',
    body: el('div', { class: 'access-form' }, [...days.map((x) => x.row), el('label', {}, ['What happened (optional)', note]), err]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', id: 'access-save', keepOpen: true,
        onClick: async (h) => {
          try {
            await S.recordAccess(record.id, { days: Object.fromEntries(days.map(({ d, box }) => [d.date, box.checked])), note: note.value.trim() || null, on: V.app.today });
          } catch (e) { err.textContent = e.message; return; }
          const used = days.filter((x) => x.box.checked).length;
          toast(`#${record.id}: access used on ${used} of ${days.length} day${days.length === 1 ? '' : 's'}.`, 'good');
          h.close();
          refresh();
        },
      },
    ],
  });
}

/** Cancelling an approved request: why, and whether BART has been told. `{ note, released, on }`, or null. */
function cancelDialog(record) {
  return new Promise((resolve) => {
    let answered = false;
    const reason = el('textarea', { rows: '3', 'aria-label': 'Why it is cancelled' });
    const told = el('input', { type: 'checkbox', 'aria-label': 'BART has been told the track is released' });
    const err = el('p', { class: 'msg err' });
    openModal({
      title: `Cancel #${record.id} ${record.location_name} and release the track?`,
      body: el('div', {}, [
        el('p', { text: 'It is kept on record as cancelled, and stops counting against anybody else\'s work. BART should be told the track is free.' }),
        el('label', {}, ['Why — the work moved, finished early, was called off…', reason]),
        el('label', { class: 'check' }, [told, ' BART has been told the track is released']),
        err,
      ]),
      onClose: () => { if (!answered) resolve(null); },
      actions: [
        { label: 'Keep it' },
        {
          label: 'Cancel and release', kind: 'danger', id: 'confirm', keepOpen: true,
          onClick: (h) => {
            if (!reason.value.trim()) { err.textContent = 'Say why.'; return; }
            answered = true;
            resolve({ note: reason.value.trim(), released: told.checked, on: V.app.today });
            h.close();
          },
        },
      ],
    });
  });
}

/** After a cancellation: the day BART was told the track is free. */
function releasedDialog(record) {
  const on = el('input', { type: 'date', value: V.app.today, 'aria-label': 'Told on' });
  openModal({
    title: `#${record.id} ${record.location_name}: BART told the track is released?`,
    body: el('div', {}, [el('label', {}, ['Told on', on])]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Record it', kind: 'primary', id: 'confirm',
        onClick: async () => {
          try { await S.recordBart(record.id, { released_on: on.value || V.app.today }); toast(`#${record.id}: BART told the track is released.`, 'good'); } catch (e) { toast(e.message, 'bad'); }
          refresh();
        },
      },
    ],
  });
}

async function splitUp(record) {
  if (!(await confirmDialog({ title: `Split #${record.id} back up?`, message: 'The requests it was made from come back as they were; this one goes.', confirmLabel: 'Split' }))) return;
  try { await S.split(record.id); toast(`#${record.id} split back up.`, 'good'); } catch (err) { toast(err.message, 'bad'); }
  refresh();
}

/* ── The PDF ──────────────────────────────────────────────────────────── */

const TEXT_SIZE = 9;

function signature() {
  try {
    const s = JSON.parse(V.app.settings?.requestor_signature || 'null');
    return s?.strokes?.length ? { field: 'requestor_signature', ...s } : null;
  } catch { return null; }
}

async function templateOrSay() {
  let bytes = null;
  try { bytes = await getTemplate(); } catch (err) { toast(`Could not fetch BART's form: ${err.message}`, 'bad'); return null; }
  if (!bytes) { toast('Upload BART\'s blank form in TAWRs → Setup first. The submittal register (CSV) works without it.', 'warn'); return null; }
  return bytes;
}

function fill(bytes, record) {
  const sig = signature();
  const out = fillForm(bytes, record.fields || {}, { signature: sig, textSize: TEXT_SIZE });
  const over = Object.entries(out.report.fields).filter(([, r]) => !r.fits).map(([k]) => label(k));
  if (over.length) toast(`#${record.id}: too long to fit even at the smallest size — ${over.join(', ')}. Shorten it in Review.`, 'warn');
  if (!sig) toast('No requester signature saved in Setup — the form is unsigned.', 'warn');
  return out.bytes;
}

async function downloadOne(record, { draft = false } = {}) {
  const bytes = await templateOrSay();
  if (!bytes) return;
  try {
    const name = T.tawrFileName({ weekStart: record.week_start, locationName: record.location_name, shift: record.shift });
    saveFile(draft ? `DRAFT ${name}` : name, fill(bytes, record), 'application/pdf');
  } catch (err) { toast(err.message, 'bad'); }
}

async function downloadAll(week, records) {
  const reps = T.repetitions(records);
  if (reps.length && !(await confirmDialog({ title: 'Some approved requests repeat each other', message: `${reps.map((r) => `#${r.a.id} and #${r.b.id}`).join('; ')} cover the same track on the same day. Download anyway?`, confirmLabel: 'Download' }))) return;
  const bytes = await templateOrSay();
  if (!bytes) return;
  try {
    const files = records.map((r) => ({ name: T.tawrFileName({ weekStart: r.week_start, locationName: `${r.location_name} #${r.id}`, shift: r.shift }), data: fill(bytes, r) }));
    saveFile(`TAWRs ${week}.zip`, zipStore(files), 'application/zip');
  } catch (err) { toast(err.message, 'bad'); }
}

/** One line per approved request: what goes to BART, for the submittal email. */
function register(week, records) {
  const head = ['TAWR', 'Week', 'Shift', 'Location', 'Area', 'Dates', 'Hours', 'Work', 'BART support', 'SSWP', 'Approved', 'Requester', 'Sent to BART', 'BART reference', 'BART answer'];
  const lines = [head.map(csvField).join(',')];
  for (const r of records) {
    const days = r.source?.days || [];
    const support = (r.source?.support || []).map((s) => (s.count > 1 ? `${s.count} x ${s.label}` : s.label)).join(', ');
    lines.push([
      `#${r.id}`, r.week_start, T.tawrShiftLabel(r.shift), r.location_name, r.fields?.row1_area || r.source?.area || '',
      days.map((d) => d.date).join(' '), days.map((d) => `${d.start}-${d.end}`).join(' '),
      (r.source?.activities || []).map((a) => [a.activityId, a.title].filter(Boolean).join(' ')).join('; '),
      support, (r.source?.sswp || []).join(' '), stampLabel(r.decided_at), r.fields?.requestor_name || '',
      r.bart?.sent_on || '', r.bart?.ref || '', r.bart?.answer || '',
    ].map(csvField).join(','));
  }
  saveFile(`TAWR submittal register ${week}.csv`, `${lines.join('\r\n')}\r\n`, 'text/csv');
}

/* ══════════════════════════════════════════════════════════════════════════
   Review: every field on the form, as it will be printed
   ═══════════════════════════════════════════════════════════════════════ */

const DAY_OPTIONS = ['', 'MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT', 'SUN'];
const CATEGORY_OPTIONS = ['', 'A', 'B', 'C', 'F', 'P', 'BL', 'Y'];
const MAINT_LINES = [
  ['maint_route_prohibit', 'Route Prohibit'], ['maint_speed_restriction', 'Speed Restriction'],
  ['maint_systems_tech_support', 'Technical Support (Systems)'], ['maint_safe_clearance', 'Safe Clearance'],
  ['maint_rail_bond_cbond', 'Rail Bond / C-Bond'], ['maint_power_tech_support', 'Technical Support (Power & Mechanical)'],
  ['maint_vehicle_equipment', 'Vehicle Equipment'], ['maint_vehicle_tech_support', 'Technical Support (Vehicle)'],
  ['maint_safety_dept', 'Safety Dept.'], ['maint_operating_bulletin', 'Operating Bulletin #'],
  ['maint_physical_barrier', 'Physical Barrier Req. (attach)'], ['maint_safety_monitor', 'Safety Monitor'],
];
const TRANS_LINES = [
  ['trans_yard_line_support', 'Yard / Line Support'], ['trans_train_required', 'Train Required'],
  ['trans_train_operators', 'Train Operator(s)'], ['trans_single_tracking', 'Single Tracking'], ['trans_occ_support', 'OCC Support'],
];

/* What BART usually needs on a request, checked as the Review is typed into. */
const NEEDED = [
  ['Requestor', (f) => f.requestor_name],
  ['the requestor\'s cell phone', (f) => f.requestor_cell_phone],
  ['Person in charge', (f) => f.person_in_charge_name],
  ['the person in charge\'s cell phone', (f) => f.person_in_charge_cell_phone],
  ['Category of Work', (f) => f.category_of_work],
  ['Work Description', (f) => f.work_description],
  ['Work/Activity in Track Zone (Yes or No)', (f) => f.work_in_track_zone_yes || f.work_in_track_zone_no],
  ['a date with its start, end and area', (f) => f.row1_date && f.row1_time_start && f.row1_time_end && f.row1_area],
];

function openReview(record, group, { readOnly = false, blocking = [] } = {}) {
  const predictions = readOnly ? [] : standing(record);
  const editor = formEditor(record, { readOnly, predictions });
  const rejected = readOnly ? [] : rejectedLike(group || record.source || {}, record.shift, record);
  const fitBox = el('div', { class: 'small fit', 'aria-live': 'polite' });
  const needBox = el('div', { class: 'need', 'aria-live': 'polite' });
  const checkNeeded = () => {
    const fields = editor.read();
    const blank = NEEDED.filter(([, has]) => !has(fields)).map(([name]) => name);
    needBox.className = `need ${blank.length ? 'need-some' : 'need-none'}`;
    needBox.textContent = blank.length ? `Still blank: ${blank.join(', ')}. BART usually needs ${blank.length === 1 ? 'it' : 'them'} — it can be submitted without, but may come back.` : 'Everything BART usually needs is filled in.';
  };
  const body = el('div', { class: 'review' }, [
    blocking.length ? el('div', { class: 'notice notice-bad' }, blocking.map((f) => el('div', { text: f.message }))) : null,
    rejected.length ? el('div', { class: 'notice notice-warn', dataset: { learned: 'rejected' } }, rejected.slice(0, 2).map((r) => el('div', { text: rejectedText(r, record) }))) : null,
    predictions.length ? el('div', { class: 'learned-note' }, [
      el('strong', { text: `✦ ${predictions.length} answer${predictions.length === 1 ? '' : 's'} predicted` }),
      ' from similar requests sent before, marked in purple. Hover one to see why; change any that are wrong — what is sent is learned from.',
    ]) : null,
    readOnly ? null : needBox,
    fitBox,
    editor.node,
  ]);
  if (!readOnly) {
    editor.node.addEventListener('input', checkNeeded);
    editor.node.addEventListener('change', checkNeeded);
    checkNeeded();
  }
  let timer = null;
  const checkFit = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let bytes = null;
      try { bytes = await getTemplate(); } catch { /* said on download */ }
      if (!bytes) { fitBox.textContent = 'Upload BART\'s form in Setup to check that everything fits.'; return; }
      try {
        const { report } = fillForm(bytes, editor.read(), { textSize: TEXT_SIZE });
        const over = Object.entries(report.fields).filter(([, r]) => !r.fits).map(([k]) => label(k));
        fitBox.className = `small fit${over.length ? ' warn' : ''}`;
        fitBox.textContent = over.length ? `Too long to fit the form even at the smallest size: ${over.join(', ')}.` : 'Fits the form.';
      } catch { fitBox.textContent = ''; }
    }, 250);
  };
  editor.node.addEventListener('input', checkFit);
  editor.node.addEventListener('change', checkFit);
  checkFit();

  const wf = S.store.workflow;
  const save = async (h, then = null) => {
    try {
      await S.updateTawr(record.id, { fields: editor.read() });
      if (then) await S.act(record.id, then);
      toast(then ? `#${record.id}: saved and ${wf.actions[then].label.toLowerCase()} — done.` : 'Saved.', 'good');
      h.close();
    } catch (err) { toast(err.message, 'bad'); }
    refresh();
  };
  const role = S.role();
  const next = T.may(wf, role, 'submit', record.status) ? 'submit' : T.may(wf, role, 'approve', record.status) ? 'approve' : null;
  openModal({
    title: `#${record.id} ${record.location_name} — ${T.tawrShiftLabel(record.shift)} shift`,
    subtitle: readOnly ? `${statusName(record.status)}. ${record.status === 'approved' ? 'Revise it to change anything.' : ''}`
      : 'Every field as it will be printed. Fields changed by hand are marked; the rest follow the look-ahead and the track plan.',
    size: 'xl',
    body,
    actions: readOnly
      ? [{ label: 'Close' }, S.writer() ? { label: 'Download PDF', kind: 'primary', onClick: () => downloadOne(record, { draft: record.status !== 'approved' }) } : null].filter(Boolean)
      : [
        { label: 'Cancel' },
        { label: 'Save', id: 'review-save', keepOpen: true, onClick: (h) => save(h) },
        next ? { label: `Save and ${wf.actions[next].label.toLowerCase()}`, kind: 'primary', id: `review-${next}`, keepOpen: true, onClick: (h) => save(h, next) } : null,
      ].filter(Boolean),
  });
}

function formEditor(record, { readOnly = false, predictions = [] } = {}) {
  const fields = record.fields || {};
  const generated = record.generated || {};
  const predictedBy = new Map();
  for (const p of predictions) for (const f of Learn.fieldsOf(p.key, fields)) predictedBy.set(f, p);
  const getters = new Map();
  const sameValue = (a, b) => { const blank = (v) => v == null || v === '' || v === false; return (blank(a) && blank(b)) || a === b; };
  const display = (v) => (v === true ? 'ticked' : v == null || v === '' || v === false ? 'blank' : String(v));
  const mark = (wrap, names) => {
    const p = names.map((n) => predictedBy.get(n)).find(Boolean);
    if (names.some((n) => !sameValue(fields[n], generated[n]))) {
      wrap.classList.add('edited');
      wrap.title = `Changed by hand. The look-ahead says: ${names.map((n) => display(generated[n])).join(' / ')}`;
    } else if (p) {
      wrap.classList.add('predicted');
      wrap.title = `Predicted: ${predictedLine(p)}, ${Math.round(p.confidence * 100)}% of their weight agreeing. Change it if it is wrong.`;
    }
    return wrap;
  };
  const text = (name, { multiline = false, placeholder = '', width = null } = {}) => {
    const input = multiline ? el('textarea', { rows: '4', placeholder }) : el('input', { type: 'text', placeholder });
    input.value = fields[name] ?? '';
    input.dataset.field = name;
    input.setAttribute('aria-label', label(name));
    if (width) input.style.width = width;
    if (readOnly) input.readOnly = true;
    getters.set(name, () => input.value.trim());
    return mark(el('span', { class: 'ctl' }, [input]), [name]);
  };
  const check = (name, caption = '') => {
    const input = el('input', { type: 'checkbox', 'aria-label': label(name) });
    input.checked = fields[name] === true;
    input.dataset.field = name;
    if (readOnly) input.disabled = true;
    getters.set(name, () => input.checked);
    return mark(el('label', { class: 'ctl check' }, [input, caption ? el('span', { text: caption }) : null]), [name]);
  };
  const select = (value, options) => {
    const s = el('select', {}, options.map((o) => (typeof o === 'string' ? el('option', { value: o, text: o || '—' }) : el('option', { value: o.value, text: o.label }))));
    s.value = value;
    if (readOnly) s.disabled = true;
    return s;
  };
  const choice = (name, options) => {
    const s = select(fields[name] ?? '', options);
    s.dataset.field = name;
    s.setAttribute('aria-label', label(name));
    getters.set(name, () => s.value);
    return mark(el('span', { class: 'ctl' }, [s]), [name]);
  };
  const yesNo = (base, caption) => {
    const yes = `${base}_yes`; const no = `${base}_no`;
    const s = select(fields[yes] ? 'Yes' : fields[no] ? 'No' : '', [{ value: '', label: '—' }, 'Yes', 'No']);
    s.setAttribute('aria-label', caption);
    getters.set(yes, () => s.value === 'Yes');
    getters.set(no, () => s.value === 'No');
    return el('div', { class: 'q' }, [el('span', { text: caption }), mark(el('span', { class: 'ctl' }, [s]), [yes, no])]);
  };
  const power = (n) => {
    const names = ['on', 'off', 'na'].map((p) => `row${n}_power_${p}`);
    const s = select(fields[names[0]] ? 'ON' : fields[names[1]] ? 'OFF' : fields[names[2]] ? 'N/A' : '', [{ value: '', label: '—' }, 'ON', 'OFF', 'N/A']);
    s.setAttribute('aria-label', `Row ${n} power status`);
    getters.set(names[0], () => s.value === 'ON');
    getters.set(names[1], () => s.value === 'OFF');
    getters.set(names[2], () => s.value === 'N/A');
    return mark(el('span', { class: 'ctl' }, [s]), names);
  };
  const section = (title, children) => el('fieldset', {}, [el('legend', { text: title }), ...children]);
  const pair = (caption, control) => el('label', { class: 'pair' }, [el('span', { text: caption }), control]);
  const rows = [];
  for (let n = 1; n <= T.FORM_ROWS; n++) {
    rows.push(el('tr', {}, [
      el('td', {}, [text(`row${n}_date`, { placeholder: 'MM/DD/YYYY', width: '96px' })]),
      el('td', {}, [choice(`row${n}_day`, DAY_OPTIONS)]),
      el('td', {}, [text(`row${n}_time_start`, { placeholder: '0700', width: '60px' })]),
      el('td', {}, [text(`row${n}_time_end`, { placeholder: '1500', width: '60px' })]),
      el('td', {}, [text(`row${n}_area`)]),
      el('td', {}, [power(n)]),
      el('td', {}, [text(`row${n}_safe_clear_rail_sections`, { width: '110px' })]),
    ]));
  }
  const supportLine = ([base, caption]) => el('div', { class: 'line' }, [
    check(`${base}_req`, caption),
    T.FIELD_KIND.has(`${base}_details`) ? text(`${base}_details`) : el('span'),
  ]);
  const node = el('div', { class: 'form' }, [
    section('Work and clearances', [
      el('div', { class: 'qs' }, [
        yesNo('work_in_track_zone', 'Work/Activity in Track Zone'),
        yesNo('clearance_verification', 'Clearance Verification'),
        yesNo('track_inspection_first_train', 'Track Inspection (with 1st Train)'),
      ]),
      el('div', { class: 'checks' }, [
        check('police_advisory_threat_of_theft', 'Police Advisory (Threat of Theft)'),
        check('advisory_no_work_clearance', 'Advisory (No Work Clearance)'),
        check('no_passage_hirail_vehicles', 'No Passage of Hi-Rail Vehicles'),
        check('coordinate_hirail_passage', 'Coordinate Hi-Rail Passage'),
      ]),
      el('div', { class: 'grid2' }, [pair('Category of Work', choice('category_of_work', CATEGORY_OPTIONS)), pair('Schedule Number', text('schedule_number'))]),
      pair('Work Description', text('work_description', { multiline: true })),
    ]),
    section('Contacts', [el('div', { class: 'grid2' }, [
      pair('Requestor', text('requestor_name')), pair('Cell phone', text('requestor_cell_phone')),
      pair('Person in charge', text('person_in_charge_name')), pair('Cell phone', text('person_in_charge_cell_phone')),
      pair('Project representative', text('project_rep_name')), pair('Cell phone', text('project_rep_cell_phone')),
    ])]),
    section('Dates, times and area (from the track plan)', [el('div', { class: 'scroll-x' }, [el('table', { class: 'grid-table' }, [
      el('thead', {}, [el('tr', {}, ['Date', 'Day', 'Start', 'End', 'Area (tracks, mileposts, gates, stations)', 'Power', 'Safe clear'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows),
    ])])]),
    section('Maintenance support', MAINT_LINES.map(supportLine)),
    section('Transportation support', [
      ...TRANS_LINES.map(supportLine),
      el('div', { class: 'line' }, [check('trans_passenger_bulletin_req', 'Passenger Bulletin'), pair('Public notice', text('trans_public_notice', { width: '80px' }))]),
      el('div', { class: 'line' }, [check('trans_sswp_iop_required_req', 'SSWP/IOP Required (attach)'), el('span')]),
      el('div', { class: 'line' }, [check('trans_adverse_impact_blanket_req', 'Adverse Impact to Blanket'), text('trans_adverse_impact_blanket_details', { placeholder: 'SSWP numbers print on this line' })]),
    ]),
    el('p', { class: 'small', text: 'The approval clearance signatures are left blank for BART. The requester\'s signature is drawn on the requestor line at download.' }),
  ]);
  return {
    node,
    read() {
      const out = {};
      for (const [name, get] of getters) {
        const v = get();
        if (v === true || (typeof v === 'string' && v)) out[name] = v;
      }
      return out;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Setup
   ═══════════════════════════════════════════════════════════════════════ */

function renderSetup(host) {
  const app = V.app;
  if (!S.writer()) {
    host.append(el('p', { class: 'empty', text: 'Setup is the requester\'s and the Track Allocation Manager\'s.' }));
    return;
  }
  const s = app.settings || {};
  host.append(el('h2', { text: 'Setup' }), el('p', { class: 'small', text: 'What every request is filled from besides the look-ahead and the track plan.' }));
  const list = el('div', { class: 'settings' });
  host.append(list);
  const group = (title) => list.append(el('h3', { class: 'settings-group', text: title }));
  const row = (caption, hint, control) => list.append(el('div', { class: 'settings-row' }, [
    el('div', {}, [el('div', { class: 'settings-name', text: caption }), hint ? el('div', { class: 'small', text: hint }) : null]),
    el('div', { class: 'settings-control' }, [control]),
  ]));
  /* `fallback` is what applies when nothing is saved; `prefill` is only a
     suggestion in the box, still to be saved. */
  const setting = (caption, key, { options = null, fallback = '', prefill = '', placeholder = '', check = null, hint = '' } = {}) => {
    let current = s[key] ?? fallback;
    const input = options ? el('select', {}, options.map((o) => el('option', { value: o, text: o }))) : el('input', { type: 'text', placeholder });
    input.value = s[key] ?? (prefill || fallback);
    input.setAttribute('aria-label', caption);
    input.dataset.setting = key;
    const btn = el('button', { type: 'button', class: 'mini', text: 'Save' });
    const sync = () => { btn.disabled = input.value.trim() === String(current ?? '').trim(); };
    sync();
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    btn.addEventListener('click', async () => {
      const v = input.value.trim();
      const problem = check?.(v);
      if (problem) { toast(problem, 'warn'); return; }
      try {
        app.settings = await S.setSettings({ [key]: v });
        current = v;
        sync();
        await app.raise(); // the drafts carry the setup too
        toast(`${caption} saved.`, 'good');
      } catch (err) { toast(err.message, 'bad'); }
    });
    row(caption, hint, el('div', { class: 'inline' }, [input, btn]));
  };

  group('BART\'s form');
  const info = (() => { try { return JSON.parse(s.template_info || 'null'); } catch { return null; } })();
  const file = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, dataset: { action: 'tawr-template-file' } });
  file.addEventListener('change', () => uploadTemplate(file.files?.[0]));
  row('The blank fillable form', info
    ? `${info.name || 'tawr.pdf'} · ${info.fields} fields · uploaded ${stampLabel(info.uploaded_at)}${info.uploaded_by ? ` by ${info.uploaded_by}` : ''}. ${S.store.mode === 'local' ? 'Kept in this browser only.' : 'Kept beside the database, never published with the site.'}`
    : `Not uploaded yet. ${S.store.mode === 'local' ? 'Kept in this browser only' : 'Kept beside the database'}, never published with the site.`,
  el('div', { class: 'inline' }, [
    el('span', { class: `badge tone-${info ? 'ok' : 'warn'}`, text: info ? 'Uploaded' : 'Missing' }),
    el('button', { type: 'button', class: 'mini', dataset: { action: 'tawr-template' }, text: info ? 'Replace…' : 'Upload…', onClick: () => file.click() }),
    file,
  ]));

  group('The requester, on every form');
  setting('Requester\'s name on the form', 'requestor_name', { prefill: S.store.user?.role === 'requester' ? S.store.user.name : '', hint: 'The one person who raises the requests.' });
  setting('Requester\'s cell phone', 'requestor_cell_phone');
  row('Requester\'s signature', 'Drawn once, here, and signed onto the requestor line of every request when it is downloaded. Drawn as lines, so it prints sharp.', signaturePad(s.requestor_signature));

  group('The same on every request');
  setting('Person in charge', 'person_in_charge_name');
  setting('Person in charge — cell phone', 'person_in_charge_cell_phone');
  setting('Project representative', 'project_rep_name');
  setting('Project representative — cell phone', 'project_rep_cell_phone');
  setting('Category of Work — TCR requests', 'category_tcr', { options: CATEGORY_OPTIONS.filter(Boolean), fallback: s.category_default || 'F', hint: 'A request for a train control room. Never shares a request with track.' });
  setting('Category of Work — track requests', 'category_track', { options: CATEGORY_OPTIONS.filter(Boolean), fallback: s.category_default || 'F', hint: 'A request for track limits. These are marked as work in the track zone.' });
  setting('Category of Work — anything else', 'category_default', { options: CATEGORY_OPTIONS.filter(Boolean), fallback: 'F', hint: 'A station, yard or platform with no track picked.' });

  group('When drafts are raised');
  setting('Days before the deadline', 'auto_lead_days', {
    fallback: '7', check: (v) => (/^\d{1,2}$/.test(v) ? null : 'A number of days, 0 to 99.'),
    hint: `A week's drafts are raised by themselves this many days before they are due (${T.TAWR_LEAD_DAYS} days before the Monday), with the Area from the track plan.`,
  });

  group('Shift hours, where the look-ahead gives none');
  for (const [id, caption] of [['day', 'Day shift'], ['swing', 'Swing shift'], ['night', 'Night shift'], ['possession', 'Blanket']]) {
    setting(caption, `hours_${id}`, { fallback: T.DEFAULT_SHIFT_HOURS[id], placeholder: T.DEFAULT_SHIFT_HOURS[id], check: (v) => (!v || T.parseHours(v) ? null : 'Write the hours as 0700-1500.') });
  }
  row('Form filler', 'The version of the code that fills the form, stamped inside every PDF it writes.', el('code', { text: `TAWR filler ${FILLER_VERSION}` }));

  host.append(phasesSection(), learningSection(), codesSection(), legendSection(), descriptionsSection());
  if (S.store.mode === 'local') host.append(backupSection());
  if (V.setupAt) {
    const at = host.querySelector(`#setup-${V.setupAt}`);
    if (at) requestAnimationFrame(() => at.scrollIntoView({ block: 'start' }));
    V.setupAt = null;
  }
}

/* ── Phases ───────────────────────────────────────────────────────────── */

function phasesSection() {
  const app = V.app;
  const phases = parsePhases(app.settings?.phases);
  const wrap = el('section', { class: 'settings-block', id: 'setup-phases' }, [
    el('h3', { class: 'settings-group', text: 'Phases of the work' }),
    el('p', { class: 'small', text: 'A phase is a box drawn on the track plan — "Phase 2" around the W and Y lines, say. On the track plan, choose it to fit the view to it, set the rest of the sheet back, and list its requests on their own.' }),
  ]);
  const save = async (list, said) => {
    try {
      app.settings = await S.setSettings({ phases: phasesText(list) });
      app.pushOverlay();
      toast(said, 'good');
    } catch (err) { toast(err.message, 'bad'); }
    rerender();
  };
  /* The list as it is now, not as it was drawn: a box may have been drawn meanwhile. */
  const current = () => parsePhases(app.settings?.phases);
  const draw = async (ph = null, fresh = null) => {
    const bbox = await app.drawPhase({ name: ph?.name || fresh.name, bbox: ph?.bbox || null });
    if (!bbox) { rerender(); return; }
    const list = current();
    if (ph) {
      const i = list.findIndex((p) => p.id === ph.id);
      if (i >= 0) list[i] = { ...list[i], bbox };
      await save(list, `${ph.name}: box redrawn.`);
    } else {
      list.push({ id: newPhaseId(), name: fresh.name, note: fresh.note, bbox });
      await save(list, `${fresh.name} added. Choose it on the track plan to look at it.`);
    }
  };
  const rename = async (ph, changes) => {
    const list = current();
    const i = list.findIndex((p) => p.id === ph.id);
    if (i < 0) return;
    list[i] = { ...list[i], ...changes };
    if (!list[i].name) { toast('A phase needs a name.', 'warn'); rerender(); return; }
    await save(list, `${list[i].name} saved.`);
  };

  if (phases.length) {
    wrap.append(el('table', { class: 'grid-table phase-table' }, [
      el('thead', {}, [el('tr', {}, ['Phase', 'Note', 'Covers', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, phases.map((ph) => {
        const name = el('input', { value: ph.name, 'aria-label': `Name of ${ph.name}`, dataset: { phaseName: ph.id } });
        const note = el('input', { value: ph.note, placeholder: 'What it is', 'aria-label': `Note on ${ph.name}` });
        name.addEventListener('change', () => rename(ph, { name: name.value.trim() }));
        note.addEventListener('change', () => rename(ph, { note: note.value.trim() }));
        return el('tr', { dataset: { phase: ph.id } }, [
          el('td', {}, [name]), el('td', {}, [note]),
          el('td', { class: 'small', text: coversText(app.data.routes, ph.bbox) }),
          el('td', { class: 'inline' }, [
            el('button', { type: 'button', class: 'mini', dataset: { action: 'phase-view' }, text: 'View', onClick: () => app.viewPhase(ph.id) }),
            el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'phase-redraw' }, text: 'Redraw box', onClick: () => draw(ph) }),
            el('button', {
              type: 'button', class: 'secondary mini danger', dataset: { action: 'phase-delete' }, text: 'Delete',
              onClick: async () => {
                if (!(await confirmDialog({ title: `Delete ${ph.name}?`, message: 'Only the box goes; nothing on the look-ahead or in any request changes.', confirmLabel: 'Delete', danger: true }))) return;
                await save(current().filter((p) => p.id !== ph.id), `${ph.name} deleted.`);
              },
            }),
          ]),
        ]);
      })),
    ]));
  }
  const name = el('input', { placeholder: `Phase ${phases.length + 1}`, 'aria-label': 'Name of the new phase', dataset: { action: 'phase-new-name' } });
  const note = el('input', { placeholder: 'W and Y lines', 'aria-label': 'Note on the new phase' });
  wrap.append(el('div', { class: 'inline phase-add' }, [
    name, note,
    el('button', {
      type: 'button', class: 'mini', dataset: { action: 'phase-draw' }, text: 'Draw its box on the track plan',
      onClick: () => {
        const n = name.value.trim() || name.placeholder;
        if (current().some((p) => p.name.toLowerCase() === n.toLowerCase())) { toast(`There is a phase called ${n} already.`, 'warn'); return; }
        draw(null, { name: n, note: note.value.trim() });
      },
    }),
  ]));
  return wrap;
}

/* ── The learning memory ──────────────────────────────────────────────── */

/** How sure the votes must be before an answer is predicted (learn_threshold). */
const THRESHOLDS = [
  ['0.75', 'Cautious — nearly every similar request agrees'],
  ['0.6', 'Balanced — most of them, by a clear margin'],
  ['0.5', 'Eager — more of them than not'],
];
const MEMORY_KIND = { form: 'Request', outcome: 'Predictions', reject: 'Rejection', link: 'Location' };

/** One entry of the memory, said in a sentence. */
function memoryLine(e) {
  const t = V.app.tawrs.find((r) => r.id === e.tawr_id);
  const acts = e.data?.source?.activities || [];
  const what = t?.location_name || acts[0]?.title || 'a request';
  const shift = e.data?.shift || t?.shift;
  const req = `${e.tawr_id != null ? `#${e.tawr_id} ` : ''}${what}${shift ? ` (${T.tawrShiftLabel(shift)})` : ''}`;
  const said = (key, v) => (v == null ? 'blank' : Learn.answerText(key, v));
  if (e.kind === 'form') {
    const n = Object.values(e.data.answers || {}).filter((v) => v !== false).length;
    return `${req} ${e.data.action === 'approve' ? 'approved' : 'submitted'} — ${n} answer${n === 1 ? '' : 's'} learned from it`;
  }
  if (e.kind === 'outcome') {
    const kept = e.data.kept?.length || 0;
    const changed = (e.data.changed || []).map((c) => `${Learn.unitLabel(c.unit)}: ${said(c.unit, c.predicted)} → ${said(c.unit, c.final)}`);
    return `${req}: ${kept} prediction${kept === 1 ? '' : 's'} kept${changed.length ? `, ${changed.length} changed before it was sent (${changed.join('; ')})` : ''}`;
  }
  if (e.kind === 'reject') return `${req} rejected: “${e.data.reason}”`;
  if (e.kind === 'link') return `“${e.data.title || e.data.activityId || 'An activity'}”${e.data.activityId && e.data.title ? ` (${e.data.activityId})` : ''} linked to ${linkLabel(e.data.link) || 'a location'}`;
  return e.kind;
}

function learningSection() {
  const app = V.app;
  const s = app.settings || {};
  const memory = app.memory || [];
  const index = app.learning || Learn.buildIndex([]);
  const acc = Learn.accuracy(index);
  const on = s.learn_predict !== 'off';
  const wrap = el('section', { class: 'settings-block', id: 'setup-learning' }, [
    el('h3', { class: 'settings-group', text: 'Learning memory' }),
    el('p', { class: 'small', text: 'Every request submitted, approved or rejected is remembered, and every location linked on the look-ahead. A new draft is filled in from the most similar requests sent before — only where they agree — and each answer it predicts is marked, with the requests it came from. What is changed before a request is sent is learned from too, and counted below.' }),
  ]);

  const stat = (value, caption, sub) => el('div', { class: 'learn-stat' }, [
    el('div', { class: 'learn-num', text: String(value) }),
    el('div', { class: 'learn-cap', text: caption }),
    sub ? el('div', { class: 'small', text: sub }) : null,
  ]);
  const approved = index.examples.filter((x) => x.approved).length;
  wrap.append(el('div', { class: 'learn-stats', dataset: { learn: 'stats' } }, [
    stat(index.examples.length, `request${index.examples.length === 1 ? '' : 's'} learned from`, `${approved} approved`),
    stat(index.links.length, `location${index.links.length === 1 ? '' : 's'} remembered`, 'from the look-ahead'),
    stat(index.rejects.length, `rejection${index.rejects.length === 1 ? '' : 's'} remembered`, 'warned of on drafts like them'),
    stat(acc.rate == null ? '—' : `${Math.round(acc.rate * 100)}%`, 'of predictions kept', acc.total ? `${acc.kept} of ${acc.total}, as sent` : 'none sent yet'),
  ]));

  const choose = (caption, key, options, fallback, hint) => {
    const sel = el('select', { 'aria-label': caption, dataset: { setting: key } }, options.map(([value, text]) => el('option', { value, text })));
    sel.value = s[key] ?? fallback;
    sel.addEventListener('change', async () => {
      try {
        app.settings = await S.setSettings({ [key]: sel.value });
        await app.raise(); // the drafts follow at once
        toast(`${caption}: ${sel.selectedOptions[0].text.split(' — ')[0]}.`, 'good');
      } catch (err) { toast(err.message, 'bad'); sel.value = s[key] ?? fallback; }
      rerender();
    });
    return el('div', { class: 'settings-row' }, [
      el('div', {}, [el('div', { class: 'settings-name', text: caption }), el('div', { class: 'small', text: hint })]),
      el('div', { class: 'settings-control' }, [sel]),
    ]);
  };
  wrap.append(el('div', { class: 'settings' }, [
    choose('Predict answers on new drafts', 'learn_predict', [['on', 'On'], ['off', 'Off']], 'on',
      'Off, a draft carries only the look-ahead and this setup; the memory still learns from what is sent.'),
    on ? choose('How sure before predicting', 'learn_threshold', THRESHOLDS, String(Learn.DEFAULT_THRESHOLD),
      'How strongly the similar requests must agree. A box is never unticked by a prediction, and nothing the look-ahead decides is touched.') : null,
  ]));

  if (acc.units.length) {
    wrap.append(el('h4', { class: 'learn-head', text: 'How each prediction has done' }), el('table', { class: 'grid-table learn-table', dataset: { learn: 'accuracy' } }, [
      el('thead', {}, [el('tr', {}, ['Answer', 'Kept', 'Changed', 'Last changed to'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, acc.units.map((u) => el('tr', {}, [
        el('td', { text: Learn.unitLabel(u.key) }),
        el('td', { text: String(u.kept) }),
        el('td', { class: u.changed ? 'warn' : '', text: String(u.changed) }),
        el('td', { class: 'small', text: u.changed ? (u.last == null ? 'blank' : Learn.answerText(u.key, u.last)) : '—' }),
      ]))),
    ]));
  }

  const forget = async (e) => {
    try {
      await S.forgetMemory(e.id);
      app.relearn(memory.filter((m) => m.id !== e.id));
      toast('Forgotten: nothing is predicted or suggested from it again.', 'good');
      app.raise();
    } catch (err) { toast(err.message, 'bad'); }
    rerender();
  };
  const latest = [...memory].reverse().slice(0, 40);
  wrap.append(el('h4', { class: 'learn-head', text: `What it remembers — ${memory.length} entr${memory.length === 1 ? 'y' : 'ies'}${memory.length > latest.length ? `, the latest ${latest.length} here` : ''}` }));
  wrap.append(latest.length
    ? el('ul', { class: 'memory-log' }, latest.map((e) => el('li', { dataset: { memory: String(e.id), kind: e.kind } }, [
      el('span', { class: `mem-kind mem-${e.kind}`, text: MEMORY_KIND[e.kind] || e.kind }),
      el('span', { class: 'mem-text', text: memoryLine(e) }),
      el('span', { class: 'small mem-when', text: `${stampLabel(e.at)}${e.by ? ` · ${e.by}` : ''}` }),
      el('button', { type: 'button', class: 'secondary mini', dataset: { action: 'memory-forget' }, title: 'Forget this entry: nothing is predicted or suggested from it again', text: 'Forget', onClick: () => forget(e) }),
    ])))
    : el('p', { class: 'empty', text: 'Nothing remembered yet. Submit a request, or link a location on the look-ahead, and it is remembered here.' }));

  const mayClear = S.store.mode === 'local' || S.role() === 'manager';
  wrap.append(el('div', { class: 'inline learn-actions' }, [
    el('button', {
      type: 'button', class: 'secondary mini', dataset: { action: 'memory-export' }, text: 'Export the memory (JSON)', disabled: !memory.length,
      onClick: () => saveFile(`tawr-memory-${app.today}.json`, JSON.stringify({ exported_at: new Date().toISOString(), entries: memory }, null, 1), 'application/json'),
    }),
    el('button', {
      type: 'button', class: 'secondary mini danger', dataset: { action: 'memory-clear' }, text: 'Clear the memory…', disabled: !memory.length || !mayClear,
      title: mayClear ? null : 'Only the Track Allocation Manager clears the memory.',
      onClick: async () => {
        if (!(await confirmDialog({
          title: 'Clear the learning memory?', confirmLabel: 'Clear', danger: true,
          message: `All ${memory.length} entries are forgotten: nothing is predicted or suggested until requests are sent again. The requests themselves do not change.`,
        }))) return;
        try {
          const r = await S.clearMemory();
          app.relearn([]);
          toast(`${r.forgotten} entr${r.forgotten === 1 ? 'y' : 'ies'} forgotten.`, 'good');
          app.raise();
        } catch (err) { toast(err.message, 'bad'); }
        rerender();
      },
    }),
  ]));
  return wrap;
}

async function uploadTemplate(file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const form = readForm(bytes);
    if (!form.fields.length) throw new Error('That PDF has no fillable fields. Upload the fillable version of the form.');
    const missing = missingFields(form, T.TAWR_FIELDS.map((f) => f[0]));
    if (missing.length) throw new Error(`That form is missing ${missing.length} field${missing.length === 1 ? '' : 's'} the requests fill: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}. Was it revised? Nothing was uploaded.`);
    await S.putTemplate(bytes);
    V.app.settings = await S.setSettings({ template_info: JSON.stringify({ name: file.name, size: bytes.length, fields: form.fields.length, uploaded_at: new Date().toISOString(), uploaded_by: S.store.user?.name || null }) });
    template = bytes;
    toast(`BART's form uploaded — all ${T.TAWR_FIELDS.length} fields found.`, 'good');
    rerender();
  } catch (err) { toast(err.message, 'bad'); }
}

const PAD_W = 360;
const PAD_H = 120;

function signaturePad(savedText) {
  let saved = null;
  try { saved = JSON.parse(savedText || 'null'); } catch { saved = null; }
  const canvas = el('canvas', { class: 'pad', width: String(PAD_W), height: String(PAD_H), 'aria-label': 'Signature pad — draw the signature with the mouse, a pen or a finger', role: 'img' });
  let strokes = (saved?.strokes || []).map((st) => st.map((p) => [...p]));
  if (saved?.width && saved.width !== PAD_W) {
    const k = Math.min(PAD_W / saved.width, PAD_H / (saved.height || PAD_H));
    strokes = strokes.map((st) => st.map(([x, y]) => [x * k, y * k]));
  }
  let live = null;
  const g = canvas.getContext('2d');
  const draw = () => {
    g.clearRect(0, 0, PAD_W, PAD_H);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const st of strokes) {
      if (!st.length) continue;
      g.beginPath();
      g.moveTo(st[0][0], st[0][1]);
      for (const [x, y] of st.slice(1)) g.lineTo(x, y);
      if (st.length === 1) g.lineTo(st[0][0] + 0.1, st[0][1]);
      g.stroke();
    }
  };
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * PAD_W * 10) / 10, Math.round(((e.clientY - r.top) / r.height) * PAD_H * 10) / 10];
  };
  const saveBtn = el('button', { type: 'button', class: 'mini', text: 'Save signature', disabled: true });
  const clearBtn = el('button', { type: 'button', class: 'secondary mini', text: 'Clear' });
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture?.(e.pointerId); live = [at(e)]; strokes.push(live); draw(); saveBtn.disabled = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!live) return;
    const p = at(e); const last = live[live.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
    live.push(p); draw();
  });
  canvas.addEventListener('pointerup', () => { live = null; });
  canvas.addEventListener('pointercancel', () => { live = null; });
  clearBtn.addEventListener('click', () => { strokes = []; draw(); saveBtn.disabled = false; });
  saveBtn.addEventListener('click', async () => {
    const sig = strokes.length ? JSON.stringify({ width: PAD_W, height: PAD_H, strokes: strokes.filter((st) => st.length) }) : '';
    try {
      V.app.settings = await S.setSettings({ requestor_signature: sig });
      saveBtn.disabled = true;
      toast(sig ? 'Signature saved.' : 'Signature removed.', 'good');
    } catch (err) { toast(err.message, 'bad'); }
  });
  requestAnimationFrame(draw);
  return el('div', { class: 'signature' }, [canvas, el('div', { class: 'inline' }, [clearBtn, saveBtn])]);
}

function codesSection() {
  const app = V.app;
  const wrap = el('section', { class: 'settings-block' }, [
    el('h3', { class: 'settings-group', text: 'Support codes' }),
    el('p', { class: 'small', text: 'What each code typed in a day asks BART for, and which line of the form it goes on. A witness is not on the form; ROC is OCC Support.' }),
  ]);
  const rows = app.la.codes.map((c) => ({ ...c }));
  const tbody = el('tbody');
  const draw = () => {
    clear(tbody);
    rows.forEach((c, i) => {
      const code = el('input', { value: c.code, 'aria-label': 'Code', style: 'width:70px', onInput: (e) => { c.code = e.target.value.toUpperCase(); } });
      const name = el('input', { value: c.name || '', 'aria-label': 'What it is', onInput: (e) => { c.name = e.target.value; } });
      const party = el('input', { value: c.party || 'BART', 'aria-label': 'Party', style: 'width:80px', onInput: (e) => { c.party = e.target.value; } });
      const line = el('select', { 'aria-label': 'Line on the form', onChange: (e) => { c.tawr_line = e.target.value; } }, T.TAWR_LINES.map((l) => el('option', { value: l.value, text: l.label })));
      line.value = c.tawr_line || 'systems';
      const active = el('input', { type: 'checkbox', 'aria-label': 'In use', onChange: (e) => { c.active = e.target.checked; } });
      active.checked = c.active !== false;
      tbody.append(el('tr', {}, [el('td', {}, [code]), el('td', {}, [name]), el('td', {}, [party]), el('td', {}, [line]), el('td', {}, [active]),
        el('td', {}, [el('button', { type: 'button', class: 'secondary mini', text: 'Remove', onClick: () => { rows.splice(i, 1); draw(); } })])]));
    });
  };
  draw();
  wrap.append(el('table', { class: 'grid-table' }, [el('thead', {}, [el('tr', {}, ['Code', 'What it is', 'Party', 'Line on the form', 'In use', ''].map((h) => el('th', { text: h })))]), tbody]),
    el('div', { class: 'inline' }, [
      el('button', { type: 'button', class: 'secondary mini', text: '+ Code', onClick: () => { rows.push({ code: '', name: '', party: 'BART', tawr_line: 'systems', active: true }); draw(); } }),
      el('button', {
        type: 'button', class: 'mini', text: 'Save codes',
        onClick: async () => {
          try { app.la.codes = await S.setCodes(rows.filter((r) => r.code)); toast('Support codes saved.', 'good'); app.lookaheadChanged(); } catch (err) { toast(err.message, 'bad'); }
        },
      }),
    ]));
  return wrap;
}

function legendSection() {
  const app = V.app;
  const wrap = el('section', { class: 'settings-block' }, [
    el('h3', { class: 'settings-group', text: 'Legend' }),
    el('p', { class: 'small', text: 'The colours days are painted in, and which shift each one is: a meaning with "night" is the night shift, "swing" swing, "blanket" the Blanket shift, "cancel" a cancelled day; anything else is the day shift. A colour not here is never guessed — its requests are flagged.' }),
  ]);
  const rows = app.la.legend.map((e) => ({ ...e }));
  const tbody = el('tbody');
  const draw = () => {
    clear(tbody);
    rows.forEach((e, i) => {
      const color = el('input', { type: 'color', value: `#${e.argb}`, 'aria-label': 'Colour', onInput: (ev) => { e.argb = ev.target.value.slice(1).toUpperCase(); } });
      const meaning = el('input', { value: e.meaning, 'aria-label': 'Meaning', onInput: (ev) => { e.meaning = ev.target.value; } });
      const role = el('select', { 'aria-label': 'Role', onChange: (ev) => { e.role = ev.target.value; } }, [el('option', { value: 'shift', text: 'Work (a shift)' }), el('option', { value: 'ignore', text: 'Shading, not work' })]);
      role.value = e.role || 'shift';
      tbody.append(el('tr', {}, [el('td', {}, [color]), el('td', {}, [meaning]), el('td', {}, [role]), el('td', { class: 'small', text: T.tawrShiftLabel(LA.shiftOfMeaning(e.meaning) || 'unmapped') }),
        el('td', {}, [el('button', { type: 'button', class: 'secondary mini', text: 'Remove', onClick: () => { rows.splice(i, 1); draw(); } })])]));
    });
  };
  draw();
  wrap.append(el('table', { class: 'grid-table' }, [el('thead', {}, [el('tr', {}, ['Colour', 'Meaning', 'Role', 'Shift', ''].map((h) => el('th', { text: h })))]), tbody]),
    el('div', { class: 'inline' }, [
      el('button', { type: 'button', class: 'secondary mini', text: '+ Colour', onClick: () => { rows.push({ argb: '00B050', meaning: '', role: 'shift' }); draw(); } }),
      el('button', {
        type: 'button', class: 'mini', text: 'Save legend',
        onClick: async () => {
          try { app.la.legend = await S.setLegend(rows.filter((r) => r.meaning.trim())); toast('Legend saved.', 'good'); app.lookaheadChanged(); } catch (err) { toast(err.message, 'bad'); }
        },
      }),
    ]));
  return wrap;
}

function descriptionsSection() {
  const app = V.app;
  const wrap = el('section', { class: 'settings-block' }, [
    el('h3', { class: 'settings-group', text: 'Expanded wording for activities' }),
    el('p', { class: 'small', text: 'What the Work Description says about an activity, after its name. Matched on the name as the look-ahead writes it (case and punctuation ignored).' }),
  ]);
  const edit = (d = null, isNew = false) => {
    const activity = el('input', { value: d?.activity || '', placeholder: 'IXL SIM Testing' });
    const wording = el('textarea', { rows: '4', placeholder: 'IXL team will perform functional testing within the train control room.' });
    wording.value = d?.description || '';
    openModal({
      title: d?.id && !isNew ? `Wording for ${d.activity}` : 'Add wording for an activity',
      body: el('div', { class: 'form-grid' }, [el('label', {}, ['Activity, as the look-ahead names it', activity]), el('label', {}, ['What the Work Description adds', wording])]),
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary', keepOpen: true,
        onClick: async (h) => {
          try {
            await S.saveDescription(d?.id && !isNew ? d.id : null, { activity: activity.value, description: wording.value });
            h.close();
            await refresh();
            app.lookaheadChanged();
          } catch (err) { toast(err.message, 'bad'); }
        },
      }],
    });
  };
  wrap.append(el('button', { type: 'button', class: 'mini', text: '+ Add wording', onClick: () => edit() }));
  if (app.descriptions.length) {
    wrap.append(el('table', { class: 'grid-table' }, [
      el('thead', {}, [el('tr', {}, ['Activity', 'Wording', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, app.descriptions.map((d) => el('tr', {}, [
        el('td', { text: d.activity }), el('td', { text: d.description || '—' }),
        el('td', {}, [
          el('button', { type: 'button', class: 'secondary mini', text: 'Edit', onClick: () => edit(d) }),
          el('button', {
            type: 'button', class: 'secondary mini', text: 'Remove',
            onClick: async () => { try { await S.deleteDescription(d.id); await refresh(); app.lookaheadChanged(); } catch (err) { toast(err.message, 'bad'); } },
          }),
        ]),
      ]))),
    ]));
  }
  const fold = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = new Set(app.descriptions.map((d) => fold(d.activity)));
  const titles = new Map();
  for (const r of app.la.model.rows) {
    if (r.kind !== 'activity' || !r.description) continue;
    if (!known.has(fold(r.description))) titles.set(fold(r.description), r.description);
  }
  if (titles.size) {
    wrap.append(el('p', { class: 'small', text: 'On the look-ahead with no wording yet:' }),
      el('div', { class: 'chips' }, [...titles.values()].sort().map((t) => el('button', { type: 'button', class: 'secondary mini', text: `+ ${t}`, onClick: () => edit({ activity: t, description: '' }, true) }))));
  }
  return wrap;
}

function backupSection() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      S.importLocal(await f.text());
      toast('Restored from the backup.', 'good');
      setTimeout(() => location.reload(), 600);
    } catch (err) { toast(err.message, 'bad'); }
  });
  return el('section', { class: 'settings-block' }, [
    el('h3', { class: 'settings-group', text: 'This browser\'s copy' }),
    el('p', { class: 'small', text: 'On the static site the look-ahead, the TAWRs and the learning memory are kept in this browser only. Back them up, or move them to another browser. BART\'s form is not in the backup.' }),
    el('div', { class: 'inline' }, [
      el('button', { type: 'button', class: 'secondary mini', text: 'Back up (JSON)', onClick: () => saveFile(`track-plan-backup-${V.app.today}.json`, S.exportLocal(), 'application/json') }),
      el('button', { type: 'button', class: 'secondary mini', text: 'Restore…', onClick: () => input.click() }),
      input,
    ]),
  ]);
}

