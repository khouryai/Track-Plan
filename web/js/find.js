/**
 * Quick find: what a few typed letters could mean — a request by its number,
 * its place or its work; an activity on the look-ahead by its ID or its words;
 * a station, train control room or yard on the track plan; or a screen — best
 * first. The finder (`finder.js`) draws it; this decides it.
 *
 * `entries()` turns what is loaded into things to find once; `search()` ranks
 * them against what was typed. Every word typed has to be found somewhere in an
 * entry, and an entry found by its own name or number ranks above one found by
 * a word somewhere in its details.
 *
 * Pure: no DOM — tests/test_tawr.mjs reads it.
 *
 * Imports: nothing.
 */

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const KIND_RANK = { request: 3, activity: 2, screen: 2, place: 1 };

/**
 * Things to find, from what the page has loaded:
 *
 *   tawrs      requests (those a revision or a consolidation replaced are left out)
 *   rows       the look-ahead's rows (activities are found)
 *   locations  the track plan's stations, TCRs and yards (`map.json` locations)
 *   screens    `[{ id, title, detail, words }]`: where the page can go
 *
 * `statusName`, `shiftName`, `linkText` and `dayName` say a status, a shift, a
 * track plan link and a day in words. Each entry is `{ kind, id, title, name?, detail, keys,
 * words, ref }` — `name` what it is called when its title leads with a number.
 */
export function entries({
  tawrs = [], rows = [], locations = [], screens = [],
  statusName = (s) => s, shiftName = (s) => s, linkText = () => '', dayName = (d) => d,
} = {}) {
  const out = [];
  for (const r of tawrs) {
    if (['superseded', 'consolidated'].includes(r.status)) continue;
    const acts = r.source?.activities || [];
    out.push({
      kind: 'request', id: `tawr:${r.id}`, ref: r,
      title: `#${r.id} ${r.location_name || ''}`.trim(),
      name: fold(r.location_name), // found by its place as readily as by its number
      detail: [statusName(r.status), `${shiftName(r.shift)} shift`, `week of ${dayName(r.week_start)}`, acts.map((a) => [a.activityId, a.title].filter(Boolean).join(' ')).join('; ')].filter(Boolean).join(' · '),
      keys: [`#${r.id}`, String(r.id)],
      words: fold([r.location_name, r.source?.area, statusName(r.status), shiftName(r.shift), ...acts.flatMap((a) => [a.activityId, a.title, a.party, a.rawLocation])].join(' ')),
      when: r.week_start,
    });
  }
  for (const row of rows) {
    if (row.kind !== 'activity') continue;
    const id = String(row.activity_id || '').trim();
    const desc = String(row.description || '').trim();
    if (!id && !desc) continue;
    const where = linkText(row.link) || row.location || '';
    out.push({
      kind: 'activity', id: `row:${row.id}`, ref: row,
      title: [id, desc].filter(Boolean).join(' · '),
      detail: [where, row.party].filter(Boolean).join(' · '),
      keys: id ? [fold(id)] : [],
      words: fold([id, desc, row.location, where, row.party, row.sswp].join(' ')),
    });
  }
  for (const l of locations) {
    out.push({
      kind: 'place', id: `place:${l.id}`, ref: l, title: l.name,
      detail: [{ tcr: 'Train control room', station: 'Station', yard: 'Yard', platform: 'Platform' }[l.kind] || l.kind, l.near].filter(Boolean).join(' · '),
      keys: [], words: fold([l.name, l.kind, l.near].join(' ')),
    });
  }
  for (const s of screens) {
    out.push({ kind: 'screen', id: `screen:${s.id}`, ref: s, title: s.title, detail: s.detail || '', keys: [fold(s.title)], words: fold([s.title, s.words].join(' ')) });
  }
  return out;
}

/** How well one entry answers the words typed; 0 when one of them is nowhere in it. */
function score(e, text, words) {
  const title = fold(e.title);
  let s = 0;
  if (e.keys.includes(text)) s += 100;                       // its number, its ID, a screen's name
  if (title.startsWith(text) || e.name?.startsWith(text)) s += 60;
  else if (title.includes(text)) s += 30;
  for (const w of words) {
    const inTitle = title.split(/[^a-z0-9#.-]+/).some((t) => t.startsWith(w));
    if (inTitle) s += 20;
    else if (title.includes(w)) s += 12;
    else if (e.words.includes(w) || e.keys.some((k) => k.startsWith(w))) s += 6;
    else return 0;
  }
  return s + (KIND_RANK[e.kind] || 0);
}

/**
 * The entries that answer `text`, best first, at most `limit`: `[{ ...entry,
 * score }]`. Nothing typed answers with nothing; ties go to the request for the
 * latest week, then to the order the entries came in.
 */
export function search(list, text, { limit = 12 } = {}) {
  const t = fold(text).trim();
  if (!t) return [];
  const words = t.split(/\s+/).filter(Boolean);
  return (list || [])
    .map((e, i) => ({ e, i, s: score(e, t, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(b.e.when || '').localeCompare(String(a.e.when || '')) || a.i - b.i)
    .slice(0, limit)
    .map((x) => ({ ...x.e, score: x.s }));
}
