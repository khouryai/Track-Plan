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
 * Imports: tawr, store, lookahead.
 */

import * as T from './tawr.js';
import * as S from './store.js';
import { weeksWithWork } from './tawr.js';

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

export function freshValues(app, group) {
  return T.formValues(group, { settings: app.settings || {}, profile: requesterProfile(app) });
}

/** What a record keeps of the group it was read from, for the cards, the review and the map. */
export function sourceOf(group, conflicts = []) {
  return {
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
  };
}

export function recordOf(app, group, values = freshValues(app, group)) {
  return {
    week_start: group.weekStart,
    group_key: group.key,
    shift: group.shift,
    location_name: group.locationName,
    first_day: group.firstDay,
    fields: values,
    generated: values,
    source: sourceOf(group),
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
      const fresh = freshValues(app, group);
      const merged = T.mergeRegenerated(record, fresh);
      const source = sourceOf(group, merged.conflicts);
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
  const fresh = freshValues(app, group);
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
  const record = recordOf(app, group, fresh);
  return { merge, record: { ...record, fields, source: { ...record.source, conflicts } } };
}
