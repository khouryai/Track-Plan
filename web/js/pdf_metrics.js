/**
 * Base-14 font metrics: how wide a string is in Helvetica, so the TAWR form
 * filler can shrink a value until it fits its box.
 *
 * Copied from cx-timeline (src/io/pdf.js, the metrics only).
 *
 * Imports: nothing (leaf).
 */

/* ── Base-14 font metrics (widths per 1000 units, ASCII 32–126) ────────── */
const W_HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const FONTS = {
  F1: { name: 'Helvetica', widths: W_HELVETICA },
  F2: { name: 'Helvetica-Bold', widths: W_HELVETICA_BOLD },
  F3: { name: 'Courier', widths: null }, // fixed pitch, 600/1000
  F4: { name: 'Courier-Bold', widths: null },
};

/** Width of a string at a given size, in points. */
export function textWidth(text, size, fontKey = 'F1') {
  const font = FONTS[fontKey] || FONTS.F1;
  let units = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (!font.widths) {
      units += 600;
    } else if (code >= 32 && code <= 126) {
      units += font.widths[code - 32];
    } else {
      units += 556; // reasonable stand-in for anything outside the table
    }
  }
  return (units / 1000) * size;
}
