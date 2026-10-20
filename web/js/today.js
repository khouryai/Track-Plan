/**
 * What needs whom, today — and the deadlines as a calendar.
 *
 * `attention()` reads every request and says, for the role looking, what is
 * waiting on them and what they are waiting on: drafts coming due, requests
 * to approve, rejections and BART's denials to put right, approved requests to
 * send to BART, access to account for, cancellations BART has not been told
 * of, conflicts and power clashes ahead, BART support over what BART can
 * provide, look-ahead activities still to link, and comments on requests the
 * reader has not seen yet. The start page draws it; each item says where to go
 * to deal with it.
 *
 * `calendarIcs()` writes the TAWR deadlines (an all-day event on each week's
 * deadline, with a reminder the day before) and the approved access (an event
 * for each day the track is had) as an iCalendar file. The server writes the
 * same feed for a calendar to subscribe to (operations.calendar_ics), and the
 * two are tested against each other.
 *
 * Pure: no DOM — `tests/test_tawr.mjs` reads it.
 *
 * Imports: tawr, conversation.
 */

import {
  tawrDeadline, deadlineState, addDaysISO, mondayOf, afterApproval, conflicts, powerConflicts, supportOver, tawrShiftLabel,
} from './tawr.js';
import { unread } from './conversation.js';

const LIVE = (r) => !['superseded', 'consolidated'].includes(r.status);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The items for one role, most pressing first: `[{ key, tone, title, detail,
 * go: { view, week? }, ids }]` — tone is `bad` (late or broken), `you` (this
 * role's move), `wait` (somebody else's) or `info`.
 *
 * @param {object} o
 * @param {object[]} o.records   every request loaded
 * @param {string} o.today       YYYY-MM-DD
 * @param {string} o.role        requester | manager | viewer
 * @param {object} o.capacity    what BART can provide (`parseCapacity`)
 * @param {object[]} o.sections  the map's power sections
 * @param {number} [o.unlinked]  look-ahead activities with work ahead and no location
 * @param {number} [o.suggestions]  of those, how many the memory can link as before
 * @param {function} [o.label]   a date as people read it
 * @param {string|number} [o.userId]  who is reading: what was said that they have not seen
 */
export function attention({ records, today, role, capacity = {}, sections = [], unlinked = 0, suggestions = 0, label = (d) => d, userId = null }) {
  const writer = role === 'requester' || role === 'manager';
  const live = (records || []).filter(LIVE);
  const out = [];
  const add = (item) => out.push({ ids: [], ...item });
  const name = (r) => `#${r.id} ${r.location_name}`;

  /* Drafts coming due, a week at a time: due within a week, or late. */
  const due = new Map();
  for (const r of live.filter((x) => x.status === 'draft')) {
    const state = deadlineState(r.first_day || r.week_start, today);
    if (state.daysLeft > 7) continue;
    const held = due.get(r.week_start) || { week: r.week_start, ids: [], state };
    held.ids.push(r.id);
    if (state.daysLeft < held.state.daysLeft) held.state = state;
    due.set(r.week_start, held);
  }
  for (const d of [...due.values()].sort((a, b) => a.week.localeCompare(b.week))) {
    add({
      key: `due:${d.week}`, tone: d.state.daysLeft < 0 ? 'bad' : writer ? 'you' : 'wait', ids: d.ids, go: { view: 'tawr', week: d.week },
      title: `${plural(d.ids.length, 'draft')} for the week of ${label(d.week)} to review and submit`,
      detail: d.state.daysLeft < 0 ? `It was due ${label(d.state.deadline)}.` : d.state.daysLeft === 0 ? 'Due today.' : `Due ${label(d.state.deadline)}.`,
    });
  }

  const submitted = live.filter((r) => r.status === 'submitted');
  if (submitted.length) {
    add({
      key: 'approve', tone: role === 'manager' ? 'you' : 'wait', ids: submitted.map((r) => r.id), go: { view: 'tawr', week: submitted[0].week_start },
      title: role === 'manager' ? `${plural(submitted.length, 'request')} waiting for your approval` : `${plural(submitted.length, 'request')} with the Track Allocation Manager`,
      detail: [...new Set(submitted.map((r) => `week of ${label(r.week_start)}`))].join(', '),
    });
  }

  for (const r of live.filter((x) => x.status === 'rejected')) {
    add({ key: `rejected:${r.id}`, tone: role === 'requester' ? 'you' : 'wait', ids: [r.id], go: { view: 'tawr', week: r.week_start },
      title: `${name(r)} was rejected`, detail: r.decision_note ? `“${r.decision_note}” — reopen it, correct it and submit it again.` : 'Reopen it, correct it and submit it again.' });
  }

  const stage = (s) => live.filter((r) => afterApproval(r, today) === s);
  for (const r of stage('denied')) {
    add({ key: `denied:${r.id}`, tone: writer ? 'you' : 'info', ids: [r.id], go: { view: 'tawr', week: r.week_start },
      title: `${name(r)} was denied by BART`, detail: `${r.bart?.note ? `“${r.bart.note}” — ` : ''}reopen it to correct it and send it again, or leave it.` });
  }
  const unsent = stage('unsent');
  if (unsent.length) {
    add({ key: 'unsent', tone: writer ? 'you' : 'info', ids: unsent.map((r) => r.id), go: { view: 'tawr', week: unsent[0].week_start },
      title: `${plural(unsent.length, 'approved request')} to send to BART`, detail: 'Download BART\'s form, send it, then record it as sent.' });
  }
  for (const r of stage('unreleased')) {
    add({ key: `release:${r.id}`, tone: writer ? 'you' : 'info', ids: [r.id], go: { view: 'tawr', week: r.week_start },
      title: `${name(r)} was cancelled — tell BART the track is released`, detail: 'Then record that BART has been told.' });
  }
  const accessDue = stage('access-due');
  if (accessDue.length) {
    add({ key: 'access', tone: writer ? 'you' : 'info', ids: accessDue.map((r) => r.id), go: { view: 'tawr', week: accessDue[0].week_start },
      title: `${plural(accessDue.length, 'request')}: say whether the access was used`, detail: 'Its days have gone by. The reports count the hours.' });
  }
  const sent = stage('sent');
  if (sent.length) {
    add({ key: 'sent', tone: 'wait', ids: sent.map((r) => r.id), go: { view: 'tawr', week: sent[0].week_start },
      title: `${plural(sent.length, 'request')} sent, waiting for BART's answer`, detail: 'Record BART\'s answer when it comes.' });
  }

  /* Conflicts and power clashes from this week on, a week at a time. */
  const ahead = live.filter((r) => r.week_start >= mondayOf(today));
  for (const week of [...new Set(ahead.map((r) => r.week_start))].sort()) {
    const these = ahead.filter((r) => r.week_start === week);
    const track = conflicts(these);
    const power = powerConflicts(these, sections);
    if (!track.length && !power.length) continue;
    const parts = [track.length ? plural(track.length, 'track conflict') : null, power.length ? plural(power.length, 'power clash', 'power clashes') : null].filter(Boolean);
    add({ key: `clash:${week}`, tone: role === 'manager' ? 'you' : 'wait', go: { view: 'map', week },
      ids: [...new Set([...track, ...power].flatMap((c) => [c.a.id, c.b.id]))],
      title: `${parts.join(' and ')} in the week of ${label(week)}`, detail: 'Requests that want the same track or power section at the same time.' });
  }
  const overs = supportOver(live, capacity).filter((o) => o.date >= today);
  if (overs.length) {
    add({ key: 'support', tone: writer ? 'you' : 'info', ids: [...new Set(overs.flatMap((o) => o.ids))], go: { view: 'tawr', week: mondayOf(overs[0].date) },
      title: `BART support over what BART can provide on ${plural(overs.length, 'shift')}`,
      detail: overs.slice(0, 3).map((o) => `${label(o.date)} ${tawrShiftLabel(o.shift).toLowerCase()}: ${o.asked} ${o.code}, BART has ${o.capacity}`).join(' · ') });
  }

  /* What was said on requests that the reader has not seen yet. */
  if (userId != null) {
    const talk = live.map((r) => ({ r, n: unread(r, userId).length })).filter((x) => x.n);
    if (talk.length) {
      add({ key: 'comments', tone: writer ? 'you' : 'info', ids: talk.map((x) => x.r.id), go: { view: 'tawr', week: talk[0].r.week_start },
        title: `${plural(talk.reduce((n, x) => n + x.n, 0), 'new comment')} on ${plural(talk.length, 'request')}`,
        detail: talk.slice(0, 3).map((x) => `${name(x.r)} (${x.n})`).join(' · ') });
    }
  }

  if (unlinked && writer) {
    add({ key: 'unlinked', tone: 'you', go: { view: 'lookahead' },
      title: `${plural(unlinked, 'activity', 'activities')} on the look-ahead with no location linked`,
      detail: suggestions ? `✦ ${suggestions} can be linked as before, from the learning memory.` : 'Their requests cannot be submitted until they are linked.' });
  }

  const rank = { bad: 0, you: 1, wait: 2, info: 3 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/**
 * The weeks to come and their deadlines: `[{ week, deadline, state, counts }]`,
 * from this week for `weeks` weeks — each week's deadline is its first day of
 * work, less the lead time, as `tawrDeadline` has it.
 */
export function deadlines(records, today, weekList, { weeks = 6 } = {}) {
  const from = mondayOf(today);
  const to = addDaysISO(from, 7 * weeks - 1);
  return (weekList || []).filter((w) => w >= from && w <= to).map((week) => {
    const these = (records || []).filter((r) => r.week_start === week && LIVE(r));
    const first = these.map((r) => r.first_day || week).sort()[0] || week;
    const counts = {};
    for (const r of these) counts[r.status] = (counts[r.status] || 0) + 1;
    return { week, deadline: tawrDeadline(first), state: deadlineState(first, today), counts };
  });
}

/** Every day the track is had: the approved requests' days from `from` to `to`, `[{ date, record, start, end }]`. */
export function onTrack(records, from, to) {
  const out = [];
  for (const r of records || []) {
    if (r.status !== 'approved') continue;
    for (const d of r.source?.days || []) if (d.date >= from && d.date <= to) out.push({ date: d.date, record: r, start: d.start, end: d.end });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
}

/* ── iCalendar ─────────────────────────────────────────────────────────── */

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const ymd = (iso) => iso.replace(/-/g, '');

/** A content line folded at 75 octets, as RFC 5545 asks: the rest of the line follows a space. */
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * The deadlines and the approved access as an iCalendar file. `weekList` is
 * the weeks with work; `stamp` the moment it was written (UTC, for DTSTAMP).
 * Times of day are floating — the reader's own clock — as the look-ahead's are.
 */
export function calendarIcs({ records, weekList, today, stamp = new Date().toISOString(), name = 'Track Plan — TAWRs' }) {
  const dtstamp = `${stamp.slice(0, 19).replace(/[-:]/g, '')}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Track Plan//TAWR deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`];
  const from = addDaysISO(mondayOf(today), -7);
  for (const d of deadlines(records, from, weekList, { weeks: 11 })) {
    const counts = Object.entries(d.counts).map(([s, n]) => `${n} ${s}`).join(', ');
    lines.push('BEGIN:VEVENT', `UID:deadline-${d.week}@track-plan`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd(d.deadline)}`, `DTEND;VALUE=DATE:${ymd(addDaysISO(d.deadline, 1))}`,
      `SUMMARY:${icsText(`TAWRs due — week of ${d.week}`)}`,
      `DESCRIPTION:${icsText(`The track access work requests for the week of ${d.week} go to BART today.${counts ? ` Requests: ${counts}.` : ''}`)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`TAWRs due tomorrow — week of ${d.week}`)}`, 'TRIGGER:-PT15H', 'END:VALARM',
      'END:VEVENT');
  }
  for (const a of onTrack(records, from, addDaysISO(from, 7 * 12))) {
    const r = a.record;
    const hours = /^\d{4}$/.test(a.start || '') && /^\d{4}$/.test(a.end || '');
    const end = hours && a.end <= a.start ? addDaysISO(a.date, 1) : a.date;
    const what = (r.source?.activities || []).map((x) => [x.activityId, x.title].filter(Boolean).join(' ')).join('; ');
    const bart = r.bart?.answer === 'granted' ? `Granted by BART${r.bart.ref ? ` (${r.bart.ref})` : ''}.` : r.bart?.sent_on ? 'Sent to BART, waiting for its answer.' : 'Approved, not yet sent to BART.';
    lines.push('BEGIN:VEVENT', `UID:tawr-${r.id}-${a.date}@track-plan`, `DTSTAMP:${dtstamp}`,
      ...(hours ? [`DTSTART:${ymd(a.date)}T${a.start}00`, `DTEND:${ymd(end)}T${a.end}00`]
        : [`DTSTART;VALUE=DATE:${ymd(a.date)}`, `DTEND;VALUE=DATE:${ymd(addDaysISO(a.date, 1))}`]),
      `SUMMARY:${icsText(`Track access #${r.id} ${r.location_name} · ${tawrShiftLabel(r.shift)}`)}`,
      `LOCATION:${icsText(r.fields?.row1_area || r.location_name)}`,
      `DESCRIPTION:${icsText(`${what}\n${bart}`)}`,
      `STATUS:${r.bart?.answer === 'granted' ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
