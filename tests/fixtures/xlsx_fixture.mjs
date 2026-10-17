#!/usr/bin/env node
/**
 * Build a .xlsx in memory, for testing the look-ahead parser.
 *
 * The look-ahead encodes shift access in cell fill colour, and the four ways
 * that can go wrong are all invisible in a spreadsheet you open by hand: a
 * theme colour looks identical to a literal one, a hidden column looks like no
 * column at all, and conditional formatting looks exactly like a fill. So the
 * fixtures have to be *built*, with each case put there deliberately, rather
 * than found.
 *
 * `buildWorkbook()` returns a Buffer. Nothing here is imported by the
 * application; it exists so `tools/lookahead_probe.js` and the parser tests
 * have something known to read.
 *
 * Usage:  node tools/fixtures/xlsx_fixture.js [out.xlsx]
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ══════════════════════════════════════════════════════════════════════════
   ZIP writing
   ═══════════════════════════════════════════════════════════════════════ */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());

  c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer, store?: boolean}>} entries
 */
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    // One entry is deliberately stored rather than deflated, so the reader's
    // method-0 path is exercised too.
    const deflated = entry.store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = entry.store ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);       // time
    local.writeUInt16LE(0x21, 12);    // date — a fixed one, so output is stable
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 30);         // extra + comment lengths
    dir.writeUInt32LE(0, 34);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ══════════════════════════════════════════════════════════════════════════
   Workbook parts
   ═══════════════════════════════════════════════════════════════════════ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/**
 * Three sheets, and the order matters: the one that carries the data is
 * deliberately **not** first, and one of the others is hidden. A parser that
 * silently takes sheet one would pass every test against a one-sheet fixture
 * and fail on the real file.
 */
const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Cover" sheetId="1" r:id="rId1"/>
<sheet name="4WLA" sheetId="2" r:id="rId2"/>
<sheet name="Old Data" sheetId="3" state="hidden" r:id="rId3"/>
</sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;

/**
 * Fill 2 is a literal RGB, 5 is a theme colour with a tint, and 6 is a legacy
 * indexed one. All three are yellow-ish on screen and all three are read
 * completely differently — which is the point.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0070C0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor theme="4" tint="-0.249977111117893"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor indexed="13"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1"/>
</cellXfs>
</styleSheet>`;

const THEME = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
</a:themeElements>
</a:theme>`;

const STRINGS = [
  'Location', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri',
  'TPSS 12', 'TPSS-12', 'Traction Power 14', 'Station 6 Platform',
  'ARCHIVED — do not use', 'EIC', 'WIT', 'Cover sheet',
];

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${STRINGS.length}" uniqueCount="${STRINGS.length}">
${STRINGS.map((s) => `<si><t>${s}</t></si>`).join('\n')}
</sst>`;

const str = (value) => STRINGS.indexOf(value);

/** A cell holding a shared string. */
const sc = (ref, value, style = 0) => `<c r="${ref}" s="${style}" t="s"><v>${str(value)}</v></c>`;
/** An empty cell that exists only to carry a fill. */
const fc = (ref, style) => `<c r="${ref}" s="${style}"/>`;

/**
 * The data sheet. Deliberately contains, in order:
 *   row 1  header
 *   row 2  a normal row, literal-RGB fills
 *   row 3  HIDDEN — an old row someone filtered out
 *   row 4  (absent entirely — a gap in the row numbering)
 *   row 5  a blank spacer row with no cells at all
 *   row 6  a normal row, theme and indexed fills
 *   row 7  HIDDEN
 *   row 8  a normal row with a merged shift across Tue–Thu
 * Column D is hidden, so Wed disappears from the visible grid.
 */
const SHEET_DATA = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F8"/>
<cols>
<col min="1" max="1" width="24" customWidth="1"/>
<col min="4" max="4" width="9" hidden="1" customWidth="1"/>
</cols>
<sheetData>
<row r="1">${sc('A1', 'Location')}${sc('B1', 'Mon')}${sc('C1', 'Tue')}${sc('D1', 'Wed')}${sc('E1', 'Thu')}${sc('F1', 'Fri')}</row>
<row r="2">${sc('A2', 'TPSS 12')}${fc('B2', 1)}${fc('C2', 1)}${fc('D2', 2)}${fc('E2', 3)}${sc('F2', 'EIC')}</row>
<row r="3" hidden="1">${sc('A3', 'ARCHIVED — do not use')}${fc('B3', 1)}${fc('C3', 1)}</row>
<row r="5"/>
<row r="6">${sc('A6', 'Traction Power 14')}${fc('B6', 4)}${fc('C6', 5)}${fc('D6', 1)}${fc('E6', 2)}${sc('F6', 'WIT')}</row>
<row r="7" hidden="1">${sc('A7', 'TPSS-12')}${fc('B7', 3)}</row>
<row r="8">${sc('A8', 'Station 6 Platform')}${fc('B8', 0)}${fc('C8', 1)}${fc('D8', 1)}${fc('E8', 1)}${fc('F8', 0)}</row>
</sheetData>
<mergeCells count="1"><mergeCell ref="C8:E8"/></mergeCells>
</worksheet>`;

/**
 * The first sheet, and deliberately not just a title.
 *
 * Row 2 is a value cell followed by three *fill-only* cells and then another
 * value. Cells with no value are self-closing (`<c r="C2" s="1"/>`), which is
 * what breaks a lazy `<row …>` match — it stops at the first `/>` and drops
 * everything after it. `readXlsx()` reads whichever sheet is first, so the case
 * has to be here for that reader to be exercised at all.
 */
const SHEET_COVER = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1">${sc('A1', 'Cover sheet')}</row>
<row r="2">${sc('A2', 'TPSS 12')}${fc('B2', 1)}${fc('C2', 1)}${fc('D2', 2)}${fc('E2', 3)}${sc('F2', 'EIC')}</row>
</sheetData>
</worksheet>`;

const SHEET_HIDDEN = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1">${sc('A1', 'ARCHIVED — do not use')}</row></sheetData>
</worksheet>`;

/**
 * @param {{conditionalFormatting?: boolean}} [opts]
 *   `conditionalFormatting` adds a CF block to the data sheet, so the probe's
 *   detection of the case that would change the design can itself be tested.
 */
export function buildWorkbook(opts = {}) {
  let data = SHEET_DATA;
  if (opts.conditionalFormatting) {
    data = data.replace(
      '</sheetData>',
      '</sheetData>\n<conditionalFormatting sqref="B2:F8">'
        + '<cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>"X"</formula></cfRule>'
        + '</conditionalFormatting>'
    );
  }

  const b = (s) => Buffer.from(s, 'utf8');
  return writeZip([
    { name: '[Content_Types].xml', data: b(CONTENT_TYPES) },
    { name: '_rels/.rels', data: b(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: b(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', data: b(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: b(SHEET_COVER) },
    { name: 'xl/worksheets/sheet2.xml', data: b(data) },
    // Stored rather than deflated, so the reader's method-0 path is covered.
    { name: 'xl/worksheets/sheet3.xml', data: b(SHEET_HIDDEN), store: true },
    { name: 'xl/styles.xml', data: b(STYLES) },
    { name: 'xl/sharedStrings.xml', data: b(SHARED_STRINGS) },
    { name: 'xl/theme/theme1.xml', data: b(THEME) },
  ]);
}

/** What the fixture asserts about itself, so tests do not restate it. */
export const EXPECTED = {
  sheets: ['Cover', '4WLA', 'Old Data'],
  hiddenSheet: 'Old Data',
  dataSheet: '4WLA',
  dataSheetIsFirst: false,
  rows: { total: 7, visible: 5, hidden: 2 },
  hiddenColumns: [4],
  merges: ['C8:E8'],
  /**
   * Real row numbers. Note 4 is absent and 5 is blank, so the nth row in the
   * XML is not row n — which is exactly the trap a parser keyed on array
   * position falls into.
   */
  rowNumbers: [1, 2, 3, 5, 6, 7, 8],
  /** Visible, filled cells: yellow x4, red, blue, theme, indexed. */
  visibleFilledCells: 8,
  distinctVisibleColours: 4,
};

/* ══════════════════════════════════════════════════════════════════════════
   A look-ahead with a calendar on it
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * A small four-week look-ahead the way the real one is laid out: a month band,
 * day numbers and weekday letters across the top, the description and the
 * location to their left, a Resource row under an activity, grey shading on
 * the calendar that is layout rather than work, and the workbook's own key —
 * a swatch row whose label sits in a hidden column.
 *
 * Fourteen days from Monday 7 September 2026. `shift` moves the first run of
 * "IXL Regression" later by that many days, which is what a re-read of next
 * week's file looks like to the timeline's suggestions.
 *
 * The key names yellow (Day Shift) and orange (Swing Shift); the grey is in no
 * key. What it should read as with the grey categorised as Work, and without:
 *
 *   IXL Regression   Mon–Wed of week one, Mon–Tue of week two   2 runs
 *   Cable pull       Thu–Fri of week one, swing shift            1 run
 *   Only shading     grey Mon–Fri                                1 run, or none
 */
export function buildLookaheadWorkbook({ shift = 0 } = {}) {
  const COLS = 'CDEFGHIJKLMNOP'.split('');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const str = (ref, v, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t>${esc(v)}</t></is></c>`;
  const num = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  const fill = (ref, style) => `<c r="${ref}" s="${style}"/>`;
  const YELLOW = 1;
  const GREY = 2;
  const ORANGE = 3;

  const days = (row, marks) => marks.map(([i, style, text]) =>
    (text ? str(`${COLS[i]}${row}`, text, style) : fill(`${COLS[i]}${row}`, style))).join('');

  const letters = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
  const firstRun = [0, 1, 2].map((i) => i + shift);

  const rows = [
    `<row r="1">${str('C1', 'SEPTEMBER')}</row>`,
    `<row r="2">${COLS.map((c, i) => num(`${c}2`, 7 + i)).join('')}</row>`,
    `<row r="3">${str('A3', 'Description of Work')}${str('B3', 'Location')}${COLS.map((c, i) => str(`${c}3`, letters[i % 7])).join('')}</row>`,
    `<row r="4">${str('A4', 'IXL Regression')}${str('B4', 'TPSS 12')}${days(4, [
      ...firstRun.map((i) => [i, YELLOW]), [5, GREY], [6, GREY], [7, YELLOW], [8, YELLOW],
    ].filter(([i], n, all) => all.findIndex(([j]) => j === i) === n).sort((a, b) => a[0] - b[0]))}</row>`,
    `<row r="5">${str('A5', 'Resource')}${days(5, [[firstRun[0], 0, 'Victor, Rosa'], [firstRun[1], 0, 'Victor']])}</row>`,
    `<row r="6">${str('A6', 'Cable pull')}${str('B6', 'Yard 3')}${days(6, [[3, ORANGE], [4, ORANGE]])}</row>`,
    `<row r="7">${str('A7', 'Only shading')}${str('B7', 'Yard 3')}${days(7, [0, 1, 2, 3, 4].map((i) => [i, GREY]))}</row>`,
    `<row r="9">${days(9, [0, 1, 2, 3].map((i) => [i, ORANGE]))}${str('Q9', 'Highlight in Orange for Swing Shift')}</row>`,
    `<row r="10">${days(10, [0, 1, 2, 3].map((i) => [i, YELLOW]))}${str('Q10', 'Highlight in Yellow for Day Shift')}</row>`,
  ];

  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="17" max="17" width="30" hidden="1" customWidth="1"/></cols>
<sheetData>
${rows.join('\n')}
</sheetData>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/></patternFill></fill>
</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
</cellXfs>
</styleSheet>`;

  const b = (x) => Buffer.from(x, 'utf8');
  return writeZip([
    { name: '[Content_Types].xml', data: b(CONTENT_TYPES) },
    { name: '_rels/.rels', data: b(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: b(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Cover" sheetId="1" r:id="rId1"/>
<sheet name="4WLA Sept" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: b(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: b(SHEET_COVER) },
    { name: 'xl/worksheets/sheet2.xml', data: b(sheet) },
    { name: 'xl/styles.xml', data: b(styles) },
    { name: 'xl/sharedStrings.xml', data: b(SHARED_STRINGS) },
    { name: 'xl/theme/theme1.xml', data: b(THEME) },
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'lookahead-sample.xlsx';
  fs.writeFileSync(out, buildWorkbook({ conditionalFormatting: process.argv.includes('--cf') }));
  console.log(`wrote ${out}`);
}
