/**
 * Phases: named boxes on the drawing — "Phase 2" around the W and Y lines —
 * kept as one setting so everybody sees the same ones, and chosen on the track
 * plan to look at one at a time.
 *
 * A phase is `{ id, name, note, bbox: [x0, y0, x1, y1] }`, its box in the
 * drawing's own points (x across, y down), as the map stores everything else.
 * The server checks the same shape before it keeps a phase (operations.py).
 *
 * Pure: no DOM. The map draws them, Setup edits them, `tests/test_tawr.mjs`
 * reads them.
 *
 * Imports: links.
 */

import { lineOf } from './links.js';

export const MAX_PHASES = 50;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The phases a setting holds: the well-formed ones, in order, never a throw. */
export function parsePhases(text) {
  let list;
  try { list = JSON.parse(text || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.name === 'string' && p.name.trim() && Array.isArray(p.bbox) && p.bbox.length === 4
    && p.bbox.every(finite) && p.bbox[0] < p.bbox[2] && p.bbox[1] < p.bbox[3])
    .slice(0, MAX_PHASES)
    .map((p, i) => ({ id: String(p.id || `phase-${i + 1}`), name: p.name.trim(), note: String(p.note || '').trim(), bbox: p.bbox.map((v) => Math.round(v)) }));
}

/** The setting's text for a list of phases. */
export function phasesText(list) {
  return JSON.stringify(list.map((p) => ({ id: p.id, name: p.name, note: p.note || '', bbox: p.bbox.map((v) => Math.round(v)) })));
}

export function newPhaseId() {
  return `phase-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Whether a drawing point lies inside a box. */
export function insideBox([x, y], [x0, y0, x1, y1]) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

const byTrack = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The tracks with a calibrated point inside a box, and their lines:
 * `{ lines: ['W', 'Y'], tracks: ['W1', 'W2', …, 'Y1', …] }`.
 */
export function linesInBox(routes, bbox) {
  const tracks = Object.entries(routes || {})
    .filter(([, pieces]) => pieces.some((pc) => pc.legs.some((lg) => lg.pts.some((pt) => insideBox(pt, bbox)))))
    .map(([track]) => track)
    .sort(byTrack);
  return { lines: [...new Set(tracks.map(lineOf))], tracks };
}

/** What a box covers, in words: "the W and Y lines", or that it covers no track. */
export function coversText(routes, bbox) {
  const { lines } = linesInBox(routes, bbox);
  if (!lines.length) return 'no calibrated track';
  const named = lines.length === 1 ? lines[0] : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
  return `the ${named} line${lines.length === 1 ? '' : 's'}`;
}
