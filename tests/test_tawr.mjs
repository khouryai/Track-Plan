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
  check('a colour nobody named is reported, not guessed', read.unknown.some((u) => u.hex === 'D9D9D9'));
  const { model, report } = la.modelFromView(read.view, { fromISO: '2026-09-07', legend: read.legend });
  const ixl = model.rows.find((r) => r.description === 'IXL Regression');
  check('activities come across with their location', ixl?.location === 'TPSS 12');
  check('their Resource row comes with them', model.rows.some((r) => r.kind === 'resource' && r.parent_id === ixl.id));
  check('the paint comes across as the shift', la.getCell(model, ixl.id, '2026-09-07')?.color === 'FFFF00');
  check('shading is left behind', report.droppedColours > 0 && !model.rows.some((r) => r.description === 'Only shading'));
  const chosen = la.modelFromView(read.view, { fromISO: '2026-09-07', legend: read.legend, choices: { D9D9D9: '0070C0' } });
  check('a colour somebody says is a shift comes across as it', chosen.model.rows.some((r) => r.description === 'Only shading'));
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
