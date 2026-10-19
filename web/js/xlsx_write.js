/**
 * Writing an .xlsx: XML parts and a style table built as it is used, packaged
 * by the stored ZIP in `zip.js`.
 *
 * The reading side (`xlsx.js`) has its own ZIP reader, so a workbook never
 * needed a library to open; this is the other direction, for the same reason —
 * no build step, and a spreadsheet is small enough not to need one.
 *
 * Copied from cx-timeline (src/io/xlsx_write.js, the XML, style and package
 * halves; the ZIP half is `zip.js`), with Track Plan as the file's creator.
 *
 * No DOM, so `tests/test_tawr.mjs` writes a workbook and reads it straight back.
 *
 * Imports: nothing.
 */

/* ══════════════════════════════════════════════════════════════════════════
   XML
   ═══════════════════════════════════════════════════════════════════════ */

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry at all; a pasted control character would
    // otherwise make the whole file unreadable.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/* ══════════════════════════════════════════════════════════════════════════
   Styles
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The style table, built from what the sheet asks for.
 *
 * A style is described as `{ bold, size, color, fill, border, h, v, wrap,
 * shrink }` and `id()` returns its index in `cellXfs`, adding it the first time
 * — so the workbook carries exactly the styles its cells use and no more.
 */
export function styleBook({ font = 'Arial', size = 10 } = {}) {
  const fonts = [];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = [];
  const xfs = [];
  const index = new Map();

  const fontId = (s) => {
    const xml = `<font>${s.bold ? '<b/>' : ''}<sz val="${s.size || size}"/>`
      + `<color rgb="FF${s.color || '000000'}"/><name val="${font}"/><family val="2"/></font>`;
    let at = fonts.indexOf(xml);
    if (at < 0) { fonts.push(xml); at = fonts.length - 1; }
    return at;
  };
  const fillId = (hex) => {
    if (!hex) return 0;
    const xml = `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
    let at = fills.indexOf(xml);
    if (at < 0) { fills.push(xml); at = fills.length - 1; }
    return at;
  };
  const borderId = (b = '') => {
    const side = (name) => (b.includes(name[0])
      ? `<${name} style="thin"><color indexed="64"/></${name}>` : `<${name}/>`);
    const xml = `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
    let at = borders.indexOf(xml);
    if (at < 0) { borders.push(xml); at = borders.length - 1; }
    return at;
  };

  // Index 0 is the default every unstyled cell falls back to.
  fontId({});
  borderId('');
  xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');

  function id(s = {}) {
    const key = JSON.stringify(s);
    if (index.has(key)) return index.get(key);
    const align = (s.h || s.v || s.wrap || s.shrink)
      ? `<alignment${s.h ? ` horizontal="${s.h}"` : ''}${s.v ? ` vertical="${s.v}"` : ''}`
        + `${s.wrap ? ' wrapText="1"' : ''}${s.shrink ? ' shrinkToFit="1"' : ''}/>`
      : '';
    const f = fontId(s);
    const fi = fillId(s.fill);
    const b = borderId(s.border);
    xfs.push(`<xf numFmtId="0" fontId="${f}" fillId="${fi}" borderId="${b}" xfId="0"`
      + ` applyFont="1"${fi ? ' applyFill="1"' : ''}${b ? ' applyBorder="1"' : ''}`
      + `${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`);
    index.set(key, xfs.length - 1);
    return xfs.length - 1;
  }

  function xml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
      + `<fills count="${fills.length}">${fills.join('')}</fills>`
      + `<borders count="${borders.length}">${borders.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }

  return { id, xml };
}

/* ══════════════════════════════════════════════════════════════════════════
   A workbook of one sheet
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The package around one worksheet: content types, relationships, the
 * workbook part (with its print titles) and a minimal core-properties part.
 */
/**
 * A name Excel will open a sheet under. It refuses a workbook whose sheet is
 * named with `[ ] : * ? / \`, starts or ends with an apostrophe, or runs past
 * 31 characters — "We found a problem with some content" — and the name here
 * is an administrator's setting (`lookahead_sheet`), free text, so
 * "4WLA 10/12" or a long revision title made a file nobody could open.
 */
export function sheetNameFor(name) {
  const clean = String(name ?? '').replace(/[[\]:*?/\\]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^'+|'+$/g, '').slice(0, 31).trim();
  return clean || 'Sheet1';
}

export function workbookParts({ sheetName, sheetXml, stylesXml, printTitles = null, title = '' }) {
  const name = xmlEscape(sheetNameFor(sheetName));
  const defined = printTitles
    ? `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${name.replace(/'/g, "''")}'!${printTitles}</definedName></definedNames>`
    : '';
  return [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>Track Plan</dc:creator>`
        + '</cp:coreProperties>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000"/></bookViews>'
        + `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>${defined}`
        + '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>',
    },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
}
