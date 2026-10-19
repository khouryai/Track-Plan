#!/usr/bin/env node
/**
 * The whole flow, in a browser: the look-ahead, linking an activity to the
 * track plan, drafts raised by themselves, submitted by the requester,
 * consolidated and approved by the Track Allocation Manager, and downloaded as
 * BART's form — once on the static site (everything in the browser), once
 * against server.py (accounts, and the server deciding).
 *
 *   node tests/smoke.mjs [--only static|server] [--shots DIR]
 *
 * The suite runs as though it were Friday 16 October 2026, 15:00 local time,
 * so the week of 2 November is the one whose TAWRs are due today. Any console
 * error or page error fails the run.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { buildFormPdf } from './fixtures/tawr_fixture.mjs';
import { buildLookaheadWorkbook } from './fixtures/xlsx_fixture.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const T = await import(path.join(ROOT, 'web/js/tawr.js'));
const pdf = await import(path.join(ROOT, 'web/js/tawr_pdf.js'));
const { readZip } = await import(path.join(ROOT, 'web/js/xlsx.js'));

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const NOW = new Date(2026, 9, 16, 15, 0, 0); // local time
const WEEK = '2026-11-02';
const WINDOW = '2026-10-12';

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  if (ok) { passed++; console.log(`  ✓ ${line}`); } else { failures.push(line); console.log(`  ✗ ${line}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-'));
const formPath = path.join(tmp, 'BART TAWR form.pdf');
fs.writeFileSync(formPath, buildFormPdf(T.TAWR_FIELDS.map(([name, kind]) => ({ name, kind }))));
const bookPath = path.join(tmp, '4WLA.xlsx');
fs.writeFileSync(bookPath, buildLookaheadWorkbook());

/* ── A static host, as GitHub Pages is ─────────────────────────────────── */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function staticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(WEB, p === '/' ? 'index.html' : p);
      if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

function pythonServer() {
  const port = 8800 + Math.floor(Math.random() * 400);
  const env = { ...process.env, TRACKPLAN_OPS_DB: path.join(tmp, 'ops.db'), TRACKPLAN_TEMPLATE: path.join(tmp, 'tawr.pdf') };
  const child = spawn('python3', [path.join(ROOT, 'server.py'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => http.get(`http://127.0.0.1:${port}/api/me`, (r) => { r.resume(); resolve({ child, base: `http://127.0.0.1:${port}/` }); })
      .on('error', () => (Date.now() - started > 20000 ? reject(new Error(`server.py did not start:\n${log}`)) : setTimeout(poll, 200)));
    poll();
  });
}

/* ── Driving the page ───────────────────────────────────────────────────── */

async function open(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  // The page's clock starts at NOW and runs. Pinned (setFixedTime), new Date()
  // never moves, and Leaflet times its pans with it: a pan never finished, and
  // the map stayed on its first frame with the requests off-screen.
  await page.clock.install({ time: NOW });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource')) return; // judged by URL below
    errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const p = new URL(r.url()).pathname;
    // Expected: probing for a server on a static host, missing tiles in a checkout, a signed-out probe.
    if (['/api/me', '/tiles/index.json', '/api/lookahead'].includes(p) || r.status() === 401 || r.status() === 403) return;
    errors.push(`${r.status()} ${p}`);
  });
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack}`));
  await page.goto(base, { waitUntil: 'networkidle' });
  return { page, errors, context };
}

const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const dayIndex = (iso, from = WINDOW) => Math.round((Date.parse(iso) - Date.parse(from)) / 864e5);
const rowOf = (page, title) => page.locator('tr.la-activity', { has: page.locator('td.la-m1', { hasText: title }) });
const dayCell = (page, title, iso, from = WINDOW) => rowOf(page, title).locator('td.la-day').nth(dayIndex(iso, from));

async function addActivity(page, title) {
  await page.click('[data-action=add-activity]');
  await page.waitForFunction(() => document.activeElement?.classList.contains('la-input'));
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await rowOf(page, title).waitFor();
}

async function paint(page, title, from, to, color) {
  await dayCell(page, title, from).click();
  await dayCell(page, title, to).click({ modifiers: ['Shift'] });
  await page.click(`[data-paint="${color}"]`);
}

async function typeIn(page, title, iso, text) {
  await dayCell(page, title, iso).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function link(page, title, { place = '', find = '', track = '', from = '', to = '', before = null }) {
  await rowOf(page, title).locator('td.la-m2').hover();
  await rowOf(page, title).locator('[data-action=loc-link]').click();
  await page.waitForSelector('#tab-pick.active');
  if (find) await page.fill('#pick-find', find);
  else if (place) await page.selectOption('#pick-location', place);
  if (track) {
    await page.click('#typed-limits summary');
    await page.selectOption('#pick-form select[name=track_id]', track);
    await page.fill('#pick-form input[name=from_mp]', from);
    await page.fill('#pick-form input[name=to_mp]', to);
  }
  if (before) await before();
  await page.click('#pick-save');
  await page.waitForSelector('#view-lookahead .la-grid');
}

async function confirm(page) {
  await page.click('.modal [data-action=confirm]');
  await page.waitForSelector('.modal-back', { state: 'detached' });
}

const card = (page, text) => page.locator('.tawr-card', { has: page.locator('h3', { hasText: text }) });

/* ══════════════════════════════════════════════════════════════════════════ */

async function flow(page, { mode }) {
  console.log(`\n${mode}: the look-ahead`);
  await page.waitForSelector('.la-grid');
  check('the look-ahead opens first', await page.locator('body[data-view=lookahead]').count() === 1);
  check('the TAWR week is highlighted', (await page.locator('.la-week-on').getAttribute('data-week')) === WEEK);

  await addActivity(page, 'IXL SIM Testing');
  await addActivity(page, 'Cable pull');
  await paint(page, 'IXL SIM Testing', WEEK, '2026-11-04', 'FFFF00');
  await typeIn(page, 'IXL SIM Testing', WEEK, 'x.wit');
  await paint(page, 'Cable pull', '2026-11-03', '2026-11-03', 'FFFF00');
  await typeIn(page, 'Cable pull', '2026-11-03', 'X');
  const mon = dayCell(page, 'IXL SIM Testing', WEEK);
  check('a day is painted in its shift colour', (await mon.evaluate((n) => getComputedStyle(n).backgroundColor)) === 'rgb(255, 255, 0)');
  check('and carries the BART support typed in it, tidied', (await mon.textContent()) === 'X.WIT');

  await rowOf(page, 'Cable pull').locator('td.la-m1').click();
  await page.keyboard.press('Control+z');
  check('undo takes back the last change', (await dayCell(page, 'Cable pull', '2026-11-03').textContent()) === '');
  await page.keyboard.press('Control+y');
  check('and redo puts it back', (await dayCell(page, 'Cable pull', '2026-11-03').textContent()) === 'X');

  await rowOf(page, 'IXL SIM Testing').locator('td.la-m4').click();
  await page.keyboard.type('BART');
  await page.keyboard.press('Enter');

  console.log(`\n${mode}: Select on track plan`);
  await link(page, 'IXL SIM Testing', {
    find: 'colma tcr', track: 'W2', from: '16.6', to: '16.9',
    before: async () => {
      check('the picker opens ready to click along the track', await page.locator('#tab-pick .tool.armed[data-tool=path]').count() === 1);
      check('typing a name finds the TCR', (await page.$eval('#pick-location', (sel) => sel.value)) === 'tcr:Colma');
      check('a TCR with track says it makes two TAWRs', await page.locator('#pick-split').isVisible() && /two TAWRs/.test(await page.textContent('#pick-split')), await page.textContent('#pick-split'));
    },
  });
  const loc = rowOf(page, 'IXL SIM Testing').locator('td.la-m2');
  check('the Location cell says the TCR and the track limits', /Colma TCR · W2 MP 16\.600–16\.900/.test(await loc.textContent()), await loc.textContent());
  check('and is marked as linked', await loc.evaluate((n) => n.classList.contains('loc-linked')));
  await loc.hover();
  check('a linked Location offers Map, where an unlinked one offered Link', await loc.locator('[data-action=loc-map]').isVisible() && await rowOf(page, 'Cable pull').locator('[data-action=loc-link]').count() === 1);
  await loc.click({ button: 'right' });
  check('right-clicking still offers Select on track plan', await page.locator('[data-action=select-on-track-plan]').count() === 1);
  await page.keyboard.press('Escape');
  await link(page, 'Cable pull', { track: 'W2', from: '16.8', to: '17.2' });
  await rowOf(page, 'IXL SIM Testing').locator('td.la-m1').click();
  await page.click('[data-action=add-resource]');
  const names = page.locator('tr.la-resource td.la-day').nth(dayIndex(WEEK));
  await names.click();
  await page.keyboard.type('Victor, Rosa');
  await page.keyboard.press('Enter');
  check('a Resource row under an activity names who is on it', (await names.textContent()) === 'Victor, Rosa');
  await shot(page, `${mode}-1-lookahead`);

  console.log(`\n${mode}: drafts raised by themselves`);
  await page.waitForFunction(() => document.querySelector('#tawr-count')?.textContent === '3', null, { timeout: 15000 });
  check('the week due is raised without being asked', true);
  await page.click('nav.views [data-view=tawr]');
  await page.waitForSelector('.tawr-card');
  check('one request per place — the TCR and the track separately', await page.locator('.tawr-card').count() === 3);
  const tcr = card(page, 'Colma TCR');
  const ixl = card(page, 'W2 MP 16.600–16.900');
  check('the TCR request is the room alone', (await tcr.locator('.area').textContent()) === 'Colma TCR' && await tcr.locator('.badge.kind-tcr').count() === 1);
  check('the track request is the limits alone', (await ixl.locator('.area').textContent()) === 'W2 MP 16.600-16.900' && await ixl.locator('.badge.kind-track').count() === 1, await ixl.locator('.area').textContent());
  check('the support is asked for once, with the track', /EIC/.test(await ixl.locator('.facts').textContent()) && /None/.test(await tcr.locator('.facts').textContent()));
  check('and the TCR request says so', /asked for on its track request/.test(await tcr.textContent()));
  check('overlapping track is named to each other', await page.locator('.flags .overlap').count() === 2);
  check('and the conflict — same track, same time — is said on both', await page.locator('.flags .clash').count() === 2);
  check('a requester is not offered consolidation', await page.locator('[data-action=consolidate-pair]').count() === 0);
  check('nor approval', await page.locator('[data-action=tawr-approve]').count() === 0);
  check('the party to action and the crew come off the look-ahead', /Party to action: BART/.test(await ixl.textContent()) && /Crew: Rosa, Victor/.test(await ixl.textContent()));
  check('each request says whose turn it is, and by when', /^Your turn: review and submit by \w{3} \d+ \w{3}$/.test(await ixl.locator('.next').textContent()), await ixl.locator('.next').textContent());
  check('a TCR request names the track request made from the same activity', new RegExp(`^Goes with #${await ixl.getAttribute('data-tawr-id')} \\(track\\)`).test(await tcr.locator('.pair').textContent()), await tcr.locator('.pair').textContent());
  check('its details stay folded away until asked for', await ixl.locator('.tawr-detail').isHidden());
  await ixl.locator('.tawr-toggle').click();
  check('and open under the row', await ixl.locator('.tawr-detail .facts').isVisible());
  await ixl.locator('[data-action=tawr-review]').click();
  check('the review says what BART usually needs that is still blank', /^Still blank: .*Person in charge/.test(await page.textContent('.modal .need')), await page.textContent('.modal .need'));
  await page.fill('.modal input[data-field=schedule_number]', 'S-123');
  await page.click('.modal [data-action=review-save]');
  await page.waitForSelector('.modal-back', { state: 'detached' });
  await page.waitForFunction(() => [...document.querySelectorAll('.tawr-card')].some((c) => /1 field changed by hand/.test(c.textContent)));
  check('a field changed in Review is kept and marked as changed by hand', true);
  await ixl.locator('[data-action=tawr-map]').click();
  await page.waitForSelector('body[data-view=map]');
  const back = page.locator('#map-back');
  check('a request shown on the map offers the way back to it', /^← Back to TAWR #\d+$/.test(await back.textContent()) && await back.isVisible(), await back.textContent());
  await back.click();
  await page.waitForSelector('body[data-view=tawr]');
  check('which returns to it, opened', await card(page, 'W2 MP 16.600–16.900').locator('.tawr-detail').isVisible());

  console.log(`\n${mode}: the conflicts on the track plan`);
  await page.click('nav.views [data-view=map]');
  await page.waitForSelector('#onmap .status-filter');
  await page.waitForTimeout(300);
  check('the track plan opens fitted to the whole sheet', await fitted(page));
  check('the conflict is listed', /Conflicts this week \(1\)/.test(await page.textContent('#onmap')));
  const clash = await page.textContent('#onmap .clash-list li');
  check('in words: who, and where and when they meet', /want the same track at the same time/.test(clash) && /Where W2 MP 16\.800–16\.900/.test(clash), clash);
  check('every track request carries its number on the map', await page.locator('.req-tag').count() === 2 && /^#\d+$/.test(await page.locator('.req-tag span').first().textContent()));
  const ink = await page.evaluate(() => ({
    blend: getComputedStyle(document.querySelector('.leaflet-ink-pane')).mixBlendMode,
    bands: document.querySelectorAll('.leaflet-ink-pane path.tawr-line').length,
    hatched: document.querySelectorAll('.leaflet-ink-pane path.tawr-clash').length,
  }));
  check('requests are ink multiplied into the drawing, one path each', ink.blend === 'multiply' && ink.bands === 2, JSON.stringify(ink));
  check('only the stretch both want is hatched as the conflict', ink.hatched === 1, JSON.stringify(ink));
  check('the week picker reads as a date', /^Week of \d+ \w{3}/.test(await page.locator('#onmap select option:checked').textContent()));
  check('and drawn where the track is shared', await page.locator('.clash-pin').count() === 1);
  check('a filter chip per status, with the week\'s counts', await page.locator('.status-filter .chip').count() === 4 && /Draft\s*3/.test(await page.textContent('.status-filter [data-status=draft]')));
  await page.locator('#onmap .clash-list li').first().click();
  await page.waitForTimeout(200);
  check('picking a conflict makes both requests glow', await page.locator('#viewport path.tawr-glow').count() >= 2);
  const pt = await lineUnderMouse(page);
  check('a request line is in view to hover', !pt.why, pt.why);
  if (!pt.why) {
    await page.mouse.move(pt.x, pt.y, { steps: 4 });
    await page.waitForSelector('.leaflet-tooltip.map-tip', { timeout: 5000 });
    const tipText = await page.textContent('.leaflet-tooltip.map-tip');
    await shot(page, `${mode}-2b-hover`);
    check('hovering a request shows its party, description and limits', /Party to action: BART/.test(tipText) && /IXL SIM Testing|Cable pull/.test(tipText) && /Limits: W2 MP/.test(tipText), tipText);
    await page.mouse.move(5, 300);
  }
  await page.click('.status-filter [data-status=draft]');
  check('a status switched off is not drawn', await page.locator('#viewport path.tawr-line').count() === 0);
  await page.click('.status-filter [data-status=draft]');
  await page.check('[data-action=conflicts-only]');
  check('only requests in a conflict, when asked', /TAWRs this week \(2 of 3\)/.test(await page.textContent('#onmap')));
  await page.uncheck('[data-action=conflicts-only]');
  await page.locator('#onmap li[data-tawr]').filter({ hasText: 'Colma TCR' }).click();
  await page.waitForTimeout(200);
  check('a request picked from the list glows', await page.locator('#onmap li[data-tawr].sel').count() === 1 && await page.locator('.loc-pin-lit').count() >= 1);
  await shot(page, `${mode}-2-conflicts`);

  await page.click('nav.views [data-view=tawr]');
  await page.click('.subtabs [data-section=setup]');
  await page.fill('[data-setting=requestor_name]', 'Rae Requester');
  await page.locator('.settings-row', { has: page.locator('[data-setting=requestor_name]') }).locator('button').click();
  await page.waitForSelector('.toast-good >> text=/saved/');
  await page.click('.subtabs [data-section=requests]');
  await page.waitForSelector('.tawr-card');
  for (const c of await page.locator('.tawr-card input.pick').all()) await c.check();
  await page.click('[data-action=bulk-submit]');
  await confirm(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.tawr-card')].every((c) => c.dataset.tawrStatus === 'submitted'));
  check('all three are submitted together', true);
  await shot(page, `${mode}-3-submitted`);
}

async function manage(page, { mode }) {
  console.log(`\n${mode}: the Track Allocation Manager`);
  await page.click('nav.views [data-view=tawr]');
  await page.waitForSelector('.tawr-card');
  check('the badge counts what is waiting for approval', (await page.textContent('#tawr-count')) === '3');
  check('the TCR request is not offered to consolidate with track', await card(page, 'Colma TCR').locator('[data-action=consolidate-pair]').count() === 0);
  check('the manager is told it is their turn', /^Your turn: settle the conflict, then approve or reject$/.test(await card(page, 'W2 MP 16.600–16.900').locator('.next').textContent()), await card(page, 'W2 MP 16.600–16.900').locator('.next').textContent());
  const overlapping = page.locator('.tawr-card', { has: page.locator('[data-action=consolidate-pair]') }).first();
  await overlapping.locator('.tawr-toggle').click();
  await overlapping.locator('[data-action=consolidate-pair]').click();
  await page.click('.modal [data-action=confirm]');
  await page.waitForFunction(() => document.querySelectorAll('.tawr-card').length === 2);
  const one = card(page, 'W2 MP 16.600–17.200');
  check('two overlapping track requests become one', (await one.getAttribute('data-tawr-status')) === 'submitted');
  check('its limits accumulate, leftmost to rightmost', (await one.locator('.area').textContent()) === 'W2 MP 16.600-17.200', await one.locator('.area').textContent());
  check('the TCR request stays its own', await card(page, 'Colma TCR').count() === 1);
  check('the originals are kept as consolidated', /Consolidated and superseded \(2\)/.test(await page.textContent('.tawr-history summary')));
  await one.locator('[data-action=tawr-approve]').click();
  await confirm(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.tawr-card')].some((c) => c.dataset.tawrStatus === 'approved'));
  check('approved', true);
  check('an approved request is not edited, only viewed', await one.locator('[data-action=tawr-view]').count() === 1 && await one.locator('[data-action=tawr-review]').count() === 0);

  console.log(`\n${mode}: BART's form`);
  await page.click('.subtabs [data-section=setup]');
  const chooser = page.waitForEvent('filechooser');
  await page.click('[data-action=tawr-template]');
  await (await chooser).setFiles(formPath);
  await page.waitForSelector('.toast-good >> text=/all \\d+ fields found/');
  check('the blank form is checked for every field and kept', true);
  await page.click('.subtabs [data-section=requests]');
  const dl = page.waitForEvent('download');
  await card(page, 'W2 MP 16.600–17.200').locator('[data-action=tawr-download]').click();
  const file = await dl;
  const bytes = new Uint8Array(fs.readFileSync(await file.path()));
  const form = pdf.readForm(bytes);
  const value = (n) => form.fields.find((f) => f.name === n)?.value;
  check('the download is BART\'s form, named for the week, limits and shift', file.suggestedFilename() === 'TAWR 2026-11-02 W2 MP 16.600-17.200 Day.pdf', file.suggestedFilename());
  check('filled with the limits as the Area', value('row1_area') === 'W2 MP 16.600-17.200', value('row1_area'));
  check('marked as work in the track zone', value('work_in_track_zone_yes') === 'Yes' && value('work_in_track_zone_no') !== 'Yes', `${value('work_in_track_zone_yes')} ${value('work_in_track_zone_no')}`);
  check('the dates', value('row1_date') === '11/02/2026' && value('row3_date') === '11/04/2026', value('row1_date'));
  check('and what was changed by hand, carried through consolidating', value('schedule_number') === 'S-123', value('schedule_number'));
  check('and the requester, set before it was submitted', value('requestor_name') === 'Rae Requester', value('requestor_name'));
  const zdl = page.waitForEvent('download');
  await page.click('[data-action=tawr-download-all]');
  const zf = await zdl;
  const zbytes = fs.readFileSync(await zf.path());
  const files = readZip(zbytes.buffer.slice(zbytes.byteOffset, zbytes.byteOffset + zbytes.byteLength));
  check('the week downloads as one zip, once each', files.size === 1);

  console.log(`\n${mode}: on the map`);
  await card(page, 'W2 MP 16.600–17.200').locator('[data-action=tawr-map]').click();
  await page.waitForSelector('body[data-view=map]');
  await page.waitForSelector('#onmap li[data-tawr]');
  await page.waitForTimeout(300);
  check('the approved request is listed on the map', /approved/.test(await page.locator('#onmap li[data-tawr]').filter({ hasText: 'W2 MP' }).textContent()));
  check('and glows there, picked', await page.locator('#viewport path.tawr-glow').count() > 0);
  check('shown close up rather than fitted', !(await fitted(page)));
  check('no conflict left once they are one', /Conflicts this week \(0\)/.test(await page.textContent('#onmap')));
  await shot(page, `${mode}-4-map`);
  await page.click('nav.views [data-view=lookahead]');
  check('the look-ahead shows which request each activity is in', /#\d+/.test(await rowOf(page, 'IXL SIM Testing').locator('.loc-tawr').textContent()));
  await rowOf(page, 'IXL SIM Testing').locator('.loc-tawr').click();
  await page.waitForSelector('body[data-view=tawr]');
  check('and opens it', await card(page, 'W2 MP 16.600–17.200').locator('.tawr-detail').isVisible());
  await page.click('nav.views [data-view=lookahead]');
  await page.click('nav.views [data-view=map]');
  await page.waitForTimeout(300);
  check('coming back to the track plan fits the whole sheet again', await fitted(page));
}

async function copyPaste(page, { mode }) {
  console.log(`\n${mode}: copying days, shift and all`);
  await page.click('nav.views [data-view=lookahead]');
  await dayCell(page, 'IXL SIM Testing', WEEK).click();
  await page.keyboard.press('Control+c');
  await dayCell(page, 'Cable pull', '2026-11-05').click({ button: 'right' });
  await page.click('.ctx-menu [data-action=paste]');
  const thu = dayCell(page, 'Cable pull', '2026-11-05');
  check('a copied day pastes with its shift colour', (await thu.evaluate((n) => getComputedStyle(n).backgroundColor)) === 'rgb(255, 255, 0)');
  check('and its support', (await thu.textContent()) === 'X.WIT');
  await dayCell(page, 'Cable pull', '2026-11-06').click();
  await dayCell(page, 'Cable pull', '2026-11-08').click({ modifiers: ['Shift'] });
  await dayCell(page, 'Cable pull', '2026-11-07').click({ button: 'right' });
  await page.click('.ctx-menu [data-action=paste]');
  const painted = await Promise.all(['2026-11-06', '2026-11-07', '2026-11-08'].map((d) => dayCell(page, 'Cable pull', d).evaluate((n) => getComputedStyle(n).backgroundColor)));
  check('one day pasted over several fills them all', painted.every((c) => c === 'rgb(255, 255, 0)'), painted.join());
  const html = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.querySelector('.la-scroll').dispatchEvent(Object.assign(new Event('copy', { bubbles: true }), { clipboardData: dt }));
    return dt.getData('text/html');
  });
  check('the clipboard carries the colours for Excel too', /background-color:#FFFF00/.test(html), html.slice(0, 120));
}

async function sampleData(page, { mode }) {
  console.log(`\n${mode}: sample data`);
  await page.click('nav.views [data-view=lookahead]');
  await page.click('[data-action=sample]');
  await page.click('.modal [data-action=sample-confirm]');
  await rowOf(page, 'Cable trough installation').waitFor();
  check('four weeks of W and M line work arrive, linked', await page.locator('tr.la-activity td.loc-linked').count() === 16);
  const fit = await page.evaluate(() => {
    const sc = document.querySelector('.la-scroll');
    const first = [...document.querySelectorAll('tr.la-activity')][0].querySelector('td.la-painted').getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    return { fits: sc.scrollWidth <= sc.clientWidth + 1, left: sc.scrollLeft, seen: first.left >= box.left && first.right <= box.right };
  });
  check('the four weeks fit side by side, opened at the first', fit.fits && fit.left === 0 && fit.seen, JSON.stringify(fit));
  await shot(page, `${mode}-5a-sample-lookahead`);
  check('the look-ahead shows them from the coming Monday', (await page.locator('.la-week').first().getAttribute('data-week')) === '2026-10-19');
  // Read the browser's copy: the badge counts only what waits on whoever is acting.
  await page.waitForFunction(() => {
    const tawrs = JSON.parse(localStorage.getItem('trackplan.ops.v1') || '{}').tawrs || [];
    return tawrs.length === 21 && tawrs.some((t) => t.status === 'approved');
  }, null, { timeout: 20000 });
  check('every week\'s TAWRs are raised from it — 21 over four weeks', true);
  const byWeek = await page.evaluate(() => {
    const out = {};
    for (const t of JSON.parse(localStorage.getItem('trackplan.ops.v1') || '{}').tawrs || []) {
      out[t.week_start] = out[t.week_start] || {};
      out[t.week_start][t.status] = (out[t.week_start][t.status] || 0) + 1;
    }
    return out;
  });
  const only = (w, status) => Object.keys(byWeek[w] || {}).join() === status;
  check('a week whose deadline passed a while ago is approved, but for the requests in its conflict', byWeek['2026-10-19']?.approved > 0 && byWeek['2026-10-19']?.submitted === 2 && !byWeek['2026-10-19']?.draft, JSON.stringify(byWeek['2026-10-19']));
  check('the week whose deadline has just passed is submitted, waiting for approval', only('2026-10-26', 'submitted'), JSON.stringify(byWeek['2026-10-26']));
  check('the weeks still to come are drafts', only('2026-11-02', 'draft') && only('2026-11-09', 'draft'), JSON.stringify(byWeek));
  await page.click('nav.views [data-view=map]');
  await page.waitForSelector('#onmap .status-filter');
  check('the week due shows its conflicts on the track plan', /Conflicts this week \(2\)/.test(await page.textContent('#onmap')) && await page.locator('.clash-pin').count() === 2);
  await page.selectOption('#onmap select', '2026-11-09');
  const sidebar = await page.textContent('#onmap');
  check('another week, another conflict', /Conflicts this week \(1\)/.test(sidebar));
  check('the third shift is called Blanket, never by its stored name', /Blanket shift/.test(sidebar) && !/possession/i.test(sidebar));
  await shot(page, `${mode}-5-sample-map`);
}

/**
 * A point where a request's line is what is actually under the mouse: on its
 * stroke, inside the map, not under a pin, a panel or a toast. The line may run
 * far off-screen after the zoom to a conflict, so its points are tested rather
 * than assumed — and only once the map has stopped: a point found mid-zoom or
 * mid-pan is elsewhere when it stops. So no zoom or pan may be running, and the
 * same point has to be found twice, 100 ms apart.
 * When there is none, `why` says what is on top of each line instead.
 */
async function lineUnderMouse(page) {
  await page.evaluate(() => { globalThis.__lineUnderMouse = null; });
  const found = await page.waitForFunction(() => {
    let at = null;
    if (!document.querySelector('#viewport .leaflet-map-pane:is(.leaflet-zoom-anim, .leaflet-pan-anim)')) {
      search: for (const p of document.querySelectorAll('#viewport path.tawr-line')) {
        const len = p.getTotalLength();
        const m = p.getScreenCTM();
        for (let i = 1; i < 40; i++) {
          const q = p.getPointAtLength((len * i) / 40);
          const x = q.x * m.a + q.y * m.c + m.e;
          const y = q.x * m.b + q.y * m.d + m.f;
          if (document.elementFromPoint(x, y) === p) { at = { x, y }; break search; }
        }
      }
    }
    const before = globalThis.__lineUnderMouse;
    globalThis.__lineUnderMouse = at;
    return at && before && at.x === before.x && at.y === before.y ? at : null;
  }, null, { polling: 100, timeout: 5000 }).catch(() => null);
  if (found) return found.jsonValue();
  return {
    why: await page.evaluate(() => {
      const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${(e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('')}` : 'nothing');
      const lines = [...document.querySelectorAll('#viewport path.tawr-line')];
      const out = [`${lines.length} lines`, `window ${globalThis.innerWidth}x${globalThis.innerHeight}`, `map pane ${name(document.querySelector('#viewport .leaflet-map-pane'))}`];
      for (const p of lines.slice(0, 4)) {
        const len = p.getTotalLength();
        const m = p.getScreenCTM();
        const q = p.getPointAtLength(len / 2);
        const x = Math.round(q.x * m.a + q.y * m.c + m.e);
        const y = Math.round(q.x * m.b + q.y * m.d + m.f);
        const r = p.getBoundingClientRect();
        out.push(`line ${Math.round(len)} long, middle ${x},${y}, box ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}, pointer-events ${getComputedStyle(p).pointerEvents}, on top ${name(document.elementFromPoint(x, y))}`);
      }
      out.push(`dialogs ${document.querySelectorAll('.modal').length}`, `toasts "${[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ')}"`);
      return out.join('; ');
    }),
  };
}

async function fitted(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#viewport img.leaflet-image-layer, #viewport .leaflet-tile-container');
    const vp = document.querySelector('#viewport').getBoundingClientRect();
    if (!img) return false;
    const r = img.getBoundingClientRect();
    return r.width <= vp.width + 4 && r.width >= vp.width * 0.8;
  });
}

async function importBook(page, { mode }) {
  console.log(`\n${mode}: importing the 4WLA workbook`);
  await page.click('nav.views [data-view=lookahead]');
  const chooser = page.waitForEvent('filechooser');
  await page.click('[data-action=import]');
  await (await chooser).setFiles(bookPath);
  await page.waitForSelector('.modal [data-action=import-confirm]');
  await page.fill('.modal input[type=date]', '2026-09-07');
  await page.click('.modal [data-action=import-confirm]');
  await rowOf(page, 'IXL Regression').waitFor();
  check('its activities come in, painted', (await dayCell(page, 'IXL Regression', '2026-09-07', '2026-09-07').evaluate((n) => getComputedStyle(n).backgroundColor)) === 'rgb(255, 255, 0)');
  check('a location the track plan does not know is marked', await rowOf(page, 'IXL Regression').locator('td.loc-unlinked').count() === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */

const browser = await chromium.launch();
try {
  if (!only || only === 'static') {
    const { srv, base } = await staticServer();
    const { page, errors, context } = await open(browser, base);
    await page.fill('.modal input', 'Rae');
    await page.click('[data-action=acting]');
    await flow(page, { mode: 'static site' });
    await page.click('#who button');
    await page.selectOption('.modal select', 'manager');
    await Promise.all([page.waitForEvent('load'), page.click('[data-action=acting]')]);
    await page.waitForSelector('#loading', { state: 'detached' });
    check('the role is chosen in this browser, and says so', /Track Allocation Manager/.test(await page.textContent('#who')));
    await manage(page, { mode: 'static site' });
    await copyPaste(page, { mode: 'static site' });
    await importBook(page, { mode: 'static site' });
    await sampleData(page, { mode: 'static site' });
    check('no console errors (static site)', !errors.length, errors.join(' | '));
    await context.close();
    srv.close();
  }
  if (!only || only === 'server') {
    const { child, base } = await pythonServer();
    try {
      const { page, errors, context } = await open(browser, base);
      console.log('\nserver: accounts');
      await page.waitForSelector('.modal [data-action=signin]');
      check('the first visit makes the first account', /first account/i.test(await page.textContent('.modal')));
      const inputs = page.locator('.modal input');
      await inputs.nth(0).fill('Terry Manager');
      await inputs.nth(1).fill('tam');
      await inputs.nth(2).fill('manager-pass');
      await page.click('.modal [data-action=signin]');
      await page.waitForSelector('.la-grid');
      check('and it is the Track Allocation Manager', /Track Allocation Manager/.test(await page.textContent('#who')));
      // The requester's account, added by the manager.
      const made = await page.evaluate(async () => (await fetch('api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'trackplan' },
        body: JSON.stringify({ username: 'rae', name: 'Rae Requester', role: 'requester', password: 'requester-pass' }),
      })).status);
      check('the manager adds the requester', made === 201);
      // Sign out, and wait for the page it reloads to: the old one may still be
      // finishing a raise, and a sign-in box opened there is thrown away.
      await Promise.all([page.waitForEvent('load'), page.click('#who button')]);
      await page.waitForSelector('.modal [data-action=signin]');
      await page.locator('.modal input').nth(0).fill('rae');
      await page.locator('.modal input').nth(1).fill('requester-pass');
      await page.click('.modal [data-action=signin]');
      await page.waitForSelector('#loading', { state: 'detached' });
      check('a requester signs in as one', /Rae Requester · Requester/.test(await page.textContent('#who')));
      await page.click('nav.views [data-view=lookahead]');
      await flow(page, { mode: 'server' });
      const refused = await page.evaluate(async () => {
        const list = await (await fetch('api/tawrs')).json();
        return (await fetch(`api/tawrs/${list[0].id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'trackplan' }, body: '{}' })).status;
      });
      check('the server refuses a requester approving, whatever the page does', refused === 403);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#loading', { state: 'detached' });
      await page.click('nav.views [data-view=lookahead]');
      await page.waitForSelector('.la-grid');
      check('the look-ahead is kept by the server', await rowOf(page, 'IXL SIM Testing').count() === 1);
      await Promise.all([page.waitForEvent('load'), page.click('#who button')]);
      await page.waitForSelector('.modal [data-action=signin]');
      await page.locator('.modal input').nth(0).fill('tam');
      await page.locator('.modal input').nth(1).fill('manager-pass');
      await page.click('.modal [data-action=signin]');
      await page.waitForSelector('#loading', { state: 'detached' });
      await manage(page, { mode: 'server' });
      check('no console errors (server)', !errors.length, errors.join(' | '));
      await context.close();
    } finally {
      child.kill();
    }
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
