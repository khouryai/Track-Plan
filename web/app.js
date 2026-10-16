"use strict";
// Track map viewer.  The base layer is the drawing itself (map.svg, an exact
// vector copy of the PDF); everything interactive is an SVG overlay in the same
// coordinate frame (PDF points, origin top-left).

const PAGE_W = 6552, PAGE_H = 1440;
const SVGNS = "http://www.w3.org/2000/svg";
const STATUS_COLOR = {
  requested: "var(--req-requested)", approved: "var(--req-approved)", active: "var(--req-active)",
  completed: "var(--req-completed)", cancelled: "var(--req-cancelled)",
};
const $ = (s) => document.querySelector(s);

const state = { data: null, requests: [], view: { s: 1, tx: 0, ty: 0 }, sel: null, pick: null };

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

// ------------------------------------------------------------------ view

const vp = $("#viewport"), stage = $("#stage");

function applyView() {
  const { s, tx, ty } = state.view;
  stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  document.documentElement.style.setProperty("--inv", 1 / s);
  renderScaled();
}

function clampView() {
  const v = state.view, W = vp.clientWidth, H = vp.clientHeight;
  v.s = Math.max(fitScale() * 0.8, Math.min(v.s, 12));
  const mw = PAGE_W * v.s, mh = PAGE_H * v.s;
  v.tx = mw < W ? (W - mw) / 2 : Math.min(0, Math.max(W - mw, v.tx));
  v.ty = mh < H ? (H - mh) / 2 : Math.min(0, Math.max(H - mh, v.ty));
}

function fitScale() { return Math.min(vp.clientWidth / PAGE_W, vp.clientHeight / PAGE_H); }

function zoomAt(f, cx, cy) {
  const v = state.view, ns = Math.max(fitScale() * 0.8, Math.min(v.s * f, 12));
  v.tx = cx - (cx - v.tx) * (ns / v.s);
  v.ty = cy - (cy - v.ty) * (ns / v.s);
  v.s = ns;
  clampView();
  applyView();
}

function zoomTo(x0, y0, x1, y1, pad = 40) {
  const W = vp.clientWidth, H = vp.clientHeight;
  const s = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad), 6);
  state.view = { s, tx: W / 2 - ((x0 + x1) / 2) * s, ty: H / 2 - ((y0 + y1) / 2) * s };
  clampView();
  applyView();
}

function toMap(clientX, clientY) {
  const r = vp.getBoundingClientRect(), v = state.view;
  return [(clientX - r.left - v.tx) / v.s, (clientY - r.top - v.ty) / v.s];
}

// pointer pan / pinch
const pointers = new Map();
let drag = null, moved = false;
vp.addEventListener("pointerdown", (e) => {
  vp.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  moved = false;
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, tx: state.view.tx, ty: state.view.ty };
  else drag = null;
});
vp.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) {
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]), d1 = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = vp.getBoundingClientRect();
      if (d0 > 0) zoomAt(d1 / d0, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
      moved = true;
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; vp.classList.add("dragging"); }
      state.view.tx = drag.tx + dx;
      state.view.ty = drag.ty + dy;
      clampView();
      applyView();
    }
  }
  scheduleHover(e.clientX, e.clientY);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  vp.classList.remove("dragging");
  if (pointers.size === 0) {
    if (!moved && e.type === "pointerup") onMapClick(e.clientX, e.clientY);
    drag = null;
  }
};
vp.addEventListener("pointerup", endPointer);
vp.addEventListener("pointercancel", endPointer);
vp.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
vp.addEventListener("keydown", (e) => {
  const W = vp.clientWidth / 2, H = vp.clientHeight / 2;
  if (e.key === "+" || e.key === "=") zoomAt(1.4, W, H);
  else if (e.key === "-") zoomAt(1 / 1.4, W, H);
  else if (e.key.startsWith("Arrow")) {
    const d = 80;
    state.view.tx += e.key === "ArrowLeft" ? d : e.key === "ArrowRight" ? -d : 0;
    state.view.ty += e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0;
    clampView(); applyView();
  } else if (e.key === "Escape") cancelPick();
  else return;
  e.preventDefault();
});
$("#zoom-in").onclick = () => zoomAt(1.5, vp.clientWidth / 2, vp.clientHeight / 2);
$("#zoom-out").onclick = () => zoomAt(1 / 1.5, vp.clientWidth / 2, vp.clientHeight / 2);
$("#zoom-fit").onclick = () => { zoomTo(0, 0, PAGE_W, PAGE_H, 0); };
window.addEventListener("resize", () => { clampView(); applyView(); });
$("#toggle-panel").onclick = () => { $("#panel").classList.toggle("hidden"); setTimeout(() => { clampView(); applyView(); }, 0); };

// ------------------------------------------------------------------ hover readout

let hoverReq = null;
function scheduleHover(cx, cy) {
  if (hoverReq) return;
  hoverReq = requestAnimationFrame(() => { hoverReq = null; hover(cx, cy); });
}
function hover(cx, cy) {
  const [x, y] = toMap(cx, cy);
  const hit = nearestTrackPoint(x, y, Math.max(3, 14 / state.view.s));
  const g = $("#g-hover");
  g.replaceChildren();
  if (!hit) { $("#readout").textContent = state.pick ? pickPrompt() : "Hover a track for its milepost"; return; }
  $("#readout").innerHTML = `<b>${hit.track}</b> MP <b>${hit.mp.toFixed(3)}</b>` + (state.pick ? " — click to set " + (state.pick.stage === 0 ? "start" : "end") : "");
  g.append(el("circle", { cx: hit.x, cy: hit.y, r: px(5), "stroke-width": px(1.5), class: "hover-dot" }));
}

// overlay sizes in map units that stay readable at any zoom: px / scale,
// but never thinner than the drawn track itself when zoomed right in
const px = (n) => n / state.view.s;

// ------------------------------------------------------------------ overlays

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
const pathD = (pl) => "M" + pl.map((p) => p[0].toFixed(2) + " " + p[1].toFixed(2)).join("L");

function renderRoutes() {
  const g = $("#g-routes"); g.replaceChildren();
  if (!$("#lyr-routes").checked) return;
  for (const pieces of Object.values(state.data.routes))
    for (const pc of pieces) for (const lg of pc.legs) g.append(el("path", { d: pathD(lg.pts), class: "route" }));
}

function renderAnchors() {
  const g = $("#g-anchors"); g.replaceChildren();
  if (!$("#lyr-anchors").checked) return;
  for (const [track, pieces] of Object.entries(state.data.routes))
    for (const pc of pieces) for (const a of pc.anchors) {
      const c = el("circle", { cx: a.x, cy: a.y, r: 1.6, class: "anchor" + (a.line_level ? " line" : "") });
      c.append(el("title", {}, `${track} MP ${a.mp}${a.line_level ? " (line-level)" : ""}`));
      g.append(c);
    }
}

function renderQA() {
  const g = $("#g-qa"); g.replaceChildren();
  if (!$("#lyr-qa").checked) return;
  for (const l of state.data.labels) {
    if (!["out_of_sequence", "unanchored", "unused"].includes(l.status)) continue;
    const [x0, y0, x1, y1] = l.bbox;
    const r = el("rect", { x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4, rx: 2, class: "qa" });
    r.append(el("title", {}, `${l.text}: ${l.status.replace(/_/g, " ")}`));
    g.append(r);
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
  const g = $("#g-requests"); g.replaceChildren();
  if (!$("#lyr-requests").checked) return;
  for (const r of visibleRequests()) {
    const polys = sliceTrack(r.track_id, r.from_mp, r.to_mp);
    const col = STATUS_COLOR[r.status] || "var(--muted)", sel = state.sel === r.id;
    for (const pl of polys) {
      const p = el("path", { d: pathD(pl), class: "req" + (sel ? " sel" : ""), stroke: col, "stroke-width": Math.max(sel ? 6 : 4.5, px(sel ? 12 : 9)) });
      p.append(el("title", {}, `#${r.id} ${r.track_id} MP ${r.from_mp}–${r.to_mp} (${r.status})`));
      g.append(p);
    }
    for (const mp of [r.from_mp, r.to_mp]) {
      const q = locate(r.track_id, mp);
      if (q) g.append(el("circle", { cx: q.x, cy: q.y, r: Math.max(2.4, px(4.5)), fill: "#fff", stroke: col, "stroke-width": px(1.5), class: "req-end" }));
    }
    if (polys.length) {
      const [x0, y0] = bboxOf(polys);
      g.append(el("text", { x: x0, y: y0 - Math.max(4, px(8)), class: "req-label", fill: col, "font-size": px(13), "stroke-width": px(3) },
        `#${r.id} ${r.track_id} ${r.from_mp}–${r.to_mp}`));
    }
  }
}

function renderScaled() {
  // stroke widths of request overlays follow zoom so they stay legible
  clearTimeout(renderScaled.t);
  renderScaled.t = setTimeout(() => { renderRequests(); renderPick(); }, 60);
}

// ------------------------------------------------------------------ requests UI

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function loadRequests() {
  try { state.requests = await api("GET", "api/requests"); }
  catch (e) { state.requests = []; $("#form-msg").textContent = "Server not reachable - requests cannot be saved (run server.py)."; $("#form-msg").className = "msg err"; }
  renderRequestList();
  renderRequests();
}

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
      state.sel = r.id;
      const polys = sliceTrack(r.track_id, r.from_mp, r.to_mp);
      if (polys.length) zoomTo(...bboxOf(polys), 120);
      renderRequestList(); renderRequests();
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
  const g = $("#g-pick"); g.replaceChildren();
  if (!f.track_id.value || isNaN(a) || isNaN(b)) return;
  for (const pl of sliceTrack(f.track_id.value, a, b)) g.append(el("path", { d: pathD(pl), class: "pick-line", "stroke-width": Math.max(4.5, px(9)) }));
}

// pick limits on map
function pickPrompt() { return state.pick.stage === 0 ? "Click the start of the work limits on a track" : `Click the end on ${state.pick.track}`; }
$("#pick").onclick = () => {
  if (state.pick) return cancelPick();
  state.pick = { stage: 0 };
  $("#pick").classList.add("armed"); $("#pick").textContent = "Picking… (Esc to cancel)";
  vp.classList.add("picking");
  $("#readout").textContent = pickPrompt();
};
function cancelPick() {
  state.pick = null;
  $("#pick").classList.remove("armed"); $("#pick").textContent = "Pick limits on map";
  vp.classList.remove("picking");
  renderPick();
}
function onMapClick(cx, cy) {
  if (!state.pick) return;
  const [x, y] = toMap(cx, cy);
  const hit = nearestTrackPoint(x, y, Math.max(3, 14 / state.view.s));
  if (!hit) return;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (state.pick.stage === 0) {
    state.pick = { stage: 1, track: hit.track, a: hit };
    form.elements.track_id.value = hit.track;
    form.elements.from_mp.value = r3(hit.mp);
    form.elements.to_mp.value = "";
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
    previewForm();
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
    const g = $("#g-pick"); g.replaceChildren();
    g.append(el("circle", { cx: state.pick.a.x, cy: state.pick.a.y, r: px(6), "stroke-width": px(1.5), class: "pick-dot" }));
  } else if (!state.pick || state.pick.stage === 2) previewForm();
}

// ------------------------------------------------------------------ find / layers

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function flash(x, y) {
  const g = $("#g-hover"); g.replaceChildren();
  g.append(el("circle", { cx: x, cy: y, r: px(18), "stroke-width": px(2.5), class: "find-ring" }));
}

$("#find-mp").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = e.target.elements.track.value, mp = parseFloat(e.target.elements.mp.value);
  const q = locate(t, mp), r = trackRange(t);
  if (!q) { $("#find-msg").textContent = `${t} MP ${mp} is outside the calibrated range (${r.from_mp}–${r.to_mp}).`; return; }
  $("#find-msg").textContent = `${t} MP ${mp}: drawing position ${q.x.toFixed(1)}, ${q.y.toFixed(1)}`;
  zoomTo(q.x - 60, q.y - 40, q.x + 60, q.y + 40, 0);
  setTimeout(() => flash(q.x, q.y), 80);
});

function renderStations() {
  const f = $("#station-filter").value.toLowerCase(), ul = $("#station-list"); ul.replaceChildren();
  const seen = new Set();
  for (const s of state.data.stations) {
    if (seen.has(s.name) || !s.name.toLowerCase().includes(f)) continue;
    seen.add(s.name);
    const li = document.createElement("li");
    li.textContent = s.name;
    li.onclick = () => { zoomTo(s.x - 150, s.y - 70, s.x + 150, s.y + 70, 0); setTimeout(() => flash(s.x, s.y), 80); };
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
    ${d.labels.length} milepost labels read · ${d.tracks.length} calibrated tracks · ${n("out_of_sequence") + n("unanchored") + n("unused")} labels flagged for review (see docs/qa_report.md)`;
}

// ------------------------------------------------------------------ boot

(async function boot() {
  const [data] = await Promise.all([
    fetch("data/map.json").then((r) => r.json()),
    new Promise((res) => { const img = $("#base"); if (img.complete) res(); else { img.onload = res; img.onerror = res; } }),
  ]);
  state.data = data;
  indexRoutes();
  populateTracks();
  renderStations();
  renderLegend();
  renderRoutes(); renderAnchors(); renderQA();
  $("#loading").remove();
  zoomTo(0, 0, PAGE_W, PAGE_H, 0);
  await loadRequests();
})();
