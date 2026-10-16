"use strict";
// Track map viewer.  The base layer is the drawing rendered into map tiles
// straight from the vector PDF (pipeline/make_tiles.py), so it is sharp at
// every zoom.  Overlays use the drawing's own coordinates: PDF points, origin
// top-left, mapped to Leaflet CRS.Simple as latLng(-y, x).

const PAGE_W = 6552, PAGE_H = 1440;
const STATUS_COLOR = {
  requested: "#e08a00", approved: "#1f5fbf", active: "#d1242f", completed: "#6b7280", cancelled: "#9ca3af",
};
const HOVER = "#0a8f6a", ROUTE = "#8a2be2";
const $ = (s) => document.querySelector(s);

const state = { data: null, requests: [], sel: null, pick: null };

// ------------------------------------------------------------------ geometry

let SEGS = [];          // flattened calibrated segments
const GRID = 60, grid = new Map();

function indexRoutes() {
  SEGS = [];
  for (const [track, pieces] of Object.entries(state.data.routes)) {
    for (const pc of pieces) for (const lg of pc.legs) {
      for (let i = 0; i < lg.pts.length - 1; i++) {
        const [x0, y0] = lg.pts[i], [x1, y1] = lg.pts[i + 1];
        SEGS.push({ track, x0, y0, x1, y1, m0: lg.mps[i], m1: lg.mps[i + 1] });
      }
    }
  }
  grid.clear();
  SEGS.forEach((g, i) => {
    const gx0 = Math.floor(Math.min(g.x0, g.x1) / GRID), gx1 = Math.floor(Math.max(g.x0, g.x1) / GRID);
    const gy0 = Math.floor(Math.min(g.y0, g.y1) / GRID), gy1 = Math.floor(Math.max(g.y0, g.y1) / GRID);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gx + "," + gy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  });
}

/** Nearest calibrated track point to (x, y) within r: {track, mp, x, y, d}. */
function nearestTrackPoint(x, y, r) {
  let best = null;
  const gx0 = Math.floor((x - r) / GRID), gx1 = Math.floor((x + r) / GRID);
  const gy0 = Math.floor((y - r) / GRID), gy1 = Math.floor((y + r) / GRID);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    for (const i of grid.get(gx + "," + gy) || []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const g = SEGS[i], dx = g.x1 - g.x0, dy = g.y1 - g.y0, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - g.x0) * dx + (y - g.y0) * dy) / L2));
      const px = g.x0 + t * dx, py = g.y0 + t * dy, d = Math.hypot(px - x, py - y);
      if (d <= r && (!best || d < best.d)) best = { track: g.track, mp: g.m0 + t * (g.m1 - g.m0), x: px, y: py, d };
    }
  }
  return best;
}

/** Polylines covering milepost range [a, b] of a track (same rule as server.py). */
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

// ------------------------------------------------------------------ map

const ll = (x, y) => L.latLng(-y, x);
const llPoly = (pl) => pl.map(([x, y]) => ll(x, y));
const PAGE_BOUNDS = L.latLngBounds(ll(0, PAGE_H), ll(PAGE_W, 0));

const map = L.map("viewport", {
  crs: L.CRS.Simple, minZoom: -5, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 100,
  zoomControl: false, attributionControl: false, maxBounds: PAGE_BOUNDS.pad(0.25), maxBoundsViscosity: 0.8,
});
const scale = () => map.getZoomScale(map.getZoom(), 0);   // screen px per PDF point

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
  routes: L.layerGroup(), anchors: L.layerGroup(), qa: L.layerGroup(),
  requests: L.layerGroup(), pick: L.layerGroup(), hover: L.layerGroup(),
};

function zoomTo(x0, y0, x1, y1, pad = 40) {
  map.fitBounds(L.latLngBounds(ll(x0 - pad, y1 + pad), ll(x1 + pad, y0 - pad)), { maxZoom: 3.5 });
}
const fitPage = () => map.fitBounds(PAGE_BOUNDS, { animate: false });

$("#zoom-in").onclick = () => map.zoomIn();
$("#zoom-out").onclick = () => map.zoomOut();
$("#zoom-fit").onclick = fitPage;
$("#toggle-panel").onclick = () => { $("#panel").classList.toggle("hidden"); setTimeout(() => map.invalidateSize(), 0); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelPick(); });

// ------------------------------------------------------------------ hover readout

map.on("mousemove", (e) => {
  const x = e.latlng.lng, y = -e.latlng.lat;
  const hit = nearestTrackPoint(x, y, Math.max(1, 14 / scale()));
  layers.hover.clearLayers();
  if (!hit) { $("#readout").textContent = state.pick ? pickPrompt() : "Hover a track for its milepost"; return; }
  $("#readout").innerHTML = `<b>${hit.track}</b> MP <b>${hit.mp.toFixed(3)}</b>` + (state.pick ? " — click to set " + (state.pick.stage === 0 ? "start" : "end") : "");
  L.circleMarker(ll(hit.x, hit.y), { radius: 5, color: "#fff", weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.hover);
});
map.on("mouseout", () => layers.hover.clearLayers());
map.on("click", (e) => onMapClick(e.latlng.lng, -e.latlng.lat));

// ------------------------------------------------------------------ overlays

// request highlights: at least 8 px wide, growing with zoom to cover the drawn track
const reqWeight = (sel) => Math.max(sel ? 11 : 8, Math.min(70, (sel ? 5.5 : 4.5) * scale()));

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

function openReq(r) { return r.status !== "completed" && r.status !== "cancelled"; }

function conflicts(r) {
  if (!openReq(r)) return [];
  const t0 = r.start_time || "", t1 = r.end_time || "￿";
  const lo = Math.min(r.from_mp, r.to_mp), hi = Math.max(r.from_mp, r.to_mp);
  return state.requests.filter((o) => o.id !== r.id && openReq(o) && o.track_id === r.track_id
    && Math.min(o.from_mp, o.to_mp) <= hi && Math.max(o.from_mp, o.to_mp) >= lo
    && (o.start_time || "") <= t1 && (o.end_time || "￿") >= t0);
}

function visibleRequests() {
  const f = $("#status-filter").value;
  return state.requests.filter((r) => f === "all" || openReq(r));
}

function renderRequests() {
  layers.requests.clearLayers();
  if (!$("#lyr-requests").checked) return;
  for (const r of visibleRequests()) {
    const polys = sliceTrack(r.track_id, r.from_mp, r.to_mp);
    if (!polys.length) continue;
    const col = STATUS_COLOR[r.status] || "#666", sel = state.sel === r.id;
    const tip = `#${r.id} ${r.track_id} MP ${r.from_mp}–${r.to_mp} (${r.status})`;
    for (const pl of polys)
      L.polyline(llPoly(pl), { color: col, weight: reqWeight(sel), opacity: sel ? 0.8 : 0.55, lineCap: "butt" })
        .bindTooltip(tip, { sticky: true }).on("click", () => selectRequest(r, false)).addTo(layers.requests);
    for (const mp of [r.from_mp, r.to_mp]) {
      const q = locate(r.track_id, mp);
      if (q) L.circleMarker(ll(q.x, q.y), { radius: 5, color: col, weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layers.requests);
    }
    const [x0, y0] = bboxOf(polys);
    L.marker(ll(x0, y0), { interactive: false, icon: L.divIcon({ className: "req-label", html: `<span style="color:${col}">#${r.id} ${esc(r.track_id)} ${r.from_mp}–${r.to_mp}</span>`, iconSize: null, iconAnchor: [0, 22] }) })
      .addTo(layers.requests);
  }
}

map.on("zoomend", () => { renderRequests(); renderPick(); });

function selectRequest(r, zoom = true) {
  state.sel = r.id;
  const polys = sliceTrack(r.track_id, r.from_mp, r.to_mp);
  if (zoom && polys.length) zoomTo(...bboxOf(polys), 120);
  renderRequestList(); renderRequests();
}

// ------------------------------------------------------------------ requests UI

// Requests live in the database when server.py is running.  On a static host
// (GitHub Pages) there is no API, so they are kept in this browser instead.
let MODE = null;   // "server" | "local"
const LS_KEY = "trackmap.requests.v1";
let memStore = { next: 1, items: [] };

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
  const check = (r) => {
    if (r.track_id !== undefined && !trackRange(r.track_id)) throw new Error(`unknown track ${r.track_id}`);
    for (const k of ["from_mp", "to_mp"]) if (k in r && isNaN(parseFloat(r[k]))) throw new Error(`${k} must be a number`);
  };
  if (method === "GET") return [...s.items].sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "") || a.id - b.id);
  if (method === "POST") {
    check(body);
    const r = { request_no: null, start_time: null, end_time: null, work_type: null, requester: null, notes: null, status: "requested",
      ...body, id: s.next++, created_at: now, updated_at: null };
    s.items.push(r); writeLocal(s); return r;
  }
  const i = s.items.findIndex((r) => r.id === id);
  if (i < 0) throw new Error("no such request");
  if (method === "PUT") { check(body); s.items[i] = { ...s.items[i], ...body, id, updated_at: now }; writeLocal(s); return s.items[i]; }
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
    for (const k of ["request_no", "track_id", "from_mp", "to_mp", "start_time", "end_time", "work_type", "requester", "status", "notes"]) if (r[k] != null) rec[k] = r[k];
    try { await api("POST", "api/requests", rec); n++; } catch (e) { /* skip invalid rows */ }
  }
  formMsg(`Imported ${n} of ${items.length} requests.`);
  await loadRequests();
}
$("#export").onclick = exportRequests;
$("#import").onclick = () => $("#import-file").click();
$("#import-file").onchange = (e) => { if (e.target.files[0]) importRequests(e.target.files[0]); e.target.value = ""; };

function fmtTime(t) { return t ? t.replace("T", " ") : "—"; }

function renderRequestList() {
  const ul = $("#req-list"); ul.replaceChildren();
  const list = visibleRequests();
  if (!list.length) { const li = document.createElement("li"); li.className = "m"; li.textContent = "No requests yet. Fill in the form or pick limits on the map."; li.style.cursor = "default"; ul.append(li); return; }
  for (const r of list) {
    const li = document.createElement("li");
    li.style.setProperty("--c", STATUS_COLOR[r.status]);
    if (state.sel === r.id) li.classList.add("sel");
    const range = trackRange(r.track_id);
    const outside = range && (Math.min(r.from_mp, r.to_mp) < range.from_mp - 1e-9 || Math.max(r.from_mp, r.to_mp) > range.to_mp + 1e-9);
    const cf = conflicts(r);
    li.innerHTML = `<div class="t">#${r.id}${r.request_no ? " · " + esc(r.request_no) : ""} — ${esc(r.track_id)} MP ${r.from_mp} – ${r.to_mp} <span class="pill" style="--c:${STATUS_COLOR[r.status]}">${r.status}</span></div>
      <div class="m">${esc(r.work_type || "")}${r.requester ? " · " + esc(r.requester) : ""}</div>
      <div class="m">${fmtTime(r.start_time)} → ${fmtTime(r.end_time)}</div>
      ${outside ? `<div class="warn">Partly outside calibrated range ${range.from_mp}–${range.to_mp}</div>` : ""}
      ${cf.length ? `<div class="warn">Overlaps ${cf.map((o) => "#" + o.id).join(", ")} (same track, MP and time)</div>` : ""}
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

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const form = $("#req-form");
function formMsg(t, err) { const m = $("#form-msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }

function editRequest(r) {
  for (const k of ["id", "request_no", "track_id", "from_mp", "to_mp", "start_time", "end_time", "work_type", "requester", "status", "notes"])
    form.elements[k].value = r[k] ?? "";
  $("#req-form-title").textContent = `Edit request #${r.id}`;
  $("#cancel-edit").hidden = false;
  showTab("requests");
  form.scrollIntoView({ behavior: "smooth" });
  previewForm();
}
function resetForm() {
  form.reset();
  form.elements.id.value = "";
  $("#req-form-title").textContent = "New access request";
  $("#cancel-edit").hidden = true;
  state.pick = null; renderPick();
}
$("#cancel-edit").onclick = resetForm;

async function deleteRequest(r) {
  if (!confirm(`Delete request #${r.id} (${r.track_id} MP ${r.from_mp}–${r.to_mp})?`)) return;
  try { await api("DELETE", `api/requests/${r.id}`); await loadRequests(); }
  catch (e) { formMsg(e.message, true); }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form).entries());
  const id = f.id; delete f.id;
  f.from_mp = parseFloat(f.from_mp); f.to_mp = parseFloat(f.to_mp);
  if (!sliceTrack(f.track_id, f.from_mp, f.to_mp).length) {
    const r = trackRange(f.track_id);
    return formMsg(`${f.track_id} MP ${f.from_mp}–${f.to_mp} is outside the calibrated range${r ? ` (${r.from_mp}–${r.to_mp})` : ""}.`, true);
  }
  try {
    const saved = id ? await api("PUT", `api/requests/${id}`, f) : await api("POST", "api/requests", f);
    state.sel = saved.id;
    resetForm();
    formMsg(`Saved request #${saved.id}.`);
    await loadRequests();
  } catch (err) { formMsg(err.message, true); }
});
form.addEventListener("input", () => previewForm());

function previewForm() {
  const f = form.elements, a = parseFloat(f.from_mp.value), b = parseFloat(f.to_mp.value);
  state.pick = state.pick && state.pick.stage < 2 ? state.pick : null;
  layers.pick.clearLayers();
  if (!f.track_id.value || isNaN(a) || isNaN(b)) return;
  for (const pl of sliceTrack(f.track_id.value, a, b))
    L.polyline(llPoly(pl), { color: HOVER, weight: reqWeight(false), opacity: 0.5, interactive: false }).addTo(layers.pick);
}

// pick limits on map
function pickPrompt() { return state.pick.stage === 0 ? "Click the start of the work limits on a track" : `Click the end on ${state.pick.track}`; }
$("#pick").onclick = () => {
  if (state.pick && state.pick.stage < 2) return cancelPick();
  state.pick = { stage: 0 };
  $("#pick").classList.add("armed"); $("#pick").textContent = "Picking… (Esc to cancel)";
  map.getContainer().classList.add("picking");
  $("#readout").textContent = pickPrompt();
};
function cancelPick() {
  state.pick = null;
  $("#pick").classList.remove("armed"); $("#pick").textContent = "Pick limits on map";
  map.getContainer().classList.remove("picking");
  renderPick();
}
function onMapClick(x, y) {
  if (!state.pick || state.pick.stage > 1) return;
  const hit = nearestTrackPoint(x, y, Math.max(1, 20 / scale()));
  if (!hit) return;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (state.pick.stage === 0) {
    state.pick = { stage: 1, track: hit.track, a: hit };
    form.elements.track_id.value = hit.track;
    form.elements.from_mp.value = r3(hit.mp);
    form.elements.to_mp.value = "";
    $("#readout").textContent = pickPrompt();
  } else {
    let mp = hit.mp;
    if (hit.track !== state.pick.track) {   // project onto the first track
      const h2 = nearestTrackPointOn(state.pick.track, x, y);
      if (!h2) return;
      mp = h2.mp;
    }
    form.elements.to_mp.value = r3(mp);
    const p = state.pick;
    cancelPick();
    state.pick = { stage: 2, track: p.track };
    formMsg("Limits set - fill in the details and save.");
  }
  renderPick();
}
function nearestTrackPointOn(track, x, y) {
  let best = null;
  for (const g of SEGS) {
    if (g.track !== track) continue;
    const dx = g.x1 - g.x0, dy = g.y1 - g.y0, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - g.x0) * dx + (y - g.y0) * dy) / L2));
    const px = g.x0 + t * dx, py = g.y0 + t * dy, d = Math.hypot(px - x, py - y);
    if (!best || d < best.d) best = { mp: g.m0 + t * (g.m1 - g.m0), x: px, y: py, d };
  }
  return best;
}
function renderPick() {
  if (state.pick && state.pick.stage === 1) {
    layers.pick.clearLayers();
    L.circleMarker(ll(state.pick.a.x, state.pick.a.y), { radius: 6, color: "#fff", weight: 1.5, fillColor: HOVER, fillOpacity: 1, interactive: false }).addTo(layers.pick);
  } else previewForm();
}

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
  form.elements.track_id.innerHTML = opts;
  $("#find-mp").elements.track.innerHTML = opts;
  const tb = $("#track-table tbody"); tb.replaceChildren();
  for (const t of state.data.tracks) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${t.id}</td><td>${t.from_mp} – ${t.to_mp}</td>`;
    tr.onclick = () => { const p = sliceTrack(t.id, t.from_mp, t.to_mp); if (p.length) zoomTo(...bboxOf(p), 60); };
    tb.append(tr);
  }
}

for (const id of ["lyr-routes", "lyr-anchors", "lyr-qa", "lyr-requests"])
  $("#" + id).onchange = () => { renderRoutes(); renderAnchors(); renderQA(); renderRequests(); };
$("#status-filter").onchange = () => { renderRequestList(); renderRequests(); };

function renderLegend() {
  $("#legend").innerHTML = "<h2>Request status</h2>" + Object.entries(STATUS_COLOR)
    .map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${k}</div>`).join("");
  const d = state.data, n = (s) => d.labels.filter((l) => l.status === s).length;
  $("#data-info").innerHTML = `Source: ${esc(d.source)} · extracted ${esc(d.generated.slice(0, 10))}<br>
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
  populateTracks();
  renderStations();
  renderLegend();
  renderRoutes(); renderAnchors(); renderQA();
  $("#loading").remove();
  await detectMode();
  await loadRequests();
})();
