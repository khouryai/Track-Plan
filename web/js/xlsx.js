/**
 * Reading the four-week look-ahead.
 *
 * The look-ahead is an Excel workbook the deputy edits in place, and it encodes
 * shift access in **cell fill colour** against a fixed legend. So this is not
 * an importer in the usual sense: the values matter far less than the colours,
 * and almost everything that can go wrong is invisible in a spreadsheet you
 * open by hand.
 *
 * Four rules, each of which exists because of a specific way it breaks:
 *
 * **One sheet, chosen by name.** The workbook is large and the four-week grid
 * is one tab among several. `readXlsx()` in `io/importers.js` takes whichever
 * sheet is first, which would silently read a cover page. A missing sheet is an
 * error here, never a fall back to sheet one.
 *
 * **Visible rows and columns only.** Rows are hidden by hand and by autofilter,
 * both as `hidden="1"`. A hidden *column* matters more than a hidden row: with
 * one column per day, dropping one removes a day from the week and nothing
 * about the result looks wrong.
 *
 * **The real row number travels with the row.** Blank and absent rows mean the
 * nth row in the file is not row n, so an array index is not an identity. Row
 * identity is what change classification rests on.
 *
 * **A colour that is not in the legend is never guessed.** It goes to an
 * unknown bucket for somebody to map. The legend is stable in practice, and
 * relying on that would still be wrong, because the failure is silent and lands
 * in evidence.
 *
 * Copied from cx-timeline (src/io/lookahead.js): Track-Plan imports the
 * 4WLA workbook with it once, into its own look-ahead (`lookahead.js`).
 *
 * Imports: inflate (a leaf).
 */

import { inflateRaw } from './inflate.js';

/* ══════════════════════════════════════════════════════════════════════════
   ZIP
   ═══════════════════════════════════════════════════════════════════════ */

/** Read the container into `name -> Uint8Array`, via the central directory. */
export function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('That file is not a .xlsx (no ZIP directory found).');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // The local header repeats the name and carries its own extra field, whose
    // length routinely differs from the one in the directory.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compressed);
    out.set(name, method === 0 ? raw : inflateRaw(raw));

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function partText(files, name) {
  const part = files.get(name);
  return part ? new TextDecoder().decode(part) : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

/* ══════════════════════════════════════════════════════════════════════════
   Colour
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The legacy 56-entry palette an `indexed="n"` fill refers to.
 *
 * Excel still writes these for anything inherited from an older workbook, so a
 * parser that only understands `rgb=` sees nothing at all on exactly those
 * cells — and a blank cell reads as "no shift booked", which is a different
 * fact entirely.
 */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/** `theme="n"` indexes the scheme with the dark/light pairs swapped. */
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

export function readTheme(xml) {
  const scheme = /<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1] || '';
  const colors = {};
  for (const m of scheme.matchAll(/<a:(\w+)>([\s\S]*?)<\/a:\1>/g)) {
    const [, key, body] = m;
    const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(body)?.[1];
    const sys = /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(body)?.[1];
    if (srgb || sys) colors[key] = (srgb || sys).toUpperCase();
  }
  return THEME_ORDER.map((key) => colors[key] || null);
}

/**
 * Apply an OOXML tint, in HLS as the specification requires.
 *
 * Doing it in RGB gives a near miss, and a near miss against a legend keyed on
 * exact colours is a lookup that fails. Accent 1 at -0.25 has to come out
 * #2F5597 — what Excel calls "Blue, Accent 1, Darker 25%".
 */
export function applyTint(hex, tint) {
  if (!tint) return hex;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let lum = (max + min) / 2;
  let hue = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = lum > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
  }

  lum = tint < 0 ? lum * (1 + tint) : lum * (1 - tint) + tint;
  lum = Math.min(1, Math.max(0, lum));

  const toRgb = (p, q, t) => {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };

  let out;
  if (sat === 0) out = [lum, lum, lum];
  else {
    const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
    const p = 2 * lum - q;
    out = [toRgb(p, q, hue + 1 / 3), toRgb(p, q, hue), toRgb(p, q, hue - 1 / 3)];
  }
  return out.map((v) => Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * `styleIndex -> { hex, source }` for every cell format in the workbook.
 *
 * The chain is `cellXfs[s].fillId -> fills[id].patternFill.fgColor`, and the
 * colour at the end arrives in one of three notations. Resolving all three to
 * one hex is what lets the legend be keyed on the colour rather than on how it
 * happened to be written.
 */
export function readFills(stylesXml, theme) {
  const fillsBlock = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)?.[1] || '';
  const fills = (fillsBlock.match(/<fill>[\s\S]*?<\/fill>/g) || []).map((fill) => {
    const pattern = /patternType="(\w+)"/.exec(fill)?.[1] || 'none';
    if (pattern === 'none') return { hex: null, source: 'none' };

    const fg = /<fgColor([^>]*)\/>/.exec(fill)?.[1] || '';
    const tint = parseFloat(/tint="(-?[\d.]+)"/.exec(fg)?.[1] || '0') || 0;

    const rgb = /rgb="([0-9A-Fa-f]{6,8})"/.exec(fg)?.[1];
    if (rgb) {
      const base = (rgb.length === 8 ? rgb.slice(2) : rgb).toUpperCase();
      return { hex: applyTint(base, tint), source: 'rgb' };
    }

    const themed = /theme="(\d+)"/.exec(fg)?.[1];
    if (themed != null) {
      const base = theme[parseInt(themed, 10)] || null;
      return { hex: base ? applyTint(base, tint) : null, source: `theme:${themed}` };
    }

    const indexed = /indexed="(\d+)"/.exec(fg)?.[1];
    if (indexed != null) {
      const base = INDEXED[parseInt(indexed, 10)] || null;
      return { hex: base ? applyTint(base, tint) : null, source: `indexed:${indexed}` };
    }

    return { hex: null, source: 'unresolved' };
  });

  /* White is not a highlight.
     An explicit white fill and no fill at all are the same thing to anybody
     looking at the sheet — a highlight nobody can see is not one — and Excel
     writes white fills into all sorts of default styling. Reading them as
     colours put hundreds of cells into the unmapped bucket and asked somebody
     to explain the absence of a highlight. */
  const plain = fills.map((f) => (f.hex === 'FFFFFF' ? { hex: null, source: 'none' } : f));

  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || '';
  const xfs = xfsBlock.match(/<xf[\s\S]*?(?:\/>|<\/xf>)/g) || [];
  return xfs.map((xf) => {
    const fillId = parseInt(/fillId="(\d+)"/.exec(xf)?.[1] ?? '0', 10);
    return plain[fillId] || { hex: null, source: 'none' };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   The sheet
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Rows and cells, matched as either a self-closing tag or an open/close pair.
 *
 * The obvious `/<row[\s\S]*?(?:\/>|<\/row>)/` is wrong here, and wrong in a way
 * that only shows up on a sheet like this one. A cell carrying a fill but no
 * value is written `<c r="D2" s="1"/>`, and a lazy match stops at that first
 * `/>` — truncating the row and dropping every cell after it. A workbook full
 * of *values* never hits it, because those cells close with `</c>`. A workbook
 * full of *colours* hits it on nearly every row.
 */
const ROW_RE = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
const CELL_RE = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;

/** 'A' -> 1, 'AA' -> 27. One-based, matching how a spreadsheet talks. */
export function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}


/** Every sheet in the workbook, with its hidden state and its part path. */
export function readSheets(files) {
  const workbook = partText(files, 'xl/workbook.xml');
  const rels = partText(files, 'xl/_rels/workbook.xml.rels');
  const sheets = [];

  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] || '';
    let zipPath = '';
    if (rid) {
      const rel = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels);
      if (rel) {
        const target = rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
        if (files.has(`xl/${target}`)) zipPath = `xl/${target}`;
      }
    }
    sheets.push({
      name: decodeXml(/name="([^"]*)"/.exec(attrs)?.[1] || ''),
      state: /state="(\w+)"/.exec(attrs)?.[1] || 'visible',
      zipPath,
    });
  }
  return sheets;
}

/**
 * Parse one named sheet into a grid of visible cells.
 *
 * Returns `{ sheet, rows, hiddenRows, hiddenColumns, merges, conditional }`.
 * Each row is `{ row, cells: [{ col, ref, value, hex, source }] }` where `row`
 * is the **spreadsheet** row number.
 */
export function parseSheet(buffer, sheetName) {
  const files = readZip(buffer);
  const sheets = readSheets(files);

  const chosen = sheets.find((s) => s.name === sheetName);
  if (!chosen) {
    // Never fall back to the first sheet. Reading a cover page and reporting a
    // week of no work would be worse than reporting nothing at all.
    throw new Error(
      `The workbook has no sheet called "${sheetName}". It has: ${sheets.map((s) => s.name).join(', ')}.`
    );
  }
  if (!chosen.zipPath) throw new Error(`"${sheetName}" has no readable worksheet part.`);
  if (chosen.state !== 'visible') {
    // A hidden sheet under the configured name almost always means the name is
    // stale and the live grid has moved to another tab.
    throw new Error(`"${sheetName}" is hidden in the workbook — check which tab the look-ahead is on now.`);
  }

  const sharedStrings = [];
  for (const si of partText(files, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    sharedStrings.push(parts.map((p) => decodeXml(p.replace(/<[^>]+>/g, ''))).join(''));
  }

  const theme = readTheme(partText(files, 'xl/theme/theme1.xml'));
  const styleFills = readFills(partText(files, 'xl/styles.xml'), theme);
  const xml = new TextDecoder().decode(files.get(chosen.zipPath));

  /* Hidden columns. One column per day, so a hidden one silently removes a day
     from the week — and unlike a missing row, nothing about the result looks
     wrong. */
  const hiddenColumns = new Set();
  const colsBlock = /<cols[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] || '';
  for (const m of colsBlock.matchAll(/<col\b([^>]*)\/?>/g)) {
    if (!/hidden="1"/.test(m[1])) continue;
    const min = parseInt(/min="(\d+)"/.exec(m[1])?.[1] ?? '0', 10);
    const max = parseInt(/max="(\d+)"/.exec(m[1])?.[1] ?? '0', 10);
    for (let c = min; c <= max; c++) hiddenColumns.add(c);
  }

  const merges = [];
  const mergeBlock = /<mergeCells[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml)?.[1] || '';
  for (const m of mergeBlock.matchAll(/<mergeCell[^>]*ref="([^"]+)"/g)) merges.push(m[1]);

  /* Conditional formatting is reported, not evaluated. A colour that comes
     from a rule is not in the cell's style at all, so if the grid is painted
     that way this parser would see an empty sheet — and saying so is the only
     honest thing to do about it. */
  const conditional = [];
  for (const m of xml.matchAll(/<conditionalFormatting[^>]*sqref="([^"]+)"/g)) conditional.push(m[1]);

  const rows = [];
  let hiddenRows = 0;

  for (const rowXml of xml.match(ROW_RE) || []) {
    const head = /<row\b([^>]*)>/.exec(rowXml)?.[1] || rowXml;
    if (/hidden="1"/.test(head)) {
      hiddenRows++;
      continue;
    }
    const rowNumber = parseInt(/\br="(\d+)"/.exec(head)?.[1] ?? '0', 10);

    const cells = [];
    /* Text from *hidden* columns is kept for one narrow purpose and no other:
       the legend key is written in a hidden column beside a row of coloured
       swatches, so dropping it the way every other hidden cell is dropped
       would throw away the one thing that says what the colours mean. It never
       becomes a cell of the grid — only this label. */
    let label = '';

    for (const cellXml of rowXml.match(CELL_RE) || []) {
      const ref = /\br="([A-Z]+)(\d+)"/.exec(cellXml);
      if (!ref) continue;
      const col = colNumber(ref[1]);

      const type = /\bt="([^"]+)"/.exec(cellXml)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        value = (cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
          .map((p) => decodeXml(p.replace(/<[^>]+>/g, ''))).join('');
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
        if (raw != null) value = type === 's' ? (sharedStrings[parseInt(raw, 10)] ?? '') : decodeXml(raw);
      }

      if (hiddenColumns.has(col)) {
        if (!label && String(value).trim()) label = String(value).trim();
        continue;
      }

      const styleIndex = parseInt(/\bs="(\d+)"/.exec(cellXml)?.[1] ?? '-1', 10);
      const fill = styleIndex >= 0 ? styleFills[styleIndex] : null;

      cells.push({
        col,
        ref: `${ref[1]}${ref[2]}`,
        value,
        hex: fill?.hex || null,
        source: fill?.source || 'none',
      });
    }

    // A row with no visible cells at all is not a row of the grid.
    if (cells.length) rows.push({ row: rowNumber, cells, label });
  }

  return {
    sheet: chosen.name,
    sheets: sheets.map((s) => ({ name: s.name, state: s.state })),
    rows,
    hiddenRows,
    hiddenColumns: [...hiddenColumns],
    merges,
    conditional,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   The legend
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The legend the workbook writes down about itself.
 *
 * BART's look-ahead carries its own key: a short block of rows near the bottom
 * where the whole row is painted one colour and a label beside it reads
 * "Highlight in Orange for Swing Shift". That is the authors' own statement of
 * what the colours mean, so reading it is not guessing — it is the one place
 * in this pipeline where a meaning can be taken from the file rather than
 * typed by somebody.
 *
 * It stays deliberately strict. A row qualifies only when every visible cell
 * on it carries the *same* fill and none of them holds a value: a swatch, in
 * other words, and not a row of work that happens to be highlighted. Anything
 * that does not match that shape is simply not returned, and the colours it
 * used go on to the `unknown` bucket to be mapped by hand — which is the same
 * answer this module gives everywhere else it cannot be certain.
 */
export function readLegend(grid) {
  const out = [];
  const seen = new Set();

  for (const row of grid.rows || []) {
    const cells = row.cells || [];
    if (cells.length < 2) continue;
    if (cells.some((c) => String(c.value ?? '').trim())) continue;
    if (cells.some((c) => !c.hex)) continue;
    if (new Set(cells.map((c) => c.hex)).size !== 1) continue;

    const label = String(row.label || '').trim();
    if (!label) continue;

    // "Highlight in Orange for Swing Shift" → "Swing Shift". The colour word
    // in the sentence is thrown away on purpose: the swatch is the colour, and
    // where the two disagree the swatch is the one that was painted.
    const phrased = /^\s*highlight\s+in\s+\S+\s+for\s+(.+?)\s*$/i.exec(label);
    const meaning = (phrased ? phrased[1] : label).trim();
    if (!meaning) continue;

    const argb = cells[0].hex;
    if (seen.has(argb)) continue;
    seen.add(argb);
    out.push({ argb, meaning, row: row.row });
  }

  return out;
}

/**
 * Turn a parsed grid into shifts, against the legend.
 *
 * `legend` is `[{ argb, meaning }]`. A colour that is not in it is collected in
 * `unknown` rather than defaulted to anything — the legend is stable in
 * practice and relying on that would still be wrong, because one stray shade
 * from Excel's recent-colours picker would misclassify a shift with nothing on
 * screen to show it happened, and the result lands in evidence.
 */
/**
 * Whether a cell's fill is dark enough that text on it has to go white.
 *
 * Perceived lightness, not average: the eye weighs green far more than blue,
 * and an average makes BART's mid-blue shifts read as light when the label on
 * them is invisible.
 *
 * Here rather than in the renderer because *two* things draw these cells — the
 * grid on screen and the PDF export — and the moment they answer this
 * differently the printed calendar has white text on a pale cell somewhere,
 * which nobody notices until it is in front of a client.
 */
export function isDark(hex) {
  const n = parseInt(String(hex).slice(-6), 16);
  if (Number.isNaN(n)) return false;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}

/**
 * One entry per colour: the one in force.
 *
 * `rc_legend` is *versioned* — `unique (valid_from, argb)` — so a colour that
 * has been re-mapped has a row per date, and only the newest of them is what it
 * means now. Choosing that has to happen here rather than being left to how the
 * caller sorted its array, and it did not: this was
 *
 *     new Map(legend.map((l) => [l.argb, …]))
 *
 * which silently took whichever row came *last*. `listLegend()` hands them over
 * newest first — its own comment says "a caller taking the first entry for a
 * colour gets the one in force" — so last meant **oldest**, and every correction
 * anybody ever made was discarded in favour of the first thing that colour was
 * ever called.
 *
 * The symptom was the worst kind: pressing "Just shading" on the grey a workbook
 * shades its layout with inserted a row saying `ignore`, the lookup kept reading
 * the older `shift` row, and all those rows stayed on the calendar. And because
 * the older row carries a meaning the colour was no longer *unmapped*, so the
 * button that would have fixed it disappeared. Pressing it again only added
 * another row it would also ignore.
 *
 * A missing `valid_from` sorts oldest, so the shorter `{ argb, meaning, role }`
 * shape the ingest path passes still resolves. A future-dated row wins on the
 * calendar the moment it exists, which is consistent with the legend being
 * re-applied at paint time rather than frozen into a snapshot.
 */
export function inForce(legend) {
  const best = new Map();
  for (const entry of legend || []) {
    const key = String(entry.argb).toUpperCase();
    const held = best.get(key);
    if (held && String(held.valid_from || '') >= String(entry.valid_from || '')) continue;
    best.set(key, {
      valid_from: entry.valid_from || '',
      meaning: entry.meaning,
      role: entry.role || 'shift',
    });
  }
  return best;
}

export function applyLegend(grid, legend) {
  const byColour = inForce(legend);
  const unknown = new Map();

  const rows = grid.rows.map((row) => ({
    row: row.row,
    label: row.label || '',
    // The editor's id for the row, where it published one — see `gridFromModel()`.
    ...(row.id ? { id: row.id } : {}),
    cells: row.cells.map((cell) => {
      if (!cell.hex) return { ...cell, meaning: null, role: null };
      const entry = byColour.get(cell.hex);
      const meaning = entry?.meaning || null;
      if (!meaning) {
        const seen = unknown.get(cell.hex) || { hex: cell.hex, count: 0, samples: [] };
        seen.count++;
        if (seen.samples.length < 4) seen.samples.push(cell.ref);
        unknown.set(cell.hex, seen);
      }
      // An unmapped colour is left as a shift on purpose: it may well be one,
      // and treating the unexplained as ignorable would hide the rows that
      // most need somebody to look at them.
      return { ...cell, meaning, role: entry?.role || 'shift' };
    }),
  }));

  return { ...grid, rows, unknown: [...unknown.values()].sort((a, b) => b.count - a.count) };
}

/**
 * A legend under which only colours categorised as **Work** count.
 *
 * `applyLegend()` treats a colour it has never heard of as a shift, and for the
 * calendar that is right: an unexplained colour might be work, and hiding it
 * would bury the rows that most need looking at. Putting bars on a plan is a
 * different act — a suggestion is a proposal to commit dates, and a proposal
 * from a colour nobody has categorised is a guess. So every fill on the grid
 * that `legend` does not mention is added here as `ignore`, and what reaches
 * `role === 'shift'` is exactly what somebody categorised as Work. A Section
 * band (`divider`) and Shading (`ignore`) are not work either way.
 */
export function workOnlyLegend(grid, legend) {
  const known = inForce(legend);
  const out = [...(legend || [])];
  const added = new Set();
  for (const row of grid?.rows || []) {
    for (const cell of row.cells || []) {
      if (!cell.hex) continue;
      const hex = String(cell.hex).toUpperCase();
      if (known.has(hex) || added.has(hex)) continue;
      added.add(hex);
      out.push({ argb: hex, meaning: '', role: 'ignore' });
    }
  }
  return out;
}

/**
 * The legend a workbook carries with it, for where there is no calendar legend.
 *
 * The workbook's own key ("Highlight in Orange for Swing Shift") names the
 * colours it uses for work, so those start as Work; `choices` — what somebody
 * categorised on this plan, `hex → 'shift' | 'ignore'` — overrides it and adds
 * the colours the key never mentioned.
 */
export function fileLegend(grid, choices = {}) {
  const out = readLegend(grid).map((k) => {
    const hex = String(k.argb).toUpperCase();
    return { argb: hex, meaning: k.meaning, role: choices[hex] || 'shift' };
  });
  for (const [hex, role] of Object.entries(choices || {})) {
    if (!out.some((e) => e.argb === hex)) out.push({ argb: hex, meaning: '', role });
  }
  return out;
}
