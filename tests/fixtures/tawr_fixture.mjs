/**
 * A fillable PDF with the TAWR form's field names, made for the tests.
 *
 * BART's own form is kept out of the repository on purpose — it is uploaded by
 * an administrator into private storage and never published with the site — so
 * the tests build a stand-in with the same field names, kinds and box sizes:
 * single-line boxes eight points high under a nine-point font, the work
 * description a multi-line box under fourteen, checkboxes with Yes and Off
 * appearances, dropdowns with the form's options, two signature fields.
 *
 * Two shapes, because a form arrives in either: `compressed: false` writes a
 * classic cross-reference table (how the template was saved), `true` puts the
 * objects in a compressed object stream behind a cross-reference stream with a
 * PNG predictor (how Acrobat re-saves a file).
 */

import zlib from 'node:zlib';

const DAYS = ['MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT', 'SUN', '  '];
const CATEGORIES = ['A', 'B', 'C', 'F', 'P', 'BL', 'Y', ' '];

const str = (s) => `(${String(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * `fields`: `[{ name, kind }]`, kind text | check | choice | sig. Answers the
 * PDF as a Uint8Array.
 */
export function buildFormPdf(fields, { compressed = false, auto = false, needAppearances = false } = {}) {
  // `auto`: every box, and the form's default, left at font size 0 — "auto".
  const tf = (n) => (auto ? 0 : n);
  const objects = []; // index = object number - 1; { body, stream? }
  const add = (body, stream = null) => { objects.push({ body, stream }); return objects.length; };
  const set = (n, body, stream = null) => { objects[n - 1] = { body, stream }; };

  const catalog = add('');
  const pages = add('');
  const page = add('');
  const helv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const zadb = add('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
  const on = add('<< /BBox [0 0 12 12] /Resources << /Font << /ZaDb 5 0 R >> >> >>', '0 g BT /ZaDb 10 Tf 1 1 Td (4) Tj ET');
  const off = add('<< /BBox [0 0 12 12] >>', '');
  const blankAp = add('<< /BBox [0 0 10 10] >>', '/Tx BMC EMC');

  const annots = [];
  const roots = [];
  let x = 30;
  let y = 760;
  for (const f of fields) {
    const multiline = f.name === 'work_description';
    const w = multiline ? 568 : f.kind === 'check' ? 12 : f.name.endsWith('_date') ? 52 : f.name.includes('time') ? 31 : 160;
    const h = multiline ? 52 : f.kind === 'check' ? 11 : f.kind === 'sig' ? 14 : 8;
    if (x + w > 590) { x = 30; y -= multiline ? 60 : 16; }
    if (multiline && x !== 30) { x = 30; y -= 60; }
    const rect = `[${x} ${y} ${x + w} ${y + h}]`;
    x += w + 8;
    let body;
    if (f.kind === 'text') {
      // BART's date boxes carry Acrobat's own date check, and so do these.
      const aa = f.name.endsWith('_date')
        ? ' /AA << /F << /S /JavaScript /JS (AFDate_FormatEx\\("mm/dd/yyyy"\\);) >> /K << /S /JavaScript /JS (AFDate_KeystrokeEx\\("mm/dd/yyyy"\\);) >> >>'
        : '';
      body = `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${str(f.name)} /Rect ${rect} /P ${page} 0 R /F 4 `
        + `/DA (0 0 0 rg /Helv ${tf(multiline ? 14 : 9)} Tf)${multiline ? ' /Ff 4096' : ''}${aa} /AP << /N ${blankAp} 0 R >> >>`;
    } else if (f.kind === 'check') {
      body = `<< /Type /Annot /Subtype /Widget /FT /Btn /T ${str(f.name)} /Rect ${rect} /P ${page} 0 R /F 4 `
        + `/DA (0 0 1 rg /ZaDb 12 Tf) /V /Off /AS /Off /AP << /N << /Yes ${on} 0 R /Off ${off} 0 R >> >> >>`;
    } else if (f.kind === 'choice') {
      const opts = f.name === 'category_of_work' ? CATEGORIES : DAYS;
      body = `<< /Type /Annot /Subtype /Widget /FT /Ch /T ${str(f.name)} /Rect ${rect} /P ${page} 0 R /F 4 `
        + `/Ff ${f.name === 'category_of_work' ? 393216 : 131072} /Opt [${opts.map(str).join(' ')}] `
        + `/DA (0 0 0 rg /Helv ${tf(f.name === 'category_of_work' ? 12 : 8)} Tf) /V ( ) /AP << /N ${blankAp} 0 R >> >>`;
    } else {
      body = `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${str(f.name)} /Rect ${rect} /P ${page} 0 R /F 4 >>`;
    }
    const n = add(body);
    annots.push(n);
    roots.push(n);
  }

  const contents = add('<< >>', 'BT /Helv 12 Tf 30 780 Td (SYSTEM ACCESS / TRACK ALLOCATION WORK REQUEST FORM) Tj ET');
  const acro = add(`<< /Fields [${roots.map((n) => `${n} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) `
    + `/DR << /Font << /Helv ${helv} 0 R /ZaDb ${zadb} 0 R >> >> /SigFlags 1${needAppearances ? ' /NeedAppearances true' : ''} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R${fields.length ? ` /AcroForm ${acro} 0 R` : ''} >>`);
  set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R `
    + `/Resources << /Font << /Helv ${helv} 0 R >> >>${annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : ''} >>`);

  return compressed ? writeCompressed(objects, catalog) : writeClassic(objects, catalog);
}

function writeClassic(objects, root) {
  const chunks = ['%PDF-1.3\n%\xe2\xe3\xcf\xd3\n'];
  let offset = Buffer.byteLength(chunks[0], 'latin1');
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(offset);
    const text = o.stream != null
      ? `${i + 1} 0 obj\n${o.body.replace(/>>\s*$/, ` /Length ${Buffer.byteLength(o.stream, 'latin1')} >>`)}\nstream\n${o.stream}\nendstream\nendobj\n`
      : `${i + 1} 0 obj\n${o.body}\nendobj\n`;
    chunks.push(text);
    offset += Buffer.byteLength(text, 'latin1');
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  chunks.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(chunks.join(''), 'latin1'));
}

function writeCompressed(objects, root) {
  const header = '%PDF-1.6\n%\xe2\xe3\xcf\xd3\n';
  const parts = [Buffer.from(header, 'latin1')];
  let offset = parts[0].length;
  const entries = new Array(objects.length + 1); // [type, a, b]
  entries[0] = [0, 0, 65535];

  // Streams stay top-level objects; every other object goes into one object stream.
  const inStream = [];
  objects.forEach((o, i) => {
    if (o.stream == null) { inStream.push(i + 1); return; }
    entries[i + 1] = [1, offset, 0];
    const data = zlib.deflateSync(Buffer.from(o.stream, 'latin1'));
    const head = Buffer.from(`${i + 1} 0 obj\n${o.body.replace(/>>\s*$/, ` /Filter /FlateDecode /Length ${data.length} >>`)}\nstream\n`, 'latin1');
    const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
    parts.push(head, data, tail);
    offset += head.length + data.length + tail.length;
  });

  const objStmNum = objects.length + 1;
  let body = '';
  const index = [];
  inStream.forEach((n, i) => {
    index.push(`${n} ${body.length}`);
    body += `${objects[n - 1].body}\n`;
    entries[n] = [2, objStmNum, i];
  });
  const prefix = `${index.join(' ')}\n`;
  const packed = zlib.deflateSync(Buffer.from(prefix + body, 'latin1'));
  entries[objStmNum] = [1, offset, 0];
  const sHead = Buffer.from(`${objStmNum} 0 obj\n<< /Type /ObjStm /N ${inStream.length} /First ${Buffer.byteLength(prefix, 'latin1')} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`, 'latin1');
  const sTail = Buffer.from('\nendstream\nendobj\n', 'latin1');
  parts.push(sHead, packed, sTail);
  offset += sHead.length + packed.length + sTail.length;

  // The cross-reference stream: W [1 4 2], rows PNG-Up predicted, deflated.
  const xrefNum = objStmNum + 1;
  entries[xrefNum] = [1, offset, 0];
  const rowLen = 7;
  const raw = Buffer.alloc(entries.length * rowLen);
  entries.forEach(([t, a, b], i) => {
    raw[i * rowLen] = t;
    raw.writeUInt32BE(a, i * rowLen + 1);
    raw.writeUInt16BE(b, i * rowLen + 5);
  });
  const predicted = Buffer.alloc(entries.length * (rowLen + 1));
  for (let r = 0; r < entries.length; r++) {
    predicted[r * (rowLen + 1)] = 2; // Up
    for (let i = 0; i < rowLen; i++) {
      const up = r ? raw[(r - 1) * rowLen + i] : 0;
      predicted[r * (rowLen + 1) + 1 + i] = (raw[r * rowLen + i] - up) & 0xff;
    }
  }
  const xdata = zlib.deflateSync(predicted);
  const xHead = Buffer.from(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${entries.length} /W [1 4 2] /Root ${root} 0 R `
    + `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${rowLen} >> /Length ${xdata.length} >>\nstream\n`, 'latin1');
  parts.push(xHead, xdata, Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
