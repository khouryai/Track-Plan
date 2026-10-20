#!/usr/bin/env node
/**
 * The look-ahead, its track plan links and the TAWRs read off them — no
 * browser, no network.
 *
 *   node tests/test_tawr.mjs
 *
 * Every rule agreed for the form is a check here: one request per place and
 * shift, a typed location matched exactly or not at all, hours combined,
 * support added across activities with the busiest day asked for, a witness
 * left off, overlapping places named to each other, consolidations merged, the
 * workflow table, the workbook import, and BART's form filled and read back.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { buildFormPdf } from './fixtures/tawr_fixture.mjs';
import { buildLookaheadWorkbook } from './fixtures/xlsx_fixture.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const la = await import(path.join(ROOT, 'web/js/lookahead.js'));
const T = await import(path.join(ROOT, 'web/js/tawr.js'));
const L = await import(path.join(ROOT, 'web/js/links.js'));
const pdf = await import(path.join(ROOT, 'web/js/tawr_pdf.js'));
const zip = await import(path.join(ROOT, 'web/js/zip.js'));
const SAMPLE = await import(path.join(ROOT, 'web/js/sample.js'));
const PH = await import(path.join(ROOT, 'web/js/phases.js'));
const LEARN = await import(path.join(ROOT, 'web/js/learn.js'));
const XL = await import(path.join(ROOT, 'web/js/la_xlsx.js'));
const TODAY = await import(path.join(ROOT, 'web/js/today.js'));
const REP = await import(path.join(ROOT, 'web/js/reports.js'));
const HIST = await import(path.join(ROOT, 'web/js/la_history.js'));
const CONV = await import(path.join(ROOT, 'web/js/conversation.js'));
const ATT = await import(path.join(ROOT, 'web/js/attachments.js'));
const FIND = await import(path.join(ROOT, 'web/js/find.js'));
const { readZip } = await import(path.join(ROOT, 'web/js/xlsx.js'));
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/map.json'), 'utf8'));
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/tawr_workflow.json'), 'utf8'));

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  if (ok) { passed++; console.log(`  ✓ ${line}`); } else { failures.push(line); console.log(`  ✗ ${line}`); }
}

const MON = '2026-11-02';
const day = (n) => la.addDaysISO(MON, n);
const DAY = 'FFFF00';
const NIGHT = '0070C0';
const CANCEL = 'FF0000';
const ODD = '123456';

const COLMA_TCR = MAP.locations.find((l) => l.id === 'tcr:Colma');
const M1 = (a, b) => ({ track: 'M1', from_mp: a, to_mp: b });
const geomM1 = (a, b) => [[[1000 + a * 10, 500], [1000 + b * 10, 500]]];

function sample() {
  const rows = [
    la.blankRow('section', { id: 's1', sort: 1, description: 'Colma — Testing' }),
    la.blankRow('activity', { id: 'ixl', sort: 2, activity_id: 'A100', description: 'IXL SIM Testing', location: 'Colma TCR', sswp: '660', work_hours: '0700-1500',
      link: { location_id: COLMA_TCR.id, location_name: COLMA_TCR.name, location_kind: 'tcr', limits: [M1(13.9, 14.1)], geometry: geomM1(13.9, 14.1) } }),
    la.blankRow('resource', { id: 'ixl-r', parent_id: 'ixl', sort: 3 }),
    la.blankRow('activity', { id: 'dcs', sort: 4, description: 'DCS Testing', location: 'colma tcr', party: 'BART', work_hours: '0900-1700' }),
    la.blankRow('activity', { id: 'cable', sort: 5, description: 'Cable pull', location: '',
      link: { limits: [M1(14.0, 14.5)], geometry: geomM1(14.0, 14.5) } }),
    la.blankRow('activity', { id: 'night', sort: 6, description: 'Night tie-in', location: 'Colma TCR', work_hours: '' }),
    la.blankRow('activity', { id: 'myst', sort: 7, description: 'Survey', location: 'Mystery Yard', work_hours: '0800-1200' }),
    la.blankRow('activity', { id: 'gone', sort: 8, description: 'Cancelled walk', location: 'Concord Yard' }),
    la.blankRow('activity', { id: 'odd', sort: 9, description: 'Odd colour', location: 'Concord Yard' }),
    la.blankRow('activity', { id: 'far', sort: 10, description: 'Bonding', location: '',
      link: { limits: [M1(20, 21)], geometry: geomM1(20, 21) } }),
  ];
  const c = (row_id, n, color, text = '') => ({ row_id, day: day(n), color, text });
  const cells = [
    c('ixl', 0, DAY, 'X.WIT'), c('ixl', 1, DAY, 'X'), c('ixl', 2, DAY, 'X.X'),
    c('ixl-r', 0, null, 'Victor, Rosa'), c('ixl-r', 1, null, 'Victor'),
    c('dcs', 0, DAY, 'X'), c('dcs', 1, DAY, 'TCE.ROC'),
    c('cable', 1, DAY, 'X.~WIT'),
    c('night', 3, NIGHT, ''), c('night', 4, NIGHT, 'X'),
    c('myst', 2, DAY, ''),
    c('gone', 0, CANCEL, 'X'),
    c('odd', 0, ODD, ''),
    c('far', 1, DAY, ''),
    c('ixl', 9, DAY, 'X'), // next week: not this week's business
  ];
  return la.makeModel(rows, cells);
}

const opts = (extra = {}) => ({
  legend: la.DEFAULT_LEGEND, codes: la.DEFAULT_CODES, locations: MAP.locations,
  descriptions: [{ activity: 'IXL SIM testing', description: 'functional testing in the TCR' }],
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('\nThe look-ahead model');
{
  const m = sample();
  const ordered = la.orderedRows(m.rows);
  check('a Resource row follows its activity', ordered[2].id === 'ixl-r' && ordered[1].id === 'ixl');
  const snap = (mm) => JSON.stringify({ rows: la.orderedRows(mm.rows), cells: la.cellList(mm).sort((a, b) => la.cellKey(a.row_id, a.day).localeCompare(la.cellKey(b.row_id, b.day))) });
  const before = snap(m);
  const inv = la.applyOps(m, [
    { op: 'cell', row_id: 'ixl', day: day(3), color: DAY, text: 'x' },
    { op: 'row', id: 'ixl', set: { location: 'Somewhere', link: null } },
    { op: 'row', id: 'new1', set: { kind: 'activity', description: 'New', sort: 99 } },
  ]);
  check('a cell is set', la.getCell(m, 'ixl', day(3))?.color === DAY);
  check('a row is created', m.rows.some((r) => r.id === 'new1'));
  la.applyOps(m, inv);
  check('the inverse puts everything back, link included', snap(m) === before);
  const del = la.applyOps(m, la.deleteOps(m, ['ixl']));
  check('deleting an activity takes its Resource row and cells', !m.rows.some((r) => r.id === 'ixl' || r.id === 'ixl-r') && !la.getCell(m, 'ixl-r', day(0)));
  la.applyOps(m, del);
  check('and undoing it brings them back', snap(m) === before);
  check('codes are tidied as typed', la.normaliseSupportIfCodes(' x . wit') === 'X.WIT' && la.normaliseSupportIfCodes('call Pat') === 'call Pat');
  check('a code is added and taken away', la.addCode('X', 'WIT') === 'X.WIT' && la.addCode('X.WIT.X', 'X', -1) === 'X.WIT');
  check('an unknown code is named', la.unknownCodes('X.ZZ.~QQ', la.DEFAULT_CODES).join() === 'ZZ');
  const rowsIn = la.rowsInWindow(m, la.windowDays(MON, 1));
  check('the window keeps busy rows and their section', rowsIn[0].id === 's1' && rowsIn.some((r) => r.id === 'ixl-r'));
  check('today is the reader\'s date', la.todayISO(new Date(2026, 9, 16, 23, 30)) === '2026-10-16');
}

console.log('\nTrack plan links');
{
  check('a TCR is matched by its short name', L.resolveLocationText('Colma TCR', MAP.locations)?.id === 'tcr:Colma');
  check('a station by its name alone', L.resolveLocationText('colma', MAP.locations)?.id === 'stn:Colma');
  check('never by a fragment', L.resolveLocationText('Colm', MAP.locations) === null);
  const W = (t, a, b) => ({ track: t, from_mp: a, to_mp: b });
  const block = [W('W1', 23.9, 24.446), W('W3', 23.747, 24.1), W('W2', 23.8, 24.2), { name: 'Crossover SW177/SW377', kind: 'crossover', context: '' }];
  check('a block of track is its limits, leftmost to rightmost, every track named', L.limitsText(block) === 'W1+W2+W3 MP 23.747–24.446', L.limitsText(block));
  check('the crossovers inside the limits are not in the words', !/Crossover/.test(L.limitsText(block)));
  check('each line keeps its own mileposts', L.limitsText([M1(16.0, 16.35), { track: 'M2', from_mp: 16.1, to_mp: 16.3 }, W('W1', 16.6, 16.9)], { dash: '-' }) === 'M1+M2 MP 16.000-16.350; W1 MP 16.600-16.900');
  check('only yard tracks picked: their names', L.limitsText([{ name: 'DTF02', kind: 'yard' }]) === 'DTF02');
  const link = { location_id: 'tcr:Colma', location_name: COLMA_TCR.name, location_kind: 'tcr', limits: [M1(13.9, 14.1), { name: 'Crossover SW177/SW377', kind: 'crossover', context: '' }], geometry: geomM1(13.9, 14.1) };
  check('the Location column says the room and the limits', L.linkLabel(link) === 'Colma TCR · M1 MP 13.900–14.100', L.linkLabel(link));
  const parts = L.linkParts(link);
  check('a TCR and track are two parts, never one', parts.map((p) => p.kind).join() === 'tcr,track');
  check('the room keys by the TCR', L.partKey(parts[0]) === 'loc:tcr:Colma');
  check('the track keys by its limits', L.partKey(parts[1]) === 'trk:M1 MP 13.900-14.100');
  check('the room part carries no track, the track part no room', !parts[0].limits.length && !parts[0].geometry.length && !parts[1].location_id);
  check('a station picked with track only says where the track is', L.linkParts({ location_id: 'stn:Colma', location_name: 'Colma Station', location_kind: 'station', limits: [M1(1, 2)] }).map((p) => p.kind).join() === 'track');
  check('a station alone is a part of its own', L.linkParts({ location_id: 'stn:Colma', location_name: 'Colma Station', location_kind: 'station' })[0].kind === 'place');
  check('limits on one track that overlap become one', JSON.stringify(L.unionLinks([{ limits: [M1(1, 2)] }, { limits: [M1(1.5, 3)] }]).limits) === JSON.stringify([M1(1, 3)]));
  check('activities on neighbouring tracks accumulate into one span', L.unionArea([{ limits: [W('W1', 23.9, 24.2)] }, { limits: [W('W2', 23.75, 24.0)] }]) === 'W1+W2 MP 23.750-24.200');
  check('overlapping mileposts overlap', L.linksOverlap({ limits: [M1(1, 2)] }, { limits: [M1(1.9, 3)] }));
  check('separate ones do not', !L.linksOverlap({ limits: [M1(1, 2)] }, { limits: [M1(2.1, 3)] }));
  check('shared drawing overlaps', L.linksOverlap({ geometry: [[[0, 0], [10, 0]]] }, { geometry: [[[5, 0], [5, 10]]] }));
  check('a room and track never overlap', !L.linksOverlap(parts[0], parts[1]));
  const spot = L.sharedSpot([[[0, 0], [10, 0]]], [[[5, 0], [8, 0]]]);
  check('where two pieces of drawing meet is found, to the drawing\'s grid', spot && spot.x >= 5 && spot.x <= 7 && spot.y === 0 && spot.bbox[0] >= 3.5 && spot.bbox[2] <= 8.5, JSON.stringify(spot));
  check('and nothing where they do not', L.sharedSpot([[[0, 0], [10, 0]]], [[[0, 50], [10, 50]]]) === null);
}

console.log('\nOne week read into requests');
const { groups } = T.extractWeek(sample(), MON, opts());
const byKey = (k) => groups.find((g) => g.key === k);
const colmaDay = byKey('loc:tcr:Colma|day');
const ixlTrack = byKey('trk:M1 MP 13.900-14.100|day');
{
  check('linked and typed activities at one TCR on one shift are one request',
    colmaDay?.activities.map((a) => a.title).join() === 'IXL SIM Testing,DCS Testing', colmaDay?.activities.map((a) => a.title).join());
  check('an activity linked to a TCR and track makes a track request too', ixlTrack?.activities.map((a) => a.title).join() === 'IXL SIM Testing');
  check('no request carries both a room and track', groups.every((g) => !(g.place.places.length && g.place.limits.length)));
  check('each request says its kind', colmaDay.kind === 'tcr' && ixlTrack.kind === 'track');
  check('the typed one says it was typed', colmaDay.activities.find((a) => a.row === 'dcs').how === 'typed');
  check('the same place at night is a second request', byKey('loc:tcr:Colma|night')?.days.length === 2);
  check('the TCR request\'s Area is the room', colmaDay.area === 'Colma TCR', colmaDay.area);
  check('the track request\'s Area is the limits', ixlTrack.area === 'M1 MP 13.900-14.100', ixlTrack.area);
  check('the track request carries the geometry for the map', ixlTrack.place.geometry.length === 1 && !colmaDay.place.geometry.length);
  check('hours combine to the earliest start and latest finish', colmaDay.days[0].start === '0700' && colmaDay.days[0].end === '1700');
  check('a day with no hours on the sheet uses the shift', byKey('loc:tcr:Colma|night').days[0].start === '2200' && byKey('loc:tcr:Colma|night').days[0].fromShift);
  check('support typed on a TCR-and-track activity is asked for once, with the track', ixlTrack.support.find((s) => s.code === 'X')?.count === 2, JSON.stringify(ixlTrack.support));
  check('and the TCR request says where it went', colmaDay.flags.some((f) => f.kind === 'support_on_track' && /IXL SIM Testing/.test(f.message)));
  check('the TCR request keeps what only it asks for', colmaDay.support.map((s) => s.code).join() === 'X,TCE,ROC', colmaDay.support.map((s) => s.code).join());
  check('a witness is never on the form', !ixlTrack.support.some((s) => s.code === 'WIT'));
  check('ROC goes on the OCC line', colmaDay.support.find((s) => s.code === 'ROC')?.line === 'occ');
  check('the party to action is carried', colmaDay.activities.find((a) => a.row === 'dcs').party === 'BART');
  check('the crew is read off the Resource row', colmaDay.activities[0].crew.join() === 'Rosa,Victor');
  check('expanded wording is used', colmaDay.description.startsWith('IXL SIM Testing — functional testing'));
  check('SSWP numbers are carried', colmaDay.sswp.join() === '660' && ixlTrack.sswp.join() === '660');
  check('a cancelled day asks for nothing', !groups.some((g) => g.activities.some((a) => a.row === 'gone')));
  check('next week is not this week\'s', colmaDay.days.every((d) => d.date <= day(6)));
  const myst = groups.find((g) => g.activities.some((a) => a.row === 'myst'));
  check('a location not linked to the track plan blocks the request', T.blockers(myst).some((f) => f.kind === 'location_unlinked'));
  const odd = groups.find((g) => g.shift === 'unmapped');
  check('an unmapped colour blocks the request', T.blockers(odd).some((f) => f.kind === 'colour_unmapped'));
  check('a clean request has no blockers', T.blockers(colmaDay).length === 0 && T.blockers(ixlTrack).length === 0);
  const cable = groups.find((g) => g.activities.some((a) => a.row === 'cable'));
  check('a struck-out code is not asked for', !cable.support.some((s) => s.code === 'WIT'));
  check('overlapping track in one shift is named to each other',
    ixlTrack.overlaps.some((o) => o.key === cable.key) && cable.overlaps.some((o) => o.key === ixlTrack.key));
  check('with the days they share', ixlTrack.overlaps.find((o) => o.key === cable.key).days.join() === day(1));
  check('a TCR request is never offered to consolidate with track', !colmaDay.overlaps.length);
  const far = groups.find((g) => g.activities.some((a) => a.row === 'far'));
  check('a place that does not overlap is not', far.overlaps.length === 0);
  check('no overlap across shifts', !byKey('loc:tcr:Colma|night').overlaps.length);
}

console.log('\nConsolidating');
{
  const cable = groups.find((g) => g.activities.some((a) => a.row === 'cable'));
  const merges = [{ id: 'm1', week_start: MON, keys: [ixlTrack.key, cable.key] }];
  const merged = T.extractWeek(sample(), MON, opts({ merges })).groups;
  const one = merged.find((g) => g.key === 'merge:m1');
  check('two track requests become one', one && !merged.some((g) => g.key === ixlTrack.key || g.key === cable.key));
  check('it lists every activity', one.activities.length === 2);
  check('its Area is the limits accumulated', one.area === 'M1 MP 13.900-14.500', one.area);
  check('it is still a track request', one.kind === 'track');
  check('support is recounted across both', one.support.find((s) => s.code === 'X').count === 2);
  check('it remembers what it was made of', one.members.join() === [ixlTrack.key, cable.key].join());
  check('and overlaps nothing left', one.overlaps.length === 0);
  check('the TCR request is left alone', merged.some((g) => g.key === colmaDay.key));
  const mixed = T.extractWeek(sample(), MON, opts({ merges: [{ id: 'm4', week_start: MON, keys: [colmaDay.key, ixlTrack.key] }] })).groups;
  check('a TCR and track are never consolidated, even if asked', mixed.some((g) => g.key === ixlTrack.key) && mixed.find((g) => g.key === 'merge:m4').kind === 'tcr');
  const later = T.extractWeek(sample(), MON, opts({ merges: [{ id: 'm2', week_start: MON, keys: [colmaDay.key, 'loc:gone|day'] }] })).groups;
  check('a member gone from the sheet is said', later.find((g) => g.key === 'merge:m2').flags.some((f) => f.kind === 'merge_partial'));
  const wrongWeek = T.extractWeek(sample(), MON, opts({ merges: [{ id: 'm3', week_start: day(7), keys: [ixlTrack.key, cable.key] }] })).groups;
  check('a consolidation belongs to its week', wrongWeek.some((g) => g.key === ixlTrack.key));
}

console.log('\nConflicts on the track');
{
  const rec = (id, g, status = 'submitted') => ({ id, status, shift: g.shift, week_start: g.weekStart, location_name: g.locationName, source: { days: g.days, activities: g.activities } });
  const cable = groups.find((g) => g.activities.some((a) => a.row === 'cable'));
  const far = groups.find((g) => g.activities.some((a) => a.row === 'far'));
  const night = byKey('loc:tcr:Colma|night');
  const list = [rec(1, colmaDay), rec(2, ixlTrack), rec(3, cable, 'draft'), rec(4, far), rec(5, night)];
  const found = T.conflicts(list);
  check('the same track at the same time is a conflict', found.some((c) => c.a.id === 2 && c.b.id === 3));
  check('with the day and both requests\' hours', found.find((c) => c.a.id === 2 && c.b.id === 3).when.map((w) => `${w.date} ${w.a} ${w.b}`).join() === `${day(1)} 0700–1500 0700–1500`);
  check('the same room at different times is not', !found.some((c) => [c.a.id, c.b.id].includes(5)));
  check('a room and track are not', !found.some((c) => c.a.id === 1 && c.b.id === 2));
  check('track that does not overlap is not', !found.some((c) => [c.a.id, c.b.id].includes(4)));
  const nightTrack = { id: 6, status: 'approved', shift: 'night', week_start: MON, location_name: 'M1', source: { days: [{ date: day(0), start: '2200', end: '0600' }], activities: [{ link: { limits: [M1(13.95, 14.05)] } }] } };
  const blanket = { id: 7, status: 'submitted', shift: 'possession', week_start: MON, location_name: 'M1', source: { days: [{ date: day(1), start: '0000', end: '0800' }], activities: [{ link: { limits: [M1(14.0, 14.2)] } }] } };
  check('a Blanket from midnight meets the night shift before it', T.conflicts([nightTrack, blanket]).length === 1);
  check('a superseded request conflicts with nothing', T.conflicts([{ ...nightTrack, status: 'superseded' }, blanket]).length === 0);
}

console.log('\nThe form values');
{
  const v = T.formValues(colmaDay, { settings: { person_in_charge_name: 'Pat Lee', category_tcr: 'F', category_track: 'A' }, profile: { requestor_name: 'Alex Morgan', cell_phone: '555-0100' } });
  check('each day is a row, with its date the way the form wants it', v.row1_date === '11/02/2026' && v.row1_day === 'MON' && v.row3_date === '11/04/2026');
  check('the Area is on every row', v.row1_area === colmaDay.area && v.row3_area === colmaDay.area);
  check('the requester is the one on the form', v.requestor_name === 'Alex Morgan' && v.requestor_cell_phone === '555-0100');
  check('Technical Support (Systems) says what and how many', v.maint_systems_tech_support_details === 'EIC, TCE', v.maint_systems_tech_support_details);
  check('OCC support has its line', v.trans_occ_support_details === 'ROC');
  check('SSWP goes on the bottom line', v.trans_adverse_impact_blanket_details === 'SSWP# 660');
  check('a TCR request is not work in the track zone, and takes the TCR category', v.work_in_track_zone_no === true && !v.work_in_track_zone_yes && v.category_of_work === 'F');
  const t = T.formValues(ixlTrack, { settings: { category_tcr: 'F', category_track: 'A' } });
  check('a track request is work in the track zone, and takes the track category', t.work_in_track_zone_yes === true && !t.work_in_track_zone_no && t.category_of_work === 'A');
  check('its Area is the limits', t.row1_area === 'M1 MP 13.900-14.100' && t.maint_systems_tech_support_details === '2 x EIC');
  check('without a category for its kind, the default', T.categoryFor('track', { category_default: 'C' }) === 'C' && T.categoryFor('tcr', {}) === 'F');
  const edited = { fields: { ...v, row1_time_start: '0600' }, generated: v };
  const fresh = { ...v, row1_time_end: '1800' };
  const m = T.mergeRegenerated(edited, fresh);
  check('regenerating keeps a hand edit and takes the rest', m.fields.row1_time_start === '0600' && m.fields.row1_time_end === '1800');
  check('approved then changed is seen', T.changedSince(v, fresh).join() === 'row1_time_end');
  check('the file is named for the week, place and shift', T.tawrFileName({ weekStart: MON, locationName: 'Colma TCR', shift: 'night' }) === 'TAWR 2026-11-02 Colma TCR Night.pdf');
}

console.log('\nWhen requests are raised');
{
  check('the week being prepared is the first not yet due', T.dueWeek('2026-10-16') === '2026-11-02' && T.dueWeek('2026-10-17') === '2026-11-09');
  check('a draft appears a week before it is due', T.weeksToRaise(['2026-11-09', '2026-11-16'], '2026-10-16', 7).join() === '2026-11-09');
  check('and not for a week that has ended', T.weeksToRaise(['2026-10-05'], '2026-10-16', 7).length === 0);
  check('the weeks with work are found', T.weeksWithWork(sample()).join() === `${MON},${day(7)}`);
}

console.log('\nThe workflow');
{
  check('a requester submits a draft', T.may(WORKFLOW, 'requester', 'submit', 'draft'));
  check('a requester never approves', !T.may(WORKFLOW, 'requester', 'approve', 'submitted'));
  check('the track allocation manager approves a submitted request', T.may(WORKFLOW, 'manager', 'approve', 'submitted'));
  check('nobody approves a draft that was not submitted', !T.may(WORKFLOW, 'manager', 'approve', 'draft'));
  check('only the manager consolidates', T.may(WORKFLOW, 'manager', 'consolidate', 'submitted') && !T.may(WORKFLOW, 'requester', 'consolidate', 'draft'));
  check('an approved request is not edited', !T.canEdit(WORKFLOW, 'manager', 'approved') && !T.canEdit(WORKFLOW, 'requester', 'approved'));
  check('a submitted request is the manager\'s to edit', T.canEdit(WORKFLOW, 'manager', 'submitted') && !T.canEdit(WORKFLOW, 'requester', 'submitted'));
  check('a viewer does nothing', T.actionsFor(WORKFLOW, 'viewer', 'draft').length === 0 && !T.canWrite(WORKFLOW, 'viewer'));
  const rec = (id, days, link) => ({ id, status: 'approved', shift: 'day', week_start: MON, source: { days: days.map((date) => ({ date })), activities: [{ link }] } });
  const reps = T.repetitions([rec('a', [day(0)], { limits: [M1(1, 2)] }), rec('b', [day(0), day(1)], { limits: [M1(1.5, 3)] }), rec('c', [day(2)], { limits: [M1(1, 2)] })]);
  check('two approved requests for the same track on the same day are a repetition', reps.length === 1 && reps[0].days.join() === day(0));
}

console.log('\nAfter approval: BART, and the access');
{
  const days = [{ date: day(0), start: '2230', end: '0430' }, { date: day(1), start: '2230', end: '0430' }, { date: day(2), start: '', end: '' }];
  const rec = (extra = {}) => ({ id: 9, status: 'approved', week_start: MON, source: { days }, ...extra });
  const before = day(0);
  const after = day(2);
  check('a night shift\'s hours run past midnight', T.dayHours(days[0]) === 6 && T.dayHours(days[2]) === null);
  check('approved and not sent is the requester\'s to send', T.afterApproval(rec(), before) === 'unsent');
  check('sent, it waits for BART', T.afterApproval(rec({ bart: { sent_on: day(-17) } }), before) === 'sent');
  check('granted, nothing to do until a day has gone by', T.afterApproval(rec({ bart: { sent_on: day(-17), answer: 'granted' } }), before) === 'granted');
  check('then the access is due to be recorded', T.afterApproval(rec({ bart: { answer: 'granted' } }), after) === 'access-due');
  check('and once recorded, it is done', T.afterApproval(rec({ bart: { answer: 'granted' }, access: { days: { [day(0)]: true } } }), after) === 'recorded');
  check('denied and cancelled say so, and whether BART was told', T.afterApproval(rec({ status: 'denied' }), after) === 'denied'
    && T.afterApproval(rec({ status: 'cancelled' }), after) === 'unreleased' && T.afterApproval(rec({ status: 'cancelled', bart: { released_on: day(1) } }), after) === 'released'
    && T.afterApproval(rec({ status: 'submitted' }), after) === null);
  const a = T.accessOf(rec({ access: { days: { [day(0)]: true, [day(1)]: false, [day(2)]: true } } }));
  check('the access used is counted in days and hours', a.recorded && a.used === 2 && a.days === 3 && a.hoursAsked === 12 && a.hoursUsed === 6, JSON.stringify(a));
  check('nothing is counted as used before it is recorded', T.accessOf(rec()).used === null && T.accessOf(rec()).hoursAsked === 12);
  check('BART denying and cancelling are steps after approval, and either is reopened', T.may(WORKFLOW, 'requester', 'deny', 'approved') && T.may(WORKFLOW, 'manager', 'cancel', 'approved')
    && !T.may(WORKFLOW, 'requester', 'cancel', 'submitted') && T.may(WORKFLOW, 'requester', 'reopen', 'denied') && T.may(WORKFLOW, 'requester', 'reopen', 'cancelled')
    && !T.may(WORKFLOW, 'viewer', 'cancel', 'approved'));
  const live = (status) => T.conflicts([{ id: 1, status, source: { days: [{ date: day(0), start: '0800', end: '1600' }], activities: [{ link: { limits: [M1(1, 2)] } }] } },
    { id: 2, status: 'approved', source: { days: [{ date: day(0), start: '0800', end: '1600' }], activities: [{ link: { limits: [M1(1, 2)] } }] } }]).length;
  check('a cancelled or denied request no longer conflicts with anything', live('approved') === 1 && live('cancelled') === 0 && live('denied') === 0);
  const denied = LEARN.entriesFor({ id: 4, week_start: MON, shift: 'night', source: {} }, 'deny', 'No flagger available');
  check('BART\'s denial is remembered as a rejection, marked as BART\'s', denied.length === 1 && denied[0].kind === 'reject' && denied[0].data.by_bart === true);
}

console.log('\nPower sections and BART\'s capacity');
{
  const P = MAP.power;
  const subs = P.facilities.filter((f) => f.kind === 'substation');
  check('substations and gap breaker stations are read off the drawing, each at its milepost', subs.length >= 50 && P.facilities.filter((f) => f.kind === 'gap_breaker').length >= 40
    && P.facilities.every((f) => Number.isFinite(f.mp) && f.lines.length));
  const balboa = P.sections.find((s) => s.line === 'M' && s.from_mp <= 13.6 && s.to_mp >= 13.6);
  check('a line is cut into power sections between them', P.sections.length > 60 && balboa?.from_mp === 13.53 && balboa?.to_mp === 14.13, JSON.stringify(balboa));
  const req = (id, status, limits, rows, shift = 'night') => ({
    id, status, shift, week_start: MON,
    source: { place: { limits }, days: rows.map(([date]) => ({ date, start: '2300', end: '0500' })), activities: [] },
    fields: Object.fromEntries(rows.flatMap(([date, power], i) => [[`row${i + 1}_date`, T.formDate(date)], [`row${i + 1}_power_${power}`, true]])),
  });
  const offM = req(1, 'approved', [{ track: 'M1', from_mp: 13.6, to_mp: 13.8 }], [[day(0), 'off'], [day(1), 'off']]);
  const onM = req(2, 'submitted', [{ track: 'M2', from_mp: 13.9, to_mp: 14.0 }], [[day(1), 'on']]);
  const onElsewhere = req(3, 'draft', [{ track: 'M2', from_mp: 14.5, to_mp: 14.6 }], [[day(1), 'on']]);
  const na = req(4, 'draft', [{ track: 'M1', from_mp: 13.7, to_mp: 13.75 }], [[day(1), 'na']]);
  check('a request\'s power is read off its form, day by day', T.powerOn(offM, day(0)) === 'off' && T.powerOn(na, day(1)) === 'na' && T.powerOn(offM, day(3)) === null);
  check('its limits fall in power sections', [...T.sectionsOf(offM, P.sections)].join() === balboa.id && T.sectionsOf(onElsewhere, P.sections).has(balboa.id) === false);
  const clashes = T.powerConflicts([offM, onM, onElsewhere, na], P.sections);
  check('power off and power on in the same section at the same time clash — another section, or no need either way, does not', clashes.length === 1
    && clashes[0].a.id === 1 && clashes[0].b.id === 2 && clashes[0].when.map((w) => w.date).join() === day(1), JSON.stringify(clashes.map((c) => [c.a.id, c.b.id])));
  check('a cancelled request clashes with nothing', T.powerConflicts([offM, { ...onM, status: 'cancelled' }], P.sections).length === 0);

  const cap = T.parseCapacity(JSON.stringify({ X: { night: 2, day: 4 }, TCE: { night: 'two' } }));
  check('what BART can provide is read as numbers, never guessed', cap.X.night === 2 && cap.X.day === 4 && !cap.TCE && Object.keys(T.parseCapacity('nonsense')).length === 0);
  const asks = (id, status, perDay, shift = 'night') => ({ id, status, shift, source: { days: Object.entries(perDay).map(([date, support]) => ({ date, support })) } });
  const over = T.supportOver([
    asks(1, 'approved', { [day(0)]: { X: 1 }, [day(1)]: { X: 2 } }),
    asks(2, 'draft', { [day(1)]: { X: 1, TCE: 3 } }),
    asks(3, 'rejected', { [day(1)]: { X: 5 } }),
    asks(4, 'submitted', { [day(1)]: { X: 1 } }, 'day'),
  ], cap);
  check('support asked for beyond what BART has is found, day by day and shift by shift', over.length === 1 && over[0].date === day(1) && over[0].code === 'X'
    && over[0].asked === 3 && over[0].capacity === 2 && over[0].ids.join() === '1,2', JSON.stringify(over));
  const g = T.extractWeek(sample(), MON, { locations: MAP.locations }).groups.find((x) => x.days.some((d) => Object.keys(d.support).length));
  check('each day of a request says what it asks BART for', Boolean(g) && g.days.every((d) => typeof d.support === 'object'));

  const ix = Object.fromEntries(MAP.interlockings.map((i) => [i.name, i]));
  check('interlockings drawn with limits are read as limits on each track', MAP.interlockings.length >= 40 && ix.W45?.limits.map((l) => l.track).join() === 'W1,W2,W3,W4'
    && ix.C25?.limits.every((l) => l.from_mp === 8.62 && l.to_mp === 8.88), JSON.stringify(ix.C25));
  check('a track the drawing squeezed is steadied to its neighbour', ix.C25.limits.some((l) => l.adjusted));
}

console.log('\nToday, and the deadlines as a calendar');
{
  const rec = (id, status, week, extra = {}) => ({
    id, status, week_start: week, first_day: week, location_name: `Place ${id}`, shift: 'night',
    source: { days: [{ date: week, start: '2230', end: '0430' }], activities: [{ activityId: 'C-M301', title: 'ATC loop cable, Glen Park' }] }, ...extra,
  });
  const today = '2026-10-16';
  const records = [
    rec(1, 'draft', '2026-11-02'), rec(2, 'draft', '2026-11-02'), rec(3, 'draft', '2026-11-30'),
    rec(4, 'submitted', '2026-10-26'), rec(5, 'rejected', '2026-11-09', { decision_note: 'No flagger' }),
    rec(6, 'approved', '2026-10-19'), rec(7, 'approved', '2026-10-19', { bart: { sent_on: '2026-10-02' } }),
    rec(8, 'cancelled', '2026-10-19'), rec(9, 'superseded', '2026-11-02'),
  ];
  const keys = (role) => TODAY.attention({ records, today, role }).map((i) => `${i.key}:${i.tone}`);
  const manager = keys('manager');
  check('the manager is told what is theirs to do first', manager[0] === 'due:2026-11-02:you' && manager.includes('approve:you') && manager.includes('unsent:you')
    && manager.includes('release:8:you') && manager.includes('sent:wait') && !manager.some((k) => k.startsWith('due:2026-11-30')), manager.join(' '));
  const requester = keys('requester');
  check('the requester sees a rejection as theirs, and approval as somebody else\'s', requester.includes('rejected:5:you') && requester.includes('approve:wait'), requester.join(' '));
  const viewer = keys('viewer');
  check('a viewer is told, never asked', !viewer.some((k) => k.endsWith(':you')), viewer.join(' '));
  check('a draft past its deadline is late', TODAY.attention({ records: [rec(1, 'draft', '2026-10-26')], today, role: 'requester' })[0].tone === 'bad');
  check('activities still to link are the writers\' to do', TODAY.attention({ records: [], today, role: 'requester', unlinked: 3, suggestions: 2 })[0].title
    === '3 activities on the look-ahead with no location linked');

  const ahead = TODAY.deadlines(records, today, ['2026-10-19', '2026-11-02', '2026-11-30', '2027-01-04'], { weeks: 8 });
  check('the deadlines ahead are each week\'s first day less the lead time', ahead.map((d) => `${d.week} ${d.deadline}`).join() === '2026-10-19 2026-10-02,2026-11-02 2026-10-16,2026-11-30 2026-11-13'
    && ahead[1].counts.draft === 2 && !ahead[1].counts.superseded);
  check('the access approved is listed day by day', TODAY.onTrack(records, '2026-10-19', '2026-10-25').map((a) => a.record.id).join() === '6,7');

  const ics = TODAY.calendarIcs({ records, weekList: ['2026-10-19', '2026-11-02'], today, stamp: '2026-10-16T22:00:00.000Z' });
  const lines = ics.split('\r\n');
  check('the calendar has each week\'s deadline, all day, with a reminder the day before', lines.includes('UID:deadline-2026-11-02@track-plan')
    && lines.includes('DTSTART;VALUE=DATE:20261016') && lines.includes('TRIGGER:-PT15H') && lines.includes('DTSTAMP:20261016T220000Z'));
  check('and the approved access, a night shift ending the next morning', lines.includes('DTSTART:20261019T223000') && lines.includes('DTEND:20261020T043000')
    && lines.includes('STATUS:TENTATIVE') && !ics.includes('tawr-8-'));
  check('text is escaped and long lines folded at 75 octets, as the server writes them', ics.replace(/\r\n /g, '').includes('DESCRIPTION:C-M301 ATC loop cable\\, Glen Park\\nApproved\\, not yet sent to BART.')
    && lines.every((l) => new globalThis.TextEncoder().encode(l).length <= 75) && ics.endsWith('END:VCALENDAR\r\n'));
  check('a long line folds without splitting a character', TODAY.foldLine(`SUMMARY:${'—'.repeat(40)}`).split('\r\n ').every((l) => new globalThis.TextEncoder().encode(l).length <= 75));
}

console.log('\nReports');
{
  const dayOf = (stamp) => stamp.slice(0, 10); // the tests' calendar is Greenwich's
  const h = (action, at, note) => ({ action, at, by: 'Terry Manager', ...(note ? { note } : {}) });
  const rec = (id, status, week, extra = {}) => ({
    id, status, week_start: week, first_day: week, location_name: `Place ${id}`, shift: 'night', history: [],
    source: { days: [{ date: week, start: '2200', end: '0400' }, { date: addDay(week, 1), start: '2200', end: '0400' }] }, ...extra,
  });
  const addDay = (iso, n) => la.addDaysISO(iso, n);
  const records = [
    // Went in two days early, rejected, corrected, approved, granted, both nights used.
    rec(1, 'approved', '2026-10-05', { submitted_at: '2026-09-16T10:00:00Z', bart: { answer: 'granted' }, access: { days: { '2026-10-05': true, '2026-10-06': false } },
      history: [h('submit', '2026-09-10T10:00:00Z'), h('reject', '2026-09-12T10:00:00Z', 'No flagger named'), h('submit', '2026-09-16T10:00:00Z'), h('approve', '2026-09-17T10:00:00Z')] }),
    // Late, approved, then denied by BART.
    rec(2, 'denied', '2026-10-05', { submitted_at: '2026-09-20T10:00:00Z', bart: { answer: 'denied', note: 'Single tracking not available' },
      history: [h('submit', '2026-09-20T10:00:00Z'), h('approve', '2026-09-21T10:00:00Z'), h('deny', '2026-09-23T10:00:00Z', 'Single tracking not available')] }),
    rec(3, 'cancelled', '2026-10-12', { submitted_at: '2026-09-25T10:00:00Z', history: [h('submit', '2026-09-25T10:00:00Z'), h('approve', '2026-09-26T10:00:00Z'), h('cancel', '2026-10-01T10:00:00Z', 'Rain')] }),
    rec(4, 'draft', '2026-10-12'),
    // Approved and granted, then revised: replaced by a new draft, but the decision and the answer stand.
    rec(5, 'superseded', '2026-10-12', { submitted_at: '2026-09-20T10:00:00Z', bart: { answer: 'granted' }, history: [h('submit', '2026-09-20T10:00:00Z'), h('approve', '2026-09-22T10:00:00Z')] }),
    // Rejected, resubmitted, then merged into another request.
    rec(7, 'consolidated', '2026-10-12', { submitted_at: '2026-09-24T14:00:00Z', history: [h('submit', '2026-09-24T10:00:00Z'), h('reject', '2026-09-24T12:00:00Z', 'Wrong limits'), h('submit', '2026-09-24T14:00:00Z')] }),
    rec(6, 'approved', '2026-12-07'),
  ];
  const rep = REP.report(records, { from: '2026-10-05', to: '2026-10-12', dayOf });
  check('every week in the range is a row, its requests by how they ended', rep.weeks.map((w) => w.week).join() === '2026-10-05,2026-10-12'
    && rep.weeks[0].counts.approved === 1 && rep.weeks[0].counts.denied === 1 && rep.weeks[1].counts.cancelled === 1 && rep.weeks[1].counts.waiting === 1 && rep.totals.raised === 4,
    JSON.stringify(rep.weeks.map((w) => w.counts)));
  check('decisions are counted from the history: a rejection put right is still a rejection', rep.totals.approvals === 4 && rep.totals.rejections === 2,
    `${rep.totals.approvals} approvals, ${rep.totals.rejections} rejections`);
  check('a request revised or consolidated is not raised twice, but what was decided on it counts', rep.totals.raised === 4 && rep.weeks[1].raised === 2
    && rep.reasons.some((x) => x.id === 7) && rep.totals.sent === 3);
  check('how early each went in, against its deadline', REP.leadDays(records[0], dayOf) === 2 && REP.leadDays(records[1], dayOf) === -2 && REP.leadDays(records[3], dayOf) === null
    && rep.lead['1-3'] === 1 && rep.lead.late === 1 && rep.totals.late === 1 && rep.totals.onTime === 2, JSON.stringify(rep.lead));
  check('BART\'s answers are counted, a revised request\'s too', rep.totals.granted === 2 && rep.totals.denied === 1);
  check('track hours approved, and used where it was recorded', rep.totals.hoursApproved === 12 && rep.totals.hoursRecorded === 12 && rep.totals.hoursUsed === 6
    && REP.percent(rep.totals.hoursUsed, rep.totals.hoursRecorded) === '50%' && REP.percent(1, 0) === '—');
  check('the reasons for rejections and denials, newest first, and only those', rep.reasons.map((x) => `${x.id} ${x.kind}`).join() === '7 rejected,2 denied,1 rejected'
    && rep.reasons[2].note === 'No flagger named', rep.reasons.map((x) => `${x.id} ${x.kind}`).join());
}

console.log('\nThe look-ahead\'s history');
{
  const meaning = (hex) => ({ '0070C0': 'Night Shift', FFC000: 'Swing Shift', FFFF00: 'Day Shift' })[hex] || '';
  check('a day painted, moved to another shift and cleared, in words',
    HIST.dayChange(null, { color: '0070C0', text: '' }, meaning) === 'Painted Night Shift'
    && HIST.dayChange({ color: '0070C0', text: 'X.WIT' }, { color: 'FFC000', text: 'X' }, meaning) === 'Night Shift → Swing Shift · support taken off WIT'
    && HIST.dayChange({ color: '0070C0', text: '' }, null, meaning) === 'Night Shift cleared',
  HIST.dayChange({ color: '0070C0', text: 'X.WIT' }, { color: 'FFC000', text: 'X' }, meaning));
  const d = HIST.codesDiff('X.WIT', 'X.~WIT.X');
  check('support counted code by code: one more EIC, the witness struck out', d.added.join() === 'X' && d.struck.join() === 'WIT' && !d.removed.length, JSON.stringify(d));
  const back = HIST.codesDiff('X.~WIT', 'X.WIT');
  check('and a struck code put back is put back, not added', back.reinstated.join() === 'WIT' && !back.added.length && !back.removed.length, JSON.stringify(back));
  check('names put on and taken off', HIST.namesChange({ text: 'Ann Example, Bo Sample' }, { text: 'Ann Example and Cy Test' }) === 'Cy Test put on · Bo Sample taken off');
  check('text that is not codes is said as it was and is', HIST.dayChange({ color: null, text: 'see note' }, { color: null, text: 'see notes' }) === '"see note" → "see notes"');

  const rows = new Map([['a', { id: 'a', kind: 'activity', activity_id: 'C-W101', description: 'Cable trough' }], ['r', { id: 'r', kind: 'resource', parent_id: 'a' }]]);
  check('a row is called what it said then, a names row by its activity', HIST.rowLabel(rows.get('a'), rows) === 'C-W101 · Cable trough'
    && HIST.rowLabel(rows.get('r'), rows) === 'Names under C-W101 · Cable trough' && HIST.rowLabel({ kind: 'section' }) === 'Section');
  const link = { location_id: 'tcr:Colma', location_name: 'Colma TCR', location_kind: 'tcr', limits: [], geometry: [[[0, 0], [1, 1]]] };
  const e = HIST.rowEdit({ id: 'a', kind: 'activity', description: 'IXL', sort: 1, link: null }, { id: 'a', kind: 'activity', description: 'IXL SIM Testing', sort: 2, link }, 'IXL SIM Testing');
  check('a row change keeps what changed, never where it sits or the geometry', JSON.stringify(e.before) === JSON.stringify({ description: 'IXL', link: null })
    && JSON.stringify(e.after.link) === JSON.stringify({ location_id: 'tcr:Colma', location_name: 'Colma TCR', location_kind: 'tcr', limits: [] }) && !('sort' in e.after), JSON.stringify(e));
  check('moving a row is no change to what it says', HIST.rowEdit({ id: 'a', sort: 1 }, { id: 'a', sort: 2 }, '') === null);
  check('a day written as it was is no change; a new one is an insert', HIST.cellEdit({ color: 'ffff00', text: 'X' }, { color: 'FFFF00', text: 'X' }, 'a', MON, '') === null
    && HIST.cellEdit(null, { color: 'FFFF00', text: '' }, 'a', MON, '').action === 'insert' && HIST.cellEdit({ color: 'FFFF00', text: '' }, null, 'a', MON, '').action === 'delete');

  const log = [
    { id: 1, batch: 5, at: '2026-10-18T09:00:00Z', by: 'Rae Requester', target: 'row', action: 'insert', row_id: 'a', day: null, label: 'C-W101 · Cable trough', before: null, after: {} },
    { id: 2, batch: 5, at: '2026-10-18T09:00:00Z', by: 'Rae Requester', target: 'cell', action: 'insert', row_id: 'a', day: MON, label: 'C-W101 · Cable trough', before: null, after: { color: '0070C0', text: 'X' } },
    { id: 3, batch: 6, at: '2026-10-19T10:30:00Z', by: 'Sam Scheduler', target: 'cell', action: 'update', row_id: 'a', day: MON, label: 'C-W101 · Cable trough', before: { color: '0070C0', text: 'X' }, after: { color: 'FFC000', text: 'X' } },
    { id: 4, batch: 6, at: '2026-10-19T10:30:00Z', by: 'Sam Scheduler', target: 'cell', action: 'insert', row_id: 'a', day: day(1), label: 'C-W101 · Cable trough', before: null, after: { color: 'FFC000', text: '' } },
    { id: 5, batch: 7, at: '2026-10-19T11:00:00Z', by: 'Rae Requester', target: 'import', action: 'replace', row_id: null, day: null, label: '', before: { rows: 3, cells: 9 }, after: { rows: 4, cells: 12 } },
  ];
  check('a day\'s history is its entries, newest first', HIST.cellHistory(log, 'a', MON).map((x) => x.id).join() === '3,2');
  check('a row\'s is everything on it', HIST.rowHistory(log, 'a').map((x) => x.id).join() === '4,3,2,1');
  const b = HIST.batches(log);
  check('the log read as the actions that made it, newest first, each in the order it was done',
    b.map((x) => x.batch).join() === '7,6,5' && b[1].edits.map((x) => x.id).join() === '3,4' && b[1].by === 'Sam Scheduler');
  check('an import is one line that says what it replaced', HIST.editText(log[4]) === 'Imported a workbook: 4 rows and 12 days, in place of 3 rows and 9 days', HIST.editText(log[4]));
  check('a row added, a day changed, and where', HIST.editText(log[0]) === 'Added C-W101 · Cable trough' && HIST.editText(log[2], { meaningOf: meaning }) === 'Night Shift → Swing Shift'
    && HIST.editWhere(log[2], { dayLabel: (x) => `<${x}>` }) === `C-W101 · Cable trough · <${MON}>`);
  const brief = HIST.linkBrief(link);
  const linked = HIST.editText({ target: 'row', action: 'update', label: 'x', before: { link: null }, after: { link: brief } });
  check('a link changed is said as where it is', linked === `Track plan link none → ${L.linkLabel(brief)}` && L.linkLabel(brief), linked);
  check('the legend and the codes say what was added', HIST.editText({ target: 'codes', before: [{ code: 'X' }], after: [{ code: 'X' }, { code: 'TCE' }] }) === 'Support codes: TCE added');

  const behind = HIST.editsFor({ rows: ['a'], days: [MON] }, log);
  check('the edits behind a change to a request: its days on its rows', behind.map((x) => x.id).join() === '2,3');
  check('what an activity says is found on its row, not its days', HIST.editsFor({ rows: ['a'], days: [], rowFields: true }, log).map((x) => x.id).join() === '1');
  const stamp = (iso) => iso.slice(5, 16);
  check('who made them, and when', HIST.whoText(behind, { stamp }) === 'Rae Requester and Sam Scheduler, 10-18T09:00 – 10-19T10:30', HIST.whoText(behind, { stamp }));
  check('one person, one moment; nobody, nothing', HIST.whoText([log[2]], { stamp }) === 'Sam Scheduler, 10-19T10:30' && HIST.whoText([]) === '');
}

console.log('\nWhat changed since a request was submitted');
{
  const track = (to) => ({ kind: 'track', limits: [{ track: 'W2', from_mp: 16.6, to_mp: to }] });
  const before = {
    area: 'W2 MP 16.600–17.200',
    days: [{ date: MON, start: '22:00', end: '04:00', rows: ['a'], support: { X: 1, WIT: 1 } }, { date: day(1), start: '22:00', end: '04:00', rows: ['a'], support: { X: 1 } }],
    activities: [{ row: 'a', title: 'Cable trough', activityId: 'C-W101', party: 'Example Electric', sswp: '12', days: [MON, day(1)], crew: ['Ann Example'], link: track(17.2) }],
  };
  const after = JSON.parse(JSON.stringify(before));
  after.days = [{ date: MON, start: '23:00', end: '04:00', rows: ['a'], support: { X: 1 } }, { date: day(2), start: '22:00', end: '04:00', rows: ['a'], support: { X: 1 } }];
  after.activities[0].title = 'Cable trough and conduit';
  after.activities.push({ row: 'b', title: 'Signal cable', activityId: 'C-W102', days: [day(2)], crew: [], link: track(17.2) });
  const lines = T.sourceChanges(before, after, { dayLabel: (x) => `<${x}>` });
  const text = lines.map((l) => l.text);
  check('a day\'s hours and support, as they were and are', text[0] === `<${MON}>: hours 22:00–04:00 → 23:00–04:00, support X.WIT → X`, text[0]);
  check('a day no longer asked for', text[1] === `<${day(1)}> is no longer asked for on this shift (it was 22:00–04:00)`, text[1]);
  check('a day added', text[2] === `<${day(2)}> added, 22:00–04:00, support X`, text[2]);
  check('what an activity says, and an activity added', text[3] === 'C-W101 · Cable trough and conduit: description "Cable trough" → "Cable trough and conduit"'
    && text[4] === 'C-W102 · Signal cable added to this request', text.slice(3).join(' | '));
  check('each line carries its rows and days, to find the edits behind it', lines[0].rows.join() === 'a' && lines[0].days.join() === MON && lines[3].rowFields === true && lines[4].days.join() === day(2));
  check('the same reading is no change', T.sourceChanges(before, JSON.parse(JSON.stringify(before))).length === 0);
  const old = JSON.parse(JSON.stringify(before));
  for (const x of old.days) delete x.support;
  check('a request kept before each day carried its support compares what it has', T.sourceChanges(old, before).length === 0);
  const moved = JSON.parse(JSON.stringify(before));
  moved.activities[0].link = track(17.4);
  moved.area = 'W2 MP 16.600–17.400';
  const ml = T.sourceChanges(before, moved).map((l) => l.text);
  check('a location moved is said once, as the activity\'s', ml.length === 1
    && ml[0].includes(`location ${L.partArea(track(17.2), { dash: '–' })} → ${L.partArea(track(17.4), { dash: '–' })}`), ml.join(' | '));
}

console.log('\nA request\'s conversation');
{
  const first = {
    id: 1, status: 'superseded', comments: [{ id: 1, at: '2026-10-10T09:00:00Z', by: 'Rae Requester', by_id: 2, text: 'Flagger is Ann Example, 415-555-0101' }],
    history: [{ at: '2026-10-11T09:00:00Z', by: 'Terry Manager', action: 'reject', note: 'No flagger named' }, { at: '2026-10-12T09:00:00Z', by: 'Rae Requester', action: 'submit' }],
  };
  const second = {
    id: 2, status: 'draft', supersedes: 1, seen_comment: 0, week_start: MON, first_day: MON, location_name: 'Colma TCR', history: [],
    comments: [{ id: 2, at: '2026-10-13T09:00:00Z', by: 'Terry Manager', by_id: 1, text: 'Is the EIC booked?' }, { id: 3, at: '2026-10-13T10:00:00Z', by: 'Rae Requester', by_id: 2, text: 'Yes.' }],
  };
  const member = { id: 3, status: 'consolidated', merged_into: 2, comments: [{ id: 4, at: '2026-10-09T09:00:00Z', by: 'Rae Requester', by_id: 2, text: 'Same room as #1.' }], history: [] };
  const t = CONV.thread(second, [first, second, member]);
  check('the thread is the request\'s own and those it replaced, oldest first',
    t.map((x) => x.text).join(' | ') === 'Same room as #1. | Flagger is Ann Example, 415-555-0101 | No flagger named | Is the EIC booked? | Yes.', t.map((x) => x.text).join(' | '));
  check('a line from an earlier request says which, and how it was replaced', t[0].on.id === 3 && t[0].on.how === 'consolidated' && t[1].on.id === 1 && t[1].on.how === 'revised' && t[3].on === null);
  check('a decision\'s reason is in it, named', t[2].kind === 'step' && t[2].label === 'Rejected' && t[2].by === 'Terry Manager');
  check('what is new: somebody else\'s, newer than what was shown', CONV.unread(second, 2).map((c) => c.id).join() === '2' && CONV.unread(second, '1').map((c) => c.id).join() === '3'
    && CONV.unread({ ...second, seen_comment: 3 }, 2).length === 0 && CONV.newestComment(second) === 3);
  const items = TODAY.attention({ records: [second], today: '2026-10-16', role: 'requester', userId: 2, label: (x) => x });
  check('the start page says what was said that the reader has not seen', items.some((i) => i.key === 'comments' && i.title === '1 new comment on 1 request' && i.detail === '#2 Colma TCR (1)'),
    items.map((i) => i.title).join(' | '));
}

console.log('\nFiles sent with a request');
{
  check('a file is its own name, with no folder or forbidden characters', ATT.cleanFileName('C:\\Users\\rae\\SSWP 12.pdf') === 'SSWP 12.pdf'
    && ATT.cleanFileName('../../etc/passwd') === 'passwd' && ATT.cleanFileName('a<b>:c|d?.pdf') === 'abcd.pdf' && ATT.cleanFileName(`${'x'.repeat(200)}.pdf`).length === 114);
  check('documents, drawings, photos and emails go; pages and programs do not', ATT.fileType('plan.DWG') === 'image/vnd.dwg' && ATT.fileType('SSWP.pdf') === 'application/pdf'
    && ATT.fileType('run.exe') === null && ATT.fileType('page.html') === null && ATT.fileType('README') === null);
  check('never too big, empty or too many', ATT.attachProblem('a.pdf', ATT.ATTACH_MAX + 1).status === 413 && ATT.attachProblem('a.pdf', 0).status === 400
    && ATT.attachProblem('a.pdf', 10, ATT.ATTACH_PER_REQUEST).status === 409 && ATT.attachProblem('a.exe', 10).status === 415 && ATT.attachProblem('a.pdf', 10) === null);
  check('sizes as people say them', ATT.sizeText(840) === '840 bytes' && ATT.sizeText(12 * 1024) === '12 KB' && ATT.sizeText(3.4 * 1024 * 1024) === '3.4 MB');
  const py = fs.readFileSync(path.join(ROOT, 'operations.py'), 'utf8');
  const block = py.match(/ATTACH_TYPES = \{([\s\S]*?)\n\}/)[1];
  const server = Object.fromEntries([...block.matchAll(/"(\w+)": "([^"]+)"/g)].map(([, k, v]) => [k, v]));
  check('the browser allows exactly what the server allows', JSON.stringify(Object.entries(server).sort()) === JSON.stringify(Object.entries(ATT.ATTACH_TYPES).sort()),
    `${Object.keys(server).length} on the server, ${Object.keys(ATT.ATTACH_TYPES).length} here`);
  check('and the same limits', new RegExp(`ATTACH_MAX = 20 \\* 1024 \\* 1024`).test(py) && ATT.ATTACH_MAX === 20 * 1024 * 1024
    && new RegExp(`ATTACH_PER_REQUEST = ${ATT.ATTACH_PER_REQUEST}\\b`).test(py));
}

console.log('\nQuick find');
{
  const tawrs = [
    { id: 12, status: 'draft', shift: 'night', week_start: '2026-11-02', location_name: 'W1 MP 20.700–21.300', source: { area: 'W1 MP 20.700-21.300', activities: [{ activityId: 'C-W103', title: 'Wayside equipment case foundations', party: 'Pacific Civil' }] } },
    { id: 7, status: 'approved', shift: 'day', week_start: '2026-10-19', location_name: 'Daly City TCR', source: { activities: [{ activityId: 'T-M401', title: 'IXL SIM testing', party: 'Hitachi' }] } },
    { id: 3, status: 'superseded', shift: 'day', week_start: '2026-10-19', location_name: 'Daly City TCR', source: {} },
    { id: 120, status: 'submitted', shift: 'day', week_start: '2026-11-09', location_name: 'Colma TCR', source: {} },
  ];
  const rows = [
    { id: 'a', kind: 'activity', activity_id: 'C-W101', description: 'Cable trough installation', location: 'W1 MP 17.2', party: 'Hitachi' },
    { id: 's', kind: 'section', description: 'W LINE — CONSTRUCTION' },
    { id: 'r', kind: 'resource', description: 'Resource' },
  ];
  const locations = [{ id: 'tcr:Daly City', name: 'Daly City TCR (Train Control Room)', kind: 'tcr', near: 'M1 MP 13.5' }, { id: 'stn:Colma', name: 'Colma Station', kind: 'station' }];
  const screens = [{ id: 'reports', title: 'Reports', detail: 'Approval rate', words: 'charts statistics' }];
  const list = FIND.entries({ tawrs, rows, locations, screens });
  const titles = (q) => FIND.search(list, q).map((f) => f.title);
  check('requests replaced by a revision or a consolidation are not found; sections and names rows are not activities',
    !list.some((e) => e.id === 'tawr:3') && list.filter((e) => e.kind === 'activity').length === 1 && list.length === 3 + 1 + 2 + 1);
  check('a request by its number, before the one whose number only starts the same', titles('#12')[0] === '#12 W1 MP 20.700–21.300' && titles('12')[0] === '#12 W1 MP 20.700–21.300', titles('12').join(' | '));
  check('an activity by its ID, whatever the case', titles('c-w101')[0] === 'C-W101 · Cable trough installation');
  check('a place: the request there before the room on the drawing, both found', titles('daly city').join(' | ') === '#7 Daly City TCR | Daly City TCR (Train Control Room)', titles('daly city').join(' | '));
  check('every word typed has to be found, anywhere in it', titles('cable hitachi')[0] === 'C-W101 · Cable trough installation' && !titles('cable pacific').length);
  check('a request by its work, its party, its shift', titles('wayside')[0] === '#12 W1 MP 20.700–21.300' && titles('pacific civil')[0] === '#12 W1 MP 20.700–21.300'
    && titles('night').includes('#12 W1 MP 20.700–21.300'));
  check('a screen by its name or its words', titles('reports')[0] === 'Reports' && titles('statistics')[0] === 'Reports');
  check('nothing typed finds nothing; a limit is kept', FIND.search(list, '   ').length === 0 && FIND.search(list, 'a', { limit: 2 }).length === 2);
}

console.log('\nToday at a glance');
{
  const recs = [
    { id: 1, status: 'draft', week_start: '2026-11-02', first_day: '2026-11-02', location_name: 'A', source: {}, comments: [{ id: 5, by_id: 9, text: 'hello' }], seen_comment: 0 },
    { id: 2, status: 'draft', week_start: '2026-11-30', first_day: '2026-11-30', location_name: 'B', source: {} },
    { id: 3, status: 'submitted', week_start: '2026-10-26', first_day: '2026-10-26', location_name: 'C', source: {} },
    { id: 4, status: 'approved', week_start: '2026-10-19', first_day: '2026-10-19', location_name: 'D', source: { days: [{ date: '2026-10-20' }] }, bart: { sent_on: '2026-10-02' } },
  ];
  const f = Object.fromEntries(TODAY.figures({ records: recs, today: '2026-10-16', userId: 2 }).map((x) => [x.key, x]));
  check('drafts due within a week, and where they are', f.due.n === 1 && f.due.go.week === '2026-11-02' && f.due.go.view === 'tawr');
  check('waiting for approval, waiting for BART, comments not yet read', f.approve.n === 1 && f.approve.go.week === '2026-10-26' && f.bart.n === 1 && f.comments.n === 1, JSON.stringify(f));
  check('nothing in conflict is said as nothing', f.clash.n === 0 && f.clash.go.view === 'map');
}

console.log('\nThe sample data');
{
  const { start, rows, cells } = SAMPLE.sampleLookahead('2026-10-17', MAP);
  check('it starts on the coming Monday', start === '2026-10-19' && SAMPLE.sampleStart('2026-10-19') === '2026-10-19');
  check('and covers four weeks', cells.every((c) => c.day >= start && c.day <= la.addDaysISO(start, 27)) && cells.some((c) => c.day >= la.addDaysISO(start, 21)));
  const acts = rows.filter((r) => r.kind === 'activity');
  check('construction and testing and commissioning', acts.some((r) => r.activity_id.startsWith('C-')) && acts.some((r) => r.activity_id.startsWith('T-')));
  check('on the W line and the M line only', acts.every((r) => (r.link.limits || []).every((l) => /^[WM]/.test(l.track))) && acts.some((r) => /W\d/.test(r.location)) && acts.some((r) => /M\d/.test(r.location)));
  check('every location linked to the track plan, with the drawing\'s geometry for track', acts.every((r) => L.hasLink(r.link)) && acts.filter((r) => r.link.limits.length).every((r) => r.link.geometry.length));
  check('every milepost inside its track\'s calibrated range', acts.every((r) => r.link.limits.every((l) => {
    const t = MAP.tracks.find((x) => x.id === l.track);
    return t && l.from_mp >= t.from_mp && l.to_mp <= t.to_mp;
  })));
  const model = la.makeModel(rows, cells);
  let id = 1;
  const found = [];
  const kinds = new Set();
  for (let w = 0; w < 4; w++) {
    const week = la.addDaysISO(start, 7 * w);
    const groups = T.extractWeek(model, week, { legend: la.DEFAULT_LEGEND, codes: la.DEFAULT_CODES, locations: MAP.locations }).groups;
    for (const g of groups) kinds.add(g.kind);
    check(`week ${w + 1} raises requests with nothing blocking them`, groups.length >= 4 && groups.every((g) => !T.blockers(g).length));
    const recs = groups.map((g) => ({ id: id++, status: 'draft', shift: g.shift, week_start: week, location_name: g.locationName, source: { days: g.days, activities: g.activities } }));
    for (const c of T.conflicts(recs)) found.push({ week: w + 1, c });
  }
  check('TCR requests and track requests both', kinds.has('tcr') && kinds.has('track'));
  check('five conflicts, planted', found.length === 5, found.map((f) => `${f.week}:${f.c.a.location_name}/${f.c.b.location_name}`).join(' '));
  check('some on one shift, which can be consolidated', found.filter((f) => f.c.a.shift === f.c.b.shift).length === 2);
  check('some across shifts, which cannot', found.filter((f) => f.c.a.shift !== f.c.b.shift).length === 3);
  check('one in a train control room', found.some((f) => /Daly City TCR/.test(f.c.a.location_name) && /Daly City TCR/.test(f.c.b.location_name)));
  check('one where the night shift runs into a Blanket', found.some((f) => [f.c.a.shift, f.c.b.shift].sort().join() === 'night,possession'));
  const cancelled = T.extractWeek(model, la.addDaysISO(start, 7), { legend: la.DEFAULT_LEGEND, codes: la.DEFAULT_CODES, locations: MAP.locations }).groups
    .find((g) => g.activities.some((a) => a.activityId === 'C-M304'));
  check('a cancelled day asks for nothing', cancelled.days.length === 1);
}

console.log('\nThe 4WLA workbook');
{
  const buf = buildLookaheadWorkbook();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  check('the calendar sheet is found by its weekday row', la.lookaheadSheets(ab).join() === '4WLA Sept');
  const read = la.readWorkbook(ab, { anchorISO: '2026-09-01' });
  check('the days are dated', read.dated && read.view.days[0].date === '2026-09-07');
  check('the workbook\'s own key is read', read.fromKey.length === 0 && read.legend.some((e) => e.argb === 'FFC000'));
  check('a colour nobody named is reported, not guessed', read.unknown.some((u) => u.hex === 'C6E0B4'));
  const { model, report } = la.modelFromView(read.view, { fromISO: '2026-09-07', legend: read.legend });
  const ixl = model.rows.find((r) => r.description === 'IXL Regression');
  check('activities come across with their location', ixl?.location === 'TPSS 12');
  check('their Resource row comes with them', model.rows.some((r) => r.kind === 'resource' && r.parent_id === ixl.id));
  check('the paint comes across as the shift', la.getCell(model, ixl.id, '2026-09-07')?.color === 'FFFF00');
  check('shading is left behind', report.droppedColours > 0 && !model.rows.some((r) => r.description === 'Only shading'));
  const chosen = la.modelFromView(read.view, { fromISO: '2026-09-07', legend: read.legend, choices: { C6E0B4: '0070C0' } });
  check('a colour somebody says is a shift comes across as it', chosen.model.rows.some((r) => r.description === 'Only shading'));

  // Written out in BART's layout, and read straight back by the reader that imports BART's file.
  const start = SAMPLE.sampleStart('2026-10-16');
  const { rows, cells } = SAMPLE.sampleLookahead('2026-10-16', MAP);
  const out = la.makeModel(rows, cells);
  const witRow = rows.find((r) => r.kind === 'activity');
  const witDay = cells.find((c) => c.row_id === witRow.id).day;
  la.applyOps(out, [{ op: 'cell', row_id: witRow.id, day: witDay, color: la.getCell(out, witRow.id, witDay).color, text: 'X.~WIT' }]);
  const days = la.windowDays(start, 4);
  const bytes = XL.lookaheadWorkbook({ model: out, days, legend: la.DEFAULT_LEGEND, codes: la.DEFAULT_CODES, title: '4 Week Look Ahead' });
  const back = la.readWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { anchorISO: start });
  check('the export is a workbook the import reads, dated', back.dated && back.view.days[0].date === start && back.view.days.length === 28, back.view.days[0]?.date);
  check('every colour in it is the legend\'s, or the sheet\'s own weekend and band greys', back.unknown.length === 0, JSON.stringify(back.unknown));
  const again = la.modelFromView(back.view, { fromISO: start, legend: back.legend }).model;
  const acts = (m) => la.orderedRows(m.rows).filter((r) => r.kind === 'activity');
  check('every activity comes back, in order, with its columns', acts(again).map((r) => [r.activity_id, r.description, r.location, r.sswp, r.party, r.work_hours].join('|')).join('\n')
    === acts(out).map((r) => [r.activity_id, r.description, r.location, r.sswp, r.party, r.work_hours].join('|')).join('\n'));
  const painted = (m) => acts(m).flatMap((r) => days.map((d) => la.getCell(m, r.id, d)).filter((c) => c?.color).map((c) => `${c.day} ${c.color} ${c.text}`)).sort().join(';');
  check('and every painted day with its shift and support', painted(again) === painted(out));
  check('a struck-out witness comes back struck out', la.getCell(again, acts(again)[0].id, witDay)?.text === 'X.~WIT', la.getCell(again, acts(again)[0].id, witDay)?.text);
  check('sections and Resource rows come back too', again.rows.filter((r) => r.kind === 'section').length === out.rows.filter((r) => r.kind === 'section').length
    && again.rows.some((r) => r.kind === 'resource'));
  const plain = XL.lookaheadWorkbook({ model: out, days, legend: la.DEFAULT_LEGEND, codes: la.DEFAULT_CODES, resources: false });
  const noNames = la.readWorkbook(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength), { anchorISO: start });
  check('without names, only the work is written', !la.modelFromView(noNames.view, { fromISO: start, legend: noNames.legend }).model.rows.some((r) => r.kind === 'resource'));
  check('the file is named for its window', XL.lookaheadFileName(days) === `4WLA ${start} to ${days[27]}.xlsx`);
}

console.log('\nBART\'s form, filled');
{
  const fieldSpecs = T.TAWR_FIELDS.map(([name, kind]) => ({ name, kind }));
  const blank = buildFormPdf(fieldSpecs);
  const form = pdf.readForm(blank);
  check('a stand-in form has every field', pdf.missingFields(form, T.TAWR_FIELDS.map((f) => f[0])).length === 0);
  const values = T.formValues(colmaDay, { profile: { requestor_name: 'Alex Morgan' } });
  const signature = { field: 'requestor_signature', width: 300, height: 100, strokes: [[[10, 50], [60, 20], [120, 80]]] };
  const { bytes, report } = pdf.fillForm(blank, values, { signature, textSize: 9 });
  const back = pdf.readForm(bytes);
  const val = (n) => back.fields.find((f) => f.name === n)?.value;
  check('the Area from the track plan is on the form', val('row1_area') === colmaDay.area, val('row1_area'));
  check('the dates are on the form', val('row1_date') === '11/02/2026');
  check('the filler stamps itself', back.filler === `TAWR filler ${pdf.FILLER_VERSION}`);
  check('the original bytes are kept', Buffer.from(bytes.subarray(0, blank.length)).equals(Buffer.from(blank)));
  check('everything fits', Object.values(report.fields).every((r) => r.fits));
  const z = zip.zipStore([{ name: 'a.pdf', data: bytes }, { name: 'b.pdf', data: bytes }]);
  const files = readZip(z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength));
  check('the week downloads as one zip', files.size === 2 && files.get('a.pdf').length === bytes.length);
}

console.log('\nphases');
{
  const text = JSON.stringify([
    { id: 'p2', name: ' Phase 2 ', note: 'W and Y lines', bbox: [150, 930, 1900, 1265.4] },
    { name: 'no box' }, { name: 'backwards', bbox: [10, 0, 0, 10] }, { name: '', bbox: [0, 0, 1, 1] }, 'junk',
  ]);
  const phases = PH.parsePhases(text);
  check('only well-formed phases are read, named and boxed', phases.length === 1 && phases[0].name === 'Phase 2' && phases[0].bbox[3] === 1265, JSON.stringify(phases));
  check('a broken setting reads as no phases, never a throw', PH.parsePhases('{').length === 0 && PH.parsePhases(null).length === 0);
  check('and is written back the same', PH.parsePhases(PH.phasesText(phases))[0].note === 'W and Y lines');
  const cover = PH.linesInBox(MAP.routes, phases[0].bbox);
  check('a box covers the tracks with a calibrated point inside it', cover.lines.join() === 'W,Y' && cover.tracks.includes('Y1') && !cover.tracks.some((t) => t.startsWith('M')), cover.tracks.join(','));
  check('said in words', PH.coversText(MAP.routes, phases[0].bbox) === 'the W and Y lines');
  check('a box over no track says so', PH.coversText(MAP.routes, [0, 0, 10, 10]) === 'no calibrated track');
  check('inside a box', PH.insideBox([200, 1000], phases[0].bbox) && !PH.insideBox([2000, 1000], phases[0].bbox));
}

console.log('\nlearning memory');
{
  const act = (title, activityId, party, extra = {}) => ({ title, activityId, party, hoursText: '2200-0500', sswp: '701', ...extra });
  const src = (kind, acts, tracks, codes = ['X']) => ({
    kind, activities: acts, support: codes.map((code) => ({ code })),
    place: { places: kind === 'tcr' ? [{ id: 'tcr:Colma', name: 'Colma TCR' }] : [], limits: tracks.map((t) => ({ track: t, from_mp: 17.2, to_mp: 17.9 })) },
  });
  const nightForm = (id, extra = {}) => ({
    work_in_track_zone_yes: true, clearance_verification_yes: true, track_inspection_first_train_no: true,
    police_advisory_threat_of_theft: true, person_in_charge_name: 'Dana Okafor', person_in_charge_cell_phone: '415-555-0142',
    row1_date: '10/20/2026', row1_power_off: true, row2_date: '10/21/2026', row2_power_off: true, ...extra,
  });
  let n = 0;
  const entry = (kind, tawrId, data, at = '2026-10-10T10:00:00Z') => ({ id: ++n, kind, tawr_id: tawrId, at, by: 'Rae', data });
  const cable = src('track', [act('Cable trough installation', 'C-W101', 'Hitachi')], ['W1', 'W2']);
  const pull = src('track', [act('Signal cable pull', 'C-W102', 'Hitachi')], ['W2']);
  const entries = [
    entry('form', 1, { action: 'submit', shift: 'night', source: LEARN.compactSource(cable), answers: LEARN.answersOf(nightForm(1)) }),
    entry('form', 1, { action: 'approve', shift: 'night', source: LEARN.compactSource(cable), answers: LEARN.answersOf(nightForm(1)) }, '2026-10-11T10:00:00Z'),
    entry('form', 2, { action: 'submit', shift: 'night', source: LEARN.compactSource(pull), answers: LEARN.answersOf(nightForm(2)) }),
    entry('form', 3, { action: 'submit', shift: 'day', source: LEARN.compactSource(src('track', [act('Wayside equipment case foundations', 'C-W103', 'Pacific Civil')], ['W1'])),
      answers: LEARN.answersOf({ work_in_track_zone_yes: true, clearance_verification_no: true, person_in_charge_name: 'Luis Ortega', person_in_charge_cell_phone: '415-555-0177', row1_date: '10/20/2026', row1_power_na: true }) }),
    entry('link', null, { title: 'IXL SIM testing — San Bruno', activityId: 'T-W201', typed: 'San Bruno', link: { location_id: 'tcr:San Bruno', location_name: 'San Bruno TCR', location_kind: 'tcr', limits: [] } }),
    entry('reject', 9, { shift: 'night', source: LEARN.compactSource(cable), reason: 'No flagger named for night work on W1' }),
    entry('outcome', 2, { kept: ['power', 'person_in_charge'], changed: [{ unit: 'police_advisory_threat_of_theft', predicted: true, final: false }] }),
  ];
  const index = LEARN.buildIndex(entries, { now: Date.parse('2026-10-16T12:00:00Z') });
  check('each request is learned from once, by its last word', index.examples.length === 3 && index.examples.find((e) => e.id === 1).approved);
  check('the answers a form gives, a decision at a time', JSON.stringify(LEARN.answersOf(nightForm(1)).person_in_charge) === '["Dana Okafor","415-555-0142"]'
    && LEARN.answersOf(nightForm(1)).power === 'off' && LEARN.answersOf(nightForm(1)).clearance_verification === 'yes');

  const target = { ...src('track', [act('Cable trough installation', 'C-W101', 'Hitachi')], ['W1', 'W2']), shift: 'night' };
  const defaults = { work_in_track_zone_yes: true, clearance_verification_no: true, track_inspection_first_train_no: true, row1_date: '11/09/2026', row1_power_na: true, row2_date: '11/10/2026', row2_power_na: true };
  const guess = LEARN.predict(index, target, { generated: defaults });
  check('a similar request predicts what was sent before', guess.power?.value === 'off' && guess.clearance_verification?.value === 'yes' && guess.police_advisory_threat_of_theft?.value === true
    && guess.person_in_charge?.value[0] === 'Dana Okafor', JSON.stringify(Object.fromEntries(Object.entries(guess).map(([k, v]) => [k, v.value]))));
  check('and says how sure, from how many', guess.power.support === 2 && guess.power.confidence >= 0.6 && guess.power.from.includes(1));
  check('what the setup already gives is no prediction', !('work_in_track_zone' in guess) && !('track_inspection_first_train' in guess));
  const filled = LEARN.applyPredictions(defaults, guess);
  check('a prediction fills every box it decides', filled.row1_power_off && filled.row2_power_off && !filled.row1_power_na && filled.clearance_verification_yes && !filled.clearance_verification_no
    && filled.person_in_charge_cell_phone === '415-555-0142');
  check('the fields it fills are named for marking', LEARN.fieldsOf('power', filled).includes('row2_power_off') && LEARN.fieldsOf('person_in_charge').length === 2);

  const unlike = { ...src('tcr', [act('IXL SIM testing', 'T-M401', 'BART Systems')], [], ['TCE']), shift: 'day' };
  check('an unlike request predicts nothing', Object.keys(LEARN.predict(index, unlike, { generated: {} })).length === 0);
  const split = LEARN.buildIndex([
    entry('form', 21, { action: 'submit', shift: 'night', source: LEARN.compactSource(cable), answers: LEARN.answersOf(nightForm(21, { row1_power_off: false, row1_power_on: true, row2_power_off: false, row2_power_on: true })) }),
    entry('form', 22, { action: 'submit', shift: 'night', source: LEARN.compactSource(cable), answers: LEARN.answersOf(nightForm(22)) }),
  ], { now: Date.parse('2026-10-16T12:00:00Z') });
  check('requests that disagree predict nothing', !('power' in LEARN.predict(split, target, { generated: defaults })));
  const monitored = LEARN.buildIndex([1, 2].map((i) => entry('form', 30 + i, { action: 'submit', shift: 'night', source: LEARN.compactSource(cable),
    answers: LEARN.answersOf(nightForm(30 + i, { maint_safety_monitor_details: 'BART safety monitor' })) })), { now: Date.parse('2026-10-16T12:00:00Z') });
  check('a details line is predicted only with its tick', !('maint_safety_monitor_details' in LEARN.predict(monitored, target, { generated: defaults })));

  const record = { id: 40, week_start: '2026-11-09', shift: 'night', source: { ...cable, predicted: guess }, fields: { ...filled, row1_power_off: false, row1_power_on: true, row2_power_off: false, row2_power_on: true } };
  const outcome = LEARN.outcomeOf(record);
  check('what was sent is checked against what was predicted', outcome.changed.length === 1 && outcome.changed[0].unit === 'power' && outcome.changed[0].final === 'on' && outcome.kept.includes('person_in_charge'), JSON.stringify(outcome));
  const left = LEARN.entriesFor(record, 'submit');
  check('submitting leaves the form and its outcome in the memory', left.map((e) => e.kind).join() === 'form,outcome' && left[0].data.answers.power === 'on' && !('geometry' in left[0].data.source.place));
  check('a rejection is remembered with its reason', LEARN.entriesFor(record, 'reject', 'No flagger')[0].data.reason === 'No flagger' && LEARN.entriesFor(record, 'withdraw').length === 0);
  const acc = LEARN.accuracy(index);
  check('how often predictions were kept is tracked', acc.kept === 2 && acc.changed === 1 && Math.round(acc.rate * 100) === 67 && acc.units[0].key);

  const byId = LEARN.suggestLink(index, { activity_id: 'T-W201', description: 'Anything', location: '' });
  const byWords = LEARN.suggestLink(index, { activity_id: '', description: 'IXL SIM Testing San Bruno', location: '' });
  check('a location is suggested from the same activity linked before', byId?.link.location_id === 'tcr:San Bruno' && byId.how === 'id' && byId.score === 1);
  check('or one named the same way, never as surely', byWords?.link.location_id === 'tcr:San Bruno' && byWords.how === 'words' && byWords.score < 1);
  check('but not where the location typed says somewhere else', LEARN.suggestLink(index, { activity_id: '', description: 'IXL SIM Testing San Bruno', location: 'Daly City' }) === null);
  check('but not from a stranger', LEARN.suggestLink(index, { activity_id: 'X-1', description: 'Rail grinding', location: '' }) === null);
  const fills = LEARN.suggestFields(index, { activity_id: 'C-W101', description: 'Cable trough installation', party: '', work_hours: '', sswp: '702' });
  check('its party and hours from the requests it was in, never over what is there', fills.party?.value === 'Hitachi' && fills.work_hours?.value === '2200-0500' && !fills.sswp, JSON.stringify(fills));
  const warned = LEARN.rejectionsLike(index, target);
  check('a request like one rejected says why that one was', warned.length === 1 && /flagger/.test(warned[0].reason) && LEARN.rejectionsLike(index, unlike).length === 0);

  const routes = { W1: [{ legs: [{ pts: [[0, 0], [100, 0]], mps: [17, 18] }] }] };
  const drawn = { location_id: null, location_name: null, location_kind: null, limits: [{ track: 'W1', from_mp: 17.2, to_mp: 17.5 }], geometry: [[[20.004, 0], [50.0049, 0]]] };
  const kept = LEARN.linkEntry({ description: 'Tie replacement W1', activity_id: 'T-W301', location: 'W1 17.2' }, drawn).data.link;
  check('a link is remembered with its drawing, rounded', JSON.stringify(kept.geometry) === '[[[20,0],[50,0]]]' && kept.limits[0].track === 'W1');
  const again = LEARN.restoreLink({ ...kept, geometry: undefined }, routes);
  check('and drawn again from its limits when it was too long to keep', again.geometry.length === 1 && Math.round(again.geometry[0][0][0]) === 20 && Math.round(again.geometry[0].at(-1)[0]) === 50);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
