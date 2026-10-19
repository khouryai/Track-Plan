/**
 * The learning memory: what the requests sent before say about the next one.
 *
 * Every request submitted, approved or rejected is remembered (store.js writes
 * the entries; the server keeps them in `memory`), and so is every location
 * linked on the look-ahead. From that memory:
 *
 *   - **A draft's answers are predicted.** The questions BART's form asks that
 *     the look-ahead cannot answer — the clearances, the ticks for support,
 *     the person in charge, the power status, the safe-clear sections — are
 *     voted on by the most similar requests sent before, weighted towards the
 *     closest, the approved and the recent. An answer is predicted only when
 *     the votes agree strongly enough (the threshold in Setup), and only where
 *     it differs from what the setup already gives; nothing the look-ahead
 *     decides is ever touched. A prediction is written into the draft as a
 *     generated value, so typing over it is a hand edit like any other, and
 *     `source.predicted` says where each came from.
 *   - **An activity's location is suggested** from where the same activity, or
 *     one named the same way, was linked before; and its party, work hours and
 *     SSWP from the requests it was in.
 *   - **A draft that resembles a rejected request says so**, with the reason.
 *   - **What was predicted is checked against what was sent**, so how often
 *     each prediction is kept is tracked over time (Setup → Learning).
 *
 * Similarity is a weighted overlap of what a request is: the words of its
 * activities, their ids and id families ("C-W", "T-M"), the party to action,
 * whether it is a TCR or track, the shift, the places, tracks and lines, and
 * the support codes. Which of those matter depends on the answer: a support
 * line or an advisory follows the work itself (its words, rare ones counting
 * for more, and its ids), the person in charge follows the party, the power
 * and the clearances follow the kind of work and the shift, the safe-clear
 * sections the very tracks.
 *
 * Pure: no DOM, no storage — `tests/test_tawr.mjs` reads it.
 *
 * Imports: tawr, links.
 */

import { FORM_ROWS, FIELD_LABEL } from './tawr.js';
import { lineOf, sliceRoute } from './links.js';

export const MEMORY_KINDS = ['form', 'link', 'reject', 'outcome'];
export const DEFAULT_THRESHOLD = 0.6;

/* ── The answers a form gives ─────────────────────────────────────────────
   One "unit" is one decision somebody makes on the form, however many boxes
   it fills: Yes or No, a tick, a name with its phone, the power status of
   every date row. */

const YESNO = [
  ['work_in_track_zone', 'Work/Activity in Track Zone'],
  ['clearance_verification', 'Clearance Verification'],
  ['track_inspection_first_train', 'Track Inspection (with 1st Train)'],
];
const CHECKS = [
  'police_advisory_threat_of_theft', 'advisory_no_work_clearance', 'no_passage_hirail_vehicles', 'coordinate_hirail_passage',
  'maint_operating_bulletin_req', 'maint_physical_barrier_req', 'maint_power_tech_support_req', 'maint_rail_bond_cbond_req',
  'maint_route_prohibit_req', 'maint_safe_clearance_req', 'maint_safety_dept_req', 'maint_safety_monitor_req',
  'maint_speed_restriction_req', 'maint_vehicle_equipment_req', 'maint_vehicle_tech_support_req',
  'trans_adverse_impact_blanket_req', 'trans_passenger_bulletin_req', 'trans_single_tracking_req',
  'trans_train_operators_req', 'trans_train_required_req', 'trans_yard_line_support_req',
];
const TEXTS = ['category_of_work', 'schedule_number', 'trans_public_notice'];
/** A details line, and the tick it belongs to: it is only predicted when the tick is. */
const DETAILS = [
  'maint_operating_bulletin', 'maint_physical_barrier', 'maint_power_tech_support', 'maint_rail_bond_cbond', 'maint_route_prohibit',
  'maint_safe_clearance', 'maint_safety_dept', 'maint_safety_monitor', 'maint_speed_restriction', 'maint_vehicle_equipment',
  'maint_vehicle_tech_support', 'trans_single_tracking', 'trans_train_operators', 'trans_train_required', 'trans_yard_line_support',
];
const PAIRS = [
  ['person_in_charge', 'person_in_charge_name', 'person_in_charge_cell_phone', 'Person in charge'],
  ['project_rep', 'project_rep_name', 'project_rep_cell_phone', 'Project representative'],
];
const POWER = ['on', 'off', 'na'];
const POWER_LABEL = { on: 'ON', off: 'OFF', na: 'N/A' };

const label = (name) => (FIELD_LABEL.get(name) || name).replace(/ \((checkbox|details)\)$/, '');

/* What each kind of answer follows, as weights on what a request is. */
const PROFILES = {
  work: { words: 6, ids: 4, families: 2, kind: 1, codes: 1 },              // the work itself
  party: { parties: 6, families: 1, ids: 1, words: 1 },                    // who does it
  site: { kind: 3, shift: 3, tracks: 1.5, lines: 1, places: 1.5, words: 1, ids: 1 }, // the kind of work, when, roughly where
  place: { tracks: 3, places: 3, lines: 1, kind: 1, ids: 1 },             // exactly where
};
const SITE_CHECKS = new Set(['no_passage_hirail_vehicles', 'coordinate_hirail_passage']);

/** Every unit, in the order the form asks them, with what it follows. */
export const UNITS = [
  ...YESNO.map(([key, text]) => ({ key, kind: 'yesno', label: text, profile: 'site' })),
  ...CHECKS.map((key) => ({ key, kind: 'check', label: label(key), profile: SITE_CHECKS.has(key) ? 'site' : 'work' })),
  ...DETAILS.map((base) => ({ key: `${base}_details`, kind: 'text', label: `${label(`${base}_details`)} (details)`, requires: `${base}_req`, profile: 'work' })),
  ...TEXTS.map((key) => ({ key, kind: 'text', label: label(key), profile: 'work' })),
  ...PAIRS.map(([key, , , text]) => ({ key, kind: 'pair', label: text, profile: 'party' })),
  { key: 'power', kind: 'power', label: 'Power status', profile: 'site' },
  { key: 'safe_clear', kind: 'rows', label: 'Safe clear rail section(s)', profile: 'place' },
];
const UNIT = new Map(UNITS.map((u) => [u.key, u]));
const PAIR = new Map(PAIRS.map(([key, name, phone]) => [key, [name, phone]]));

const blank = (v) => v == null || String(v).trim() === '';
const dated = (fields) => Array.from({ length: FORM_ROWS }, (_, i) => i + 1).filter((n) => !blank(fields[`row${n}_date`]));

/** The most common of a list, the first seen winning a tie. */
function commonest(list) {
  const n = new Map();
  for (const v of list) n.set(v, (n.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (best == null || c > n.get(best)) best = v;
  return best;
}

/** The answers a set of form values gives, unit by unit; a unit nobody answered is absent. */
export function answersOf(fields = {}) {
  const out = {};
  for (const [key] of YESNO) {
    if (fields[`${key}_yes`] === true) out[key] = 'yes';
    else if (fields[`${key}_no`] === true) out[key] = 'no';
  }
  for (const key of CHECKS) out[key] = fields[key] === true;
  for (const base of DETAILS) if (!blank(fields[`${base}_details`])) out[`${base}_details`] = String(fields[`${base}_details`]).trim();
  for (const key of TEXTS) if (!blank(fields[key])) out[key] = String(fields[key]).trim();
  for (const [key, name, phone] of PAIRS) {
    if (!blank(fields[name]) || !blank(fields[phone])) out[key] = [String(fields[name] || '').trim(), String(fields[phone] || '').trim()];
  }
  const rows = dated(fields);
  const power = commonest(rows.map((n) => POWER.find((p) => fields[`row${n}_power_${p}`] === true)).filter(Boolean));
  if (power) out.power = power;
  const safe = commonest(rows.map((n) => String(fields[`row${n}_safe_clear_rail_sections`] || '').trim()).filter(Boolean));
  if (safe) out.safe_clear = safe;
  return out;
}

/** The form fields a unit fills in these values: what Review marks as predicted. */
export function fieldsOf(key, values = {}) {
  const unit = UNIT.get(key);
  if (!unit) return [];
  if (unit.kind === 'yesno') return [`${key}_yes`, `${key}_no`];
  if (unit.kind === 'pair') return PAIR.get(key);
  if (unit.kind === 'power') return dated(values).flatMap((n) => POWER.map((p) => `row${n}_power_${p}`));
  if (unit.kind === 'rows') return dated(values).map((n) => `row${n}_safe_clear_rail_sections`);
  return [key];
}

/** A unit's answer, said the way the form shows it. */
export function answerText(key, value) {
  const unit = UNIT.get(key);
  if (!unit) return String(value);
  if (unit.kind === 'yesno') return value === 'yes' ? 'Yes' : 'No';
  if (unit.kind === 'check') return value ? 'ticked' : 'not ticked';
  if (unit.kind === 'pair') return (value || []).filter(Boolean).join(', ');
  if (unit.kind === 'power') return POWER_LABEL[value] || String(value);
  return String(value);
}

export const unitLabel = (key) => UNIT.get(key)?.label || key;

/** Form values with predicted answers written in, every box a unit fills set to agree. */
export function applyPredictions(values, predicted = {}) {
  const v = { ...values };
  for (const [key, p] of Object.entries(predicted)) {
    const unit = UNIT.get(key);
    if (!unit) continue;
    if (unit.kind === 'yesno') {
      delete v[`${key}_yes`]; delete v[`${key}_no`];
      v[`${key}_${p.value}`] = true;
    } else if (unit.kind === 'check') {
      if (p.value === true) v[key] = true; else delete v[key];
    } else if (unit.kind === 'pair') {
      const [name, phone] = PAIR.get(key);
      v[name] = p.value[0] || '';
      v[phone] = p.value[1] || '';
    } else if (unit.kind === 'power') {
      for (const n of dated(v)) {
        for (const q of POWER) delete v[`row${n}_power_${q}`];
        v[`row${n}_power_${p.value}`] = true;
      }
    } else if (unit.kind === 'rows') {
      for (const n of dated(v)) v[`row${n}_safe_clear_rail_sections`] = p.value;
    } else v[key] = p.value;
  }
  return v;
}

/* ── What a request is ────────────────────────────────────────────────── */

const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'onto', 'over', 'work', 'works']);
/** The words of a title worth comparing: "IXL SIM testing — San Bruno" → ixl, sim, testing, san, bruno. */
export function words(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}
const fold = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** "C-W101" → "C-W": the kind of work and the line, as the ids are numbered. */
const family = (id) => (String(id || '').toUpperCase().match(/^[A-Z]+[-\s]?[A-Z]*/)?.[0] || '').replace(/\s/g, '-');

/**
 * What a request is, for comparing it with others: from a reading of the
 * look-ahead (a group) or what a record keeps (`source`) and its shift.
 */
export function featuresOf(src = {}, shift = src.shift) {
  const acts = src.activities || [];
  const limits = src.place?.limits || [];
  return {
    kind: src.kind || 'unlinked',
    shift: shift || '',
    words: new Set(acts.flatMap((a) => words(a.title))),
    ids: new Set(acts.map((a) => String(a.activityId || '').trim().toUpperCase()).filter(Boolean)),
    families: new Set(acts.map((a) => family(a.activityId)).filter(Boolean)),
    parties: new Set(acts.map((a) => fold(a.party)).filter(Boolean)),
    places: new Set((src.place?.places || []).map((p) => p.id)),
    tracks: new Set(limits.map((l) => l.track)),
    lines: new Set(limits.map((l) => lineOf(l.track))),
    codes: new Set((src.support || []).map((s) => s.code)),
  };
}

const WEIGHTS = { words: 3, ids: 3, families: 1, parties: 1.5, kind: 2, shift: 1, places: 1.5, tracks: 1, lines: 0.5, codes: 1 };

function jaccard(a, b) {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** Two sets of words compared with each weighted by how rare it is (`idf`): "cable" says more than "testing". */
function cosine(a, b, idf) {
  let dot = 0; let na = 0; let nb = 0;
  for (const w of a) { const x = idf(w) ** 2; na += x; if (b.has(w)) dot += x; }
  for (const w of b) nb += idf(w) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * How alike two requests are, 0 to 1, by the weights given (all of what a
 * request is, unless a profile says which parts). A part neither says
 * anything about does not count either way.
 */
export function similarity(a, b, weights = WEIGHTS, idf = null) {
  let sum = 0; let weight = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (k === 'kind' || k === 'shift') {
      if (!a[k] && !b[k]) continue;
      weight += w;
      if (a[k] === b[k]) sum += w;
      continue;
    }
    if (!a[k].size && !b[k].size) continue;
    weight += w;
    if (a[k].size && b[k].size) sum += w * (k === 'words' && idf ? cosine(a[k], b[k], idf) : jaccard(a[k], b[k]));
  }
  return weight ? sum / weight : 0;
}

/* ── The memory, read for use ─────────────────────────────────────────── */

const DAY_MS = 86400000;
const HALF_LIFE_DAYS = 180;
const recency = (at, now) => 0.5 ** (Math.max(0, (now - Date.parse(at || 0)) / DAY_MS) / HALF_LIFE_DAYS);

/**
 * The memory's entries read once for predicting: each request once (its last
 * word — approved over submitted), with what it is worked out; the links, the
 * rejections and the outcomes as they are.
 */
export function buildIndex(entries = [], { now = Date.now() } = {}) {
  const rank = (e) => (e.data?.action === 'approve' ? 2 : 1);
  const forms = new Map();
  for (const e of entries) {
    if (e.kind !== 'form' || !e.data?.answers) continue;
    const key = e.tawr_id ?? `e${e.id}`;
    const prev = forms.get(key);
    if (!prev || rank(e) > rank(prev) || (rank(e) === rank(prev) && String(e.at) >= String(prev.at))) forms.set(key, e);
  }
  const examples = [...forms.values()].map((e) => ({
    id: e.tawr_id, at: e.at, approved: e.data.action === 'approve', f: featuresOf(e.data.source, e.data.shift),
    answers: e.data.answers, activities: e.data.source?.activities || [],
  }));
  const links = entries.filter((e) => e.kind === 'link' && e.data?.link).map((e) => ({
    id: e.id, at: e.at, by: e.by, title: e.data.title || '', words: new Set(words(e.data.title)),
    activityId: String(e.data.activityId || '').trim().toUpperCase(), typed: fold(e.data.typed), link: e.data.link,
  }));
  const rejects = entries.filter((e) => e.kind === 'reject' && e.data?.reason).map((e) => ({
    id: e.tawr_id, at: e.at, by: e.by, reason: e.data.reason, f: featuresOf(e.data.source, e.data.shift),
  }));
  const outcomes = entries.filter((e) => e.kind === 'outcome' && e.data);
  // How many requests each word is in, for weighting the rare ones up.
  const df = new Map();
  for (const ex of examples) for (const w of ex.f.words) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log((examples.length + 1) / ((df.get(w) || 0) + 1)) + 1;
  return { examples, links, rejects, outcomes, now, idf };
}

const MIN_SIMILAR = 0.3;
const NEIGHBOURS = 25;

/**
 * The answers predicted for a request: `{ unit: { value, confidence, support,
 * of, from } }` — `support` requests agreeing out of the `of` similar ones that
 * answered, `from` their numbers. `generated` is what the setup already gives:
 * an answer the same as that is no prediction.
 */
export function predict(index, target, { threshold = DEFAULT_THRESHOLD, generated = {} } = {}) {
  if (!index?.examples?.length) return {};
  const f = featuresOf(target, target.shift);
  const neighbours = new Map();
  const nearFor = (profile) => {
    if (!neighbours.has(profile)) {
      neighbours.set(profile, index.examples.map((ex) => ({ ex, sim: similarity(f, ex.f, PROFILES[profile], index.idf) }))
        .filter((n) => n.sim >= MIN_SIMILAR)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, NEIGHBOURS));
    }
    return neighbours.get(profile);
  };
  const already = answersOf(generated);
  const out = {};
  for (const unit of UNITS) {
    const near = nearFor(unit.profile);
    const tally = new Map();
    let total = 0; let answered = 0;
    for (const { ex, sim } of near) {
      if (!(unit.key in ex.answers)) continue;
      const value = ex.answers[unit.key];
      const w = sim * sim * (ex.approved ? 1.25 : 1) * recency(ex.at, index.now);
      const k = JSON.stringify(value);
      const t = tally.get(k) || { value, weight: 0, from: [], best: 0 };
      t.weight += w;
      t.from.push(ex.id);
      t.best = Math.max(t.best, sim);
      tally.set(k, t);
      total += w;
      answered++;
    }
    if (!total) continue;
    const top = [...tally.values()].sort((a, b) => b.weight - a.weight)[0];
    const confidence = top.weight / total;
    const support = top.from.length;
    // One request alone is enough only when it is nearly the same request, and nothing disagrees.
    const alone = support === 1 && top.best >= 0.9 && tally.size === 1;
    if (confidence < threshold || (support < 2 && !alone)) continue;
    if (unit.kind === 'check' && top.value !== true) continue; // unticked is how a box starts
    if (JSON.stringify(already[unit.key] ?? (unit.kind === 'check' ? false : null)) === JSON.stringify(top.value)) continue;
    out[unit.key] = { value: top.value, confidence: Math.round(confidence * 100) / 100, support, of: answered, from: top.from.filter((x) => x != null).slice(0, 6) };
  }
  for (const unit of UNITS) {
    if (unit.requires && out[unit.key] && out[unit.requires]?.value !== true && generated[unit.requires] !== true) delete out[unit.key];
  }
  return out;
}

/* ── Locations, parties and hours remembered ──────────────────────────── */

/**
 * Where an activity was linked before, if the memory is sure: the same
 * activity id, the same typed location, or a title with the same words — and
 * then only where the location typed now does not say somewhere else.
 * `{ link, how: 'id' | 'typed' | 'words', score, title, at, by }` or null.
 */
export function suggestLink(index, row) {
  if (!index?.links?.length) return null;
  const id = String(row.activity_id || '').trim().toUpperCase();
  const w = new Set(words(row.description));
  const typed = fold(row.location);
  let best = null;
  for (const l of index.links) {
    let score = 0; let how = null;
    if (id && l.activityId === id) { score = 1; how = 'id'; } else if (typed && l.typed && typed === l.typed) { score = 0.95; how = 'typed'; } else if (w.size && l.words.size && !(typed && l.typed && typed !== l.typed)) {
      score = 0.9 * jaccard(w, l.words); // never as sure as the same id
      how = 'words';
    }
    if (score >= 0.54 && (!best || score > best.score || (score === best.score && String(l.at) > String(best.at)))) best = { ...l, score, how };
  }
  return best && { link: best.link, how: best.how, score: Math.round(best.score * 100) / 100, title: best.title, at: best.at, by: best.by };
}

/**
 * The party to action, work hours and SSWP an activity had in the requests it
 * was in before, where the row has none: `{ party?, work_hours?, sswp? }`, each
 * `{ value, support }`.
 */
export function suggestFields(index, row) {
  if (!index?.examples?.length) return {};
  const id = String(row.activity_id || '').trim().toUpperCase();
  const w = new Set(words(row.description));
  const seen = [];
  for (const ex of index.examples) {
    for (const a of ex.activities) {
      const same = (id && String(a.activityId || '').trim().toUpperCase() === id)
        || (w.size && jaccard(w, new Set(words(a.title))) >= 0.75);
      if (same) seen.push(a);
    }
  }
  const out = {};
  for (const [field, from] of [['party', 'party'], ['work_hours', 'hoursText'], ['sswp', 'sswp']]) {
    if (!blank(row[field])) continue;
    const values = seen.map((a) => String(a[from] || '').trim()).filter(Boolean);
    const top = commonest(values);
    if (top) out[field] = { value: top, support: values.filter((v) => v === top).length };
  }
  return out;
}

/** Rejected requests like this one, closest first: `[{ reason, id, at, by, similarity }]`. */
export function rejectionsLike(index, target, { min = 0.6 } = {}) {
  if (!index?.rejects?.length) return [];
  const f = featuresOf(target, target.shift);
  return index.rejects.map((r) => ({ reason: r.reason, id: r.id, at: r.at, by: r.by, similarity: Math.round(similarity(f, r.f) * 100) / 100 }))
    .filter((r) => r.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity);
}

/* ── Entries, as the store writes them ────────────────────────────────── */

const round2 = (v) => Math.round(v * 100) / 100;
const GEOMETRY_MAX = 12000;
/** A link as the memory keeps it: its geometry too, rounded, when it is not too long to keep. */
function compactLink(l) {
  if (!l) return null;
  const out = { location_id: l.location_id || null, location_name: l.location_name || null, location_kind: l.location_kind || null, limits: l.limits || [] };
  const geometry = (l.geometry || []).map((pl) => pl.map(([x, y]) => [round2(x), round2(y)]));
  if (geometry.length && JSON.stringify(geometry).length <= GEOMETRY_MAX) out.geometry = geometry;
  return out;
}

/** A remembered link made whole again: its geometry as kept, or drawn again from its limits. */
export function restoreLink(link, routes) {
  if (!link) return null;
  const geometry = link.geometry?.length ? link.geometry
    : (link.limits || []).filter((l) => l.track).flatMap((l) => sliceRoute(routes, l.track, l.from_mp, l.to_mp));
  return { location_id: link.location_id || null, location_name: link.location_name || null, location_kind: link.location_kind || null, limits: link.limits || [], geometry };
}

/** What the memory keeps of a request's source: what it is, without its drawing. */
export function compactSource(src = {}) {
  return {
    kind: src.kind || 'unlinked',
    activities: (src.activities || []).map((a) => ({
      title: a.title || '', activityId: a.activityId || '', party: a.party || '', hoursText: a.hoursText || '', sswp: a.sswp || '',
    })),
    place: { places: (src.place?.places || []).map((p) => ({ id: p.id, name: p.name })), limits: src.place?.limits || [] },
    support: (src.support || []).map((s) => ({ code: s.code })),
  };
}

/** Which predictions a request kept and which were changed before it was sent. */
export function outcomeOf(record) {
  const predicted = record.source?.predicted || {};
  const keys = Object.keys(predicted);
  if (!keys.length) return null;
  const final = answersOf(record.fields || {});
  const kept = []; const changed = [];
  for (const key of keys) {
    const was = predicted[key].value;
    const now = final[key] ?? (UNIT.get(key)?.kind === 'check' ? false : null);
    if (JSON.stringify(was) === JSON.stringify(now)) kept.push(key); else changed.push({ unit: key, predicted: was, final: now });
  }
  return { kept, changed };
}

/** The entries a step of the workflow leaves in the memory. */
export function entriesFor(record, action, note = null) {
  const base = { tawr_id: record.id };
  const data = { week: record.week_start, shift: record.shift, source: compactSource(record.source) };
  if (action === 'submit' || action === 'approve') {
    const out = [{ ...base, kind: 'form', data: { ...data, action, answers: answersOf(record.fields || {}) } }];
    const outcome = action === 'submit' ? outcomeOf(record) : null;
    if (outcome) out.push({ ...base, kind: 'outcome', data: outcome });
    return out;
  }
  if (action === 'reject' && String(note || '').trim()) return [{ ...base, kind: 'reject', data: { ...data, reason: String(note).trim() } }];
  return [];
}

/** The entry a location linked on the look-ahead leaves. */
export function linkEntry(row, link) {
  return { kind: 'link', tawr_id: null, data: { title: row.description || '', activityId: row.activity_id || '', typed: row.location || '', link: compactLink(link) } };
}

/* ── How well it has done ─────────────────────────────────────────────── */

/**
 * Predictions kept and changed, over all and unit by unit, from the outcomes
 * (`since`, an ISO date, to look at the recent ones only).
 */
export function accuracy(index, { since = null } = {}) {
  const units = new Map();
  let kept = 0; let changed = 0;
  for (const o of index?.outcomes || []) {
    if (since && String(o.at) < since) continue;
    for (const key of o.data.kept || []) {
      kept++;
      const u = units.get(key) || { key, kept: 0, changed: 0, last: null };
      u.kept++;
      units.set(key, u);
    }
    for (const c of o.data.changed || []) {
      changed++;
      const u = units.get(c.unit) || { key: c.unit, kept: 0, changed: 0, last: null };
      u.changed++;
      u.last = c.final;
      units.set(c.unit, u);
    }
  }
  const total = kept + changed;
  return { kept, changed, total, rate: total ? kept / total : null, units: [...units.values()].sort((a, b) => (b.kept + b.changed) - (a.kept + a.changed)) };
}
