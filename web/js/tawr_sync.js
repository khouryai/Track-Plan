/**
 * Keeping the TAWRs in step with the look-ahead.
 *
 * A week's requests are read off the look-ahead (`tawr.js`) and saved as
 * drafts; when the look-ahead changes, every draft follows it without losing
 * what anybody typed into it (`mergeRegenerated`). A submitted, approved or
 * rejected request is never touched — it is marked as no longer matching
 * instead. Drafts are raised **by themselves** for every week whose deadline
 * (seventeen days before its Monday) is within the lead time in Setup, so the
 * requester finds them ready, with the Area already written from the track
 * plan.
 *
 * A fresh reading carries the learning memory's predictions (learn.js) for the
 * answers the look-ahead cannot give, written in as generated values, so a
 * draft follows them as the memory grows and typing over one is a hand edit.
 *
 * Imports: tawr, store, learn, sample.
 */

import * as T from './tawr.js';
import * as S from './store.js';
import { weeksWithWork } from './tawr.js';
import { predict, applyPredictions, DEFAULT_THRESHOLD } from './learn.js';
import { sampleAnswers } from './sample.js';

/** Everything a week is read with, from what the application has loaded. */
export function readingOptions(app) {
  const settings = app.settings || {};
  const shiftHours = {};
  for (const s of ['day', 'swing', 'night', 'possession']) shiftHours[s] = settings[`hours_${s}`] || T.DEFAULT_SHIFT_HOURS[s];
  return {
    legend: app.la.legend,
    codes: app.la.codes,
    locations: app.locations,
    descriptions: app.descriptions || [],
    shiftHours,
    merges: app.merges || [],
  };
}

export function extract(app, week, extra = {}) {
  return T.extractWeek(app.la.model, week, { ...readingOptions(app), ...extra }).groups;
}

/** The requester printed on every form: the one person who raises them (Setup). */
export function requesterProfile(app) {
  const s = app.settings || {};
  return { requestor_name: s.requestor_name || '', cell_phone: s.requestor_cell_phone || '' };
}

/** What the look-ahead and the setup give a request: what "changed since" compares. */
export function freshValues(app, group) {
  return T.formValues(group, { settings: app.settings || {}, profile: requesterProfile(app) });
}

/**
 * A request as a draft would be raised now: the look-ahead and the setup's
 * values, with the memory's predictions written in — `{ values, predicted }`.
 */
export function freshReading(app, group) {
  const values = freshValues(app, group);
  const s = app.settings || {};
  if (!app.learning || s.learn_predict === 'off') return { values, predicted: {} };
  const threshold = Number.parseFloat(s.learn_threshold) || DEFAULT_THRESHOLD;
  const predicted = predict(app.learning, group, { threshold, generated: values });
  return { values: applyPredictions(values, predicted), predicted };
}

/** What a record keeps of the group it was read from, for the cards, the review and the map. */
export function sourceOf(group, conflicts = [], predicted = {}) {
  return {
    kind: group.kind,
    activities: group.activities,
    days: group.days,
    support: group.support,
    sswp: group.sswp,
    flags: group.flags,
    unexpanded: group.unexpanded,
    area: group.area,
    place: group.place,
    members: group.members,
    overlaps: group.overlaps,
    conflicts,
    predicted,
  };
}

export function recordOf(app, group, reading = freshReading(app, group)) {
  return {
    week_start: group.weekStart,
    group_key: group.key,
    shift: group.shift,
    location_name: group.locationName,
    first_day: group.firstDay,
    fields: reading.values,
    generated: reading.values,
    source: sourceOf(group, [], reading.predicted),
  };
}

const live = (r) => !['superseded', 'consolidated'].includes(r.status);

/**
 * Bring one week's drafts up to date: a draft for every request the
 * look-ahead calls for, every existing draft regenerated. Answers counts.
 */
export async function syncWeek(app, week) {
  const groups = extract(app, week);
  const records = app.tawrs.filter((r) => r.week_start === week && live(r));
  let made = 0; let updated = 0; let kept = 0;
  for (const group of groups) {
    const record = records.find((r) => r.group_key === group.key);
    if (!record) {
      try {
        await S.createTawr(recordOf(app, group));
        made++;
      } catch (err) {
        if (err.status !== 409) throw err; // somebody else raised it a moment ago
      }
    } else if (record.status === 'draft') {
      const { values: fresh, predicted } = freshReading(app, group);
      const merged = T.mergeRegenerated(record, fresh);
      const source = sourceOf(group, merged.conflicts, predicted);
      const changed = JSON.stringify(merged.fields) !== JSON.stringify(record.fields)
        || JSON.stringify(merged.generated) !== JSON.stringify(record.generated)
        || JSON.stringify(source) !== JSON.stringify(record.source)
        || record.location_name !== group.locationName || record.first_day !== group.firstDay;
      if (changed) {
        await S.updateTawr(record.id, {
          fields: merged.fields, generated: merged.generated, source, location_name: group.locationName, first_day: group.firstDay,
        });
        updated++;
      }
    } else kept++;
  }
  return { made, updated, kept };
}

/**
 * Raise the drafts that should exist by now — every week due within the lead
 * time — and bring them up to date. Only for somebody who may write.
 */
export async function autoRaise(app) {
  if (!S.writer()) return { made: 0, updated: 0, weeks: [] };
  const lead = Number.parseInt(app.settings?.auto_lead_days ?? '7', 10);
  const weeks = T.weeksToRaise(weeksWithWork(app.la.model), app.today, Number.isFinite(lead) ? lead : 7);
  let made = 0; let updated = 0;
  for (const w of weeks) {
    const r = await syncWeek(app, w);
    made += r.made;
    updated += r.updated;
  }
  return { made, updated, weeks };
}

/**
 * The sample's weeks as they would stand by now. A week whose deadline has
 * passed was submitted, and approved once it passed a week ago — all but the
 * requests in a conflict, which wait for the Track Allocation Manager. An
 * approved request went to BART on its deadline, and BART granted it three
 * days later where that day has come. On the static site every step is taken,
 * and stamped when this story says it was (submitted two days before the
 * deadline, approved the day before), so what Reports says of the sample is
 * what it says of a real week; on a server, those steps this account may
 * take, stamped by the server as now. Answers how many steps were taken.
 */
export async function settleSample(app) {
  const steps = [];
  for (const week of new Set(app.tawrs.map((t) => t.week_start))) {
    const deadline = T.tawrDeadline(week);
    if (deadline >= app.today) continue;
    const live = app.tawrs.filter((t) => t.week_start === week && !['superseded', 'consolidated'].includes(t.status));
    const clashing = new Set(T.conflicts(live).flatMap((c) => [c.a.id, c.b.id]));
    const approve = T.addDaysISO(deadline, 7) < app.today;
    for (const t of live) {
      if (t.status !== 'draft' || (t.source?.flags || []).some((f) => f.blocking)) continue;
      steps.push([t.id, 'submit', localStamp(T.addDaysISO(deadline, -2), 10)]);
      if (approve && !clashing.has(t.id)) steps.push([t.id, 'approve', localStamp(T.addDaysISO(deadline, -1), 15)]);
    }
  }
  /* As a requester would have filled them in before sending them — which is
     what the learning memory learns from. */
  const fills = {};
  for (const [id] of steps) {
    const t = app.tawrs.find((r) => r.id === id);
    if (t && !fills[id]) fills[id] = sampleAnswers(t);
  }
  const bartFor = (id) => {
    const t = app.tawrs.find((r) => r.id === id);
    const sent = T.tawrDeadline(t.first_day || t.week_start);
    const granted = T.addDaysISO(sent, 3);
    return { sent_on: sent, ref: `BT-${4400 + id}`, ...(granted <= app.today ? { answer: 'granted', answered_on: granted } : {}) };
  };
  let taken = steps;
  if (S.store.mode === 'local') {
    S.settleLocalSample(steps, fills, Object.fromEntries(steps.filter(([, a]) => a === 'approve').map(([id]) => [id, bartFor(id)])));
  } else {
    taken = steps.filter(([, action]) => T.may(S.store.workflow, S.role(), action));
    for (const [id, fields] of Object.entries(fills)) {
      const t = app.tawrs.find((r) => r.id === Number(id));
      if (taken.some(([x]) => x === Number(id))) await S.updateTawr(Number(id), { fields: { ...t.fields, ...fields } });
    }
    for (const [id, action] of taken) await S.act(id, action);
    for (const [id] of taken.filter(([, a]) => a === 'approve')) await S.recordBart(id, bartFor(id));
  }
  if (taken.length) await app.reloadTawrs();
  return taken.length;
}

/** A moment on a day, on this computer's clock: when one of the sample's steps was taken. */
function localStamp(day, hour) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0).toISOString();
}

/**
 * The merged request for a consolidation, read with the merge applied: what
 * `consolidate()` is sent along with the ids. The merge id is made here, so
 * the record and the merge agree before the server sees either.
 */
export function consolidation(app, records) {
  const week = records[0].week_start;
  const id = crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const merge = { id, week_start: week, keys: records.map((r) => r.group_key).sort() };
  const groups = extract(app, week, { merges: [...(app.merges || []), merge] });
  const group = groups.find((g) => g.key === `merge:${id}`);
  if (!group) throw new Error('Those requests are no longer on the look-ahead this week. Update the drafts first.');
  /* What somebody typed into a member by hand comes along — a schedule
     number, a clearance answer — unless two members say different things, when
     the look-ahead's value stands and the review names the field. What the
     look-ahead decides (dates, hours, area, support) is read afresh. */
  const reading = freshReading(app, group);
  const fresh = reading.values;
  const fields = { ...fresh };
  const conflicts = [];
  for (const k of new Set(records.flatMap((r) => T.editedKeys(r.fields, r.generated)))) {
    if (T.fromLookahead(k)) continue;
    const said = new Set(records.filter((r) => T.editedKeys(r.fields, r.generated).includes(k)).map((r) => JSON.stringify(r.fields?.[k] ?? null)));
    if (said.size === 1) {
      const v = JSON.parse([...said][0]);
      if (v == null) delete fields[k]; else fields[k] = v;
    } else conflicts.push(k);
  }
  const record = recordOf(app, group, reading);
  return { merge, record: { ...record, fields, source: { ...record.source, conflicts } } };
}
