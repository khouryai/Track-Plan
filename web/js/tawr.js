/**
 * Track access work requests (TAWRs), read off the look-ahead and placed on
 * the track plan.
 *
 * BART wants a System Access / Track Allocation Work Request for every place
 * the team works, seventeen days before the work. Everything the form needs is
 * already on the 4WLA — which days, which shift, what hours, what BART support —
 * and *where* is the track plan link on each activity (`links.js`): the
 * station or train control room and the block of track picked on the map. So a
 * request is read off the look-ahead, never typed again.
 *
 * Rebuilt from cx-timeline's `src/core/tawr.js`. The rules are the same:
 *
 * **One request is one location, one shift, one week (Monday to Sunday).** Two
 * activities at the same place on the same shift are one request listing both;
 * the same place on a day shift and a night shift is two.
 *
 * **Hours combine, support adds.** A day's hours are the earliest start and the
 * latest finish of the activities there that day, or the shift's own hours.
 * Support is counted per day, adding the activities together, and the busiest
 * day is what is asked for. A witness is never on the form; ROC goes on the OCC
 * line and every other code on Technical Support (Systems).
 *
 * **Nothing is guessed.** An activity whose location is not linked to the
 * track plan, and a colour the legend does not know, are flags that stop the
 * request being submitted or approved.
 *
 * What Track-Plan adds: the **place is the track plan link**, so the Area is
 * written from it, and two requests in one week and shift whose places overlap
 * on the drawing are named to each other (`overlaps`) so the track allocation
 * manager can **consolidate** them into one (`merges`) before they go to BART —
 * no repetition.
 *
 * **A TCR and track are never one request** — different categories of work. An
 * activity linked to both makes two requests, one per part of its link
 * (`linkParts`): "Colma TCR", and "W1+W2+W3 MP 23.747-24.446", the track limits
 * accumulated from the leftmost milepost to the rightmost. Its BART support is
 * asked for once, on the track request, and the TCR request says so.
 *
 * Pure: no DOM, no network, so `tests/test_tawr.mjs` runs it in Node.
 *
 * Imports: lookahead, links.
 */

import {
  DEFAULT_LEGEND, legendMap, shiftOfMeaning, orderedRows, cellList, resourcesOf,
  cellTokens, isCancelMeaning, resourceNames,
} from './lookahead.js';
import {
  hasLink, linkForLocation, resolveLocationText, unionLinks, unionArea, linksOverlap,
  shortLocationName, limitsText, linkParts, partKey, partArea, PART_KINDS,
} from './links.js';

export { PART_KINDS };

export { shiftOfMeaning };

/** How many days before the work the request has to be in. */
export const TAWR_LEAD_DAYS = 17;

/**
 * Every field on BART's form, by the name it carries in the PDF:
 * `[name, kind, label]`, kind being text, check, choice or sig. The template an
 * administrator uploads is checked against this list, so a revised form that
 * renamed a box is reported rather than filled half way.
 */
export const TAWR_FIELDS = [
  ['advisory_no_work_clearance', 'check', 'Advisory (No Work Clearance)'],
  ['clearance_verification_no', 'check', 'Clearance Verification: No'],
  ['clearance_verification_yes', 'check', 'Clearance Verification: Yes'],
  ['coordinate_hirail_passage', 'check', 'Coordinate Hi-Rail Passage'],
  ['no_passage_hirail_vehicles', 'check', 'No Passage of Hi-Rail Vehicles'],
  ['police_advisory_threat_of_theft', 'check', 'Police Advisory (Threat of Theft)'],
  ['schedule_number', 'text', 'Schedule Number'],
  ['track_inspection_first_train_no', 'check', 'Track Inspection (with 1st Train): No'],
  ['track_inspection_first_train_yes', 'check', 'Track Inspection (with 1st Train): Yes'],
  ['work_in_track_zone_no', 'check', 'Work/Activity in Track Zone: No'],
  ['work_in_track_zone_yes', 'check', 'Work/Activity in Track Zone: Yes'],
  ['person_in_charge_cell_phone', 'text', 'Person in Charge Cell Phone'],
  ['person_in_charge_name', 'text', 'Person in Charge'],
  ['project_rep_cell_phone', 'text', 'Project Representative Cell Phone'],
  ['project_rep_name', 'text', 'Project Representative'],
  ['project_rep_signature', 'sig', 'Project Representative Signature'],
  ['requestor_cell_phone', 'text', 'Requestor Cell Phone'],
  ['requestor_name', 'text', 'Requestor'],
  ['requestor_signature', 'sig', 'Requestor Signature'],
  ['category_of_work', 'choice', 'Category of Work (A, B, C, F, P, BL, Y)'],
  ['work_description', 'text', 'Work Description'],
  ['row1_area', 'text', 'Row 1 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row1_date', 'text', 'Row 1 Date'],
  ['row1_day', 'choice', 'Row 1 Day'],
  ['row1_power_na', 'check', 'Row 1 Power Status: N/A'],
  ['row1_power_off', 'check', 'Row 1 Power Status: OFF'],
  ['row1_power_on', 'check', 'Row 1 Power Status: ON'],
  ['row1_safe_clear_rail_sections', 'text', 'Row 1 Safe Clear Rail Section(s)'],
  ['row1_time_end', 'text', 'Row 1 End Time'],
  ['row1_time_start', 'text', 'Row 1 Start Time'],
  ['row2_area', 'text', 'Row 2 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row2_date', 'text', 'Row 2 Date'],
  ['row2_day', 'choice', 'Row 2 Day'],
  ['row2_power_na', 'check', 'Row 2 Power Status: N/A'],
  ['row2_power_off', 'check', 'Row 2 Power Status: OFF'],
  ['row2_power_on', 'check', 'Row 2 Power Status: ON'],
  ['row2_safe_clear_rail_sections', 'text', 'Row 2 Safe Clear Rail Section(s)'],
  ['row2_time_end', 'text', 'Row 2 End Time'],
  ['row2_time_start', 'text', 'Row 2 Start Time'],
  ['row3_area', 'text', 'Row 3 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row3_date', 'text', 'Row 3 Date'],
  ['row3_day', 'choice', 'Row 3 Day'],
  ['row3_power_na', 'check', 'Row 3 Power Status: N/A'],
  ['row3_power_off', 'check', 'Row 3 Power Status: OFF'],
  ['row3_power_on', 'check', 'Row 3 Power Status: ON'],
  ['row3_safe_clear_rail_sections', 'text', 'Row 3 Safe Clear Rail Section(s)'],
  ['row3_time_end', 'text', 'Row 3 End Time'],
  ['row3_time_start', 'text', 'Row 3 Start Time'],
  ['row4_area', 'text', 'Row 4 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row4_date', 'text', 'Row 4 Date'],
  ['row4_day', 'choice', 'Row 4 Day'],
  ['row4_power_na', 'check', 'Row 4 Power Status: N/A'],
  ['row4_power_off', 'check', 'Row 4 Power Status: OFF'],
  ['row4_power_on', 'check', 'Row 4 Power Status: ON'],
  ['row4_safe_clear_rail_sections', 'text', 'Row 4 Safe Clear Rail Section(s)'],
  ['row4_time_end', 'text', 'Row 4 End Time'],
  ['row4_time_start', 'text', 'Row 4 Start Time'],
  ['row5_area', 'text', 'Row 5 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row5_date', 'text', 'Row 5 Date'],
  ['row5_day', 'choice', 'Row 5 Day'],
  ['row5_power_na', 'check', 'Row 5 Power Status: N/A'],
  ['row5_power_off', 'check', 'Row 5 Power Status: OFF'],
  ['row5_power_on', 'check', 'Row 5 Power Status: ON'],
  ['row5_safe_clear_rail_sections', 'text', 'Row 5 Safe Clear Rail Section(s)'],
  ['row5_time_end', 'text', 'Row 5 End Time'],
  ['row5_time_start', 'text', 'Row 5 Start Time'],
  ['row6_area', 'text', 'Row 6 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row6_date', 'text', 'Row 6 Date'],
  ['row6_day', 'choice', 'Row 6 Day'],
  ['row6_power_na', 'check', 'Row 6 Power Status: N/A'],
  ['row6_power_off', 'check', 'Row 6 Power Status: OFF'],
  ['row6_power_on', 'check', 'Row 6 Power Status: ON'],
  ['row6_safe_clear_rail_sections', 'text', 'Row 6 Safe Clear Rail Section(s)'],
  ['row6_time_end', 'text', 'Row 6 End Time'],
  ['row6_time_start', 'text', 'Row 6 Start Time'],
  ['row7_area', 'text', 'Row 7 Area (Tracks, Mileposts, Gates, Stations)'],
  ['row7_date', 'text', 'Row 7 Date'],
  ['row7_day', 'choice', 'Row 7 Day'],
  ['row7_power_na', 'check', 'Row 7 Power Status: N/A'],
  ['row7_power_off', 'check', 'Row 7 Power Status: OFF'],
  ['row7_power_on', 'check', 'Row 7 Power Status: ON'],
  ['row7_safe_clear_rail_sections', 'text', 'Row 7 Safe Clear Rail Section(s)'],
  ['row7_time_end', 'text', 'Row 7 End Time'],
  ['row7_time_start', 'text', 'Row 7 Start Time'],
  ['maint_operating_bulletin_details', 'text', 'Operating Bulletin # (details)'],
  ['maint_operating_bulletin_req', 'check', 'Operating Bulletin # (checkbox)'],
  ['maint_physical_barrier_details', 'text', 'Physical Barrier Req. (Please Attach) (details)'],
  ['maint_physical_barrier_req', 'check', 'Physical Barrier Req. (Please Attach) (checkbox)'],
  ['maint_power_tech_support_details', 'text', 'Technical Support (Power & Mechanical) (details)'],
  ['maint_power_tech_support_req', 'check', 'Technical Support (Power & Mechanical) (checkbox)'],
  ['maint_rail_bond_cbond_details', 'text', 'Rail Bond/C-Bond (details)'],
  ['maint_rail_bond_cbond_req', 'check', 'Rail Bond/C-Bond (checkbox)'],
  ['maint_route_prohibit_details', 'text', 'Route Prohibit (details)'],
  ['maint_route_prohibit_req', 'check', 'Route Prohibit (checkbox)'],
  ['maint_safe_clearance_details', 'text', 'Safe Clearance (details)'],
  ['maint_safe_clearance_req', 'check', 'Safe Clearance (checkbox)'],
  ['maint_safety_dept_details', 'text', 'Safety Dept. (details)'],
  ['maint_safety_dept_req', 'check', 'Safety Dept. (checkbox)'],
  ['maint_safety_monitor_details', 'text', 'Safety Monitor (details)'],
  ['maint_safety_monitor_req', 'check', 'Safety Monitor (checkbox)'],
  ['maint_speed_restriction_details', 'text', 'Speed Restriction (details)'],
  ['maint_speed_restriction_req', 'check', 'Speed Restriction (checkbox)'],
  ['maint_systems_tech_support_details', 'text', 'Technical Support (Systems) (details)'],
  ['maint_systems_tech_support_req', 'check', 'Technical Support (Systems) (checkbox)'],
  ['maint_vehicle_equipment_details', 'text', 'Vehicle Equipment (details)'],
  ['maint_vehicle_equipment_req', 'check', 'Vehicle Equipment (checkbox)'],
  ['maint_vehicle_tech_support_details', 'text', 'Technical Support (Vehicle) (details)'],
  ['maint_vehicle_tech_support_req', 'check', 'Technical Support (Vehicle) (checkbox)'],
  ['trans_adverse_impact_blanket_details', 'text', 'Adverse Impact to Blanket (details)'],
  ['trans_adverse_impact_blanket_req', 'check', 'Adverse Impact to Blanket (checkbox)'],
  ['trans_occ_support_details', 'text', 'OCC Support (details)'],
  ['trans_occ_support_req', 'check', 'OCC Support (checkbox)'],
  ['trans_passenger_bulletin_req', 'check', 'Passenger Bulletin (checkbox)'],
  ['trans_public_notice', 'text', 'Public Notice'],
  ['trans_single_tracking_details', 'text', 'Single Tracking (details)'],
  ['trans_single_tracking_req', 'check', 'Single Tracking (checkbox)'],
  ['trans_sswp_iop_required_req', 'check', 'SSWP/IOP Required (Please Attach) (checkbox)'],
  ['trans_train_operators_details', 'text', 'Train Operator(s) (details)'],
  ['trans_train_operators_req', 'check', 'Train Operator(s) (checkbox)'],
  ['trans_train_required_details', 'text', 'Train Required (details)'],
  ['trans_train_required_req', 'check', 'Train Required (checkbox)'],
  ['trans_yard_line_support_details', 'text', 'Yard/Line Support (details)'],
  ['trans_yard_line_support_req', 'check', 'Yard/Line Support (checkbox)'],
  ['appr_ops_planning_date', 'text', 'Operations Planning Date'],
  ['appr_ops_planning_signature', 'text', 'Operations Planning Signature'],
  ['appr_power_mech_date', 'text', 'Power & Mechanical Support Date'],
  ['appr_power_mech_signature', 'text', 'Power & Mechanical Support Signature'],
  ['appr_safety_dept_date', 'text', 'Safety Department Date'],
  ['appr_safety_dept_signature', 'text', 'Safety Department Signature'],
  ['appr_safety_monitor_supv_date', 'text', 'Safety Monitor Supervisor Date'],
  ['appr_safety_monitor_supv_signature', 'text', 'Safety Monitor Supervisor Signature'],
  ['appr_systems_maint_date', 'text', 'Systems Maintenance Support Date'],
  ['appr_systems_maint_signature', 'text', 'Systems Maintenance Support Signature'],
  ['appr_ta_committee_chair_date', 'text', 'TA Committee Chairperson Date'],
  ['appr_ta_committee_chair_signature', 'text', 'TA Committee Chairperson Signature'],
  ['appr_transportation_occ_date', 'text', 'Transportation OCC Date'],
  ['appr_transportation_occ_signature', 'text', 'Transportation OCC Signature'],
  ['appr_way_facilities_date', 'text', 'Way & Facilities Support Date'],
  ['appr_way_facilities_signature', 'text', 'Way & Facilities Support Signature'],
  ['appr_yard_admin_line_mgr_date', 'text', 'Yard Administrator / Line Mgr. Date'],
  ['appr_yard_admin_line_mgr_signature', 'text', 'Yard Administrator / Line Mgr. Signature'],
];

export const FIELD_KIND = new Map(TAWR_FIELDS.map(([name, kind]) => [name, kind]));
export const FIELD_LABEL = new Map(TAWR_FIELDS.map(([name, , label]) => [name, label]));

/** The rows the form has for dates. */
export const FORM_ROWS = 7;

/** The shifts a request is split by, in the order they are listed. */
export const TAWR_SHIFTS = [
  { id: 'day', label: 'Day' },
  { id: 'swing', label: 'Swing' },
  { id: 'night', label: 'Night' },
  { id: 'possession', label: 'Blanket' },
  { id: 'unmapped', label: 'Unmapped colour' },
];

export function tawrShiftLabel(id) {
  return TAWR_SHIFTS.find((s) => s.id === id)?.label || id || '';
}

/**
 * The hours a shift works when the sheet does not say. By the shift, not the
 * colour: a colour is re-mapped in Legend, and the hours must not move with it.
 */
export const DEFAULT_SHIFT_HOURS = {
  day: '0700-1500',
  swing: '1500-2300',
  night: '2200-0600',
  possession: '0000-0800',
};

/* ── Hours ─────────────────────────────────────────────────────────────── */

/**
 * "0700-1500", "07:00 – 15:30", "7:00-15:00", "2200-0600" → minutes from
 * midnight, `{ start, end }`; null for anything else. An end before the start
 * is the next morning, which is what a night shift writes.
 */
export function parseHours(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):?(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):?(\d{2})$/i);
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  return { start: (h1 % 24) * 60 + m1, end: (h2 % 24) * 60 + m2 };
}

/** Minutes from midnight as the form writes a time: 420 → "0700". */
export function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/**
 * The earliest start and latest finish of several ranges on one day.
 *
 * Each range is laid on a line that runs past midnight, so 2200–0600 ends at
 * 30:00 and outlasts 2300–0500. On a night shift a start in the small hours is
 * that same night continuing, not the morning before it.
 */
export function combineHours(ranges, shift) {
  let start = Infinity;
  let end = -Infinity;
  for (const r of ranges || []) {
    if (!r) continue;
    let s = r.start;
    let e = r.end <= r.start ? r.end + 1440 : r.end;
    if (shift === 'night' && s < 720) { s += 1440; e += 1440; }
    if (s < start) start = s;
    if (e > end) end = e;
  }
  if (!Number.isFinite(start)) return null;
  return { start: start % 1440, end: end % 1440 };
}

/* ── Dates ─────────────────────────────────────────────────────────────── */

const DAY_MS = 86400000;
const msOf = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDaysISO(iso, n) {
  return isoOf(msOf(iso) + n * DAY_MS);
}

export function mondayOf(iso) {
  const ms = msOf(iso);
  return isoOf(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

/** The form's own spelling of a weekday, as its Day dropdown offers them. */
const FORM_DAYS = ['SUN', 'MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT'];

export function formDay(iso) {
  return FORM_DAYS[new Date(msOf(iso)).getUTCDay()];
}

/** "2026-10-19" → "10/19/2026" — the mm/dd/yyyy BART's date boxes check for. */
export function formDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

/** The last day the request can go in: seventeen calendar days before its first day. */
export function tawrDeadline(firstISO) {
  return addDaysISO(firstISO, -TAWR_LEAD_DAYS);
}

/**
 * How the deadline stands today: `{ deadline, daysLeft, tone, label }`. Tone
 * is `bad` once it has passed, `warn` inside three days, `ok` otherwise.
 */
export function deadlineState(firstISO, todayISO) {
  const deadline = tawrDeadline(firstISO);
  const daysLeft = Math.round((msOf(deadline) - msOf(todayISO)) / DAY_MS);
  const tone = daysLeft < 0 ? 'bad' : daysLeft <= 3 ? 'warn' : 'ok';
  const label = daysLeft < 0
    ? `Overdue by ${-daysLeft} day${daysLeft === -1 ? '' : 's'}`
    : daysLeft === 0 ? 'Due today' : `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  return { deadline, daysLeft, tone, label };
}

/* ── Reading a week ────────────────────────────────────────────────────── */

/** Case and punctuation only — the fold every register in the calendar uses. */
export function fold(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The lines of the form a support code can go on, as the register offers them. */
export const TAWR_LINES = [
  { value: 'systems', label: 'Technical Support (Systems)' },
  { value: 'occ', label: 'OCC Support' },
  { value: 'none', label: 'Not on the form' },
];

/** Which form line a support code goes on: `systems`, `occ` or `none`. */
export function lineOfCode(code, register) {
  const entry = register?.get(String(code).toUpperCase());
  if (entry?.tawr_line) return entry.tawr_line;
  if (String(code).toUpperCase() === 'WIT') return 'none';
  if (String(code).toUpperCase() === 'ROC') return 'occ';
  return 'systems';
}

function codeRegister(codes) {
  const map = new Map();
  for (const c of codes || []) if (c?.code) map.set(String(c.code).toUpperCase(), c);
  return map;
}

/* ── Reading a week ────────────────────────────────────────────────────── */

/**
 * Where an activity is, as the TAWR knows it: its track plan link, or the
 * location typed in its Location cell where that names a station, TCR, yard or
 * platform exactly. `how` is `map`, `typed` or null (not linked).
 */
export function placeOf(row, locations = []) {
  if (hasLink(row?.link)) return { link: row.link, how: 'map' };
  const loc = resolveLocationText(row?.location, locations);
  return loc ? { link: linkForLocation(loc), how: 'typed' } : { link: null, how: null };
}

/**
 * Every request a week of the look-ahead calls for.
 *
 *   model          the look-ahead (`lookahead.js` rows and cells)
 *   weekStart      the Monday, as an ISO date
 *   legend         the shift colours
 *   codes          the support code register
 *   locations      the track plan's stations, TCRs, yards and platforms —
 *                  for a location typed rather than picked on the map
 *   descriptions   `[{ activity, description }]` — the expanded wording
 *   shiftHours     `{ day, swing, night, possession }` — "0700-1500"
 *   merges         `[{ id, week_start, keys }]` — requests the track allocation
 *                  manager consolidated into one
 *
 * Answers `{ groups }`. Each group is one request: its key (place and shift, or
 * the consolidation), its place and Area, the activities with their days and
 * crews, one entry per day worked with its combined hours, the support asked
 * for, the SSWP numbers, the work description, the other requests it overlaps,
 * and its flags.
 *
 * @param {{ rows: any[], cells: Map<string, any> }} model
 * @param {string} weekStart
 * @param {{ legend?: any[], codes?: any[], locations?: any[], descriptions?: any[], shiftHours?: object, merges?: any[] }} [options]
 */
export function extractWeek(model, weekStart, {
  legend = DEFAULT_LEGEND, codes = [], locations = [], descriptions = [], shiftHours = DEFAULT_SHIFT_HOURS, merges = [],
} = {}) {
  const colours = legendMap(legend);
  const register = codeRegister(codes);
  const expanded = new Map((descriptions || []).map((d) => [fold(d.activity), String(d.description || '').trim()]));
  const weekEnd = addDaysISO(weekStart, 6);

  const weekCells = new Map(); // row id -> Map(day -> cell)
  for (const c of cellList(model)) {
    if (c.day < weekStart || c.day > weekEnd) continue;
    if (!weekCells.has(c.row_id)) weekCells.set(c.row_id, new Map());
    weekCells.get(c.row_id).set(c.day, c);
  }
  const cellsOf = (id) => weekCells.get(id) || new Map();

  const raw = new Map();
  orderedRows(model.rows).forEach((row, order) => {
    if (row.kind !== 'activity') return;
    const title = String(row.description || '').trim() || String(row.activity_id || '').trim();
    if (!title) return; // a row of paint with no description is not an activity
    const rawLocation = String(row.location || '').trim();
    const { link, how } = placeOf(row, locations);
    const parts = link ? linkParts(link) : [null];
    // The support typed on the day is asked for once: with the track, where there is track.
    const supportPart = parts.find((p) => p?.kind === 'track') || parts[0];
    const resources = resourcesOf(model, row.id);

    /* The paint says the shift. The workbook sometimes paints the Resource row
       instead of the activity, so either one's paint counts; the activity
       line's own wins, being last. Its text never does — those are names. */
    const paintAt = new Map();
    for (const r of resources) for (const [day, c] of cellsOf(r.id)) if (c.color) paintAt.set(day, c);
    for (const [day, c] of cellsOf(row.id)) if (c.color) paintAt.set(day, c);

    for (const [date, c] of [...paintAt].sort((a, b) => a[0].localeCompare(b[0]))) {
      const entry = colours.get(String(c.color).toUpperCase());
      if (entry && entry.role && entry.role !== 'shift') continue; // shading, not work
      const meaning = entry?.meaning || null;
      if (isCancelMeaning(meaning)) continue; // a cancelled day asks for nothing
      const shift = shiftOfMeaning(meaning) || 'unmapped';
      for (const part of parts) {
        const key = `${part ? partKey(part) : `raw:${fold(rawLocation)}`}|${shift}`;
        if (!raw.has(key)) {
          raw.set(key, {
            key, weekStart, shift, kind: part?.kind || 'unlinked', members: [key], mergeId: null,
            activities: new Map(), days: new Map(), unmappedColours: new Set(), supportElsewhere: new Map(),
          });
        }
        const group = raw.get(key);
        if (shift === 'unmapped') group.unmappedColours.add(String(c.color).toUpperCase());
        if (!group.activities.has(row.id)) {
          group.activities.set(row.id, {
            row: row.id, order, title, activityId: String(row.activity_id || '').trim(),
            party: String(row.party || '').trim(), sswp: String(row.sswp || '').trim(),
            hoursText: String(row.work_hours || '').trim(), rawLocation, link: part, how, days: [], crew: new Set(),
          });
        }
        const act = group.activities.get(row.id);
        act.days.push(date);
        for (const r of resources) for (const n of resourceNames(cellsOf(r.id).get(date)?.text || '')) act.crew.add(n);
        if (!group.days.has(date)) group.days.set(date, []);
        const counts = new Map();
        for (const t of cellTokens(cellsOf(row.id).get(date)?.text || '')) {
          if (!t.cancelled) counts.set(t.code, (counts.get(t.code) || 0) + 1);
        }
        if (part !== supportPart && counts.size) {
          group.supportElsewhere.set(title, partArea(supportPart));
          counts.clear();
        }
        group.days.get(date).push({ row: row.id, hoursText: act.hoursText, counts });
      }
    }
  });

  /* Consolidations: the requests the track allocation manager made one. Only
     within a shift — a form row is one day's start and finish — and within a
     kind: a TCR and track are never one request. */
  for (const m of merges || []) {
    if (m.week_start !== weekStart) continue;
    const present = (m.keys || []).filter((k) => raw.has(k));
    if (!present.length) continue;
    const first = raw.get(present[0]);
    const into = {
      key: `merge:${m.id}`, weekStart, shift: first.shift, kind: first.kind, members: [], mergeId: m.id,
      activities: new Map(), days: new Map(), unmappedColours: new Set(), supportElsewhere: new Map(),
    };
    for (const k of present) {
      const g = raw.get(k);
      if (g.shift !== into.shift || g.kind !== into.kind) continue;
      raw.delete(k);
      into.members.push(k);
      for (const [id, a] of g.activities) {
        const held = into.activities.get(id);
        if (held) { held.days.push(...a.days); for (const n of a.crew) held.crew.add(n); } else into.activities.set(id, a);
      }
      for (const [date, entries] of g.days) into.days.set(date, [...(into.days.get(date) || []), ...entries]);
      for (const h of g.unmappedColours) into.unmappedColours.add(h);
      for (const [t, where] of g.supportElsewhere) into.supportElsewhere.set(t, where);
    }
    into.missing = (m.keys || []).filter((k) => !into.members.includes(k));
    raw.set(into.key, into);
  }

  const out = [...raw.values()].map((g) => finish(g, { register, expanded, shiftHours }));

  /* Requests whose places overlap, in the same shift and of the same kind:
     offered for consolidation. */
  const cache = new WeakMap();
  for (const a of out) {
    for (const b of out) {
      if (a === b || a.shift !== b.shift || a.kind !== b.kind) continue;
      const touch = a.activities.some((x) => b.activities.some((y) => linksOverlap(x.link, y.link, cache)));
      if (!touch) continue;
      const shared = a.days.map((d) => d.date).filter((d) => b.days.some((e) => e.date === d));
      a.overlaps.push({ key: b.key, locationName: b.locationName, days: shared });
    }
  }

  const SHIFT_ORDER = TAWR_SHIFTS.map((s) => s.id);
  out.sort((a, b) => a.locationName.localeCompare(b.locationName)
    || SHIFT_ORDER.indexOf(a.shift) - SHIFT_ORDER.indexOf(b.shift));
  return { groups: out };
}

function finish(g, { register, expanded, shiftHours }) {
  const flags = [];
  const activities = [...g.activities.values()];
  for (const a of activities) a.days = [...new Set(a.days)].sort();
  activities.sort((a, b) => a.order - b.order); // as the sheet lists them

  for (const a of activities) {
    if (a.link) continue;
    if (!a.rawLocation) {
      flags.push({ kind: 'no_location', blocking: true, row: a.row,
        message: `"${a.title}" has no location. Right-click its Location cell on the look-ahead and choose Select on track plan.` });
    } else {
      flags.push({ kind: 'location_unlinked', blocking: true, row: a.row,
        message: `"${a.rawLocation}" (${a.title}) is not linked to the track plan. Right-click its Location cell and choose Select on track plan.` });
    }
  }
  if (g.shift === 'unmapped') {
    flags.push({ kind: 'colour_unmapped', blocking: true,
      message: `Painted in a colour the legend does not know (${[...g.unmappedColours].map((h) => `#${h}`).join(', ')}). Say what it is in Setup → Legend, or repaint it.` });
  }
  for (const [title, where] of g.supportElsewhere || []) {
    flags.push({ kind: 'support_on_track', blocking: false,
      message: `The BART support typed for "${title}" is asked for on its track request (${where}), not here — a TCR and track are separate requests. Add it in Review if the room needs its own.` });
  }
  if (g.missing?.length) {
    flags.push({ kind: 'merge_partial', blocking: false,
      message: `${g.missing.length} of the requests consolidated here ${g.missing.length === 1 ? 'is' : 'are'} no longer on the look-ahead this week.` });
  }

  /* Hours, a day at a time. */
  const unreadable = new Set();
  const fallback = parseHours(shiftHours?.[g.shift] || DEFAULT_SHIFT_HOURS[g.shift] || '');
  const days = [...g.days.keys()].sort().map((date) => {
    const entries = g.days.get(date);
    let fromShift = false;
    const ranges = entries.map((e) => {
      const read = parseHours(e.hoursText);
      if (read) return read;
      if (e.hoursText) unreadable.add(e.hoursText);
      fromShift = true;
      return fallback;
    });
    const hours = combineHours(ranges, g.shift);
    return {
      date,
      start: hours ? hhmm(hours.start) : '',
      end: hours ? hhmm(hours.end) : '',
      fromShift,
      rows: [...new Set(entries.map((e) => e.row))],
    };
  });
  for (const text of unreadable) {
    flags.push({ kind: 'hours_unreadable', blocking: false,
      message: `Could not read the work hours "${text}"; the shift's hours were used instead.` });
  }
  if (days.some((d) => !d.start)) {
    flags.push({ kind: 'hours_missing', blocking: false,
      message: 'No hours for some days — the shift has no default hours. Fill them in.' });
  }
  if (days.length > FORM_ROWS) {
    flags.push({ kind: 'too_many_days', blocking: false,
      message: `${days.length} day rows; the form has ${FORM_ROWS}.` });
  }

  /* Support: per day, the activities added together; the busiest day is asked for. */
  const peak = new Map();
  for (const entries of g.days.values()) {
    const day = new Map();
    for (const e of entries) for (const [code, n] of e.counts) day.set(code, (day.get(code) || 0) + n);
    for (const [code, n] of day) peak.set(code, Math.max(peak.get(code) || 0, n));
  }
  const support = [];
  const unknownCodes = [];
  for (const [code, count] of peak) {
    const line = lineOfCode(code, register);
    if (!register.has(code)) unknownCodes.push(code);
    if (line === 'none') continue;
    const entry = register.get(code);
    support.push({ code, count, line, label: String(entry?.name || '').trim() || code });
  }
  support.sort((a, b) => (register.get(a.code)?.sort ?? 999) - (register.get(b.code)?.sort ?? 999) || a.code.localeCompare(b.code));
  if (unknownCodes.length) {
    flags.push({ kind: 'code_unknown', blocking: false,
      message: `Support code${unknownCodes.length === 1 ? '' : 's'} not in the register: ${unknownCodes.join(', ')} — listed under Technical Support. Add ${unknownCodes.length === 1 ? 'it' : 'them'} in Setup → Support codes.` });
  }

  const sswp = [...new Set(activities.map((a) => a.sswp).filter(Boolean))];

  /* The description of work: each activity once, with the wording mapped to it. */
  const seen = new Set();
  const lines = [];
  const unexpanded = [];
  for (const a of activities) {
    const k = fold(a.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const more = expanded.get(k);
    if (more) lines.push(`${a.title} — ${more}`);
    else { lines.push(a.title); unexpanded.push(a.title); }
  }

  const links = activities.map((a) => a.link).filter(Boolean);
  const place = unionLinks(links);
  const unlinked = [...new Set(activities.filter((a) => !a.link).map((a) => a.rawLocation).filter(Boolean))];
  const named = place.places.map((p) => shortLocationName(p.name));
  const locationName = named.length ? named.join(' / ')
    : place.limits.length ? limitsText(place.limits, { dash: '–' })
      : unlinked[0] || '(no location)';
  const area = [unionArea(links), ...unlinked].filter(Boolean).join('; ') || locationName;

  return {
    key: g.key,
    weekStart: g.weekStart,
    shift: g.shift,
    kind: g.kind,
    members: g.members,
    mergeId: g.mergeId,
    locationName,
    area,
    place: { places: place.places, limits: place.limits, geometry: place.geometry },
    activities: activities.map((a) => ({
      row: a.row, title: a.title, activityId: a.activityId, party: a.party, sswp: a.sswp, hoursText: a.hoursText,
      rawLocation: a.rawLocation, link: a.link, how: a.how, days: a.days, crew: [...a.crew].sort(),
    })),
    days,
    firstDay: days[0]?.date || g.weekStart,
    support,
    sswp,
    description: lines.join('\n'),
    unexpanded,
    overlaps: [],
    flags,
  };
}

/** The Mondays of every week that has a painted day in the look-ahead, in order. */
export function weeksWithWork(model) {
  const out = new Set();
  for (const c of cellList(model)) if (c.color) out.add(mondayOf(c.day));
  return [...out].sort();
}

/* ── The form ──────────────────────────────────────────────────────────── */

/** Setup's Category of Work for a kind of request; F unless somebody said otherwise. */
export function categoryFor(kind, settings = {}) {
  const own = kind === 'track' ? settings.category_track : kind === 'tcr' ? settings.category_tcr : null;
  return String(own || settings.category_default || 'F');
}

const supportText = (items) => items.map((s) => (s.count > 1 ? `${s.count} x ${s.label}` : s.label)).join(', ');

/**
 * The value of every field the request fills, `{ field: string | boolean }`.
 *
 * `settings` carries the contacts that are the same on every request (person
 * in charge, project representative); `profile` is the administrator raising
 * it — their name and cell phone go in as the requestor, and their signature is
 * drawn at export, not stored as a field. What the look-ahead cannot say is set
 * to the answer agreed for it: clearance verification and first-train
 * inspection No, power N/A. The kind of request decides the rest — a track
 * request is work in the track zone and takes Setup's category for track work,
 * a TCR request is not and takes the one for TCR work (`categoryFor`).
 * Everything left out stays blank for a person to fill.
 *
 * @param {object} group
 * @param {{ settings?: Object<string, any>, profile?: Object<string, any> }} [options]
 */
export function formValues(group, { settings = {}, profile = {} } = {}) {
  const track = group.kind === 'track';
  const v = {
    [track ? 'work_in_track_zone_yes' : 'work_in_track_zone_no']: true,
    clearance_verification_no: true,
    track_inspection_first_train_no: true,
    category_of_work: categoryFor(group.kind, settings),
    work_description: group.description,
    requestor_name: String(profile.requestor_name || ''),
    requestor_cell_phone: String(profile.cell_phone || ''),
    person_in_charge_name: String(settings.person_in_charge_name || ''),
    person_in_charge_cell_phone: String(settings.person_in_charge_cell_phone || ''),
    project_rep_name: String(settings.project_rep_name || ''),
    project_rep_cell_phone: String(settings.project_rep_cell_phone || ''),
  };
  group.days.slice(0, FORM_ROWS).forEach((d, i) => {
    const n = i + 1;
    v[`row${n}_date`] = formDate(d.date);
    v[`row${n}_day`] = formDay(d.date);
    v[`row${n}_time_start`] = d.start;
    v[`row${n}_time_end`] = d.end;
    v[`row${n}_area`] = group.area;
    v[`row${n}_power_na`] = true;
  });
  const systems = group.support.filter((s) => s.line === 'systems');
  const occ = group.support.filter((s) => s.line === 'occ');
  if (systems.length) {
    v.maint_systems_tech_support_req = true;
    v.maint_systems_tech_support_details = supportText(systems);
  }
  if (occ.length) {
    v.trans_occ_support_req = true;
    v.trans_occ_support_details = supportText(occ);
  }
  if (group.sswp.length) {
    v.trans_sswp_iop_required_req = true;
    // The SSWP box has no line of its own; the one beside it is the bottom line.
    v.trans_adverse_impact_blanket_details = `SSWP# ${group.sswp.map((s) => s.replace(/^sswp\s*#?\s*/i, '')).join(', ')}`;
  }
  return v;
}

/** The fields the look-ahead decides — what "changed since approval" compares. */
export function fromLookahead(name) {
  return /^row\d_/.test(name)
    || ['work_description', 'maint_systems_tech_support_req', 'maint_systems_tech_support_details',
      'trans_occ_support_req', 'trans_occ_support_details', 'trans_sswp_iop_required_req',
      'trans_adverse_impact_blanket_details'].includes(name);
}

const same = (a, b) => (a ?? '') === (b ?? '') || (a === false && b == null) || (a == null && b === false);

/** The fields somebody changed by hand: where the value is not what was generated. */
export function editedKeys(fields, generated) {
  const keys = new Set([...Object.keys(fields || {}), ...Object.keys(generated || {})]);
  return [...keys].filter((k) => !same(fields?.[k], generated?.[k])).sort();
}

/**
 * A draft brought up to date with a fresh reading: every field nobody edited
 * takes the new value, every edit is kept, and an edit whose generated value
 * moved underneath it is named in `conflicts` so the review can say so.
 */
export function mergeRegenerated({ fields = {}, generated = {} }, fresh) {
  const edited = new Set(editedKeys(fields, generated));
  const next = {};
  const conflicts = [];
  for (const k of new Set([...Object.keys(fresh), ...Object.keys(fields)])) {
    if (edited.has(k)) {
      next[k] = fields[k];
      if (!same(generated[k], fresh[k])) conflicts.push(k);
    } else if (fresh[k] !== undefined && fresh[k] !== '' && fresh[k] !== false) next[k] = fresh[k];
  }
  return { fields: next, generated: fresh, conflicts: conflicts.sort() };
}

/** What the look-ahead now says differently from what was approved. */
export function changedSince(generated, fresh) {
  const keys = new Set([...Object.keys(generated || {}), ...Object.keys(fresh || {})]);
  return [...keys].filter((k) => fromLookahead(k) && !same(generated?.[k], fresh?.[k])).sort();
}

/** Whether a request may be approved: no blocking flag. */
export function blockers(group) {
  return (group?.flags || []).filter((f) => f.blocking);
}

/** "TAWR 2026-10-19 Train Control Room Day.pdf" — safe on every file system. */
export function tawrFileName({ weekStart, locationName, shift }) {
  const name = `TAWR ${weekStart} ${locationName} ${tawrShiftLabel(shift)}`;
  // Plain characters only: a dash or a quote some file system or browser refuses is a download called "download".
  return `${name.replace(/[\u2010-\u2015]/g, '-').replace(/[^\x20-\x7e]+/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()}.pdf`;
}

/* ── The request's life ─────────────────────────────────────────────────── */

/*
 * Who may do what to a request, and from which status, is one table —
 * `web/data/tawr_workflow.json` — read by this module in the browser and by
 * `server.py`, which is where it is enforced. The screen only offers what the
 * table allows; the server refuses anything else.
 */

/** Whether `role` may take `action` on a request in `status`. */
export function may(workflow, role, action, status) {
  const a = workflow?.actions?.[action];
  return Boolean(a && a.roles.includes(role) && (status == null || a.from.includes(status)));
}

/** The actions open to `role` on a request in `status`, in the table's order. */
export function actionsFor(workflow, role, status) {
  return Object.keys(workflow?.actions || {}).filter((k) => may(workflow, role, k, status));
}

/** Whether `role` may change a request's fields in `status`. */
export function canEdit(workflow, role, status) {
  return Boolean(workflow?.edit?.[status]?.includes(role));
}

/** Whether `role` may change the look-ahead, the setup and raise drafts. */
export function canWrite(workflow, role) {
  return Boolean(workflow?.write?.includes(role));
}

/**
 * The weeks whose drafts should exist by now: the deadline (seventeen days
 * before the Monday) is no more than `leadDays` away, and the week has not
 * ended. A draft appears `leadDays` before it is due, so there is time to
 * review it; an overdue week still gets its draft, marked overdue.
 */
export function weeksToRaise(weeks, todayISO, leadDays = 7) {
  return (weeks || []).filter((w) => addDaysISO(tawrDeadline(w), -leadDays) <= todayISO && addDaysISO(w, 6) >= todayISO);
}

/**
 * The week whose requests are being prepared now: the first whose deadline has
 * not passed. The look-ahead highlights it.
 */
export function dueWeek(todayISO) {
  let w = mondayOf(todayISO);
  while (tawrDeadline(w) < todayISO) w = addDaysISO(w, 7);
  return w;
}

/**
 * Approved requests that would go to BART twice for the same thing: the same
 * shift, places that overlap, on a day in common. Each pair once.
 */
export function repetitions(records) {
  const out = [];
  const cache = new WeakMap();
  const live = (records || []).filter((r) => r.status === 'approved');
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.shift !== b.shift || a.week_start !== b.week_start) continue;
      const da = new Set((a.source?.days || []).map((d) => d.date));
      const days = (b.source?.days || []).map((d) => d.date).filter((d) => da.has(d));
      if (!days.length) continue;
      const la = (a.source?.activities || []).map((x) => x.link).filter(Boolean);
      const lb = (b.source?.activities || []).map((x) => x.link).filter(Boolean);
      if (la.some((x) => lb.some((y) => linksOverlap(x, y, cache)))) out.push({ a, b, days });
    }
  }
  return out;
}

/* ── Conflicts on the track ─────────────────────────────────────────────── */

const LIVE = ['draft', 'submitted', 'approved', 'rejected'];

/**
 * When a request has the track (or the room), day by day, as instants:
 * `[{ date, from, to, hours }]`. A night shift runs past midnight into the
 * next day; a day without hours is taken as the whole day — an unknown time
 * conflicts with everything rather than nothing.
 */
export function occupancy(record) {
  return (record.source?.days || []).map((d) => {
    const base = msOf(d.date);
    const read = parseHours(`${d.start}-${d.end}`);
    if (!read) return { date: d.date, from: base, to: base + DAY_MS, hours: 'all day' };
    const end = read.end <= read.start ? read.end + 1440 : read.end;
    return { date: d.date, from: base + read.start * 60000, to: base + end * 60000, hours: `${d.start}–${d.end}` };
  });
}

/**
 * Requests that want the same track (or the same room) at the same time: live
 * requests whose places overlap on the drawing and whose hours overlap,
 * whatever their shift — a Blanket from midnight meets the night shift before
 * it. Each pair once: `{ a, b, when: [{ date, a: hours, b: hours }] }`.
 */
export function conflicts(records) {
  const live = (records || []).filter((r) => LIVE.includes(r.status));
  const out = [];
  const cache = new WeakMap();
  const parts = (r) => (r.source?.activities || []).map((x) => x.link).filter(Boolean);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const when = [];
      for (const x of occupancy(a)) {
        for (const y of occupancy(b)) {
          if (x.from < y.to && y.from < x.to) when.push({ date: x.date, a: x.hours, b: y.hours });
        }
      }
      if (!when.length) continue;
      if (parts(a).some((x) => parts(b).some((y) => linksOverlap(x, y, cache)))) out.push({ a, b, when });
    }
  }
  return out;
}
