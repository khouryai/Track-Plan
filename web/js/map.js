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

import { samplePolys, bboxOf, limitText, hasLink, linkArea, shortLocationName } from './links.js';
import { el, esc, toast } from './ui.js';

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

const state = { data: null, tool: null, draft: [], path: null, pick: null, overlay: null, selected: null };

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
  const lo = Math.min(a, b); const hi = Math.max(a, b); const out = [];
  for (const pc of state.data.routes[track] || []) {
    for (const lg of pc.legs) {
      let cur = null;
      for (let i = 0; i < lg.pts.length - 1; i++) {
        const p0 = lg.pts[i]; const p1 = lg.pts[i + 1]; const m0 = lg.mps[i]; const m1 = lg.mps[i + 1];
        const c0 = Math.max(Math.min(m0, m1), lo); const c1 = Math.min(Math.max(m0, m1), hi);
        if (c0 > c1) { if (cur) { out.push(cur); cur = null; } continue; }
        const at = (m) => { const f = m1 === m0 ? 0 : (m - m0) / (m1 - m0); return [p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])]; };
        const [s, e] = m0 <= m1 ? [c0, c1] : [c1, c0];
        if (!cur) cur = [at(s)];
        cur.push(at(e));
      }
      if (cur) out.push(cur);
    }
  }
  return out;
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
  if (hit.sid != null) L.polyline(llPoly(NET[hit.sid].pts), { color: HOVER, weight: 3, opacity: 0.6, interactive: false }).addTo(layers.hover);
  L.circleMarker(ll(hit.x, hit.y), { radius: 5, color: '#fff', weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.hover);
}

// ------------------------------------------------------------------ selection tools

const HINTS = {
  box: 'Drag a box over the block of tracks. Everything inside becomes part of the location.',
  path: 'Click the start, then click along the track (through any crossover) to the end. Click the tool again or press Esc to finish.',
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
  $('#sel-list').replaceChildren(...lims.map((l) => el('li', { text: limitText(l) })));
  renderDraft();
}

function pickedLocation() {
  return locationById($('#pick-location').value);
}

function renderDraft() {
  layers.draft.clearLayers();
  for (const pl of draftGeometry().concat(typedGeometry())) {
    L.polyline(llPoly(pl), { color: HOVER, weight: reqWeight(false), opacity: 0.5, interactive: false }).addTo(layers.draft);
  }
  if (state.path) L.circleMarker(ll(state.path.x, state.path.y), { radius: 6, color: '#fff', weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.draft);
  const loc = state.pick ? pickedLocation() : null;
  if (loc) locationMarker(loc, HOVER).addTo(layers.draft);
}

// ------------------------------------------------------------------ overlays

const reqWeight = (sel) => Math.max(sel ? 11 : 8, Math.min(70, (sel ? 5.5 : 4.5) * scale()));

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

function renderOverlay() {
  layers.tawrs.clearLayers();
  layers.activities.clearLayers();
  const o = state.overlay;
  if (!o) return;
  if ($('#lyr-activities').checked) {
    for (const a of o.activities || []) {
      if (!hasLink(a.link)) continue;
      for (const pl of a.link.geometry || []) {
        L.polyline(llPoly(pl), { color: ACTIVITY, weight: 3, opacity: 0.85, dashArray: '6 5', interactive: true })
          .bindTooltip(esc(`${a.title} — ${linkArea(a.link)}`), { sticky: true }).addTo(layers.activities);
      }
      const loc = a.link.location_id && locationById(a.link.location_id);
      if (loc && !(a.link.geometry || []).length) locationMarker(loc, ACTIVITY, shortLocationName(loc.name)).addTo(layers.activities);
    }
  }
  if (!$('#lyr-tawrs').checked) return;
  for (const t of o.tawrs || []) {
    const place = t.source?.place || {};
    const col = STATUS_COLOR[t.status] || '#666';
    const sel = state.selected === t.id;
    const tip = `TAWR #${t.id} ${t.location_name} · ${t.shift} · ${t.status}`;
    for (const pl of place.geometry || []) {
      L.polyline(llPoly(pl), { color: col, weight: reqWeight(sel), opacity: sel ? 0.85 : 0.5, lineCap: 'butt' })
        .bindTooltip(esc(tip), { sticky: true }).on('click', () => selectTawr(t)).addTo(layers.tawrs);
    }
    for (const p of place.places || []) {
      const loc = locationById(p.id);
      if (loc) locationMarker(loc, col, `#${t.id} ${shortLocationName(loc.name)}`).addTo(layers.tawrs);
    }
  }
}

function selectTawr(t, zoom = false) {
  state.selected = t.id;
  if (zoom) showPlace(t.source?.place);
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

export function showTawr(t) {
  selectTawr(t, true);
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
  host.append(el('h2', { text: 'TAWRs this week' }));
  if (!o.tawrs?.length) host.append(el('p', { class: 'small', text: 'None yet. They are raised from the look-ahead in the TAWRs view.' }));
  const ul = el('ul', { class: 'req-list' });
  for (const t of o.tawrs || []) {
    const li = el('li', { class: state.selected === t.id ? 'sel' : '', style: `--c:${STATUS_COLOR[t.status]}` }, [
      el('div', { class: 't' }, [`#${t.id} ${t.location_name} `, el('span', { class: 'pill', style: `--c:${STATUS_COLOR[t.status]}`, text: t.status })]),
      el('div', { class: 'm', text: `${t.shift} shift · ${(t.source?.days || []).length} day(s)` }),
      t.source?.area ? el('div', { class: 'm', text: t.source.area }) : null,
      el('div', { class: 'btns' }, [el('button', { type: 'button', class: 'secondary', text: 'Open', onClick: (e) => { e.stopPropagation(); o.onOpenTawr?.(t); } })]),
    ]);
    li.addEventListener('click', () => selectTawr(t, true));
    ul.append(li);
  }
  host.append(ul);
  const linked = (o.activities || []).filter((a) => hasLink(a.link));
  host.append(el('h2', { text: 'Linked activities' }));
  if (!linked.length) host.append(el('p', { class: 'small', text: 'No activity in this week is linked yet. Right-click a Location cell on the look-ahead and choose Select on track plan.' }));
  const al = el('ul', { class: 'plain act-list' });
  for (const a of linked) {
    al.append(el('li', { onClick: () => showLink(a.link) }, [el('b', { text: a.title }), el('div', { class: 'small', text: linkArea(a.link) })]));
  }
  host.append(al);
}

/**
 * What the map shows of the look-ahead: `{ weeks, week, tawrs, activities,
 * onWeek(week), onOpenTawr(record) }`.
 */
export function setOverlay(o) {
  state.overlay = o;
  if (state.selected && !(o.tawrs || []).some((t) => t.id === state.selected)) state.selected = null;
  if (!map) return;
  renderOverlay();
  renderOnMapList();
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
  $('#pick-location').value = link?.location_id || '';
  $('#pick-title').textContent = title;
  $('#pick-msg').textContent = '';
  $('#typed-limits').open = false;
  document.querySelector('[data-tab=pick]').hidden = false;
  showTab('pick');
  $('#panel').classList.remove('hidden');
  renderPlaces();
  onDraftChanged();
  invalidate();
  if (link && !showLink(link)) fitPage();
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
  L.circleMarker(ll(x, y), { radius: 18, color: HOVER, weight: 3, fill: false, interactive: false }).addTo(layers.hover);
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
  const groups = [['tcr', 'Train control rooms (TCR)'], ['station', 'Stations'], ['yard', 'Yards'], ['platform', 'Platforms']];
  $('#pick-location').innerHTML = `<option value="">— no station or TCR —</option>${groups.map(([k, label]) => {
    const items = state.data.locations.filter((l) => l.kind === k);
    return items.length ? `<optgroup label="${label}">${items.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</optgroup>` : '';
  }).join('')}`;
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
  if (tileIndex) {
    // high-density screens get the next zoom level's tiles at half size
    const R = window.devicePixelRatio >= 1.5 ? 1 : 0;
    new DrawingTiles('', {
      index: tileIndex, tileSize: 256 >> R, zoomOffset: R, minZoom: -5, maxZoom: 6,
      minNativeZoom: -4 - R, maxNativeZoom: 4 - R, bounds: PAGE_BOUNDS, noWrap: true, keepBuffer: 3,
    }).addTo(map);
  } else {
    L.imageOverlay('map.svg', PAGE_BOUNDS, { interactive: false }).addTo(map);
  }
  for (const k of ['segs', 'routes', 'anchors', 'qa', 'activities', 'tawrs', 'places', 'draft', 'hover']) layers[k] = L.layerGroup().addTo(map);
  fitPage();
  indexRoutes();
  indexSegments();
  populateTracks();
  renderStations();
  renderLegend();
  renderSegs(); renderRoutes(); renderAnchors(); renderQA();

  $('#zoom-in').onclick = () => map.zoomIn();
  $('#zoom-out').onclick = () => map.zoomOut();
  $('#zoom-fit').onclick = fitPage;
  $('#toggle-panel').onclick = () => { $('#panel').classList.toggle('hidden'); invalidate(); };
  document.querySelectorAll('#panel .tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.tool) setTool(state.tool); });
  $('#sel-clear').onclick = () => { state.draft = []; state.path = null; onDraftChanged(); };
  for (const n of ['track_id', 'from_mp', 'to_mp']) $('#pick-form').elements[n].addEventListener('input', onDraftChanged);
  $('#pick-location').addEventListener('change', () => {
    const loc = pickedLocation();
    if (loc) zoomTo(loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70, 0);
    renderDraft();
  });
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
