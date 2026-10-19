/**
 * The track map. The base layer is the drawing rendered into map tiles
 * straight from the vector PDF (pipeline/make_tiles.py), so it is sharp at
 * every zoom. Overlays use the drawing's own coordinates: PDF points, origin
 * top-left, mapped to Leaflet CRS.Simple as latLng(-y, x).
 *
 * Two layers of track data come from the extraction (web/data/map.json):
 *   routes    milepost-calibrated running tracks (W1, M2, C1 ...): exact MPs
 *   segments  every piece of track on the drawing - running tracks, crossovers,
 *             yard leads, pocket and middle tracks - each with a name and the
 *             calibrated MP where it meets a running track.
 *
 * What the map is for now: **linking a look-ahead activity to where it is.**
 * `pickLocation()` opens the Link panel for one activity — a station, its TCR
 * (train control room), a yard or platform, and/or a block of track picked by
 * box, by drawing along it, piece by piece or as a typed milepost range — and
 * answers the link (`links.js`) the look-ahead saves on the activity. And it
 * draws the week's TAWRs where they are, coloured by status, so overlapping
 * requests can be seen before they go to BART.
 *
 * Imports: links, ui.
 */

import { samplePolys, bboxOf, limitText, limitsText, hasLink, linkArea, shortLocationName, sharedSpot, sliceRoute } from './links.js';
import { el, esc, toast } from './ui.js';
import { tawrShiftLabel } from './tawr.js';
import { insideBox, coversText } from './phases.js';

const L = window.L;
const PAGE_W = 6552;
const PAGE_H = 1440;

/** TAWR status colours: the same on the map, the list and the cards. */
export const STATUS_COLOR = {
  draft: '#8a8f98', submitted: '#e08a00', approved: '#1f5fbf', rejected: '#d1242f',
  superseded: '#b8bcc4', consolidated: '#b8bcc4',
};
const HOVER = '#0a8f6a';
const ROUTE = '#8a2be2';
const ACTIVITY = '#0a8f6a';
const KIND_COLOR = { running: '#8a2be2', crossover: '#e0670b', yard: '#16a34a', track: '#0ea5e9' };
const $ = (s) => document.querySelector(s);
const r3 = (v) => Math.round(v * 1000) / 1000;

const state = {
  data: null, tool: null, draft: [], path: null, pick: null, overlay: null, selected: null,
  // The track plan's own view of the week: which statuses to draw, conflicts only, the conflict in focus.
  statuses: new Set(['draft', 'submitted', 'approved', 'rejected']), conflictsOnly: false, conflict: null,
  // Phases: the ones defined, the one being looked at, whether its requests are listed alone, one being drawn.
  phases: [], phase: null, phaseOnly: true, phaseDraw: null,
};
const SHOWN_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const CONFLICT = '#d1242f';
const GLOW = '#14d3a0'; // bright whatever the status, so a grey draft glows as clearly as a blue approval

// ------------------------------------------------------------------ calibrated routes

let RSEGS = [];
const GRID = 60;
const rgrid = new Map();

function gridAdd(g, i, x0, y0, x1, y1) {
  for (let gx = Math.floor(Math.min(x0, x1) / GRID); gx <= Math.floor(Math.max(x0, x1) / GRID); gx++) {
    for (let gy = Math.floor(Math.min(y0, y1) / GRID); gy <= Math.floor(Math.max(y0, y1) / GRID); gy++) {
      const k = `${gx},${gy}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
  }
}
function gridNear(g, x, y, r) {
  const out = new Set();
  for (let gx = Math.floor((x - r) / GRID); gx <= Math.floor((x + r) / GRID); gx++) {
    for (let gy = Math.floor((y - r) / GRID); gy <= Math.floor((y + r) / GRID); gy++) {
      for (const i of g.get(`${gx},${gy}`) || []) out.add(i);
    }
  }
  return out;
}
function projSeg(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0; const dy = y1 - y0; const L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2));
  const px = x0 + t * dx; const py = y0 + t * dy;
  return { t, px, py, d: Math.hypot(px - x, py - y) };
}

function indexRoutes() {
  RSEGS = []; rgrid.clear();
  for (const [track, pieces] of Object.entries(state.data.routes)) {
    for (const pc of pieces) {
      for (const lg of pc.legs) {
        for (let i = 0; i < lg.pts.length - 1; i++) {
          const [x0, y0] = lg.pts[i]; const [x1, y1] = lg.pts[i + 1];
          RSEGS.push({ track, x0, y0, x1, y1, m0: lg.mps[i], m1: lg.mps[i + 1] });
          gridAdd(rgrid, RSEGS.length - 1, x0, y0, x1, y1);
        }
      }
    }
  }
}

/** Nearest calibrated track point within r: {track, mp, x, y, d}. */
function nearestTrackPoint(x, y, r, track) {
  let best = null;
  for (const i of gridNear(rgrid, x, y, r)) {
    const g = RSEGS[i];
    if (track && g.track !== track) continue;
    const p = projSeg(x, y, g.x0, g.y0, g.x1, g.y1);
    if (p.d <= r && (!best || p.d < best.d)) best = { track: g.track, mp: g.m0 + p.t * (g.m1 - g.m0), x: p.px, y: p.py, d: p.d };
  }
  return best;
}

/** Polylines covering milepost range [a, b] of a calibrated track (same rule as server.py). */
export function sliceTrack(track, a, b) {
  return sliceRoute(state.data.routes, track, a, b);
}
function locate(track, mp) {
  const p = sliceTrack(track, mp, mp);
  return p.length ? { x: p[0][0][0], y: p[0][0][1] } : null;
}
function trackRange(track) { return state.data.tracks.find((t) => t.id === track); }

// ------------------------------------------------------------------ all track segments

let NET = [];
const sgrid = new Map(); const NODES = new Map(); // node id -> {x, y, adj: [{sid, other}]}

function indexSegments() {
  NET = state.data.segments;
  sgrid.clear(); NODES.clear();
  NET.forEach((s, sid) => {
    s.cum = [0];
    for (let i = 1; i < s.pts.length; i++) s.cum.push(s.cum[i - 1] + Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]));
    s.L = s.cum[s.cum.length - 1];
    for (let i = 0; i < s.pts.length - 1; i++) gridAdd(sgrid, sid * 10000 + i, ...s.pts[i], ...s.pts[i + 1]);
    for (const [n, p] of [[s.a, s.pts[0]], [s.b, s.pts[s.pts.length - 1]]]) {
      if (!NODES.has(n)) NODES.set(n, { x: p[0], y: p[1], adj: [] });
    }
    if (s.a !== s.b) {
      NODES.get(s.a).adj.push({ sid, other: s.b });
      NODES.get(s.b).adj.push({ sid, other: s.a });
    }
  });
}

/** Nearest point on any track segment within r: {sid, s, x, y, d}. */
function segHit(x, y, r) {
  let best = null;
  for (const k of gridNear(sgrid, x, y, r)) {
    const sid = Math.floor(k / 10000); const i = k % 10000; const s = NET[sid];
    const [x0, y0] = s.pts[i]; const [x1, y1] = s.pts[i + 1];
    const p = projSeg(x, y, x0, y0, x1, y1);
    if (p.d <= r && (!best || p.d < best.d)) best = { sid, s: s.cum[i] + p.t * (s.cum[i + 1] - s.cum[i]), x: p.px, y: p.py, d: p.d };
  }
  return best;
}

function pointAt(s, d) {
  d = Math.max(0, Math.min(s.L, d));
  let i = 0;
  while (i < s.cum.length - 2 && s.cum[i + 1] < d) i++;
  const f = (d - s.cum[i]) / ((s.cum[i + 1] - s.cum[i]) || 1e-9);
  return [s.pts[i][0] + f * (s.pts[i + 1][0] - s.pts[i][0]), s.pts[i][1] + f * (s.pts[i + 1][1] - s.pts[i][1])];
}
function subPoly(sid, d0, d1) {
  const s = NET[sid]; const lo = Math.min(d0, d1); const hi = Math.max(d0, d1);
  const pts = [pointAt(s, lo)];
  for (let i = 0; i < s.pts.length; i++) if (s.cum[i] > lo && s.cum[i] < hi) pts.push(s.pts[i]);
  pts.push(pointAt(s, hi));
  return d0 <= d1 ? pts : pts.reverse();
}

/** Shortest route along the track network between two points on segments. */
function trackPath(A, B) {
  if (A.sid === B.sid) return subPoly(A.sid, A.s, B.s);
  const sa = NET[A.sid]; const sb = NET[B.sid];
  const dist = new Map(); const prev = new Map(); const done = new Set();
  dist.set(sa.a, A.s);
  dist.set(sa.b, Math.min(dist.get(sa.b) ?? Infinity, sa.L - A.s));
  for (;;) {
    let u = null; let du = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < du) { u = n; du = d; }
    if (u === null) break;
    done.add(u);
    if (done.has(sb.a) && done.has(sb.b)) break;
    for (const { sid, other } of NODES.get(u).adj) {
      const nd = du + NET[sid].L;
      if (nd < (dist.get(other) ?? Infinity)) { dist.set(other, nd); prev.set(other, { u, sid }); }
    }
  }
  const viaA = (dist.get(sb.a) ?? Infinity) + B.s; const viaB = (dist.get(sb.b) ?? Infinity) + (sb.L - B.s);
  if (!Number.isFinite(Math.min(viaA, viaB))) return null;
  const endNode = viaA <= viaB ? sb.a : sb.b;
  const chain = [];
  for (let n = endNode; prev.has(n); n = prev.get(n).u) chain.unshift(prev.get(n));
  const startNode = chain.length ? chain[0].u : endNode;
  let pts = subPoly(A.sid, A.s, startNode === sa.a ? 0 : sa.L);
  let at = startNode;
  for (const { sid } of chain) {
    const s = NET[sid];
    const fwd = s.a === at;
    pts = pts.concat((fwd ? s.pts : [...s.pts].reverse()).slice(1));
    at = fwd ? s.b : s.a;
  }
  pts = pts.concat(subPoly(B.sid, endNode === sb.a ? 0 : sb.L, B.s).slice(1));
  return pts;
}

/** Clip a polyline to a rectangle (Liang-Barsky per segment). */
function clipPoly(pts, x0, y0, x1, y1) {
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]; const [bx, by] = pts[i + 1]; const dx = bx - ax; const dy = by - ay;
    let t0 = 0; let t1 = 1; let ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const P = [ax + t0 * dx, ay + t0 * dy]; const Q = [ax + t1 * dx, ay + t1 * dy];
    if (!cur) cur = [P];
    cur.push(Q);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((pl) => pl.length > 1 && Math.hypot(pl[pl.length - 1][0] - pl[0][0], pl[pl.length - 1][1] - pl[0][1]) > 0.5);
}

function fmtEnd(e) { return e ? `${e.track} MP ${e.mp.toFixed(2)}` : null; }
function segContext(seg) {
  const [ea, eb] = seg.ends;
  if (ea && eb && ea.track === eb.track && seg.kind !== 'crossover') {
    return `${ea.track} MP ${Math.min(ea.mp, eb.mp).toFixed(2)}–${Math.max(ea.mp, eb.mp).toFixed(2)}`;
  }
  const [a, b] = seg.ends.map(fmtEnd);
  if (a && b && a !== b) return `between ${a} and ${b}`;
  if (a || b) return `from ${a || b}`;
  return '';
}

/** What a selection covers: MP ranges on calibrated tracks plus the other named pieces. */
export function describeGeometry(polys) {
  const runs = new Map(); const others = new Map();
  for (const [x, y] of samplePolys(polys, 1)) {
    const rh = nearestTrackPoint(x, y, 1.5);
    if (rh) {
      const r = runs.get(rh.track) || [Infinity, -Infinity];
      runs.set(rh.track, [Math.min(r[0], rh.mp), Math.max(r[1], rh.mp)]);
      continue;
    }
    const sh = segHit(x, y, 1.5);
    if (sh && !others.has(sh.sid)) others.set(sh.sid, NET[sh.sid]);
  }
  const limits = [...runs].sort((a, b) => a[0].localeCompare(b[0])).map(([t, [a, b]]) => ({ track: t, from_mp: r3(a), to_mp: r3(b) }));
  const named = new Map();
  for (const s of others.values()) {
    const ctx = segContext(s); const key = `${s.name}|${ctx}`;
    if (!named.has(key)) named.set(key, { name: s.name, kind: s.kind, context: ctx });
  }
  return limits.concat([...named.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

// ------------------------------------------------------------------ map

const ll = (x, y) => L.latLng(-y, x);
const llPoly = (pl) => pl.map(([x, y]) => ll(x, y));
const toXY = (latlng) => [latlng.lng, -latlng.lat];
const PAGE_BOUNDS = L.latLngBounds(ll(0, PAGE_H), ll(PAGE_W, 0));

let map = null;
const scale = () => map.getZoomScale(map.getZoom(), 0); // screen px per PDF point
const pickRadius = () => Math.max(1, 16 / scale());

// Only non-blank tiles exist; blank ones are served as white without a request.
const WHITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23fff'/%3E%3C/svg%3E";
const DrawingTiles = L.TileLayer.extend({
  // draw each tile 1px larger so neighbours overlap: no hairline seams when
  // the browser scales tiles at fractional zoom levels
  _initTile(tile) {
    L.TileLayer.prototype._initTile.call(this, tile);
    const s = this.getTileSize();
    tile.style.width = `${s.x + 1}px`;
    tile.style.height = `${s.y + 1}px`;
  },
  getTileUrl(c) {
    const z = this._getZoomForUrl(); const col = this.options.index[z] && this.options.index[z][c.x];
    return col && col.includes(c.y) ? `tiles/${z}/${c.x}/${c.y}.png` : WHITE;
  },
});

const layers = {};

function zoomTo(x0, y0, x1, y1, pad = 40) {
  map.fitBounds(L.latLngBounds(ll(x0 - pad, y1 + pad), ll(x1 + pad, y0 - pad)), { maxZoom: 3.5 });
}
const fitPage = () => map.fitBounds(PAGE_BOUNDS, { animate: false });

// ------------------------------------------------------------------ hover readout

function readoutAt(x, y) {
  const r = pickRadius(); const rh = nearestTrackPoint(x, y, r); const sh = segHit(x, y, r);
  if (rh && (!sh || rh.d <= sh.d + 1)) return { html: `<b>${rh.track}</b> MP <b>${rh.mp.toFixed(3)}</b>`, x: rh.x, y: rh.y, sid: sh && sh.sid };
  if (sh) {
    const s = NET[sh.sid]; const ctx = segContext(s);
    return { html: `<b>${esc(s.name)}</b>${ctx ? ` · ${esc(ctx)}` : ''}`, x: sh.x, y: sh.y, sid: sh.sid };
  }
  return null;
}

function showReadout(e) {
  const [x, y] = toXY(e.latlng); const hit = readoutAt(x, y);
  layers.hover.clearLayers();
  if (!hit) { $('#readout').textContent = toolPrompt() || 'Hover a track for its milepost'; return; }
  $('#readout').innerHTML = hit.html + (state.tool ? ` — ${esc(toolPrompt(true))}` : '');
  if (hit.sid != null) L.polyline(llPoly(NET[hit.sid].pts), { pane: INK, color: HOVER, weight: inkWidth() * 0.8, opacity: 0.45, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layers.hover);
  L.circleMarker(ll(hit.x, hit.y), { pane: DOTS, radius: 5, color: '#fff', weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.hover);
}

// ------------------------------------------------------------------ selection tools

const HINTS = {
  box: 'Drag a box over the block of tracks. Everything inside becomes part of the location.',
  path: 'Click where the work starts on a track, then where it ends — through crossovers too. Keep clicking to take it further; press Esc when done.',
  piece: 'Click any piece of track - crossover, yard lead, middle track - to add it; click again to remove it.',
};
function toolPrompt(short) {
  if (state.tool === 'box') return short ? 'drag to box-select' : HINTS.box;
  if (state.tool === 'path') return state.path ? (short ? 'click to extend' : 'Click the next point along the track') : (short ? 'click to start' : 'Click the start of the work limits');
  if (state.tool === 'piece') return short ? 'click to add / remove' : HINTS.piece;
  return '';
}
function setTool(t) {
  state.tool = state.tool === t ? null : t;
  state.path = null;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('armed', b.dataset.tool === state.tool));
  $('#tool-hint').textContent = state.tool ? HINTS[state.tool] : '';
  map.getContainer().classList.toggle('boxing', !!state.tool);
  if (state.tool === 'box') map.dragging.disable(); else map.dragging.enable();
  if (state.tool === 'path') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  renderDraft();
  renderOverlay(); // an armed tool takes the clicks; the overlay only shows
}

function draftGeometry() {
  return state.draft.map((p) => (p.type === 'seg' ? NET[p.sid].pts : p.pts));
}

function typedGeometry() {
  const f = $('#pick-form').elements; const t = f.track_id.value; const a = parseFloat(f.from_mp.value); const b = parseFloat(f.to_mp.value);
  return t && !Number.isNaN(a) && !Number.isNaN(b) ? sliceTrack(t, a, b) : [];
}

function onDraftChanged() {
  const geom = draftGeometry().concat(typedGeometry());
  const lims = describeGeometry(geom);
  $('#selection').hidden = !geom.length;
  /* What the request will say: the limits, leftmost to rightmost on each line.
     The pieces inside them are listed underneath, small, for checking. */
  const named = lims.filter((l) => !l.track);
  $('#sel-list').replaceChildren(...[
    ...(limitsText(lims) ? limitsText(lims).split('; ').map((t) => el('li', { class: 'sel-limits', text: t })) : []),
    named.length && lims.some((l) => l.track)
      ? el('li', { class: 'small sel-inside', text: `Inside the limits: ${named.map((l) => l.name).join(', ')}` }) : null,
    lims.some((l) => l.track) && lims.filter((l) => l.track).length > 1
      ? el('li', { class: 'small sel-inside', text: `Per track: ${lims.filter((l) => l.track).map((l) => limitText(l, { dash: '–' })).join(' · ')}` }) : null,
  ].filter(Boolean));
  splitNote();
  renderDraft();
}

function pickedLocation() {
  return locationById($('#pick-location').value);
}

function renderDraft() {
  layers.draft.clearLayers();
  const geometry = draftGeometry().concat(typedGeometry());
  if (geometry.length) L.polyline(multi(geometry), { pane: INK, color: HOVER, weight: inkWidth(), opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layers.draft);
  if (state.path) L.circleMarker(ll(state.path.x, state.path.y), { pane: DOTS, radius: 6, color: '#fff', weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.draft);
  const loc = state.pick ? pickedLocation() : null;
  if (loc) locationMarker(loc, HOVER).addTo(layers.draft);
}

// ------------------------------------------------------------------ overlays

/* ── How the overlay is drawn ──────────────────────────────────────────────
   Requests are ink on the drawing rather than paint over it. They are drawn in
   their own pane, blended with "multiply" (style.css), so the drawing's black
   linework and lettering stay crisp through them and only the paper takes the
   colour, as a highlighter does on a printed sheet. A band therefore has to be
   wider than the track line it lies on, or it vanishes into it: the sheet's
   running tracks are about 4 pt, so a band is 7.5 pt at any zoom. Each request
   is one path however many pieces of track it covers, so nothing darkens where
   the pieces meet. Dots that must stay white sit in a pane of their own above. */
const INK = 'ink';
const DOTS = 'dots';
const inkWidth = () => Math.max(6, 7.5 * scale());
/* How strongly each status inks the paper: grey needs more to read at all. */
const INK_OPACITY = { draft: 0.7, submitted: 0.55, approved: 0.5, rejected: 0.55 };
const multi = (geometry) => geometry.map(llPoly);
const PHASE = 'phase';
const PHASE_COLOR = '#5b4bc4';

function renderSegs() {
  layers.segs.clearLayers();
  if (!$('#lyr-segs').checked) return;
  for (const s of NET) L.polyline(llPoly(s.pts), { color: KIND_COLOR[s.kind] || '#0ea5e9', weight: 3, opacity: 0.55, interactive: false }).addTo(layers.segs);
}

function renderRoutes() {
  layers.routes.clearLayers();
  if (!$('#lyr-routes').checked) return;
  for (const pieces of Object.values(state.data.routes)) {
    for (const pc of pieces) for (const lg of pc.legs) L.polyline(llPoly(lg.pts), { color: ROUTE, weight: 2, opacity: 0.6, interactive: false }).addTo(layers.routes);
  }
}

function renderAnchors() {
  layers.anchors.clearLayers();
  if (!$('#lyr-anchors').checked) return;
  for (const [track, pieces] of Object.entries(state.data.routes)) {
    for (const pc of pieces) {
      for (const a of pc.anchors) {
        L.circleMarker(ll(a.x, a.y), { radius: 4, color: a.line_level ? '#b07ae6' : ROUTE, weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(`${track} MP ${a.mp}${a.line_level ? ' (line-level)' : ''}`).addTo(layers.anchors);
      }
    }
  }
}

function renderQA() {
  layers.qa.clearLayers();
  if (!$('#lyr-qa').checked) return;
  for (const l of state.data.labels) {
    if (!['out_of_sequence', 'unanchored', 'unused'].includes(l.status)) continue;
    const [x0, y0, x1, y1] = l.bbox;
    L.rectangle(L.latLngBounds(ll(x0 - 2, y1 + 2), ll(x1 + 2, y0 - 2)), { color: STATUS_COLOR.rejected, weight: 2, fill: false })
      .bindTooltip(`${l.text}: ${l.status.replace(/_/g, ' ')}`).addTo(layers.qa);
  }
}

export function locationById(id) { return state.data.locations.find((l) => l.id === id) || null; }
function locationMarker(loc, col, label = loc.name) {
  return L.marker(ll(loc.x, loc.y), { interactive: false, icon: L.divIcon({ className: 'loc-pin', html: `<span style="color:${col}">${esc(label)}</span>`, iconSize: null, iconAnchor: [10, 28] }) });
}

/**
 * The places a link can name, one pin per point on the drawing — a station and
 * its TCR share one — each opening a choice of what is there.
 */
function renderPlaces() {
  layers.places.clearLayers();
  if (!state.pick) return;
  const byPoint = new Map();
  for (const loc of state.data.locations) {
    const k = `${loc.x.toFixed(1)},${loc.y.toFixed(1)}`;
    if (!byPoint.has(k)) byPoint.set(k, []);
    byPoint.get(k).push(loc);
  }
  for (const locs of byPoint.values()) {
    const first = locs[0];
    const m = L.circleMarker(ll(first.x, first.y), { radius: 7, color: '#fff', weight: 2, fillColor: '#1f5fbf', fillOpacity: 0.9 });
    m.bindTooltip(locs.map((l) => shortLocationName(l.name)).join(' · '));
    m.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const box = el('div', { class: 'place-choice' }, [
        el('b', { text: 'Use this place' }),
        ...locs.map((l) => el('button', {
          type: 'button', class: 'secondary', dataset: { place: l.id }, text: l.name,
          onClick: () => { $('#pick-location').value = l.id; renderDraft(); map.closePopup(); },
        })),
      ]);
      L.popup({ closeButton: true }).setLatLng(ll(first.x, first.y)).setContent(box).openOn(map);
    });
    m.addTo(layers.places);
  }
}

/* ── What the look-ahead puts on the map ───────────────────────────────── */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);

/** The conflicts the overlay was given, that involve this request. */
const conflictsOf = (t) => (state.overlay?.conflicts || []).filter((c) => c.a.id === t.id || c.b.id === t.id);

/** What hovering a request says: the place, the days, and each activity with its party and limits. */
function tawrTip(t) {
  const src = t.source || {};
  const rows = (src.activities || []).map((a) => `<div class="tip-act"><b>${esc([a.activityId, a.title].filter(Boolean).join(' · '))}</b>`
    + `${a.party ? `<br>Party to action: ${esc(a.party)}` : ''}`
    + `${a.link ? `<br>Limits: ${esc(linkArea(a.link))}` : ''}</div>`).join('');
  const days = (src.days || []).map((d) => `${dayName(d.date)} ${d.start || '?'}–${d.end || '?'}`).join(', ');
  const clash = conflictsOf(t).map((c) => {
    const other = c.a.id === t.id ? c.b : c.a;
    return `<div class="tip-clash">Conflicts with #${other.id} ${esc(other.location_name)} — ${esc(c.when.map((w) => dayName(w.date)).join(', '))}</div>`;
  }).join('');
  return `<div class="tip-head">TAWR #${t.id} · ${esc(cap(t.status))}</div>`
    + `<div><b>${esc(t.location_name)}</b> · ${esc(tawrShiftLabel(t.shift))} shift</div>`
    + `<div>Limits: ${esc(src.area || t.location_name)}</div>`
    + `<div>${esc(days)}</div>${rows}${clash}`;
}

function activityTip(a) {
  return `<div class="tip-head">Look-ahead activity</div>`
    + `<div><b>${esc([a.activity_id, a.description].filter(Boolean).join(' · ') || a.title)}</b></div>`
    + `${a.party ? `<div>Party to action: ${esc(a.party)}</div>` : ''}`
    + `<div>Limits: ${esc(linkArea(a.link))}</div>`
    + `${a.days?.length ? `<div>This week: ${esc(a.days.map((d) => `${dayName(d.date)}${d.shift ? ` (${tawrShiftLabel(d.shift)})` : ''}`).join(', '))}</div>` : ''}`;
}

const tipOptions = { sticky: true, direction: 'top', className: 'map-tip', opacity: 1, offset: [0, -10] };

/** The week's requests in view: all of them, or those in the phase being looked at when it is to list them alone. */
function poolTawrs() {
  const ph = state.phaseOnly ? phaseById(state.phase) : null;
  return (state.overlay?.tawrs || []).filter((t) => !ph || inPhase(t, ph));
}

/** The requests drawn: the statuses picked, or only those in a conflict. */
function shownTawrs() {
  const o = state.overlay;
  if (!o) return [];
  const clashing = new Set((o.conflicts || []).flatMap((c) => [c.a.id, c.b.id]));
  return poolTawrs().filter((t) => state.statuses.has(t.status) && (!state.conflictsOnly || clashing.has(t.id)));
}

/** The requests glowing: the one selected, or both sides of the conflict in focus. */
function glowing() {
  const c = state.conflict;
  return new Set(c ? [c.a.id, c.b.id] : state.selected ? [state.selected] : []);
}

function renderOverlay() {
  layers.tawrs.clearLayers();
  layers.activities.clearLayers();
  const o = state.overlay;
  if (!o) return;
  const quiet = Boolean(state.pick || state.tool); // picking: the overlay is for looking, not clicking
  const w = inkWidth();
  if ($('#lyr-activities').checked) {
    for (const a of o.activities || []) {
      if (!hasLink(a.link)) continue;
      const geometry = a.link.geometry || [];
      if (geometry.length) {
        // Where the look-ahead has work: a lighter, dashed band — quieter than a request.
        L.polyline(multi(geometry), {
          pane: INK, color: ACTIVITY, weight: w * 0.75, opacity: 0.45, dashArray: `${w * 0.9} ${w * 0.8}`, lineCap: 'butt', lineJoin: 'round',
          interactive: !quiet, className: 'act-ink',
        }).bindTooltip(activityTip(a), tipOptions).addTo(layers.activities);
      }
      const loc = a.link.location_id && locationById(a.link.location_id);
      if (loc && !geometry.length) locationMarker(loc, ACTIVITY, shortLocationName(loc.name)).addTo(layers.activities);
    }
  }
  if (!$('#lyr-tawrs').checked) return;
  const shown = shownTawrs();
  const glow = glowing();
  for (const t of shown) {
    const place = t.source?.place || {};
    const col = STATUS_COLOR[t.status] || '#666';
    const lit = glow.has(t.id);
    const geometry = place.geometry || [];
    if (geometry.length) {
      if (lit) {
        // Picked: a soft halo under the band, blurred (#tp-glow in index.html) and breathing.
        L.polyline(multi(geometry), { pane: INK, color: GLOW, weight: w * 2.4, opacity: 0.5, lineCap: 'round', lineJoin: 'round', interactive: false, className: 'tawr-glow' }).addTo(layers.tawrs);
      }
      // The others step back while one is picked, so the eye goes where it was sent.
      const opacity = lit ? 0.9 : glow.size ? 0.25 : INK_OPACITY[t.status] ?? 0.55;
      const band = L.polyline(multi(geometry), {
        pane: INK, color: col, weight: w, opacity, lineCap: 'round', lineJoin: 'round', interactive: !quiet,
        className: `tawr-line st-${t.status}${lit ? ' tawr-lit' : ''}`,
      }).bindTooltip(tawrTip(t), tipOptions);
      if (!quiet) band.on('click', () => selectTawr(t));
      band.addTo(layers.tawrs);
    }
    /* Its number on the line, so which line is which needs no hovering — and a
       track request can be found when the whole sheet is fitted, too small to see. */
    const mid = midpointOf(geometry);
    if (mid) {
      const tag = L.marker(ll(mid[0], mid[1]), {
        interactive: !quiet, keyboard: false,
        icon: L.divIcon({ className: `req-tag${lit ? ' req-tag-lit' : ''}`, html: `<span style="--c:${col}">#${t.id}</span>`, iconSize: null, iconAnchor: [14, 26] }),
      }).bindTooltip(tawrTip(t), { ...tipOptions, sticky: false });
      if (!quiet) tag.on('click', () => selectTawr(t));
      tag.addTo(layers.tawrs);
    }
    for (const p of place.places || []) {
      const loc = locationById(p.id);
      if (!loc) continue;
      const m = L.marker(ll(loc.x, loc.y), {
        interactive: !quiet,
        icon: L.divIcon({ className: `loc-pin${lit ? ' loc-pin-lit' : ''}`, html: `<span style="color:${col}">#${t.id} ${esc(shortLocationName(loc.name))}</span>`, iconSize: null, iconAnchor: [10, 28] }),
      }).bindTooltip(tawrTip(t), { ...tipOptions, sticky: false });
      if (!quiet) m.on('click', () => selectTawr(t));
      m.addTo(layers.tawrs);
    }
  }
  /* Conflicts: where two requests want the same track, or room, at the same time. */
  const ids = new Set(shown.map((t) => t.id));
  for (const c of o.conflicts || []) {
    if (!ids.has(c.a.id) || !ids.has(c.b.id)) continue;
    /* The stretch both want, hatched in red over both bands (#tp-hatch in index.html). */
    const stretch = sharedLimits(c).flatMap((l) => sliceRoute(state.data.routes, l.track, l.from_mp, l.to_mp));
    if (stretch.length) {
      L.polyline(multi(stretch), { pane: INK, color: 'url(#tp-hatch)', weight: w * 1.3, opacity: 1, lineCap: 'butt', lineJoin: 'round', interactive: false, className: 'tawr-clash' }).addTo(layers.tawrs);
    }
    const spot = conflictSpot(c);
    if (!spot) continue;
    const focus = state.conflict === c;
    const m = L.marker(ll(spot.x, spot.y), {
      interactive: !quiet,
      icon: L.divIcon({ className: `clash-pin${focus ? ' clash-pin-lit' : ''}`, html: '<span>!</span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindTooltip(`<div class="tip-head tip-clash">Conflict</div><div>#${c.a.id} ${esc(c.a.location_name)} and #${c.b.id} ${esc(c.b.location_name)}</div>`
      + c.when.map((w) => `<div>${esc(dayName(w.date))}: ${esc(w.a)} and ${esc(w.b)}</div>`).join(''), { ...tipOptions, sticky: false });
    if (!quiet) m.on('click', () => focusConflict(c));
    m.addTo(layers.tawrs);
  }
}

/** The middle of the longest line in a geometry, along its length: where a request's number goes. */
function midpointOf(geometry) {
  let best = null; let bestLen = -1;
  for (const pl of geometry) {
    let len = 0;
    for (let i = 1; i < pl.length; i++) len += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
    if (len > bestLen) { best = pl; bestLen = len; }
  }
  if (!best?.length) return null;
  let left = bestLen / 2;
  for (let i = 1; i < best.length; i++) {
    const step = Math.hypot(best[i][0] - best[i - 1][0], best[i][1] - best[i - 1][1]);
    if (step >= left && step > 0) {
      const f = left / step;
      return [best[i - 1][0] + (best[i][0] - best[i - 1][0]) * f, best[i - 1][1] + (best[i][1] - best[i - 1][1]) * f];
    }
    left -= step;
  }
  return best[0];
}

/** The stretches of track two requests in a conflict both want, per track. */
function sharedLimits(c) {
  const both = [];
  for (const x of c.a.source?.place?.limits || []) {
    for (const y of c.b.source?.place?.limits || []) {
      if (x.track !== y.track) continue;
      const lo = Math.max(Math.min(+x.from_mp, +x.to_mp), Math.min(+y.from_mp, +y.to_mp));
      const hi = Math.min(Math.max(+x.from_mp, +x.to_mp), Math.max(+y.from_mp, +y.to_mp));
      if (lo < hi) both.push({ track: x.track, from_mp: lo, to_mp: hi });
    }
  }
  return both;
}

/** Where two requests in a conflict meet: the stretch of track both want, or the room. */
function sharedWhere(c) {
  const both = sharedLimits(c);
  if (both.length) return limitsText(both, { dash: '–' });
  const names = new Map((c.a.source?.place?.places || []).map((p) => [p.id, p.name]));
  const room = (c.b.source?.place?.places || []).find((p) => names.has(p.id));
  return room ? shortLocationName(room.name) : '';
}

/** "#18 Tie replacement": a request by its number and the work it is for. */
function workOf(t) {
  const acts = t.source?.activities || [];
  return `#${t.id} ${acts[0]?.title || t.location_name}${acts.length > 1 ? ` and ${acts.length - 1} more` : ''}`;
}

/** Where to pin a conflict: the track the two share, or the room. */
function conflictSpot(c) {
  const ga = c.a.source?.place?.geometry || [];
  const gb = c.b.source?.place?.geometry || [];
  const shared = sharedSpot(ga, gb);
  if (shared) return shared;
  const pa = new Set((c.a.source?.place?.places || []).map((p) => p.id));
  const room = (c.b.source?.place?.places || []).find((p) => pa.has(p.id));
  const loc = room && locationById(room.id);
  if (loc) return { x: loc.x, y: loc.y - 18, bbox: [loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70] };
  const g = ga.length ? ga : gb;
  if (!g.length) return null;
  const b = bboxOf(g);
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, bbox: b };
}

function selectTawr(t, zoom = false) {
  state.selected = t.id;
  state.conflict = null;
  if (zoom) showPlace(t.source?.place);
  renderOverlay();
  renderOnMapList();
}

function focusConflict(c) {
  state.conflict = c;
  state.selected = null;
  const spot = conflictSpot(c);
  if (spot) {
    const [x0, y0, x1, y1] = spot.bbox;
    zoomTo(x0, y0, x1, y1, 120);
  }
  renderOverlay();
  renderOnMapList();
}

/** Zoom to a place: its track if it has any, else its station or TCR. */
function showPlace(place) {
  const geom = place?.geometry || [];
  if (geom.length) { zoomTo(...bboxOf(geom), 120); return true; }
  const loc = (place?.places || [])[0] && locationById(place.places[0].id);
  if (loc) { zoomTo(loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70, 0); return true; }
  return false;
}

/** Show one link on the map — "Show on track plan" from the look-ahead. */
export function showLink(link) {
  if (!hasLink(link)) return false;
  return showPlace({ geometry: link.geometry || [], places: link.location_id ? [{ id: link.location_id }] : [] });
}

/** Show one request, glowing — "Show on track plan" from its card. */
export function showTawr(t) {
  state.statuses.add(t.status); // a request asked for is never filtered out of sight
  state.conflictsOnly = false;
  selectTawr(t, true);
  return true;
}

/** What the marks on the map mean, beyond the status colours the chips show. */
function mapKey() {
  const line = (style) => `<svg width="34" height="12" aria-hidden="true"><line x1="2" y1="6" x2="32" y2="6" style="${style}"/></svg>`;
  const rows = [
    [line(`stroke:${GLOW};stroke-width:10;stroke-opacity:.5;stroke-linecap:round;filter:url(#tp-glow-key)`), 'The request you picked glows'],
    [line('stroke:url(#tp-hatch);stroke-width:9'), 'Where two requests conflict; <span class="key-pin">!</span> marks it'],
    [line(`stroke:${ACTIVITY};stroke-width:7;stroke-opacity:.45;stroke-dasharray:7 6`), 'An activity linked on the look-ahead'],
    ['<span class="req-tag-key">#17</span>', 'A request\'s number; a TCR request is pinned at the room'],
  ];
  return el('details', { class: 'map-key', open: true }, [
    el('summary', { text: 'Key' }),
    el('ul', {}, rows.map(([sym, text]) => el('li', { html: `<span class="sym">${sym}</span><span>${text}</span>` }))),
  ]);
}

function renderOnMapList() {
  const host = $('#onmap');
  if (!host) return;
  const o = state.overlay;
  host.replaceChildren();
  if (!o) return;
  if (o.weeks?.length) {
    const sel = el('select', { 'aria-label': 'Week', onChange: (e) => o.onWeek?.(e.target.value) },
      o.weeks.map((w) => el('option', { value: w.value, text: w.label })));
    sel.value = o.week;
    host.append(el('label', {}, ['Week', sel]));
  }

  /* The phase being looked at, if one is: what it covers, and whether its requests are listed alone. */
  const ph = phaseById(state.phase);
  if (ph) {
    const alone = el('input', { type: 'checkbox', dataset: { action: 'phase-only' }, onChange: (e) => { state.phaseOnly = e.target.checked; renderOverlay(); renderOnMapList(); } });
    alone.checked = state.phaseOnly;
    host.append(el('div', { class: 'phase-note' }, [
      el('b', { text: ph.name }), ` covers ${coversText(state.data.routes, ph.bbox)}${ph.note ? ` — ${ph.note}` : ''}.`,
      el('label', { class: 'check' }, [alone, ` Only requests in ${ph.name}`]),
    ]));
  }

  /* The status filter: which of the week's requests are drawn. */
  const all = poolTawrs();
  const count = (s) => all.filter((t) => t.status === s).length;
  const chips = el('div', { class: 'status-filter', role: 'group', 'aria-label': 'Show TAWRs by status' }, SHOWN_STATUSES.map((s) => el('button', {
    type: 'button', class: `chip${state.statuses.has(s) ? ' on' : ''}`, dataset: { status: s }, style: `--c:${STATUS_COLOR[s]}`,
    'aria-pressed': String(state.statuses.has(s)), title: `${state.statuses.has(s) ? 'Hide' : 'Show'} ${s} requests`,
    onClick: () => {
      if (state.statuses.has(s)) state.statuses.delete(s); else state.statuses.add(s);
      if (state.selected && !shownTawrs().some((t) => t.id === state.selected)) state.selected = null;
      renderOverlay(); renderOnMapList();
    },
  }, [el('span', { class: 'chip-dot' }), `${cap(s)} `, el('b', { text: String(count(s)) })])));
  const only = el('input', { type: 'checkbox', dataset: { action: 'conflicts-only' }, onChange: (e) => { state.conflictsOnly = e.target.checked; renderOverlay(); renderOnMapList(); } });
  only.checked = state.conflictsOnly;
  host.append(el('h2', { text: 'Show' }), el('p', { class: 'small hint', text: 'A request is drawn in its status colour; click a status to hide or show it.' }), chips,
    el('label', { class: 'check' }, [only, ' Only requests in a conflict']), mapKey());

  /* Conflicts first: they are what needs doing. */
  const inView = state.phaseOnly ? ph : null;
  const clashes = (o.conflicts || []).filter((c) => !inView || inPhase(c.a, inView) || inPhase(c.b, inView));
  host.append(el('h2', { class: clashes.length ? 'clash-head' : '', text: `Conflicts this week (${clashes.length})` }));
  if (!clashes.length) host.append(el('p', { class: 'small', text: 'No two requests want the same track or room at the same time.' }));
  const cl = el('ul', { class: 'req-list clash-list' });
  for (const c of clashes) {
    const where = sharedWhere(c);
    const hours = (t, side) => [...new Set(c.when.map((w) => w[side]))].join(', ');
    const li = el('li', { class: state.conflict === c ? 'sel' : '', style: `--c:${CONFLICT}`, dataset: { conflict: `${c.a.id}-${c.b.id}` }, title: 'Show both on the map' }, [
      el('div', { class: 't', text: `#${c.a.id} and #${c.b.id} want the same ${c.a.source?.kind === 'tcr' ? 'room' : 'track'} at the same time` }),
      el('div', { class: 'm', text: `${workOf(c.a)} — ${tawrShiftLabel(c.a.shift)}, ${hours(c.a, 'a')} (${c.a.status})` }),
      el('div', { class: 'm', text: `${workOf(c.b)} — ${tawrShiftLabel(c.b.shift)}, ${hours(c.b, 'b')} (${c.b.status})` }),
      el('div', { class: 'm' }, [el('b', { text: 'Where ' }), where || 'their limits overlap', el('b', { text: ' · When ' }), [...new Set(c.when.map((w) => dayName(w.date)))].join(', ')]),
      c.a.shift === c.b.shift ? el('div', { class: 'm hint', text: 'The same shift: the Track Allocation Manager can consolidate them into one request.' }) : null,
    ]);
    li.addEventListener('click', () => focusConflict(c));
    cl.append(li);
  }
  host.append(cl);

  const shown = shownTawrs();
  host.append(el('h2', { text: `TAWRs this week (${shown.length} of ${all.length})` }));
  if (!all.length) host.append(el('p', { class: 'small', text: 'None yet. They are raised from the look-ahead in the TAWRs view.' }));
  const ul = el('ul', { class: 'req-list' });
  const clashing = new Set(clashes.flatMap((c) => [c.a.id, c.b.id]));
  for (const t of shown) {
    const li = el('li', { class: glowing().has(t.id) ? 'sel' : '', style: `--c:${STATUS_COLOR[t.status]}`, dataset: { tawr: t.id } }, [
      el('div', { class: 't' }, [`#${t.id} ${t.location_name} `, el('span', { class: 'pill', style: `--c:${STATUS_COLOR[t.status]}`, text: t.status }),
        clashing.has(t.id) ? el('span', { class: 'pill', style: `--c:${CONFLICT}`, text: 'conflict' }) : null]),
      el('div', { class: 'm', text: `${tawrShiftLabel(t.shift)} shift · ${(t.source?.days || []).map((d) => dayName(d.date)).join(', ')}` }),
      el('div', { class: 'm', text: (t.source?.activities || []).map((a) => [a.title, a.party && `(${a.party})`].filter(Boolean).join(' ')).join('; ') }),
      el('div', { class: 'btns' }, [el('button', { type: 'button', class: 'secondary', text: 'Open TAWR', title: 'Open it in the TAWRs view', onClick: (e) => { e.stopPropagation(); o.onOpenTawr?.(t); } })]),
    ]);
    li.title = 'Click to find it on the map';
    li.addEventListener('click', () => selectTawr(t, true));
    ul.append(li);
  }
  host.append(ul);
  const linked = (o.activities || []).filter((a) => hasLink(a.link));
  host.append(el('h2', { text: 'Linked activities' }));
  if (!linked.length) host.append(el('p', { class: 'small', text: 'No activity in this week is linked yet. On the look-ahead, hover a Location cell and press Link.' }));
  const al = el('ul', { class: 'plain act-list' });
  for (const a of linked) {
    al.append(el('li', { onClick: () => showLink(a.link) }, [
      el('b', { text: a.title }),
      a.party ? el('div', { class: 'small', text: `Party to action: ${a.party}` }) : null,
      el('div', { class: 'small', text: linkArea(a.link) }),
    ]));
  }
  host.append(al);
}

/**
 * What the map shows of the look-ahead: `{ weeks, week, tawrs, conflicts,
 * activities, onWeek(week), onOpenTawr(record) }`.
 */
export function setOverlay(o) {
  if (state.overlay && o.week !== state.overlay.week) { state.selected = null; state.conflict = null; }
  const first = !state.overlay;
  state.overlay = o;
  state.phases = o.phases || [];
  if (first) { try { state.phase = localStorage.getItem(PHASE_KEY); } catch { /* a convenience */ } }
  if (!phaseById(state.phase)) state.phase = null;
  if (state.selected && !(o.tawrs || []).some((t) => t.id === state.selected)) state.selected = null;
  if (state.conflict) {
    const same = (o.conflicts || []).find((c) => c.a.id === state.conflict.a.id && c.b.id === state.conflict.b.id);
    state.conflict = same || null;
  }
  if (!map) return;
  renderPhaseSelect();
  renderPhase();
  renderOverlay();
  renderOnMapList();
}

/**
 * The map has just been shown: size it to its box and fit the whole sheet —
 * or, where something particular was asked for, zoom to that instead
 * (`focus` answers true when it zoomed).
 */
export function enter(focus = null) {
  if (!map) return;
  setTimeout(() => {
    map.invalidateSize();
    if (!(focus && focus())) fitView();
  }, 0);
}

/** Fit a box of the drawing — a phase's, while it is being redrawn. */
export function showBox(bbox) {
  if (!map) return false;
  map.fitBounds(boxBounds(bbox).pad(0.12), { animate: false });
  return true;
}

// ------------------------------------------------------------------ phases

const PHASE_KEY = 'trackplan.phase';
const phaseById = (id) => state.phases.find((p) => p.id === id) || null;
const boxBounds = ([x0, y0, x1, y1]) => L.latLngBounds(ll(x0, y1), ll(x1, y0));

/** The view to come back to: the phase being looked at, or the whole sheet. */
function fitView() {
  const ph = phaseById(state.phase);
  if (ph) map.fitBounds(boxBounds(ph.bbox), { animate: false, padding: [14, 14] });
  else fitPage();
}

/** Look at one phase — or none, for the whole sheet: fitted to it, the rest of the sheet set back. */
export function setPhase(id, { fit = true } = {}) {
  state.phase = phaseById(id) ? id : null;
  try {
    if (state.phase) localStorage.setItem(PHASE_KEY, state.phase); else localStorage.removeItem(PHASE_KEY);
  } catch { /* a convenience only */ }
  if (!map) return;
  renderPhaseSelect();
  renderPhase();
  renderOverlay();
  renderOnMapList();
  if (fit) fitView();
}

/** Whether a request is in a phase: any of its track inside the box, or its room. */
function inPhase(t, ph) {
  const place = t.source?.place || {};
  if ((place.geometry || []).some((pl) => pl.some((pt) => insideBox(pt, ph.bbox)))) return true;
  return (place.places || []).some((p) => { const loc = locationById(p.id); return Boolean(loc && insideBox([loc.x, loc.y], ph.bbox)); });
}

function renderPhaseSelect() {
  const sel = $('#phase-view');
  const define = state.overlay?.onDefinePhases;
  sel.replaceChildren(...[
    el('option', { value: '', text: 'Whole sheet' }),
    ...state.phases.map((p) => el('option', { value: p.id, text: p.name })),
    define ? el('option', { value: '__define', text: state.phases.length ? 'Edit phases…' : 'Define phases…' }) : null,
  ].filter(Boolean));
  sel.value = state.phase || '';
  sel.hidden = !state.phases.length && !define;
}

/** A phase's frame and name; on the whole sheet the name is a way in to it. */
function phaseFrame(ph, current) {
  const [x0, y0] = ph.bbox;
  const tag = L.marker(ll(x0, y0), {
    interactive: !current, keyboard: false,
    icon: L.divIcon({ className: `phase-tag${current ? ' phase-tag-on' : ''}`, html: `<span>${esc(ph.name)}</span>`, iconSize: null, iconAnchor: [0, 22] }),
  });
  if (!current) tag.on('click', () => setPhase(ph.id)).bindTooltip(`Look at ${esc(ph.name)}`, { direction: 'top' });
  return [
    L.rectangle(boxBounds(ph.bbox), { pane: PHASE, color: PHASE_COLOR, weight: current ? 2 : 1.5, opacity: current ? 0.85 : 0.6, dashArray: current ? null : '10 7', fill: false, interactive: false }),
    tag,
  ];
}

function renderPhase() {
  layers.phase.clearLayers();
  const d = state.phaseDraw;
  if (d) {
    if (d.bbox) L.rectangle(boxBounds(d.bbox), { pane: PHASE, color: PHASE_COLOR, weight: 2, dashArray: '8 5', fillColor: PHASE_COLOR, fillOpacity: 0.08, interactive: false }).addTo(layers.phase);
    return;
  }
  const ph = phaseById(state.phase);
  if (ph) {
    // The rest of the sheet set back: a veil over everything, with the phase cut out of it.
    const P = 3000;
    const outer = [ll(-P, -P), ll(PAGE_W + P, -P), ll(PAGE_W + P, PAGE_H + P), ll(-P, PAGE_H + P)];
    const [x0, y0, x1, y1] = ph.bbox;
    L.polygon([outer, [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)]], { pane: PHASE, stroke: false, fillColor: '#f3f4f6', fillOpacity: 0.75, interactive: false }).addTo(layers.phase);
    for (const l of phaseFrame(ph, true)) l.addTo(layers.phase);
  } else if ($('#lyr-phases').checked) {
    for (const p of state.phases) for (const l of phaseFrame(p, false)) l.addTo(layers.phase);
  }
}

let phaseResolve = null;

/**
 * Draw a phase's box on the drawing. Opens the Phase panel; answers the box,
 * `[x0, y0, x1, y1]` in drawing points, or null if cancelled.
 */
export function drawPhase({ name, bbox = null }) {
  if (phaseResolve) phaseResolve(null);
  if (state.tool) setTool(state.tool);
  state.phaseDraw = { name, bbox: bbox ? [...bbox] : null };
  map.dragging.disable();
  map.getContainer().classList.add('boxing');
  $('#phase-draw-name').textContent = name;
  document.querySelector('[data-tab=phase]').hidden = false;
  showTab('phase');
  $('#panel').classList.remove('hidden');
  phaseDrawChanged();
  return new Promise((resolve) => { phaseResolve = resolve; });
}

function phaseDrawChanged() {
  const d = state.phaseDraw;
  renderPhase();
  $('#phase-draw-covers').textContent = d.bbox ? `The box covers ${coversText(state.data.routes, d.bbox)}.` : 'Nothing drawn yet.';
  $('#phase-save').disabled = !d.bbox;
}

function endPhaseDraw(result) {
  if (!state.phaseDraw) return;
  state.phaseDraw = null;
  map.dragging.enable();
  map.getContainer().classList.remove('boxing');
  document.querySelector('[data-tab=phase]').hidden = true;
  showTab('onmap');
  renderPhase();
  const r = phaseResolve;
  phaseResolve = null;
  if (r) r(result && result.map((v) => Math.round(v)));
}

// ------------------------------------------------------------------ linking an activity

let pickResolve = null;

/**
 * Pick where an activity is. Opens the Link panel; answers the link, or null
 * if cancelled. `link` is what the activity has now, to start from.
 */
export function pickLocation({ title, link = null }) {
  if (pickResolve) pickResolve(null);
  state.pick = { title };
  state.draft = (link?.geometry || []).map((pts) => ({ type: 'poly', pts }));
  state.path = null;
  const f = $('#pick-form');
  f.reset();
  fillLocations();
  $('#pick-location').value = link?.location_id || '';
  $('#pick-title').textContent = title;
  $('#pick-msg').textContent = '';
  $('#typed-limits').open = false;
  $('#more-ways').open = false;
  document.querySelector('[data-tab=pick]').hidden = false;
  showTab('pick');
  $('#panel').classList.remove('hidden');
  renderPlaces();
  onDraftChanged();
  // One obvious way to pick track: clicking along it is on from the start.
  if (state.tool !== 'path') setTool('path');
  renderOverlay(); // drawn quiet while picking: hover shows, clicks go to the tools
  return new Promise((resolve) => { pickResolve = resolve; });
}

function endPick(result) {
  if (state.tool) setTool(state.tool);
  state.pick = null;
  state.draft = [];
  state.path = null;
  document.querySelector('[data-tab=pick]').hidden = true;
  showTab('onmap');
  renderPlaces();
  onDraftChanged();
  renderOverlay();
  const r = pickResolve;
  pickResolve = null;
  if (r) r(result);
}

function savePick() {
  const typed = typedGeometry();
  const f = $('#pick-form').elements;
  if (f.track_id.value && (f.from_mp.value || f.to_mp.value) && !typed.length) {
    const r = trackRange(f.track_id.value);
    $('#pick-msg').textContent = `${f.track_id.value} MP ${f.from_mp.value}–${f.to_mp.value} is outside the calibrated range${r ? ` (${r.from_mp}–${r.to_mp})` : ''}.`;
    return;
  }
  const geometry = draftGeometry().concat(typed).map((pl) => pl.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]));
  const limits = describeGeometry(geometry);
  const loc = pickedLocation();
  if (!geometry.length && !loc) {
    $('#pick-msg').textContent = 'Choose a station or train control room, or select track on the map.';
    return;
  }
  endPick({
    location_id: loc?.id || null, location_name: loc?.name || null, location_kind: loc?.kind || null,
    limits, geometry,
  });
}

// ------------------------------------------------------------------ panel

function showTab(name) {
  document.querySelectorAll('#panel .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#panel .tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}

function flash(x, y) {
  layers.hover.clearLayers();
  L.circleMarker(ll(x, y), { pane: DOTS, radius: 18, color: HOVER, weight: 3, fill: false, interactive: false }).addTo(layers.hover);
}

function renderStations() {
  const f = $('#station-filter').value.toLowerCase(); const ul = $('#station-list'); ul.replaceChildren();
  const seen = new Set();
  for (const s of state.data.stations) {
    if (seen.has(s.name) || !s.name.toLowerCase().includes(f)) continue;
    seen.add(s.name);
    const li = el('li', { text: s.name });
    li.onclick = () => { zoomTo(s.x - 150, s.y - 70, s.x + 150, s.y + 70, 0); map.once('moveend', () => flash(s.x, s.y)); };
    ul.append(li);
  }
}

function populateTracks() {
  const opts = state.data.tracks.map((t) => `<option value="${t.id}">${t.id} (MP ${t.from_mp}–${t.to_mp})</option>`).join('');
  $('#pick-form').elements.track_id.innerHTML = `<option value="">—</option>${opts}`;
  $('#find-mp').elements.track.innerHTML = opts;
  const tb = $('#track-table tbody'); tb.replaceChildren();
  for (const t of state.data.tracks) {
    const tr = el('tr', {}, [el('td', { text: t.id }), el('td', { text: `${t.from_mp} – ${t.to_mp}` })]);
    tr.onclick = () => { const p = sliceTrack(t.id, t.from_mp, t.to_mp); if (p.length) zoomTo(...bboxOf(p), 60); };
    tb.append(tr);
  }
  fillLocations();
}

/**
 * The TCRs, stations, yards and platforms to choose from, grouped — only those
 * whose name has every word typed into the find box. One match is chosen.
 */
function fillLocations(query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keep = (l) => words.every((w) => l.name.toLowerCase().includes(w));
  const sel = $('#pick-location');
  const was = sel.value;
  const groups = [['tcr', 'Train control rooms (TCR)'], ['station', 'Stations'], ['yard', 'Yards'], ['platform', 'Platforms']];
  const found = state.data.locations.filter((l) => groups.some(([k]) => k === l.kind) && keep(l));
  sel.innerHTML = `<option value="">${words.length ? `— ${found.length} found —` : '— no station or TCR —'}</option>${groups.map(([k, label]) => {
    const items = found.filter((l) => l.kind === k);
    return items.length ? `<optgroup label="${label}">${items.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</optgroup>` : '';
  }).join('')}`;
  if (found.some((l) => l.id === was)) sel.value = was;
  else if (words.length && found.length === 1) { sel.value = found[0].id; sel.dispatchEvent(new Event('change')); }
}

/** Say what the choice will raise: a TCR with track is two requests; a station with track is only the track. */
function splitNote() {
  const loc = pickedLocation();
  const track = draftGeometry().concat(typedGeometry()).length > 0;
  const note = $('#pick-split');
  note.hidden = !(loc && track);
  if (!loc || !track) return;
  note.textContent = loc.kind === 'tcr'
    ? `This makes two TAWRs: one for ${shortLocationName(loc.name)}, one for the track. A TCR and track are different categories of work, so they are never on one request.`
    : `With track picked, the request gives the track limits; ${shortLocationName(loc.name)} is only where it is.`;
}

function renderLegend() {
  const kindName = { running: 'running track (milepost-calibrated)', crossover: 'crossover', yard: 'yard track', track: 'other track (pocket, siding, middle…)' };
  $('#legend').innerHTML = `<h2>TAWR status</h2>${['draft', 'submitted', 'approved', 'rejected']
    .map((k) => `<div><span class="sw" style="background:${STATUS_COLOR[k]}"></span>${k}</div>`).join('')}
    <div><span class="sw sw-dash" style="border-color:${ACTIVITY}"></span>linked look-ahead activity</div>
    <h2>Track pieces</h2>${Object.entries(KIND_COLOR).map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${kindName[k]}</div>`).join('')}`;
  const d = state.data; const n = (s) => d.labels.filter((l) => l.status === s).length;
  const kinds = {};
  for (const s of d.segments) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  $('#data-info').innerHTML = `Source: ${esc(d.source)} · extracted ${esc(d.generated.slice(0, 10))}<br>
    ${d.segments.length} selectable track pieces (${kinds.running || 0} running, ${kinds.crossover || 0} crossovers, ${kinds.yard || 0} yard, ${kinds.track || 0} other) ·
    ${d.labels.length} milepost labels read · ${d.tracks.length} calibrated tracks · ${n('out_of_sequence') + n('unanchored') + n('unused')} labels flagged for review (see docs/qa_report.md)<br>
    <a href="map.svg" target="_blank" rel="noopener">Vector copy of the drawing (SVG)</a>`;
}

/** Leaflet has to be told when its box changes size — the view was hidden, or the panel toggled. */
export function invalidate() {
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

// ------------------------------------------------------------------ boot

/**
 * Draw the map into #viewport and wire the panel. `tileIndex` is
 * tiles/index.json; without it (tiles not rendered — a development checkout)
 * the vector copy of the drawing is used instead, which is softer when zoomed.
 */
export function initMap(data, tileIndex) {
  state.data = data;
  map = L.map('viewport', {
    crs: L.CRS.Simple, minZoom: -5, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 100,
    zoomControl: false, attributionControl: false, maxBounds: PAGE_BOUNDS.pad(0.25), maxBoundsViscosity: 0.8,
  });
  // The overlay's panes: ink above the other vectors, white dots above the ink, markers above both.
  map.createPane(INK).style.zIndex = 450;
  map.createPane(DOTS).style.zIndex = 460;
  map.createPane(PHASE).style.zIndex = 300; // a phase's frame and the veil over the rest: above the sheet, under everything drawn on it
  if (tileIndex) {
    // high-density screens get the next zoom level's tiles at half size
    const R = window.devicePixelRatio >= 1.5 ? 1 : 0;
    new DrawingTiles('', {
      index: tileIndex, tileSize: 256 >> R, zoomOffset: R, minZoom: -5, maxZoom: 6,
      minNativeZoom: -4 - R, maxNativeZoom: 4 - R, bounds: PAGE_BOUNDS, noWrap: true, keepBuffer: 3,
    }).addTo(map);
  } else {
    // In the tile pane like the tiles, so a phase's veil and the ink lie over it the same way.
    L.imageOverlay('map.svg', PAGE_BOUNDS, { interactive: false, pane: 'tilePane' }).addTo(map);
  }
  for (const k of ['phase', 'segs', 'routes', 'anchors', 'qa', 'activities', 'tawrs', 'places', 'draft', 'hover']) layers[k] = L.layerGroup().addTo(map);
  fitPage();
  indexRoutes();
  indexSegments();
  populateTracks();
  renderStations();
  renderLegend();
  renderSegs(); renderRoutes(); renderAnchors(); renderQA();

  $('#zoom-in').onclick = () => map.zoomIn();
  $('#zoom-out').onclick = () => map.zoomOut();
  $('#zoom-fit').onclick = fitView;
  $('#phase-view').addEventListener('change', (e) => {
    if (e.target.value === '__define') { e.target.value = state.phase || ''; state.overlay?.onDefinePhases?.(); return; }
    setPhase(e.target.value);
  });
  $('#phase-save').onclick = () => endPhaseDraw(state.phaseDraw?.bbox || null);
  $('#phase-cancel').onclick = () => endPhaseDraw(null);
  $('#lyr-phases').onchange = renderPhase;
  $('#toggle-panel').onclick = () => { $('#panel').classList.toggle('hidden'); invalidate(); };
  document.querySelectorAll('#panel .tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.tool) setTool(state.tool); });
  $('#sel-clear').onclick = () => { state.draft = []; state.path = null; onDraftChanged(); };
  for (const n of ['track_id', 'from_mp', 'to_mp']) $('#pick-form').elements[n].addEventListener('input', onDraftChanged);
  $('#pick-location').addEventListener('change', () => {
    const loc = pickedLocation();
    if (loc) zoomTo(loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70, 0);
    splitNote();
    renderDraft();
  });
  $('#pick-find').addEventListener('input', (e) => fillLocations(e.target.value));
  $('#pick-form').addEventListener('submit', (e) => { e.preventDefault(); savePick(); });
  $('#pick-cancel').onclick = () => endPick(null);

  map.on('mousemove', showReadout);
  map.on('mouseout', () => layers.hover.clearLayers());
  map.on('zoomend', () => { renderOverlay(); renderDraft(); });
  map.on('click', (e) => {
    const [x, y] = toXY(e.latlng);
    if (!state.tool) return showReadout(e); // touch screens have no hover: a tap shows the readout
    if (state.tool === 'piece') {
      const sh = segHit(x, y, pickRadius());
      if (!sh) return;
      const i = state.draft.findIndex((p) => p.type === 'seg' && p.sid === sh.sid);
      if (i >= 0) state.draft.splice(i, 1); else state.draft.push({ type: 'seg', sid: sh.sid });
      onDraftChanged();
    } else if (state.tool === 'path') {
      const sh = segHit(x, y, pickRadius());
      if (!sh) return;
      if (state.path) {
        const pts = trackPath(state.path, sh);
        if (!pts) { toast('Those two points are not connected by track on the drawing.', 'warn'); return; }
        state.draft.push({ type: 'poly', pts });
      }
      state.path = sh;
      onDraftChanged();
    }
  });

  // box select: drag a rectangle (mouse or touch) while the tool is armed
  const c = map.getContainer();
  let start = null; let rect = null;
  c.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'box' || e.button > 0 || e.target.closest('.leaflet-control')) return;
    start = map.mouseEventToLatLng(e);
    rect = L.rectangle(L.latLngBounds(start, start), { color: HOVER, weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false }).addTo(layers.draft);
    try { c.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => { if (start) rect.setBounds(L.latLngBounds(start, map.mouseEventToLatLng(e))); });
  c.addEventListener('pointerup', (e) => {
    if (!start) return;
    const b = L.latLngBounds(start, map.mouseEventToLatLng(e));
    start = null;
    const [x0, y1] = toXY(b.getSouthWest()); const [x1, y0] = toXY(b.getNorthEast());
    if (x1 - x0 < 1 || y1 - y0 < 1) { renderDraft(); return; }
    const parts = [];
    for (const s of NET) for (const pl of clipPoly(s.pts, x0, y0, x1, y1)) parts.push({ type: 'poly', pts: pl });
    if (!parts.length) { toast('No track inside that box.', 'warn'); renderDraft(); return; }
    state.draft.push(...parts);
    setTool('box'); // one box per arming; press the tool again for another
    onDraftChanged();
  });
  c.addEventListener('pointercancel', () => { start = null; renderDraft(); });

  // drawing a phase: drag a box anywhere on the sheet; drag again to redraw it
  let from = null;
  c.addEventListener('pointerdown', (e) => {
    if (!state.phaseDraw || e.button > 0 || e.target.closest('.leaflet-control, .leaflet-marker-icon')) return;
    from = toXY(map.mouseEventToLatLng(e));
    try { c.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (!from || !state.phaseDraw) return;
    const [x, y] = toXY(map.mouseEventToLatLng(e));
    state.phaseDraw.bbox = [Math.min(from[0], x), Math.min(from[1], y), Math.max(from[0], x), Math.max(from[1], y)];
    renderPhase();
  });
  c.addEventListener('pointerup', () => {
    if (!from || !state.phaseDraw) { from = null; return; }
    from = null;
    const b = state.phaseDraw.bbox;
    if (b && (b[2] - b[0] < 10 || b[3] - b[1] < 10)) state.phaseDraw.bbox = null; // a click, not a box
    phaseDrawChanged();
  });

  $('#find-mp').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = e.target.elements.track.value; const mp = parseFloat(e.target.elements.mp.value);
    const q = locate(t, mp); const r = trackRange(t);
    if (!q) { $('#find-msg').textContent = `${t} MP ${mp} is outside the calibrated range (${r.from_mp}–${r.to_mp}).`; return; }
    $('#find-msg').textContent = `${t} MP ${mp}: drawing position ${q.x.toFixed(1)}, ${q.y.toFixed(1)}`;
    zoomTo(q.x - 60, q.y - 40, q.x + 60, q.y + 40, 0);
    map.once('moveend', () => flash(q.x, q.y));
  });
  $('#station-filter').oninput = renderStations;
  for (const id of ['lyr-segs', 'lyr-routes', 'lyr-anchors', 'lyr-qa']) $(`#${id}`).onchange = () => { renderSegs(); renderRoutes(); renderAnchors(); renderQA(); };
  for (const id of ['lyr-tawrs', 'lyr-activities']) $(`#${id}`).onchange = renderOverlay;
  renderOverlay();
  renderOnMapList();
  return map;
}
