/**
 * What the requests come to over a stretch of weeks: how many were raised and
 * how each ended, how early they went in against their deadline, how often
 * the Track Allocation Manager approved and BART granted, why requests were
 * rejected or denied, and the track hours approved against those used.
 *
 * Decisions are counted from each request's history, not its status now: a
 * request rejected, corrected and approved counts one rejection and one
 * approval. A request revised or consolidated is replaced, so it is not
 * counted again as raised — but what was decided on it still happened, and
 * its replacement starts a history of its own, so its decisions and BART's
 * answer are counted. A request's lead is the days between going in and its
 * deadline (its first day less the lead time), on the person's own calendar.
 *
 * Pure: no DOM — `tests/test_tawr.mjs` reads it; `reports_view.js` draws it.
 *
 * Imports: tawr.
 */

import { tawrDeadline, accessOf, addDaysISO, mondayOf } from './tawr.js';

/** How a request ended, in the order the charts stack them. */
export const OUTCOMES = ['approved', 'rejected', 'denied', 'cancelled', 'waiting'];
export const OUTCOME_LABEL = { approved: 'Approved', rejected: 'Rejected', denied: 'Denied by BART', cancelled: 'Cancelled', waiting: 'Not decided yet' };

/** How early a request went in, in days before its deadline. */
export const LEAD_BINS = [
  { key: 'late', label: 'Late' },
  { key: 'day', label: 'On the day' },
  { key: '1-3', label: '1–3 days early' },
  { key: '4-7', label: '4–7 days early' },
  { key: '8+', label: '8 or more early' },
];

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** The day a moment fell on, on this computer's calendar — never Greenwich's. */
export function localDay(stamp) {
  const d = new Date(stamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Replaced by a revision or a consolidation: what was decided on it counts, the request does not. */
const REPLACED = ['superseded', 'consolidated'];

const outcomeOf = (r) => (['approved', 'rejected', 'denied', 'cancelled'].includes(r.status) ? r.status : 'waiting');

/** Days a request went in before its deadline — negative when late; null if it never went in. */
export function leadDays(record, dayOf = localDay) {
  if (!record?.submitted_at) return null;
  const deadline = tawrDeadline(record.first_day || record.week_start);
  return Math.round((Date.parse(deadline) - Date.parse(dayOf(record.submitted_at))) / DAY_MS);
}

export function leadBin(days) {
  if (days < 0) return 'late';
  if (days === 0) return 'day';
  if (days <= 3) return '1-3';
  if (days <= 7) return '4-7';
  return '8+';
}

/**
 * The report for the weeks from `from` to `to` (Mondays):
 *   weeks    [{ week, raised, counts: { outcome: n }, sent, onTime, late,
 *              hoursApproved, hoursRecorded, hoursUsed }]
 *   totals   { raised, sent, onTime, late, approvals, rejections, granted,
 *              denied, hoursApproved, hoursRecorded, hoursUsed }
 *   lead     { bin: n }
 *   reasons  [{ at, id, location, week, shift, by, kind: 'rejected' | 'denied', note }], newest first
 */
export function report(records, { from, to, dayOf = localDay } = {}) {
  const inRange = (records || []).filter((r) => r.week_start >= from && r.week_start <= to);
  const blank = () => ({ raised: 0, counts: Object.fromEntries(OUTCOMES.map((o) => [o, 0])), sent: 0, onTime: 0, late: 0, hoursApproved: 0, hoursRecorded: 0, hoursUsed: 0 });
  const weeks = [];
  for (let w = mondayOf(from); w <= to; w = addDaysISO(w, 7)) weeks.push({ week: w, ...blank() });
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  const totals = { ...blank(), approvals: 0, rejections: 0, granted: 0, denied: 0 };
  delete totals.counts;
  const lead = Object.fromEntries(LEAD_BINS.map((b) => [b.key, 0]));
  const reasons = [];

  for (const r of inRange) {
    const w = byWeek.get(r.week_start);
    if (!w) continue;
    for (const h of r.history || []) {
      if (h.action === 'approve') totals.approvals++;
      if (h.action === 'reject') totals.rejections++;
      if ((h.action === 'reject' || h.action === 'deny') && h.note) {
        reasons.push({ at: h.at, id: r.id, location: r.location_name, week: r.week_start, shift: r.shift, by: h.by, kind: h.action === 'reject' ? 'rejected' : 'denied', note: h.note });
      }
    }
    if (r.bart?.answer === 'granted') totals.granted++;
    if (r.bart?.answer === 'denied') totals.denied++;
    if (REPLACED.includes(r.status)) continue;
    w.raised++;
    totals.raised++;
    w.counts[outcomeOf(r)]++;
    const days = leadDays(r, dayOf);
    if (days != null) {
      w.sent++;
      totals.sent++;
      const bin = leadBin(days);
      lead[bin]++;
      if (bin === 'late') { w.late++; totals.late++; } else { w.onTime++; totals.onTime++; }
    }
    if (r.status === 'approved') {
      const a = accessOf(r);
      w.hoursApproved += a.hoursAsked;
      totals.hoursApproved += a.hoursAsked;
      if (a.recorded) {
        w.hoursRecorded += a.hoursAsked;
        w.hoursUsed += a.hoursUsed;
        totals.hoursRecorded += a.hoursAsked;
        totals.hoursUsed += a.hoursUsed;
      }
    }
  }
  reasons.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { weeks, totals, lead, reasons };
}

/** A share as people say it: "82%", or "—" with nothing to share. */
export function percent(part, whole) {
  return whole ? `${Math.round((100 * part) / whole)}%` : '—';
}
