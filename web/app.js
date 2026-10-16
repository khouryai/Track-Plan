"use strict";
// Track map viewer.  The base layer is the drawing rendered into map tiles
// straight from the vector PDF (pipeline/make_tiles.py), so it is sharp at
// every zoom.  Overlays use the drawing's own coordinates: PDF points, origin
// top-left, mapped to Leaflet CRS.Simple as latLng(-y, x).
//
// Two layers of track data come from the extraction (web/data/map.json):
//   routes    milepost-calibrated running tracks (W1, M2, C1 ...): exact MPs
//   segments  every piece of track on the drawing - running tracks, crossovers,
//             yard leads, pocket and middle tracks - each with a name and the
//             calibrated MP where it meets a running track.
// Access requests can cover any of it: drawn along the track, picked piece by
// piece, box-selected as a block, typed as track + MP range, and/or a location
// (station or train control room).

const PAGE_W = 6552, PAGE_H = 1440;
const STATUS_COLOR = {
  requested: "#e08a00", approved: "#1f5fbf", active: "#d1242f", completed: "#6b7280", cancelled: "#9ca3af",
};
const HOVER = "#0a8f6a", ROUTE = "#8a2be2";
const KIND_COLOR = { running: "#8a2be2", crossover: "#e0670b", yard: "#16a34a", track: "#0ea5e9" };
const $ = (s) => document.querySelector(s);
const r3 = (v) => Math.round(v * 1000) / 1000;

const state = { data: null, requests: [], sel: null, tool: null, draft: [], path: null };

// ------------------------------------------------------------------ calibrated routes

let RSEGS = [];
const GRID = 60, rgrid = new Map();

function gridAdd(g, i, x0, y0, x1, y1) {
  for (let gx = Math.floor(Math.min(x0, x1) / GRID); gx <= Math.floor(Math.max(x0, x1) / GRID); gx++)
    for (let gy = Math.floor(Math.min(y0, y1) / GRID); gy <= Math.floor(Math.max(y0, y1) / GRID); gy++) {
      const k = gx + "," + gy;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
}
function gridNear(g, x, y, r) {
  const out = new Set();
  for (let gx = Math.floor((x - r) / GRID); gx <= Math.floor((x + r) / GRID); gx++)
    for (let gy = Math.floor((y - r) / GRID); gy <= Math.floor((y + r) / GRID); gy++)
      for (const i of g.get(gx + "," + gy) || []) out.add(i);
  return out;
}
function projSeg(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2));
  const px = x0 + t * dx, py = y0 + t * dy;
  return { t, px, py, d: Math.hypot(px - x, py - y) };
}

function indexRoutes() {
  RSEGS = []; rgrid.clear();
  for (const [track, pieces] of Object.entries(state.data.routes))
    for (const pc of pieces) for (const lg of pc.legs)
      for (let i = 0; i < lg.pts.length - 1; i++) {
        const [x0, y0] = lg.pts[i], [x1, y1] = lg.pts[i + 1];
        RSEGS.push({ track, x0, y0, x1, y1, m0: lg.mps[i], m1: lg.mps[i + 1] });
        gridAdd(rgrid, RSEGS.length - 1, x0, y0, x1, y1);
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
function sliceTrack(track, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b), out = [];
  for (const pc of state.data.routes[track] || []) for (const lg of pc.legs) {
    let cur = null;
    for (let i = 0; i < lg.pts.length - 1; i++) {
      const p0 = lg.pts[i], p1 = lg.pts[i + 1], m0 = lg.mps[i], m1 = lg.mps[i + 1];
      const c0 = Math.max(Math.min(m0, m1), lo), c1 = Math.min(Math.max(m0, m1), hi);
      if (c0 > c1) { if (cur) { out.push(cur); cur = null; } continue; }
      const at = (m) => { const f = m1 === m0 ? 0 : (m - m0) / (m1 - m0); return [p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])]; };
      const [s, e] = m0 <= m1 ? [c0, c1] : [c1, c0];
      if (!cur) cur = [at(s)];
      cur.push(at(e));
    }
    if (cur) out.push(cur);
  }
  return out;
}
function locate(track, mp) {
  const p = sliceTrack(track, mp, mp);
  return p.length ? { x: p[0][0][0], y: p[0][0][1] } : null;
}
function trackRange(track) { return state.data.tracks.find((t) => t.id === track); }

function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of polys) for (const [x, y] of pl) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

// ------------------------------------------------------------------ all track segments

let NET = [];
const sgrid = new Map(), NODES = new Map();   // node id -> {x, y, adj: [{sid, other}]}

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
    const sid = Math.floor(k / 10000), i = k % 10000, s = NET[sid];
    const [x0, y0] = s.pts[i], [x1, y1] = s.pts[i + 1];
    const p = projSeg(x, y, x0, y0, x1, y1);
    if (p.d <= r && (!best || p.d < best.d))
      best = { sid, s: s.cum[i] + p.t * (s.cum[i + 1] - s.cum[i]), x: p.px, y: p.py, d: p.d };
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
  const s = NET[sid], lo = Math.min(d0, d1), hi = Math.max(d0, d1);
  const pts = [pointAt(s, lo)];
  for (let i = 0; i < s.pts.length; i++) if (s.cum[i] > lo && s.cum[i] < hi) pts.push(s.pts[i]);
  pts.push(pointAt(s, hi));
  return d0 <= d1 ? pts : pts.reverse();
}

/** Shortest route along the track network between two points on segments. */
function trackPath(A, B) {
  if (A.sid === B.sid) return subPoly(A.sid, A.s, B.s);
  const sa = NET[A.sid], sb = NET[B.sid];
  const dist = new Map(), prev = new Map(), done = new Set();
  dist.set(sa.a, A.s);
  dist.set(sa.b, Math.min(dist.get(sa.b) ?? Infinity, sa.L - A.s));
  for (;;) {
    let u = null, du = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < du) { u = n; du = d; }
    if (u === null) break;
    done.add(u);
    if (done.has(sb.a) && done.has(sb.b)) break;
    for (const { sid, other } of NODES.get(u).adj) {
      const nd = du + NET[sid].L;
      if (nd < (dist.get(other) ?? Infinity)) { dist.set(other, nd); prev.set(other, { u, sid }); }
    }
  }
  const viaA = (dist.get(sb.a) ?? Infinity) + B.s, viaB = (dist.get(sb.b) ?? Infinity) + (sb.L - B.s);
  if (!isFinite(Math.min(viaA, viaB))) return null;
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
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const P = [ax + t0 * dx, ay + t0 * dy], Q = [ax + t1 * dx, ay + t1 * dy];
    if (!cur) cur = [P];
    cur.push(Q);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((pl) => pl.length > 1 && Math.hypot(pl[pl.length - 1][0] - pl[0][0], pl[pl.length - 1][1] - pl[0][1]) > 0.5);
}

function samplePolys(polys, step = 1) {
  const out = [];
  for (const pl of polys) for (let i = 0; i < pl.length - 1; i++) {
    const [ax, ay] = pl[i], [bx, by] = pl[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}

function fmtEnd(e) { return e ? `${e.track} MP ${e.mp.toFixed(2)}` : null; }
function segContext(seg) {
  const [ea, eb] = seg.ends;
  if (ea && eb && ea.track === eb.track && seg.kind !== "crossover")
    return `${ea.track} MP ${Math.min(ea.mp, eb.mp).toFixed(2)}–${Math.max(ea.mp, eb.mp).toFixed(2)}`;
  const [a, b] = seg.ends.map(fmtEnd);
  if (a && b && a !== b) return `between ${a} and ${b}`;
  if (a || b) return `from ${a || b}`;
  return "";
}

/** What a selection covers: MP ranges on calibrated tracks plus the other named pieces. */
function describeGeometry(polys) {
  const runs = new Map(), others = new Map();
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
    const ctx = segContext(s), key = s.name + "|" + ctx;
    if (!named.has(key)) named.set(key, { name: s.name, kind: s.kind, context: ctx });
  }
  return limits.concat([...named.values()].sort((a, b) => a.name.localeCompare(b.name)));
}
function limitText(l) {
  if (l.track) return `${l.track} MP ${Number(l.from_mp).toFixed(3)} – ${Number(l.to_mp).toFixed(3)}`;
  return l.name + (l.context ? ` (${l.context})` : "");
}

// ------------------------------------------------------------------ map

const ll = (x, y) => L.latLng(-y, x);
const llPoly = (pl) => pl.map(([x, y]) => ll(x, y));
const toXY = (latlng) => [latlng.lng, -latlng.lat];
const PAGE_BOUNDS = L.latLngBounds(ll(0, PAGE_H), ll(PAGE_W, 0));

const map = L.map("viewport", {
  crs: L.CRS.Simple, minZoom: -5, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 100,
  zoomControl: false, attributionControl: false, maxBounds: PAGE_BOUNDS.pad(0.25), maxBoundsViscosity: 0.8,
});
const scale = () => map.getZoomScale(map.getZoom(), 0);   // screen px per PDF point
const pickRadius = () => Math.max(1, 16 / scale());

// Only non-blank tiles exist; blank ones are served as white without a request.
const WHITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23fff'/%3E%3C/svg%3E";
const DrawingTiles = L.TileLayer.extend({
  // draw each tile 1px larger so neighbours overlap: no hairline seams when
  // the browser scales tiles at fractional zoom levels
  _initTile(tile) {
    L.TileLayer.prototype._initTile.call(this, tile);
    const s = this.getTileSize();
    tile.style.width = s.x + 1 + "px";
    tile.style.height = s.y + 1 + "px";
  },
  getTileUrl(c) {
    const z = this._getZoomForUrl(), col = this.options.index[z] && this.options.index[z][c.x];
    return col && col.includes(c.y) ? `tiles/${z}/${c.x}/${c.y}.png` : WHITE;
  },
});

const layers = {
  segs: L.layerGroup(), routes: L.layerGroup(), anchors: L.layerGroup(), qa: L.layerGroup(),
  requests: L.layerGroup(), draft: L.layerGroup(), hover: L.layerGroup(),
};

function zoomTo(x0, y0, x1, y1, pad = 40) {
  map.fitBounds(L.latLngBounds(ll(x0 - pad, y1 + pad), ll(x1 + pad, y0 - pad)), { maxZoom: 3.5 });
}
const fitPage = () => map.fitBounds(PAGE_BOUNDS, { animate: false });

$("#zoom-in").onclick = () => map.zoomIn();
$("#zoom-out").onclick = () => map.zoomOut();
$("#zoom-fit").onclick = fitPage;
$("#toggle-panel").onclick = () => { $("#panel").classList.toggle("hidden"); setTimeout(() => map.invalidateSize(), 0); };

// ------------------------------------------------------------------ hover readout

function readoutAt(x, y) {
  const r = pickRadius(), rh = nearestTrackPoint(x, y, r), sh = segHit(x, y, r);
  if (rh && (!sh || rh.d <= sh.d + 1)) return { html: `<b>${rh.track}</b> MP <b>${rh.mp.toFixed(3)}</b>`, x: rh.x, y: rh.y, sid: sh && sh.sid };
  if (sh) {
    const s = NET[sh.sid], ctx = segContext(s);
    return { html: `<b>${esc(s.name)}</b>${ctx ? " · " + esc(ctx) : ""}`, x: sh.x, y: sh.y, sid: sh.sid };
  }
  return null;
}

function showReadout(e) {
  const [x, y] = toXY(e.latlng), hit = readoutAt(x, y);
  layers.hover.clearLayers();
  if (!hit) { $("#readout").textContent = toolPrompt() || "Hover a track for its milepost"; return; }
  $("#readout").innerHTML = hit.html + (state.tool ? " — " + esc(toolPrompt(true)) : "");
  if (hit.sid != null) L.polyline(llPoly(NET[hit.sid].pts), { color: HOVER, weight: 3, opacity: 0.6, interactive: false }).addTo(layers.hover);
  L.circleMarker(ll(hit.x, hit.y), { radius: 5, color: "#fff", weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.hover);
}
map.on("mousemove", showReadout);
map.on("mouseout", () => layers.hover.clearLayers());

// ------------------------------------------------------------------ selection tools

const HINTS = {
  box: "Drag a box over the block of tracks. Everything inside becomes part of this request.",
  path: "Click the start, then click along the track (through any crossover) to the end. Click the tool again or press Esc to finish.",
  piece: "Click any piece of track - crossover, yard lead, middle track - to add it; click again to remove it.",
};
function toolPrompt(short) {
  if (state.tool === "box") return short ? "drag to box-select" : HINTS.box;
  if (state.tool === "path") return state.path ? (short ? "click to extend" : "Click the next point along the track") : (short ? "click to start" : "Click the start of the work limits");
  if (state.tool === "piece") return short ? "click to add / remove" : HINTS.piece;
  return "";
}
function setTool(t) {
  state.tool = state.tool === t ? null : t;
  state.path = null;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("armed", b.dataset.tool === state.tool));
  $("#tool-hint").textContent = state.tool ? HINTS[state.tool] : "";
  map.getContainer().classList.toggle("boxing", !!state.tool);
  if (state.tool === "box") map.dragging.disable(); else map.dragging.enable();
  if (state.tool === "path") map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  renderDraft();
}
document.querySelectorAll(".tool").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.tool) setTool(state.tool); });

function draftGeometry() {
  return state.draft.map((p) => (p.type === "seg" ? NET[p.sid].pts : p.pts));
}

map.on("click", (e) => {
  const [x, y] = toXY(e.latlng);
  if (!state.tool) return showReadout(e);   // touch screens have no hover: a tap shows the readout
  if (state.tool === "piece") {
    const sh = segHit(x, y, pickRadius());
    if (!sh) return;
    const i = state.draft.findIndex((p) => p.type === "seg" && p.sid === sh.sid);
    if (i >= 0) state.draft.splice(i, 1); else state.draft.push({ type: "seg", sid: sh.sid });
    onDraftChanged();
  } else if (state.tool === "path") {
    const sh = segHit(x, y, pickRadius());
    if (!sh) return;
    if (state.path) {
      const pts = trackPath(state.path, sh);
      if (!pts) return formMsg("Those two points are not connected by track on the drawing.", true);
      state.draft.push({ type: "poly", pts });
    }
    state.path = sh;
    onDraftChanged();
  }
});

// box select: drag a rectangle (mouse or touch) while the tool is armed
(() => {
  const c = map.getContainer();
  let start = null, rect = null;
  c.addEventListener("pointerdown", (e) => {
    if (state.tool !== "box" || e.button > 0 || e.target.closest(".leaflet-control")) return;
    start = map.mouseEventToLatLng(e);
    rect = L.rectangle(L.latLngBounds(start, start), { color: HOVER, weight: 2, dashArray: "6 4", fillOpacity: 0.08, interactive: false }).addTo(layers.draft);
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* pointer already released */ }
    e.preventDefault();
  });
  c.addEventListener("pointermove", (e) => {
    if (start) rect.setBounds(L.latLngBounds(start, map.mouseEventToLatLng(e)));
  });
  c.addEventListener("pointerup", (e) => {
    if (!start) return;
    const b = L.latLngBounds(start, map.mouseEventToLatLng(e));
    start = null;
    const [x0, y1] = toXY(b.getSouthWest()), [x1, y0] = toXY(b.getNorthEast());
    if (x1 - x0 < 1 || y1 - y0 < 1) { renderDraft(); return; }
    const parts = [];
    for (const s of NET) for (const pl of clipPoly(s.pts, x0, y0, x1, y1)) parts.push({ type: "poly", pts: pl });
    if (!parts.length) { formMsg("No track inside that box.", true); renderDraft(); return; }
    state.draft.push(...parts);
    setTool("box");   // one box per arming; press the tool again for another
    onDraftChanged();
  });
  c.addEventListener("pointercancel", () => { start = null; renderDraft(); });
})();

$("#sel-clear").onclick = () => { state.draft = []; state.path = null; onDraftChanged(); };

function typedGeometry() {
  const f = form.elements, t = f.track_id.value, a = parseFloat(f.from_mp.value), b = parseFloat(f.to_mp.value);
  return t && !isNaN(a) && !isNaN(b) ? sliceTrack(t, a, b) : [];
}

function onDraftChanged() {
  const geom = draftGeometry().concat(typedGeometry());
  const lims = describeGeometry(geom);
  $("#selection").hidden = !geom.length;
  $("#sel-list").replaceChildren(...lims.map((l) => { const li = document.createElement("li"); li.textContent = limitText(l); return li; }));
  renderDraft();
}

function renderDraft() {
  layers.draft.clearLayers();
  for (const pl of draftGeometry().concat(typedGeometry()))
    L.polyline(llPoly(pl), { color: HOVER, weight: reqWeight(false), opacity: 0.5, interactive: false }).addTo(layers.draft);
  if (state.path) L.circleMarker(ll(state.path.x, state.path.y), { radius: 6, color: "#fff", weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.draft);
  const loc = locationById(form.elements.location.value);
  if (loc) locationMarker(loc, HOVER).addTo(layers.draft);
}

// ------------------------------------------------------------------ overlays

const reqWeight = (sel) => Math.max(sel ? 11 : 8, Math.min(70, (sel ? 5.5 : 4.5) * scale()));

function renderSegs() {
  layers.segs.clearLayers();
  if (!$("#lyr-segs").checked) return;
  for (const s of NET)
    L.polyline(llPoly(s.pts), { color: KIND_COLOR[s.kind] || "#0ea5e9", weight: 3, opacity: 0.55, interactive: false }).addTo(layers.segs);
}

function renderRoutes() {
  layers.routes.clearLayers();
  if (!$("#lyr-routes").checked) return;
  for (const pieces of Object.values(state.data.routes))
    for (const pc of pieces) for (const lg of pc.legs)
      L.polyline(llPoly(lg.pts), { color: ROUTE, weight: 2, opacity: 0.6, interactive: false }).addTo(layers.routes);
}

function renderAnchors() {
  layers.anchors.clearLayers();
  if (!$("#lyr-anchors").checked) return;
  for (const [track, pieces] of Object.entries(state.data.routes))
    for (const pc of pieces) for (const a of pc.anchors)
      L.circleMarker(ll(a.x, a.y), { radius: 4, color: a.line_level ? "#b07ae6" : ROUTE, weight: 1.5, fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(`${track} MP ${a.mp}${a.line_level ? " (line-level)" : ""}`).addTo(layers.anchors);
}

function renderQA() {
  layers.qa.clearLayers();
  if (!$("#lyr-qa").checked) return;
  for (const l of state.data.labels) {
    if (!["out_of_sequence", "unanchored", "unused"].includes(l.status)) continue;
    const [x0, y0, x1, y1] = l.bbox;
    L.rectangle(L.latLngBounds(ll(x0 - 2, y1 + 2), ll(x1 + 2, y0 - 2)), { color: STATUS_COLOR.active, weight: 2, fill: false })
      .bindTooltip(`${l.text}: ${l.status.replace(/_/g, " ")}`).addTo(layers.qa);
  }
}

function locationById(id) { return state.data.locations.find((l) => l.id === id) || null; }
function locationByName(name) { return state.data.locations.find((l) => l.name === name) || null; }
function locationMarker(loc, col) {
  return L.marker(ll(loc.x, loc.y), { interactive: false, icon: L.divIcon({ className: "loc-pin", html: `<span style="color:${col}">📍 ${esc(loc.name)}</span>`, iconSize: null, iconAnchor: [10, 28] }) });
}

function requestGeometry(r) {
  if (Array.isArray(r.geometry) && r.geometry.length) return r.geometry;
  return r.track_id && r.from_mp != null && r.to_mp != null ? sliceTrack(r.track_id, r.from_mp, r.to_mp) : [];
}

function openReq(r) { return r.status !== "completed" && r.status !== "cancelled"; }

const cellCache = new WeakMap();
function cells(r) {
  if (!cellCache.has(r)) cellCache.set(r, new Set(samplePolys(requestGeometry(r), 1).map(([x, y]) => Math.round(x / 1.5) + "," + Math.round(y / 1.5))));
  return cellCache.get(r);
}
function conflicts(r) {
  if (!openReq(r)) return [];
  const t0 = r.start_time || "", t1 = r.end_time || "￿", mine = cells(r);
  return state.requests.filter((o) => {
    if (o.id === r.id || !openReq(o) || (o.start_time || "") > t1 || (o.end_time || "￿") < t0) return false;
    if (r.location && r.location === o.location) return true;
    for (const c of cells(o)) if (mine.has(c)) return true;
    return false;
  });
}

function visibleRequests() {
  const f = $("#status-filter").value;
  return state.requests.filter((r) => f === "all" || openReq(r));
}

function renderRequests() {
  layers.requests.clearLayers();
  if (!$("#lyr-requests").checked) return;
  for (const r of visibleRequests()) {
    const polys = requestGeometry(r);
    const col = STATUS_COLOR[r.status] || "#666", sel = state.sel === r.id;
    const tip = `#${r.id}${r.description ? " " + r.description : ""} (${r.status})`;
    for (const pl of polys)
      L.polyline(llPoly(pl), { color: col, weight: reqWeight(sel), opacity: sel ? 0.8 : 0.55, lineCap: "butt" })
        .bindTooltip(esc(tip), { sticky: true }).on("click", () => selectRequest(r, false)).addTo(layers.requests);
    const loc = r.location && locationByName(r.location);
    if (loc) locationMarker(loc, col).addTo(layers.requests);
    if (polys.length) {
      const [x0, y0] = bboxOf(polys);
      L.marker(ll(x0, y0), { interactive: false, icon: L.divIcon({ className: "req-label", html: `<span style="color:${col}">#${r.id}${r.request_no ? " " + esc(r.request_no) : ""}</span>`, iconSize: null, iconAnchor: [0, 22] }) })
        .addTo(layers.requests);
    }
  }
}

map.on("zoomend", () => { renderRequests(); renderDraft(); });

function selectRequest(r, zoom = true) {
  state.sel = r.id;
  const polys = requestGeometry(r), loc = r.location && locationByName(r.location);
  if (zoom && polys.length) zoomTo(...bboxOf(polys), 120);
  else if (zoom && loc) zoomTo(loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70, 0);
  renderRequestList(); renderRequests();
}

// ------------------------------------------------------------------ requests storage

// Requests live in the database when server.py is running.  On a static host
// (GitHub Pages) there is no API, so they are kept in this browser instead.
let MODE = null;   // "server" | "local"
const LS_KEY = "trackmap.requests.v1";
let memStore = { next: 1, items: [] };
const FIELDS = ["request_no", "track_id", "from_mp", "to_mp", "start_time", "end_time", "work_type", "requester",
  "status", "notes", "location", "geometry", "limits", "description"];

function readLocal() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && Array.isArray(s.items)) return s; } catch (e) { /* storage blocked */ }
  return memStore;
}
function writeLocal(s) {
  memStore = s;
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* keep in memory only */ }
}

function localApi(method, url, body) {
  const s = readLocal(), id = parseInt(url.split("/")[2], 10);
  const now = new Date().toISOString().slice(0, 19) + "Z";
  const check = (r, partial) => {
    if (r.track_id && !trackRange(r.track_id)) throw new Error(`unknown track ${r.track_id}`);
    if (!partial && !r.track_id && !(r.geometry && r.geometry.length) && !r.location)
      throw new Error("give track limits on the map, a track and MP range, or a location");
  };
  if (method === "GET") return [...s.items].sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "") || a.id - b.id);
  if (method === "POST") {
    check(body);
    const r = { request_no: null, track_id: null, from_mp: null, to_mp: null, start_time: null, end_time: null, work_type: null,
      requester: null, notes: null, location: null, geometry: null, limits: null, description: null, status: "requested",
      ...body, id: s.next++, created_at: now, updated_at: null };
    s.items.push(r); writeLocal(s); return r;
  }
  const i = s.items.findIndex((r) => r.id === id);
  if (i < 0) throw new Error("no such request");
  if (method === "PUT") { check(body, true); s.items[i] = { ...s.items[i], ...body, id, updated_at: now }; writeLocal(s); return s.items[i]; }
  if (method === "DELETE") { s.items.splice(i, 1); writeLocal(s); return { deleted: id }; }
  throw new Error("unsupported");
}

async function api(method, url, body) {
  if (MODE === "local") return localApi(method, url, body);
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function detectMode() {
  if (location.hostname.endsWith("github.io")) MODE = "local";   // static hosting: no API to probe
  else try {
    const res = await fetch("api/requests", { cache: "no-store" });
    const j = res.ok ? await res.json() : null;
    MODE = Array.isArray(j) ? "server" : "local";
  } catch (e) { MODE = "local"; }
  $("#store-note").textContent = MODE === "server"
    ? "Saved to the shared database (server.py)."
    : "Static site: requests are saved in this browser only. Use Export to share or back them up.";
}

async function loadRequests() {
  try { state.requests = await api("GET", "api/requests"); }
  catch (e) { state.requests = []; formMsg("Could not load requests: " + e.message, true); }
  renderRequestList();
  renderRequests();
}

function exportRequests() {
  const blob = new Blob([JSON.stringify(state.requests, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `access-requests-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importRequests(file) {
  let items;
  try { items = JSON.parse(await file.text()); if (!Array.isArray(items)) throw new Error("expected a JSON array"); }
  catch (e) { return formMsg("Import failed: " + e.message, true); }
  let n = 0;
  for (const r of items) {
    const rec = {};
    for (const k of FIELDS) if (r[k] != null) rec[k] = r[k];
    try { await api("POST", "api/requests", rec); n++; } catch (e) { /* skip invalid rows */ }
  }
  formMsg(`Imported ${n} of ${items.length} requests.`);
  await loadRequests();
}
$("#export").onclick = exportRequests;
$("#import").onclick = () => $("#import-file").click();
$("#import-file").onchange = (e) => { if (e.target.files[0]) importRequests(e.target.files[0]); e.target.value = ""; };

// ------------------------------------------------------------------ requests UI

function fmtTime(t) { return t ? t.replace("T", " ") : "—"; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderRequestList() {
  const ul = $("#req-list"); ul.replaceChildren();
  const list = visibleRequests();
  if (!list.length) { const li = document.createElement("li"); li.className = "m"; li.textContent = "No requests yet. Box-select a block of track, draw along a track, or pick a location."; li.style.cursor = "default"; ul.append(li); return; }
  for (const r of list) {
    const li = document.createElement("li");
    li.style.setProperty("--c", STATUS_COLOR[r.status]);
    if (state.sel === r.id) li.classList.add("sel");
    const lims = Array.isArray(r.limits) && r.limits.length ? r.limits
      : (r.track_id ? [{ track: r.track_id, from_mp: r.from_mp, to_mp: r.to_mp }] : []);
    const cf = conflicts(r);
    li.innerHTML = `<div class="t">#${r.id}${r.request_no ? " · " + esc(r.request_no) : ""} <span class="pill" style="--c:${STATUS_COLOR[r.status]}">${r.status}</span></div>
      ${r.location ? `<div class="m">📍 ${esc(r.location)}</div>` : ""}
      ${lims.length ? `<ul class="lim">${lims.map((l) => `<li>${esc(limitText(l))}</li>`).join("")}</ul>` : ""}
      <div class="m">${esc(r.work_type || "")}${r.requester ? " · " + esc(r.requester) : ""}</div>
      <div class="m">${fmtTime(r.start_time)} → ${fmtTime(r.end_time)}</div>
      ${cf.length ? `<div class="warn">Overlaps ${cf.map((o) => "#" + o.id).join(", ")} (same track or location, same time)</div>` : ""}
      <div class="btns"><button class="secondary" data-act="edit">Edit</button><button class="secondary" data-act="del">Delete</button></div>`;
    li.onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "edit") return editRequest(r);
      if (act === "del") return deleteRequest(r);
      selectRequest(r);
    };
    ul.append(li);
  }
}

const form = $("#req-form");
function formMsg(t, err) { const m = $("#form-msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }

function editRequest(r) {
  for (const k of ["id", "request_no", "start_time", "end_time", "work_type", "requester", "status", "notes"])
    form.elements[k].value = r[k] ?? "";
  const hasGeom = Array.isArray(r.geometry) && r.geometry.length;
  state.draft = hasGeom ? r.geometry.map((pts) => ({ type: "poly", pts })) : [];
  form.elements.track_id.value = !hasGeom && r.track_id ? r.track_id : "";
  form.elements.from_mp.value = !hasGeom && r.from_mp != null ? r.from_mp : "";
  form.elements.to_mp.value = !hasGeom && r.to_mp != null ? r.to_mp : "";
  $("#typed-limits").open = !hasGeom && !!r.track_id;
  const loc = r.location && locationByName(r.location);
  form.elements.location.value = loc ? loc.id : "";
  $("#req-form-title").textContent = `Edit request #${r.id}`;
  $("#cancel-edit").hidden = false;
  showTab("requests");
  form.scrollIntoView({ behavior: "smooth" });
  onDraftChanged();
}
function resetForm() {
  form.reset();
  form.elements.id.value = "";
  $("#req-form-title").textContent = "New access request";
  $("#cancel-edit").hidden = true;
  state.draft = []; state.path = null;
  if (state.tool) setTool(state.tool);
  onDraftChanged();
}
$("#cancel-edit").onclick = resetForm;

async function deleteRequest(r) {
  if (!confirm(`Delete request #${r.id}?`)) return;
  try { await api("DELETE", `api/requests/${r.id}`); await loadRequests(); }
  catch (e) { formMsg(e.message, true); }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form).entries());
  const id = f.id; delete f.id;
  const typed = typedGeometry();
  if (f.track_id && (f.from_mp || f.to_mp) && !typed.length) {
    const r = trackRange(f.track_id);
    return formMsg(`${f.track_id} MP ${f.from_mp}–${f.to_mp} is outside the calibrated range${r ? ` (${r.from_mp}–${r.to_mp})` : ""}.`, true);
  }
  const geometry = draftGeometry().concat(typed).map((pl) => pl.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]));
  const limits = describeGeometry(geometry);
  const loc = locationById(f.location);
  if (!geometry.length && !loc) return formMsg("Select track on the map (box, draw or pieces), type a track and MP range, or choose a location.", true);
  const first = limits.find((l) => l.track);
  const rec = {
    request_no: f.request_no || null, start_time: f.start_time || null, end_time: f.end_time || null,
    work_type: f.work_type || null, requester: f.requester || null, status: f.status, notes: f.notes || null,
    location: loc ? loc.name : null, geometry: geometry.length ? geometry : null, limits: limits.length ? limits : null,
    track_id: first ? first.track : null, from_mp: first ? first.from_mp : null, to_mp: first ? first.to_mp : null,
    description: [loc && loc.name].concat(limits.map(limitText)).filter(Boolean).join("; "),
  };
  try {
    const saved = id ? await api("PUT", `api/requests/${id}`, rec) : await api("POST", "api/requests", rec);
    state.sel = saved.id;
    resetForm();
    formMsg(`Saved request #${saved.id}.`);
    await loadRequests();
  } catch (err) { formMsg(err.message, true); }
});
for (const n of ["track_id", "from_mp", "to_mp"]) form.elements[n].addEventListener("input", onDraftChanged);
form.elements.location.addEventListener("change", () => {
  const loc = locationById(form.elements.location.value);
  if (loc) zoomTo(loc.x - 150, loc.y - 70, loc.x + 150, loc.y + 70, 0);
  renderDraft();
});

// ------------------------------------------------------------------ find / layers

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function flash(x, y) {
  layers.hover.clearLayers();
  L.circleMarker(ll(x, y), { radius: 18, color: HOVER, weight: 3, fill: false, interactive: false }).addTo(layers.hover);
}

$("#find-mp").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = e.target.elements.track.value, mp = parseFloat(e.target.elements.mp.value);
  const q = locate(t, mp), r = trackRange(t);
  if (!q) { $("#find-msg").textContent = `${t} MP ${mp} is outside the calibrated range (${r.from_mp}–${r.to_mp}).`; return; }
  $("#find-msg").textContent = `${t} MP ${mp}: drawing position ${q.x.toFixed(1)}, ${q.y.toFixed(1)}`;
  zoomTo(q.x - 60, q.y - 40, q.x + 60, q.y + 40, 0);
  map.once("moveend", () => flash(q.x, q.y));
});

function renderStations() {
  const f = $("#station-filter").value.toLowerCase(), ul = $("#station-list"); ul.replaceChildren();
  const seen = new Set();
  for (const s of state.data.stations) {
    if (seen.has(s.name) || !s.name.toLowerCase().includes(f)) continue;
    seen.add(s.name);
    const li = document.createElement("li");
    li.textContent = s.name;
    li.onclick = () => { zoomTo(s.x - 150, s.y - 70, s.x + 150, s.y + 70, 0); map.once("moveend", () => flash(s.x, s.y)); };
    ul.append(li);
  }
}
$("#station-filter").oninput = renderStations;

function populateTracks() {
  const opts = state.data.tracks.map((t) => `<option value="${t.id}">${t.id} (MP ${t.from_mp}–${t.to_mp})</option>`).join("");
  form.elements.track_id.innerHTML = `<option value="">—</option>` + opts;
  $("#find-mp").elements.track.innerHTML = opts;
  const tb = $("#track-table tbody"); tb.replaceChildren();
  for (const t of state.data.tracks) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${t.id}</td><td>${t.from_mp} – ${t.to_mp}</td>`;
    tr.onclick = () => { const p = sliceTrack(t.id, t.from_mp, t.to_mp); if (p.length) zoomTo(...bboxOf(p), 60); };
    tb.append(tr);
  }
  const groups = [["station", "Stations"], ["tcr", "Train control rooms (TCR)"], ["yard", "Yards"], ["platform", "Platforms"]];
  form.elements.location.innerHTML = `<option value="">— none —</option>` + groups.map(([k, label]) => {
    const items = state.data.locations.filter((l) => l.kind === k);
    return items.length ? `<optgroup label="${label}">${items.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}</optgroup>` : "";
  }).join("");
}

for (const id of ["lyr-segs", "lyr-routes", "lyr-anchors", "lyr-qa", "lyr-requests"])
  $("#" + id).onchange = () => { renderSegs(); renderRoutes(); renderAnchors(); renderQA(); renderRequests(); };
$("#status-filter").onchange = () => { renderRequestList(); renderRequests(); };

function renderLegend() {
  const kindName = { running: "running track (milepost-calibrated)", crossover: "crossover", yard: "yard track", track: "other track (pocket, siding, middle…)" };
  $("#legend").innerHTML = "<h2>Request status</h2>" + Object.entries(STATUS_COLOR)
    .map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${k}</div>`).join("")
    + "<h2>Track pieces</h2>" + Object.entries(KIND_COLOR)
    .map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${kindName[k]}</div>`).join("");
  const d = state.data, n = (s) => d.labels.filter((l) => l.status === s).length;
  const kinds = {};
  for (const s of d.segments) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  $("#data-info").innerHTML = `Source: ${esc(d.source)} · extracted ${esc(d.generated.slice(0, 10))}<br>
    ${d.segments.length} selectable track pieces (${kinds.running || 0} running, ${kinds.crossover || 0} crossovers, ${kinds.yard || 0} yard, ${kinds.track || 0} other) ·
    ${d.labels.length} milepost labels read · ${d.tracks.length} calibrated tracks · ${n("out_of_sequence") + n("unanchored") + n("unused")} labels flagged for review (see docs/qa_report.md)<br>
    <a href="map.svg" target="_blank" rel="noopener">Vector copy of the drawing (SVG)</a>`;
}

// ------------------------------------------------------------------ boot

(async function boot() {
  const [data, index] = await Promise.all([
    fetch("data/map.json").then((r) => r.json()),
    fetch("tiles/index.json").then((r) => r.json()),
  ]);
  state.data = data;
  // high-density screens get the next zoom level's tiles at half size
  const R = window.devicePixelRatio >= 1.5 ? 1 : 0;
  new DrawingTiles("", { index, tileSize: 256 >> R, zoomOffset: R, minZoom: -5, maxZoom: 6,
    minNativeZoom: -4 - R, maxNativeZoom: 4 - R, bounds: PAGE_BOUNDS, noWrap: true, keepBuffer: 3 }).addTo(map);
  for (const g of Object.values(layers)) g.addTo(map);
  fitPage();
  indexRoutes();
  indexSegments();
  populateTracks();
  renderStations();
  renderLegend();
  renderSegs(); renderRoutes(); renderAnchors(); renderQA();
  $("#loading").remove();
  await detectMode();
  await loadRequests();
})();
