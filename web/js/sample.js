/**
 * A sample look-ahead: four weeks of construction and of testing and
 * commissioning on the W line and the M line, with the conflicts a track
 * allocation manager has to sort out planted in it on purpose.
 *
 * It is made for the weeks it is loaded in — the four from the next Monday —
 * so it never goes stale. Every location is linked to the track plan the way
 * "Select on track plan" links it: the mileposts are real, inside each track's
 * calibrated range, and the geometry is the drawing's own (`sliceRoute`).
 *
 * The conflicts, so they can be found and checked:
 *
 *   week 1  CBTC radio survey (W1+W2+W3 16.8-17.4) and the cable trough
 *           (W1+W2 17.2-17.9) share W1 and W2 MP 17.2-17.4 on Thursday night
 *   week 2  signal cable pull (W2 17.6-18.4) and the cable trough share W2 MP
 *           17.6-17.9 on Tuesday and Wednesday nights — the same shift, so
 *           they can be consolidated
 *   week 3  track circuit testing on swing (1400-2200) and the equipment-case
 *           foundations on days (0700-1530) share W1 MP 21.0-21.3 from 1400
 *   week 3  IXL simulation (days, 0900-1730) and DCS checks (swing, from 1500)
 *           both want Daly City TCR on Wednesday and Thursday afternoon
 *   week 4  the integrated system test on Friday night (2200-0600) runs into
 *           Saturday's Blanket tie replacement on M2 MP 14.5-14.9 from midnight
 *
 * And one activity linked to a TCR and track at once (Millbrae, Balboa Park),
 * which raises two requests; and one cancelled day, which raises none.
 *
 * Pure: no DOM. `tests/test_tawr.mjs` reads it into requests and counts the
 * conflicts.
 *
 * Imports: lookahead, links.
 */

import { blankRow, addDaysISO, mondayOf } from './lookahead.js';
import { sliceRoute, linkLabel } from './links.js';

const DAY = 'FFFF00';
const SWING = 'FFC000';
const NIGHT = '0070C0';
const BLANKET = '000000';
const CANCEL = 'FF0000';

/** The first day of the sample: the coming Monday (today, if it is one). */
export function sampleStart(todayISO) {
  return mondayOf(addDaysISO(todayISO, 6));
}

/*
 * The sheet, as data. `days` are [week (1-4), weekday (0 = Monday), colour,
 * support]; `crew` the names typed on the Resource row on those days.
 */
const SHEET = [
  { section: 'W LINE — CONSTRUCTION' },
  {
    id: 'C-W101', title: 'Cable trough installation', party: 'Hitachi', sswp: '701', hours: '2200-0500',
    tracks: [['W1', 17.2, 17.9], ['W2', 17.2, 17.9]],
    days: [[1, 0, NIGHT, 'X'], [1, 1, NIGHT, 'X'], [1, 2, NIGHT, 'X'], [1, 3, NIGHT, 'X'], [2, 0, NIGHT, 'X'], [2, 1, NIGHT, 'X'], [2, 2, NIGHT, 'X']],
    crew: 'Ramirez, Chen',
  },
  {
    id: 'C-W102', title: 'Signal cable pull', party: 'Hitachi', sswp: '702', hours: '2300-0500',
    tracks: [['W2', 17.6, 18.4]],
    days: [[2, 1, NIGHT, 'X'], [2, 2, NIGHT, 'X'], [2, 3, NIGHT, 'X']],
    crew: 'Nguyen, Patel, Brooks',
  },
  {
    id: 'C-W103', title: 'Wayside equipment case foundations', party: 'Pacific Civil', sswp: '703', hours: '0700-1530',
    tracks: [['W1', 20.7, 21.3]],
    days: [[1, 1, DAY, 'X'], [1, 2, DAY, 'X'], [1, 3, DAY, 'X'], [3, 1, DAY, 'X'], [3, 2, DAY, 'X'], [3, 3, DAY, 'X']],
  },
  {
    id: 'C-W104', title: 'Rail replacement', party: 'BART', sswp: '704', hours: '',
    tracks: [['W1', 22.4, 23.1], ['W2', 22.4, 23.1]],
    days: [[3, 5, BLANKET, 'X.X.ROC'], [3, 6, BLANKET, 'X.X.ROC']],
  },
  { section: 'W LINE — TESTING AND COMMISSIONING' },
  {
    id: 'T-W201', title: 'IXL SIM testing — San Bruno', party: 'Hitachi', sswp: '711', hours: '0800-1630',
    place: 'tcr:San Bruno',
    days: [[2, 0, DAY, 'TCE.WIT'], [2, 1, DAY, 'TCE.WIT'], [2, 2, DAY, 'TCE.WIT']],
    crew: 'Okafor',
  },
  {
    id: 'T-W202', title: 'Track circuit testing', party: 'Hitachi', sswp: '712', hours: '1400-2200',
    tracks: [['W1', 21.0, 21.6], ['W2', 21.0, 21.6]],
    days: [[3, 1, SWING, 'X.WIT'], [3, 2, SWING, 'X.WIT']],
  },
  {
    id: 'T-W203', title: 'Switch machine testing — Millbrae', party: 'Hitachi', sswp: '713', hours: '2200-0400',
    place: 'tcr:Millbrae', tracks: [['W2', 23.9, 24.3]],
    days: [[4, 1, NIGHT, 'X.TCE'], [4, 2, NIGHT, 'X.TCE'], [4, 3, NIGHT, 'X.TCE']],
    crew: 'Silva, Okafor',
  },
  {
    id: 'T-W204', title: 'CBTC wayside radio survey', party: 'Hitachi', sswp: '714', hours: '2300-0400',
    tracks: [['W1', 16.8, 17.4], ['W2', 16.8, 17.4], ['W3', 16.8, 16.98]],
    days: [[1, 3, NIGHT, 'X'], [1, 4, NIGHT, 'X']],
  },
  { section: 'M LINE — CONSTRUCTION' },
  {
    id: 'C-M301', title: 'ATC loop cable installation — Glen Park', party: 'Hitachi', sswp: '721', hours: '2230-0430',
    tracks: [['M1', 12.0, 12.8], ['M2', 12.0, 12.8]],
    days: [[1, 1, NIGHT, 'X'], [1, 2, NIGHT, 'X'], [1, 3, NIGHT, 'X'], [3, 0, NIGHT, 'X'], [3, 1, NIGHT, 'X']],
    crew: 'Brooks, Chen',
  },
  {
    id: 'C-M302', title: 'Trench and conduit — Balboa Park', party: 'Pacific Civil', sswp: '722', hours: '0700-1530',
    tracks: [['M1', 13.2, 13.7]],
    days: [[2, 0, DAY, 'X'], [2, 1, DAY, 'X'], [2, 2, DAY, 'X'], [2, 3, DAY, 'X'], [2, 4, DAY, 'X']],
  },
  {
    id: 'C-M303', title: 'Tie replacement', party: 'BART', sswp: '723', hours: '0000-0700',
    tracks: [['M1', 14.1, 14.9], ['M2', 14.1, 14.9]],
    days: [[4, 5, BLANKET, 'X.X.ROC']],
  },
  {
    id: 'C-M304', title: 'Platform edge works — 16th St Mission', party: 'BART', sswp: '724', hours: '0800-1500',
    tracks: [['M1', 9.6, 9.9]],
    // The Wednesday was cancelled: painted red, it asks for nothing.
    days: [[2, 1, DAY, 'X'], [2, 2, CANCEL, 'X']],
  },
  { section: 'M LINE — TESTING AND COMMISSIONING' },
  {
    id: 'T-M401', title: 'IXL SIM testing — Daly City', party: 'Hitachi', sswp: '731', hours: '0900-1730',
    place: 'tcr:Daly City',
    days: [[3, 0, DAY, 'TCE.WIT'], [3, 1, DAY, 'TCE.WIT'], [3, 2, DAY, 'TCE.WIT'], [3, 3, DAY, 'TCE.WIT']],
    crew: 'Patel',
  },
  {
    id: 'T-M402', title: 'DCS point-to-point checks — Daly City', party: 'Hitachi', sswp: '732', hours: '1500-2300',
    place: 'tcr:Daly City',
    days: [[3, 2, SWING, 'TCE'], [3, 3, SWING, 'TCE']],
  },
  {
    id: 'T-M403', title: 'Integrated system test', party: 'Hitachi', sswp: '733', hours: '2200-0600',
    tracks: [['M2', 14.5, 15.0]],
    days: [[4, 3, NIGHT, 'X.ROC'], [4, 4, NIGHT, 'X.ROC']],
    crew: 'Nguyen, Ramirez',
  },
  {
    id: 'T-M404', title: 'Track circuit cutover — Balboa Park', party: 'Hitachi', sswp: '734', hours: '2300-0500',
    place: 'tcr:Balboa Park', tracks: [['M1', 13.3, 13.6], ['M2', 13.3, 13.6]],
    days: [[4, 0, NIGHT, 'X.TCE.WIT'], [4, 1, NIGHT, 'X.TCE.WIT']],
  },
];

/**
 * The sample's rows and cells, from the coming Monday. `data` is map.json —
 * its routes for the geometry and its locations for the TCRs.
 *
 * @param {string} todayISO
 * @param {{ routes: object, locations: any[] }} data
 */
export function sampleLookahead(todayISO, data) {
  const start = sampleStart(todayISO);
  const rows = [];
  const cells = [];
  let sort = 0;
  for (const item of SHEET) {
    sort += 1024;
    if (item.section) {
      rows.push(blankRow('section', { sort, description: item.section }));
      continue;
    }
    const loc = item.place ? data.locations.find((l) => l.id === item.place) : null;
    if (item.place && !loc) throw new Error(`The sample names ${item.place}, which the track plan does not have.`);
    const limits = (item.tracks || []).map(([track, from_mp, to_mp]) => ({ track, from_mp, to_mp }));
    const geometry = (item.tracks || []).flatMap(([track, a, b]) => sliceRoute(data.routes, track, a, b))
      .map((pl) => pl.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]));
    const link = {
      location_id: loc?.id || null, location_name: loc?.name || null, location_kind: loc?.kind || null, limits, geometry,
    };
    const row = blankRow('activity', {
      sort, activity_id: item.id, description: item.title, party: item.party, sswp: item.sswp, work_hours: item.hours,
      link, location: linkLabel(link),
    });
    rows.push(row);
    const resource = item.crew ? blankRow('resource', { parent_id: row.id, sort: sort + 1 }) : null;
    if (resource) rows.push(resource);
    for (const [week, weekday, color, support] of item.days) {
      const day = addDaysISO(start, (week - 1) * 7 + weekday);
      cells.push({ row_id: row.id, day, color, text: support });
      if (resource) cells.push({ row_id: resource.id, day, color: null, text: item.crew });
    }
  }
  return { start, rows, cells };
}
