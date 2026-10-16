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
import { linkArea } from './links.js';
import {
  el, clear, toast, openModal, confirmDialog, promptDialog, dayLabel, stampLabel, saveFile, csvField,
} from './ui.js';
import { STATUS_COLOR } from './map.js';

const V = { app: null, root: null, section: 'requests', picked: new Set(), history: false, focus: null };

/** Open with one request in view (from the map). */
export function focus(id) { V.focus = id; }

const live = (r) => !['superseded', 'consolidated'].includes(r.status);
const label = (name) => T.FIELD_LABEL.get(name) || name;
const roleName = (r) => S.store.workflow.roles[r] || r;
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
  const manager = S.isManager();

  host.append(el('div', { class: 'tawr-head' }, [
    el('h2', { text: 'Track access work requests' }),
    el('p', { class: 'small', text: `One request per place and shift for the week, read off the look-ahead, with its Area from the track plan. Each is due ${T.TAWR_LEAD_DAYS} days before its first day. ${manager ? 'You approve, reject and consolidate them.' : S.writer() ? 'You review and submit them; the Track Allocation Manager approves them.' : 'Read only.'}` }),
  ]));

  if (S.writer()) {
    if (!settings.template_info) host.append(notice('warn', 'BART\'s blank form has not been uploaded yet.', 'Requests can be raised, submitted and approved, but not downloaded as the form until it is.', 'Open Setup'));
    else if (!settings.requestor_name || !settings.requestor_signature) host.append(notice('info', 'The requester\'s name, cell phone or signature is not saved yet.', 'Every request goes out with them. Save them in Setup.', 'Open Setup'));
  }

  /* The weeks. */
  const weeks = app.weeks();
  const counts = new Map();
  for (const t of app.tawrs) if (live(t)) counts.set(t.week_start, (counts.get(t.week_start) || 0) + 1);
  const due = T.dueWeek(app.today);
  host.append(el('div', { class: 'week-picker', role: 'group', 'aria-label': 'Week' }, weeks.map((w) => el('button', {
    type: 'button', class: `week-btn${w === week ? ' on' : ''}${w === due ? ' due' : ''}`, dataset: { week: w },
    'aria-pressed': String(w === week), title: `${dayLabel(w)} – ${dayLabel(T.addDaysISO(w, 6))}; due ${dayLabel(T.tawrDeadline(w))}`,
    onClick: () => { app.setWeek(w); V.picked.clear(); rerender(); },
  }, [`${dayLabel(w).slice(4)}`, w === due ? el('span', { class: 'tag', text: 'due now' }) : null, counts.get(w) ? el('span', { class: 'count', text: String(counts.get(w)) }) : null]))));

  /* What the look-ahead says this week, and what has been saved. */
  const groups = extract(app, week);
  const records = app.tawrs.filter((r) => r.week_start === week);
  const items = [];
  for (const g of groups) items.push({ group: g, record: records.find((r) => r.group_key === g.key && live(r)) || null });
  for (const r of records.filter(live)) if (!groups.some((g) => g.key === r.group_key)) items.push({ group: null, record: r });
  const order = { submitted: 0, draft: 1, rejected: 2, none: 3, approved: 4 };
  items.sort((a, b) => (order[a.record?.status || 'none'] - order[b.record?.status || 'none'])
    || (a.group?.locationName || a.record?.location_name || '').localeCompare(b.group?.locationName || b.record?.location_name || ''));

  const deadline = T.deadlineState(week, app.today);
  const approved = items.filter((i) => i.record?.status === 'approved').map((i) => i.record);
  const notRaised = items.filter((i) => !i.record && i.group);
  const drafts = items.filter((i) => i.record?.status === 'draft');
  const picked = items.filter((i) => i.record && V.picked.has(i.record.id)).map((i) => i.record);

  const bar = el('div', { class: 'tawr-toolbar' }, [
    el('div', {}, [
      el('strong', { text: `${dayLabel(week)} – ${dayLabel(T.addDaysISO(week, 6))} ${week.slice(0, 4)}` }),
      el('span', { class: `badge tone-${deadline.tone}`, text: `Due ${dayLabel(deadline.deadline)} · ${deadline.label}` }),
    ]),
    el('div', { class: 'tawr-actions' }, [
      S.writer() && (groups.length || drafts.length) ? el('button', {
        type: 'button', class: 'mini', dataset: { action: 'tawr-sync' },
        text: notRaised.length ? `Raise ${notRaised.length} draft${notRaised.length === 1 ? '' : 's'} from the look-ahead` : 'Update drafts from the look-ahead',
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
  }

  const list = el('div', { class: 'tawr-list' });
  for (const item of items) list.append(card(item, items));
  host.append(list);

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
    if (node) { node.classList.add('flash'); requestAnimationFrame(() => node.scrollIntoView({ block: 'center' })); }
    V.focus = null;
  }
}

function notice(tone, title, detail, action = null) {
  return el('div', { class: `notice notice-${tone}`, role: 'status' }, [
    el('div', {}, [el('strong', { text: title }), ' ', el('span', { text: detail })]),
    action ? el('button', { type: 'button', class: 'secondary mini', text: action, onClick: () => { V.section = 'setup'; rerender(); } }) : null,
  ]);
}

/* ── One request ──────────────────────────────────────────────────────── */

function card({ group, record }, items) {
  const app = V.app;
  const status = record?.status || 'none';
  const src = group ? null : record?.source || {};
  const name = group?.locationName || record?.location_name || '(no location)';
  const shift = group?.shift || record?.shift;
  const firstDay = group?.firstDay || record?.first_day || record?.week_start;
  const due = T.deadlineState(firstDay, app.today);
  const fresh = group ? freshValues(app, group) : null;
  /* Read off the look-ahead now while it can still follow it; as it was sent
     once it has been submitted or decided. */
  const frozen = record && record.status !== 'draft';
  const view = frozen ? { ...(record.source || {}) } : group || src;
  const flags = group ? (frozen ? record.source?.flags || [] : group.flags)
    : [{ kind: 'gone', blocking: true, message: 'No longer on the look-ahead this week. Discard the draft, or check the sheet.' }, ...(record?.source?.flags || [])];
  const blocking = flags.filter((f) => f.blocking);
  const changed = frozen && fresh ? T.changedSince(record.generated, fresh) : [];
  const edited = record ? T.editedKeys(record.fields, record.generated) : [];
  const overlaps = (group?.overlaps || []).map((o) => ({ ...o, item: items.find((i) => i.group?.key === o.key) })).filter((o) => o.item);
  const merged = String(record?.group_key || group?.key || '').startsWith('merge:');

  const node = el('article', {
    class: `tawr-card st-${status}`, style: `--c:${STATUS_COLOR[status] || '#9ca3af'}`,
    dataset: { tawrKey: group?.key || record?.group_key || '', tawrStatus: status, tawrId: record?.id || '' },
    'aria-label': `${name}, ${T.tawrShiftLabel(shift)} shift — ${statusName(status)}`,
  });
  const pick = record && live(record) ? el('input', {
    type: 'checkbox', class: 'pick', 'aria-label': `Pick #${record.id}`,
    onChange: (e) => { if (e.target.checked) V.picked.add(record.id); else V.picked.delete(record.id); rerender(); },
  }) : null;
  if (pick) pick.checked = V.picked.has(record.id);
  node.append(el('header', {}, [
    pick,
    el('h3', { text: `${record ? `#${record.id} ` : ''}${name}` }),
    el('span', { class: 'badge', text: `${T.tawrShiftLabel(shift)} shift` }),
    el('span', { class: 'pill', style: `--c:${STATUS_COLOR[status] || '#9ca3af'}`, text: statusName(status) }),
    merged ? el('span', { class: 'badge', text: `Consolidated from ${(view.members || group?.members || []).length}` }) : null,
    ['approved', 'none'].includes(status) && status !== 'none' ? null : el('span', { class: `badge tone-${due.tone}`, text: due.label }),
  ]));

  const days = view.days || [];
  const activities = view.activities || [];
  const support = view.support || [];
  const sswp = view.sswp || [];
  const area = (frozen ? record.fields?.row1_area : null) || view.area || name;
  node.append(el('dl', { class: 'facts' }, [
    el('dt', { text: 'Area' }), el('dd', { class: 'area', text: area }),
    el('dt', { text: 'Days' }),
    el('dd', { text: days.map((d) => `${dayLabel(d.date)} ${d.start || '?'}–${d.end || '?'}${d.fromShift ? ' (shift hours)' : ''}`).join(' · ') || '—' }),
    el('dt', { text: 'Work' }),
    el('dd', {}, activities.map((a) => el('div', {}, [
      el('b', { text: [a.activityId, a.title].filter(Boolean).join(' · ') }),
      a.link ? el('span', { class: 'small', text: ` — ${linkArea(a.link)}${a.how === 'typed' ? ' (typed)' : ''}` }) : el('span', { class: 'warn', text: ` — ${a.rawLocation ? `"${a.rawLocation}" not linked` : 'no location'}` }),
      a.crew?.length ? el('div', { class: 'small', text: `Crew: ${a.crew.join(', ')}` }) : null,
    ]))),
    el('dt', { text: 'BART support' }),
    el('dd', { text: [support.filter((s) => s.line === 'systems').map((s) => (s.count > 1 ? `${s.count} x ${s.label}` : s.label)).join(', '), support.filter((s) => s.line === 'occ').map((s) => `OCC: ${s.label}`).join(', ')].filter(Boolean).join(' · ') || 'None' }),
    sswp.length ? el('dt', { text: 'SSWP' }) : null,
    sswp.length ? el('dd', { text: sswp.join(', ') }) : null,
  ]));

  const notes = el('ul', { class: 'flags' });
  for (const f of flags) notes.append(el('li', { class: f.blocking ? 'block' : 'note', text: f.message }));
  for (const o of overlaps) {
    const other = o.item.record;
    notes.append(el('li', { class: 'overlap' }, [
      `Overlaps ${other ? `#${other.id} ` : ''}${o.locationName} on the drawing${o.days.length ? `, on ${o.days.map(dayLabel).join(', ')}` : ' this week'}. `,
      record && other && T.may(S.store.workflow, S.role(), 'consolidate', record.status) && T.may(S.store.workflow, S.role(), 'consolidate', other.status)
        ? el('button', { type: 'button', class: 'mini', dataset: { action: 'consolidate-pair' }, text: `Consolidate with #${other.id}`, onClick: () => consolidate([record, other]) })
        : el('span', { class: 'small', text: S.isManager() ? '' : 'The Track Allocation Manager can consolidate them into one.' }),
    ]));
  }
  if (changed.length) notes.append(el('li', { class: 'block', text: `The look-ahead has changed since this was ${status} (${changed.map(label).join(', ')}). ${status === 'approved' ? 'Revise it if the request should follow.' : status === 'submitted' ? 'Withdraw it to bring it up to date.' : 'Reopen it to bring it up to date.'}` }));
  if (record?.status === 'draft' && record.source?.conflicts?.length) notes.append(el('li', { class: 'note', text: `Kept your change where the look-ahead now says something else: ${record.source.conflicts.map(label).join(', ')}.` }));
  if (group?.unexpanded?.length && !frozen) notes.append(el('li', { class: 'note', text: `No expanded wording for: ${group.unexpanded.join(', ')}. Add it in Setup.` }));
  if (record?.decision_note && record.status === 'rejected') notes.append(el('li', { class: 'block', text: `Rejected: ${record.decision_note}` }));
  if (notes.childNodes.length) node.append(notes);

  const meta = [];
  if (record) {
    meta.push(`Raised ${stampLabel(record.created_at)}`);
    if (record.submitted_at && record.status !== 'draft') meta.push(`submitted ${stampLabel(record.submitted_at)}`);
    if (record.decided_at && ['approved', 'rejected'].includes(record.status)) meta.push(`${record.status} ${stampLabel(record.decided_at)}`);
    if (edited.length) meta.push(`${edited.length} field${edited.length === 1 ? '' : 's'} changed by hand`);
  } else meta.push('Not raised yet.');
  node.append(el('p', { class: 'small meta', text: meta.join(' · ') }));
  if (record?.history?.length) {
    node.append(el('details', { class: 'history' }, [
      el('summary', { text: 'History' }),
      el('ol', {}, record.history.map((h) => el('li', { text: `${stampLabel(h.at)} — ${h.by}: ${h.action}${h.note ? ` (“${h.note}”)` : ''}` }))),
    ]));
  }

  const actions = el('div', { class: 'card-actions' });
  const wf = S.store.workflow;
  const role = S.role();
  if (!record && group && S.writer()) {
    actions.append(button('Raise draft', 'tawr-raise', async () => {
      try { await S.createTawr(recordOf(app, group)); } catch (err) { toast(err.message, 'bad'); }
      refresh();
    }, { primary: true }));
  }
  if (record) {
    const editable = T.canEdit(wf, role, record.status);
    actions.append(button(editable ? 'Review' : 'View', editable ? 'tawr-review' : 'tawr-view', () => openReview(record, group, { readOnly: !editable, blocking })));
    for (const action of T.actionsFor(wf, role, record.status)) {
      if (['consolidate', 'split'].includes(action)) continue;
      if (action === 'discard' && merged) continue;
      const rule = wf.actions[action];
      const stopped = rule.unblocked && blocking.length;
      actions.append(button(rule.label, `tawr-${action}`, () => act(record, action), {
        primary: ['submit', 'approve'].includes(action), danger: ['reject', 'discard'].includes(action), disabled: stopped,
        title: stopped ? `Cannot be ${action === 'submit' ? 'submitted' : 'approved'} yet: ${blocking.map((f) => f.message).join(' ')}` : '',
      }));
    }
    if (merged && T.may(wf, role, 'split', record.status)) actions.append(button('Split back up', 'tawr-split', () => splitUp(record)));
    if (S.writer()) {
      actions.append(button(record.status === 'approved' ? 'Download PDF' : 'Preview PDF', record.status === 'approved' ? 'tawr-download' : 'tawr-preview',
        () => downloadOne(record, { draft: record.status !== 'approved' }), { primary: record.status === 'approved' }));
    }
  }
  if ((view.place?.geometry?.length || view.place?.places?.length) && record) actions.append(button('Show on track plan', 'tawr-map', () => app.showTawrOnMap(record)));
  if (actions.childNodes.length) node.append(actions);
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
  if (action === 'reject' && note == null) {
    note = await promptDialog({ title: `Reject the ${record.location_name} request?`, label: 'Why — the requester sees this', required: true, multiline: true, confirmLabel: 'Reject' });
    if (note == null) return false;
  } else if (!quiet && CONFIRM[action]) {
    const [title, message] = CONFIRM[action](record);
    if (!(await confirmDialog({ title, message, confirmLabel: S.store.workflow.actions[action].label, danger: action === 'discard' }))) return false;
  }
  try {
    await S.act(record.id, action, note);
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
  const head = ['TAWR', 'Week', 'Shift', 'Location', 'Area', 'Dates', 'Hours', 'Work', 'BART support', 'SSWP', 'Approved', 'Requester'];
  const lines = [head.map(csvField).join(',')];
  for (const r of records) {
    const days = r.source?.days || [];
    const support = (r.source?.support || []).map((s) => (s.count > 1 ? `${s.count} x ${s.label}` : s.label)).join(', ');
    lines.push([
      `#${r.id}`, r.week_start, T.tawrShiftLabel(r.shift), r.location_name, r.fields?.row1_area || r.source?.area || '',
      days.map((d) => d.date).join(' '), days.map((d) => `${d.start}-${d.end}`).join(' '),
      (r.source?.activities || []).map((a) => [a.activityId, a.title].filter(Boolean).join(' ')).join('; '),
      support, (r.source?.sswp || []).join(' '), stampLabel(r.decided_at), r.fields?.requestor_name || '',
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

function openReview(record, group, { readOnly = false, blocking = [] } = {}) {
  const editor = formEditor(record, { readOnly });
  const fitBox = el('div', { class: 'small fit', 'aria-live': 'polite' });
  const body = el('div', { class: 'review' }, [
    blocking.length ? el('div', { class: 'notice notice-bad' }, blocking.map((f) => el('div', { text: f.message }))) : null,
    fitBox,
    editor.node,
  ]);
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

function formEditor(record, { readOnly = false } = {}) {
  const fields = record.fields || {};
  const generated = record.generated || {};
  const getters = new Map();
  const sameValue = (a, b) => { const blank = (v) => v == null || v === '' || v === false; return (blank(a) && blank(b)) || a === b; };
  const display = (v) => (v === true ? 'ticked' : v == null || v === '' || v === false ? 'blank' : String(v));
  const mark = (wrap, names) => {
    if (names.some((n) => !sameValue(fields[n], generated[n]))) {
      wrap.classList.add('edited');
      wrap.title = `Changed by hand. The look-ahead says: ${names.map((n) => display(generated[n])).join(' / ')}`;
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
  const setting = (caption, key, { options = null, fallback = '', placeholder = '', check = null, hint = '' } = {}) => {
    const current = s[key] ?? fallback;
    const input = options ? el('select', {}, options.map((o) => el('option', { value: o, text: o }))) : el('input', { type: 'text', placeholder });
    input.value = current;
    input.setAttribute('aria-label', caption);
    input.dataset.setting = key;
    const btn = el('button', { type: 'button', class: 'mini', text: 'Save', disabled: true });
    const sync = () => { btn.disabled = input.value.trim() === String(current ?? '').trim(); };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    btn.addEventListener('click', async () => {
      const v = input.value.trim();
      const problem = check?.(v);
      if (problem) { toast(problem, 'warn'); return; }
      try { app.settings = await S.setSettings({ [key]: v }); toast(`${caption} saved.`, 'good'); btn.disabled = true; } catch (err) { toast(err.message, 'bad'); }
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
  setting('Requester\'s name on the form', 'requestor_name', { fallback: S.store.user?.role === 'requester' ? S.store.user.name : '', hint: 'The one person who raises the requests.' });
  setting('Requester\'s cell phone', 'requestor_cell_phone');
  row('Requester\'s signature', 'Drawn once, here, and signed onto the requestor line of every request when it is downloaded. Drawn as lines, so it prints sharp.', signaturePad(s.requestor_signature));

  group('The same on every request');
  setting('Person in charge', 'person_in_charge_name');
  setting('Person in charge — cell phone', 'person_in_charge_cell_phone');
  setting('Project representative', 'project_rep_name');
  setting('Project representative — cell phone', 'project_rep_cell_phone');
  setting('Category of Work, unless changed', 'category_default', { options: CATEGORY_OPTIONS.filter(Boolean), fallback: 'F' });

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

  host.append(codesSection(), legendSection(), descriptionsSection());
  if (S.store.mode === 'local') host.append(backupSection());
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
    try { V.app.settings = await S.setSettings({ requestor_signature: sig }); saveBtn.disabled = true; toast(sig ? 'Signature saved.' : 'Signature removed.', 'good'); } catch (err) { toast(err.message, 'bad'); }
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
    el('p', { class: 'small', text: 'On the static site the look-ahead and the TAWRs are kept in this browser only. Back them up, or move them to another browser. BART\'s form is not in the backup.' }),
    el('div', { class: 'inline' }, [
      el('button', { type: 'button', class: 'secondary mini', text: 'Back up (JSON)', onClick: () => saveFile(`track-plan-backup-${V.app.today}.json`, S.exportLocal(), 'application/json') }),
      el('button', { type: 'button', class: 'secondary mini', text: 'Restore…', onClick: () => input.click() }),
      input,
    ]),
  ]);
}

