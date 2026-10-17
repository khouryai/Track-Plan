/**
 * The track plan link: where on the map an activity's work is.
 *
 * A link is what "Select on track plan" saves onto a look-ahead activity:
 *
 *   { location_id, location_name, location_kind,   a station, TCR, yard or platform
 *     limits: [{ track, from_mp, to_mp } | { name, kind, context }],
 *     geometry: [[[x, y], …], …] }                    the track picked, drawing points
 *
 * Either half may be missing — a TCR with no track, or a block of track with
 * no station — but not both. From it come the Location column's text
 * (`linkLabel`), the TAWR's Area (`linkArea`), the key that says two
 * activities are at the same place (`linkKey`), and whether two places
 * overlap on the drawing (`linksOverlap`).
 *
 * Pure: no DOM, no Leaflet. The map module uses the same geometry helpers.
 *
 * Imports: nothing (leaf).
 */

/* ── Geometry ──────────────────────────────────────────────────────────── */

/** Points every `step` drawing points along each polyline. */
export function samplePolys(polys, step = 1) {
  const out = [];
  for (const pl of polys || []) for (let i = 0; i < pl.length - 1; i++) {
    const [ax, ay] = pl[i];
    const [bx, by] = pl[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}

/** The 1.5-point grid cells a geometry passes through: two geometries sharing one share track. */
export function cellSet(polys) {
  return new Set(samplePolys(polys, 1).map(([x, y]) => `${Math.round(x / 1.5)},${Math.round(y / 1.5)}`));
}

export function bboxOf(polys) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const pl of polys || []) for (const [x, y] of pl) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/* ── Words ─────────────────────────────────────────────────────────────── */

const r3 = (v) => Number(v).toFixed(3);

/** One limit as a line: "M1 MP 16.039 – 16.350", or a named piece with where it is. */
export function limitText(l, { dash = ' – ' } = {}) {
  if (l.track) return `${l.track} MP ${r3(l.from_mp)}${dash}${r3(l.to_mp)}`;
  return l.name + (l.context ? ` (${l.context})` : '');
}

/** "Colma TCR (Train Control Room)" → "Colma TCR": the words a cell has room for. */
export function shortLocationName(name) {
  return String(name || '').replace(/\s*\(Train Control Room\)\s*$/i, '').trim();
}

export function hasLink(link) {
  return Boolean(link && (link.location_id || (link.limits && link.limits.length) || (link.geometry && link.geometry.length)));
}

/** What the Location column says for a link: the place, then the first limit and how many more. */
export function linkLabel(link) {
  if (!hasLink(link)) return '';
  const parts = [];
  if (link.location_name) parts.push(shortLocationName(link.location_name));
  const lims = link.limits || [];
  const tracks = lims.filter((l) => l.track);
  const first = tracks[0] || lims[0];
  if (first) parts.push(first.track ? limitText(first, { dash: '–' }) : first.name);
  const more = lims.length - (first ? 1 : 0);
  return parts.join(' · ') + (more > 0 ? ` +${more}` : '');
}

/**
 * The TAWR's Area for a link, as the form's Area column wants it: tracks,
 * mileposts and the station or train control room. Plain hyphens, so the form
 * prints it in any font.
 */
export function linkArea(link) {
  if (!hasLink(link)) return '';
  const parts = [];
  if (link.location_name) parts.push(shortLocationName(link.location_name));
  for (const l of link.limits || []) parts.push(l.track ? limitText(l, { dash: '-' }) : l.name);
  return parts.join('; ');
}

/**
 * The key that says two links are the same place: the station or TCR where
 * there is one, otherwise the track limits themselves. Two activities with the
 * same key are one TAWR; two different keys whose track overlaps are offered to
 * the track allocation manager to consolidate.
 */
export function linkKey(link) {
  if (!hasLink(link)) return null;
  if (link.location_id) return `loc:${link.location_id}`;
  const sig = (link.limits || []).map((l) => limitText(l, { dash: '-' })).sort().join('|');
  return `trk:${sig || `${(link.geometry || []).length}`}`;
}

/* ── Combining and comparing ───────────────────────────────────────────── */

/** Several links as one: every place, every limit once, all the geometry. */
export function unionLinks(links) {
  const live = (links || []).filter(hasLink);
  const places = new Map();
  const limits = new Map();
  const geometry = [];
  for (const l of live) {
    if (l.location_id) places.set(l.location_id, { id: l.location_id, name: l.location_name, kind: l.location_kind });
    for (const lim of l.limits || []) limits.set(limitText(lim), lim);
    for (const pl of l.geometry || []) geometry.push(pl);
  }
  /* Limits on one track that touch or overlap become one range, so two
     activities a few hundred feet apart on M1 read as one stretch of M1. */
  const byTrack = new Map();
  const named = [];
  for (const lim of limits.values()) {
    if (!lim.track) { named.push(lim); continue; }
    if (!byTrack.has(lim.track)) byTrack.set(lim.track, []);
    const lo = Math.min(lim.from_mp, lim.to_mp);
    const hi = Math.max(lim.from_mp, lim.to_mp);
    byTrack.get(lim.track).push([lo, hi]);
  }
  const merged = [];
  for (const [track, ranges] of [...byTrack].sort((a, b) => a[0].localeCompare(b[0]))) {
    ranges.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [lo, hi] of ranges) {
      if (cur && lo <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], hi);
      else { if (cur) merged.push({ track, from_mp: cur[0], to_mp: cur[1] }); cur = [lo, hi]; }
    }
    if (cur) merged.push({ track, from_mp: cur[0], to_mp: cur[1] });
  }
  named.sort((a, b) => a.name.localeCompare(b.name));
  return { places: [...places.values()], limits: [...merged, ...named], geometry };
}

/** The Area of several links together: every place, then every limit. */
export function unionArea(links) {
  const u = unionLinks(links);
  return [...u.places.map((p) => shortLocationName(p.name)), ...u.limits.map((l) => (l.track ? limitText(l, { dash: '-' }) : l.name))].join('; ');
}

/**
 * Whether two places overlap: the same station or TCR, or track in common on
 * the drawing, or the same milepost on the same track. `cache` keeps each
 * geometry's cells between calls.
 */
export function linksOverlap(a, b, cache = new WeakMap()) {
  if (!hasLink(a) || !hasLink(b)) return false;
  if (a.location_id && a.location_id === b.location_id) return true;
  for (const la of a.limits || []) {
    if (!la.track) continue;
    for (const lb of b.limits || []) {
      if (lb.track !== la.track) continue;
      const [a0, a1] = [Math.min(la.from_mp, la.to_mp), Math.max(la.from_mp, la.to_mp)];
      const [b0, b1] = [Math.min(lb.from_mp, lb.to_mp), Math.max(lb.from_mp, lb.to_mp)];
      if (a0 <= b1 && b0 <= a1) return true;
    }
  }
  const cells = (l) => {
    if (!l.geometry?.length) return null;
    if (!cache.has(l)) cache.set(l, cellSet(l.geometry));
    return cache.get(l);
  };
  const ca = cells(a);
  const cb = cells(b);
  if (!ca || !cb) return false;
  const [small, big] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
  for (const c of small) if (big.has(c)) return true;
  return false;
}

/* ── Typed locations ───────────────────────────────────────────────────── */

const fold = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A location typed on the look-ahead (or imported with the workbook) matched
 * to the track plan's list: exactly, by its full name or the short one
 * ("Colma TCR"), case and punctuation ignored, never by a fragment. A station
 * name alone is the station. Null where nothing matches — that activity has to
 * be linked on the map.
 */
export function resolveLocationText(text, locations) {
  const want = fold(text);
  if (!want) return null;
  for (const loc of locations || []) {
    const names = [loc.name, shortLocationName(loc.name)];
    if (loc.kind === 'station') names.push(loc.name.replace(/\s+Station$/i, ''));
    if (loc.kind === 'tcr') names.push(`${shortLocationName(loc.name)} (TCR)`, shortLocationName(loc.name).replace(/\s+TCR$/i, ' Train Control Room'));
    if (names.some((n) => fold(n) === want)) return loc;
  }
  return null;
}

/** A link for a location alone, as typed text resolves to. */
export function linkForLocation(loc) {
  return loc ? { location_id: loc.id, location_name: loc.name, location_kind: loc.kind, limits: [], geometry: [] } : null;
}
