/**
 * Filling BART's TAWR form — a fillable PDF, read and written here.
 *
 * Why by hand, like `io/pdf.js`: the job is narrow. Find the form's fields by
 * name, give each a value and an appearance, draw one signature, and leave the
 * rest of the file exactly as it was. That is a PDF reader good enough to walk
 * the cross-reference and the field tree, and an *incremental update*: the
 * changed objects appended after the original bytes, with a new
 * cross-reference pointing at them. The original is never rewritten, so the
 * form stays a form — fillable in Acrobat afterwards, its two signature boxes
 * still signable — and nothing a library would have to bring with it is in the
 * calendar's bundle.
 *
 * **Every value gets its own appearance.** A field's value and what it looks
 * like are separate in a PDF, and a viewer that does not rebuild appearances
 * (most of them, and every printer) shows only the second. So each filled text
 * box is drawn here, at the size that fits it: a single line shrinks until it
 * fits across and down its box, the work description wraps and shrinks until
 * every line fits. What still does not fit at the smallest legible size is
 * reported, so the review can say so instead of the form quietly losing words.
 *
 * Reads both shapes a form arrives in: a classic cross-reference table (how
 * the template was saved) and cross-reference and object streams (how Acrobat
 * re-saves one). An encrypted file is refused with a reason.
 *
 * No DOM, so `tools/test_tawr.js` fills a form and reads it back in Node.
 *
 * Copied from cx-timeline (src/io/tawr_pdf.js) unchanged but for the import
 * of `textWidth`, which lives in `pdf_metrics.js` here.
 *
 * Imports: inflate, pdf_metrics.
 */

import { inflateRaw } from './inflate.js';
import { textWidth } from './pdf_metrics.js';

/* ══════════════════════════════════════════════════════════════════════════
   Reading objects
   ═══════════════════════════════════════════════════════════════════════ */

/*
 * Values, as this module holds them:
 *   number, true/false, null      as themselves
 *   name   /Helv                  { n: 'Helv' }
 *   string (text) or <hex>        { s: '…' } — one char per byte
 *   array                         [ … ]
 *   dict                          { d: { Key: value } }
 *   reference 12 0 R              { r: 12, g: 0 }
 *   stream                        { d: {…}, stream: Uint8Array } (raw bytes)
 */

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function latin1(bytes, from = 0, to = bytes.length) {
  let out = '';
  for (let i = from; i < to; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 8192)));
  }
  return out;
}

function bytesOf(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

class Lexer {
  constructor(bytes, pos = 0) {
    this.b = bytes;
    this.pos = pos;
  }

  skip() {
    const b = this.b;
    for (;;) {
      while (this.pos < b.length && WS.has(b[this.pos])) this.pos++;
      if (b[this.pos] === 37) { // % comment, to end of line
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      return;
    }
  }

  /** The next bare word or number, without consuming it. */
  peekWord() {
    const save = this.pos;
    this.skip();
    const w = this.word();
    this.pos = save;
    return w;
  }

  word() {
    const b = this.b;
    const start = this.pos;
    while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    return latin1(b, start, this.pos);
  }

  value() {
    this.skip();
    const b = this.b;
    const c = b[this.pos];
    if (c === 47) { // /Name
      this.pos++;
      const raw = this.word();
      return { n: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 40) return { s: this.literal() };
    if (c === 60 && b[this.pos + 1] === 60) {
      this.pos += 2;
      const d = {};
      for (;;) {
        this.skip();
        if (b[this.pos] === 62 && b[this.pos + 1] === 62) { this.pos += 2; break; }
        if (this.pos >= b.length) throw new Error('This PDF is damaged: a dictionary never ends.');
        const key = this.value();
        if (!key || key.n === undefined) throw new Error('This PDF is damaged: a dictionary key is not a name.');
        d[key.n] = this.value();
      }
      return { d };
    }
    if (c === 60) { // <hex>
      this.pos++;
      let hex = '';
      while (this.pos < b.length && b[this.pos] !== 62) {
        const ch = String.fromCharCode(b[this.pos++]);
        if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      }
      this.pos++;
      if (hex.length % 2) hex += '0';
      let s = '';
      for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return { s };
    }
    if (c === 91) {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (b[this.pos] === 93) { this.pos++; break; }
        if (this.pos >= b.length) throw new Error('This PDF is damaged: an array never ends.');
        arr.push(this.value());
      }
      return arr;
    }
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      // "12 0 R" is a reference: two integers and the letter R.
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        this.skip();
        const g = this.word();
        if (/^\d+$/.test(g)) {
          this.skip();
          if (this.b[this.pos] === 82 && (this.pos + 1 >= this.b.length || WS.has(this.b[this.pos + 1]) || DELIM.has(this.b[this.pos + 1]))) {
            this.pos++;
            return { r: n, g: Number(g) };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (!w) throw new Error(`This PDF is damaged: unexpected byte ${c} at ${this.pos}.`);
    return { op: w };
  }

  literal() {
    const b = this.b;
    this.pos++;
    let depth = 1;
    let out = '';
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) { // backslash
        const e = b[this.pos++];
        const map = { 110: '\n', 114: '\r', 116: '\t', 98: '\b', 102: '\f', 40: '(', 41: ')', 92: '\\' };
        if (map[e] !== undefined) out += map[e];
        else if (e >= 48 && e <= 55) {
          let oct = String.fromCharCode(e);
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) oct += String.fromCharCode(b[this.pos++]);
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (e === 13) { if (b[this.pos] === 10) this.pos++; } // line continuation
        else if (e === 10) { /* line continuation */ } else out += String.fromCharCode(e);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }
}

/* ── Streams ───────────────────────────────────────────────────────────── */

function zlibInflate(data) {
  // A zlib stream is a two-byte header, raw DEFLATE, and a checksum the
  // inflater stops before reaching.
  return inflateRaw(data.subarray(2));
}

function unpredict(data, parms) {
  const predictor = parms?.Predictor || 1;
  if (predictor < 10) return data;
  const colors = parms.Colors || 1;
  const bpc = parms.BitsPerComponent || 8;
  const columns = parms.Columns || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   The document
   ═══════════════════════════════════════════════════════════════════════ */

class Doc {
  constructor(bytes) {
    this.bytes = bytes;
    this.entries = new Map(); // num → { type: 1, offset, gen } | { type: 2, stm, idx }
    this.cache = new Map();
    this.objStreams = new Map();
    const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
    if (!/%PDF-\d/.test(head)) throw new Error('That file is not a PDF.');
    const tail = latin1(bytes, Math.max(0, bytes.length - 2048));
    const at = tail.lastIndexOf('startxref');
    if (at < 0) throw new Error('This PDF is damaged: it has no cross-reference.');
    this.startxref = Number(tail.slice(at + 9).trim().split(/\s+/)[0]);
    this.trailer = null;
    this.xrefIsStream = false;
    const seen = new Set();
    let offset = this.startxref;
    let first = true;
    while (Number.isFinite(offset) && !seen.has(offset)) {
      seen.add(offset);
      const t = this.readXref(offset, first);
      if (first) this.trailer = t;
      first = false;
      if (t.d.XRefStm != null) this.readXref(t.d.XRefStm, false);
      offset = t.d.Prev;
    }
    if (!this.trailer) throw new Error('This PDF is damaged: it has no trailer.');
    if (this.trailer.d.Encrypt) {
      throw new Error('This PDF is password-protected or encrypted. Save a copy without security in Acrobat and upload that.');
    }
  }

  setEntry(num, entry) {
    if (!this.entries.has(num)) this.entries.set(num, entry);
  }

  readXref(offset, first) {
    const lx = new Lexer(this.bytes, offset);
    lx.skip();
    if (lx.peekWord() === 'xref') {
      lx.word();
      for (;;) {
        lx.skip();
        const w = lx.peekWord();
        if (w === 'trailer') { lx.word(); break; }
        const start = Number(lx.word());
        lx.skip();
        const count = Number(lx.word());
        if (!Number.isFinite(start) || !Number.isFinite(count)) throw new Error('This PDF is damaged: its cross-reference table cannot be read.');
        for (let i = 0; i < count; i++) {
          lx.skip();
          const off = Number(lx.word()); lx.skip();
          const gen = Number(lx.word()); lx.skip();
          const kind = lx.word();
          if (kind === 'n' && off > 0) this.setEntry(start + i, { type: 1, offset: off, gen });
          else this.setEntry(start + i, { type: 0 });
        }
      }
      return lx.value();
    }
    // A cross-reference stream: "N G obj << /Type /XRef … >> stream".
    const obj = this.parseIndirectAt(offset);
    if (obj?.d?.Type?.n !== 'XRef') throw new Error('This PDF is damaged: its cross-reference cannot be found.');
    if (first) this.xrefIsStream = true;
    const data = this.decode(obj);
    const W = obj.d.W;
    const index = obj.d.Index || [0, obj.d.Size];
    const width = W[0] + W[1] + W[2];
    let p = 0;
    const field = (n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + data[p++]; return v; };
    for (let s = 0; s < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++) {
        if (p + width > data.length) break;
        const type = W[0] ? field(W[0]) : 1;
        const a = field(W[1]);
        const b = field(W[2]);
        const num = index[s] + i;
        if (type === 1) this.setEntry(num, { type: 1, offset: a, gen: b });
        else if (type === 2) this.setEntry(num, { type: 2, stm: a, idx: b });
        else this.setEntry(num, { type: 0 });
      }
    }
    return obj;
  }

  parseIndirectAt(offset) {
    const lx = new Lexer(this.bytes, offset);
    lx.skip(); lx.word(); lx.skip(); lx.word(); lx.skip();
    const kw = lx.word();
    if (kw !== 'obj') throw new Error(`This PDF is damaged: no object at offset ${offset}.`);
    const value = lx.value();
    lx.skip();
    if (value && value.d && lx.peekWord() === 'stream') {
      lx.word();
      if (this.bytes[lx.pos] === 13) lx.pos++;
      if (this.bytes[lx.pos] === 10) lx.pos++;
      let length = value.d.Length;
      if (length && length.r !== undefined) length = this.get(length);
      if (!Number.isFinite(length)) {
        // A length nobody wrote: find the end marker instead.
        const rest = latin1(this.bytes, lx.pos, Math.min(this.bytes.length, lx.pos + 10_000_000));
        length = rest.indexOf('endstream');
        while (length > 0 && /[\r\n]/.test(rest[length - 1])) length--;
      }
      return { d: value.d, stream: this.bytes.subarray(lx.pos, lx.pos + length) };
    }
    return value;
  }

  /** The object a reference points at, or the value itself if it is not one. */
  get(ref) {
    if (!ref || ref.r === undefined) return ref;
    if (this.cache.has(ref.r)) return this.cache.get(ref.r);
    const entry = this.entries.get(ref.r);
    let value = null;
    if (entry?.type === 1) value = this.parseIndirectAt(entry.offset);
    else if (entry?.type === 2) value = this.fromObjStream(entry.stm, entry.idx, ref.r);
    this.cache.set(ref.r, value);
    return value;
  }

  fromObjStream(stmNum, idx, num) {
    let held = this.objStreams.get(stmNum);
    if (!held) {
      const stm = this.get({ r: stmNum, g: 0 });
      const data = this.decode(stm);
      const lx = new Lexer(data, 0);
      const offsets = new Map();
      for (let i = 0; i < stm.d.N; i++) {
        const n = lx.value();
        const off = lx.value();
        offsets.set(n, off);
      }
      held = { data, first: stm.d.First, offsets };
      this.objStreams.set(stmNum, held);
    }
    const off = held.offsets.get(num);
    if (off === undefined) return null;
    return new Lexer(held.data, held.first + off).value();
  }

  decode(stream) {
    let data = stream.stream;
    const filters = [].concat(stream.d.Filter || []).map((f) => f.n);
    const parms = [].concat(stream.d.DecodeParms || []);
    filters.forEach((f, i) => {
      if (f !== 'FlateDecode') throw new Error(`This PDF uses a compression this form filler does not read (${f}).`);
      data = unpredict(zlibInflate(data), this.get(parms[i])?.d);
    });
    return data;
  }

  size() {
    return Math.max(Number(this.trailer.d.Size) || 0, ...[...this.entries.keys()].map((n) => n + 1));
  }
}

/* ── Text strings ──────────────────────────────────────────────────────── */

/** A PDF text string, as text: UTF-16 where it says so, else one byte per character. */
function textOf(value) {
  if (value == null) return null;
  if (value.n !== undefined) return value.n;
  if (value.s === undefined) return null;
  const s = value.s;
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  return s;
}

/** Text as a PDF string: plain where it is plain, UTF-16 with a byte-order mark where not. */
function pdfText(text) {
  const t = String(text ?? '');
  if (/^[\x20-\x7e\n\r\t]*$/.test(t)) return { s: t };
  let s = '\xfe\xff';
  for (const ch of t) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10); const lo = 0xdc00 + (v & 0x3ff);
      s += String.fromCharCode(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
    } else s += String.fromCharCode(code >> 8, code & 0xff);
  }
  return { s };
}

/* ══════════════════════════════════════════════════════════════════════════
   The form
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Which version of this filler wrote a PDF — stamped into every form it fills
 * (`/TrackPlanFiller` on the AcroForm) and shown in TAWR → Setup, so a download
 * that looks wrong can be traced to the code that made it. Raise it whenever
 * what this module writes changes.
 */
export const FILLER_VERSION = 5;

const KIND = { Tx: 'text', Btn: 'check', Ch: 'choice', Sig: 'sig' };

/**
 * The date format a field's own script insists on — `AFDate_FormatEx("mm/dd/yyyy")`
 * on BART's date boxes — or null.
 *
 * Acrobat runs that script whenever it shows the field, and a value it cannot
 * read as a date in that format is shown as *nothing*: "10/19/26" in an
 * mm/dd/yyyy box was a blank date until somebody clicked into it. So a date is
 * written the way the box asks for it.
 */
function dateFormatOf(doc, aaRef) {
  const aa = doc.get(aaRef);
  const action = doc.get(aa?.d?.F);
  let js = doc.get(action?.d?.JS);
  if (js?.stream) js = { s: latin1(doc.decode(js)) };
  const text = textOf(js) || '';
  return (text.match(/AFDate_FormatEx\(\s*"([^"]+)"\s*\)/) || [])[1] || null;
}

/**
 * A date written as "10/19/26", "10/19/2026" or "2026-10-19", in a format
 * spelled the Acrobat way (mm, m, dd, d, yyyy, yy). Anything that is not a
 * date is left exactly as it was typed.
 */
export function formatDateAs(value, format) {
  const t = String(value ?? '').trim();
  let y; let m; let d;
  let hit = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (hit) [, y, m, d] = hit.map(Number);
  else if ((hit = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    [, m, d, y] = hit.map(Number);
    if (hit[3].length === 2) y += 2000;
  } else return t;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return format.replace(/yyyy|yy|mm|m|dd|d/g, (tok) => ({
    yyyy: String(y), yy: pad(y % 100), mm: pad(m), m: String(m), dd: pad(d), d: String(d),
  })[tok]);
}

function walkFields(doc) {
  const catalog = doc.get(doc.trailer.d.Root);
  const acro = doc.get(catalog?.d?.AcroForm);
  const out = [];
  if (!acro?.d?.Fields) return { acro: null, fields: out, catalog };

  // Which page each widget sits on, for widgets that do not say.
  const pageOf = new Map();
  const pages = [];
  const visit = (ref, depth = 0) => {
    const node = doc.get(ref);
    if (!node?.d || depth > 50) return;
    if (node.d.Type?.n === 'Pages' || node.d.Kids) {
      for (const kid of doc.get(node.d.Kids) || []) visit(kid, depth + 1);
      return;
    }
    pages.push(ref);
    for (const a of doc.get(node.d.Annots) || []) if (a?.r !== undefined) pageOf.set(a.r, ref);
  };
  visit(catalog.d.Pages);

  const walk = (ref, parentName, inherited, depth = 0) => {
    const node = doc.get(ref);
    if (!node?.d || depth > 50) return;
    const d = node.d;
    const partial = textOf(d.T);
    const name = partial == null ? parentName : (parentName ? `${parentName}.${partial}` : partial);
    const inh = {
      FT: d.FT || inherited.FT, Ff: d.Ff ?? inherited.Ff, DA: d.DA || inherited.DA,
      Q: d.Q ?? inherited.Q, Opt: d.Opt || inherited.Opt, V: d.V !== undefined ? d.V : inherited.V,
      MaxLen: d.MaxLen ?? inherited.MaxLen,
    };
    const kids = (doc.get(d.Kids) || []).filter((k) => k?.r !== undefined);
    const kidFields = kids.filter((k) => doc.get(k)?.d?.T !== undefined);
    if (kidFields.length) {
      for (const k of kids) walk(k, name, inh, depth + 1);
      return;
    }
    // A terminal field: itself a widget, or the parent of widgets with no names.
    const widgets = kids.length ? kids : [ref];
    const ff = Number(doc.get(inh.Ff) || 0);
    let kind = KIND[inh.FT?.n] || 'other';
    if (kind === 'check' && ff & (1 << 16)) kind = 'button';
    if (kind === 'check' && ff & (1 << 15)) kind = 'radio';
    const first = doc.get(widgets[0]);
    const onStates = new Set();
    for (const w of widgets) {
      const n = doc.get(doc.get(doc.get(w)?.d?.AP)?.d?.N);
      for (const key of Object.keys(n?.d || {})) if (key !== 'Off') onStates.add(key);
    }
    const options = (doc.get(inh.Opt) || []).map((o) => {
      const v = doc.get(o);
      return Array.isArray(v) ? textOf(doc.get(v[1])) : textOf(v);
    }).filter((o) => o != null);
    out.push({
      name,
      kind,
      ref,
      value: textOf(doc.get(inh.V)),
      onState: [...onStates][0] || null,
      options,
      multiline: kind === 'text' && Boolean(ff & (1 << 12)),
      da: textOf(doc.get(inh.DA)) || textOf(doc.get(acro.d.DA)) || '/Helv 9 Tf 0 g',
      q: Number(doc.get(inh.Q) || 0),
      widgets: widgets.map((w) => ({
        ref: w,
        // A box may state its own size apart from its field — Acrobat splits
        // them when a form is edited — and the box's own word wins.
        da: textOf(doc.get(doc.get(w)?.d?.DA)) || null,
        rect: (doc.get(doc.get(w)?.d?.Rect) || [0, 0, 0, 0]).map((x) => Number(doc.get(x))),
        page: doc.get(w)?.d?.P || pageOf.get(w.r) || null,
      })),
      readOnly: Boolean(ff & 1),
      dateFormat: dateFormatOf(doc, d.AA || first?.d?.AA),
      rect: (doc.get(first?.d?.Rect) || [0, 0, 0, 0]).map((x) => Number(doc.get(x))),
    });
  };
  for (const f of doc.get(acro.d.Fields) || []) walk(f, '', {});
  return { acro, fields: out, catalog, pages };
}

/**
 * The fields of a fillable PDF: `{ fields: [{ name, kind, value, onState,
 * options, multiline, rect }] }`. Throws, with a sentence somebody can act on,
 * for a file that is not a PDF, is damaged, or is encrypted.
 */
export function readForm(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = new Doc(data);
  const { fields, acro } = walkFields(doc);
  return {
    filler: textOf(doc.get(acro?.d?.TrackPlanFiller)) || null,
    needAppearances: doc.get(acro?.d?.NeedAppearances) === true,
    fields: fields.map(({ name, kind, value, onState, options, multiline, rect, da, widgets }) => ({
      name, kind, value, onState, options, multiline, rect, da,
      // The size each of its boxes says it is, where a box says one of its own.
      widgetDa: widgets.map((w) => w.da),
    })),
  };
}

/** The names asked for that the form does not have. */
export function missingFields(form, names) {
  const have = new Set((form?.fields || []).map((f) => f.name));
  return names.filter((n) => !have.has(n));
}

/* ══════════════════════════════════════════════════════════════════════════
   Writing
   ═══════════════════════════════════════════════════════════════════════ */

function num(n) {
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 10000) / 10000).toFixed(4).replace(/\.?0+$/, '');
}

function nameOut(n) {
  return `/${String(n).replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
}

function stringOut(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = '';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(2, '0');
  return `<${hex}>`;
}

function serialize(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return `[${v.map(serialize).join(' ')}]`;
  if (v.r !== undefined) return `${v.r} ${v.g || 0} R`;
  if (v.n !== undefined) return nameOut(v.n);
  if (v.s !== undefined) return stringOut(v.s);
  if (v.d) return `<<${Object.entries(v.d).map(([k, x]) => `${nameOut(k)} ${serialize(x)}`).join(' ')}>>`;
  if (v.op) return v.op;
  return 'null';
}

/* ── Fonts and text ────────────────────────────────────────────────────── */

/* WinAnsi, for the characters past ASCII that a description is likely to hold. */
const WINANSI = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function winAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += String.fromCharCode(c);
    else if (WINANSI[c]) out += String.fromCharCode(WINANSI[c]);
    else if (c === 9) out += ' ';
    else out += '?';
  }
  return out;
}

const widthOf = (text, size) => textWidth(text, size, 'F1');

/** "/Helv 9 Tf 0 g" → { font, size, color } */
function parseDA(da) {
  const font = (da.match(/\/([^\s/]+)\s+[\d.]+\s+Tf/) || [])[1] || 'Helv';
  const size = Number((da.match(/\/[^\s/]+\s+([\d.]+)\s+Tf/) || [])[1] || 0);
  const rgb = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
  const gray = da.match(/([\d.]+)\s+g\b/);
  const color = rgb ? `${rgb[1]} ${rgb[2]} ${rgb[3]} rg` : gray ? `${gray[1]} g` : '0 g';
  return { font, size, color };
}

/** A DA with its font size set — added if the DA names none. Never 0, which is "auto". */
function sizedDA(da, size) {
  const text = String(da || '/Helv 9 Tf 0 g');
  return /\/[^\s/]+\s+[\d.]+\s+Tf/.test(text)
    ? text.replace(/(\/[^\s/]+\s+)[\d.]+(\s+Tf)/, `$1${num(size)}$2`)
    : `/Helv ${num(size)} Tf ${text}`.trim();
}

/** Lines of text that fit `width` at `size`, keeping the line breaks that were typed. */
function wrap(text, size, width) {
  const lines = [];
  for (const para of String(text).split(/\r\n|\r|\n/)) {
    const words = para.split(/(\s+)/).filter((w) => w !== '');
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (!line || widthOf(next.trimEnd(), size) <= width) { line = next; continue; }
      lines.push(line.trimEnd());
      line = w.trimStart();
      // A single word wider than the box is broken where it has to be.
      while (widthOf(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const MIN_SIZE = 4;

/**
 * The appearance of a filled text box, and whether it fits.
 *
 * Single line: the form's own size, shrunk until the text fits across the box
 * and its glyphs fit inside it top to bottom. Multi-line: wrapped, and shrunk a
 * quarter point at a time until every line is inside the box.
 */
function layoutText(text, field, w, h, size0 = null) {
  const { size: daSize } = parseDA(field.da);
  const start = size0 || daSize || 12;
  const pad = 2;
  if (field.multiline) {
    for (let size = start; size >= MIN_SIZE; size -= 0.25) {
      const lines = wrap(text, size, w - pad * 2);
      if (lines.length * size * 1.15 <= h - pad) return { size, lines, fits: true, h };
    }
    return { size: MIN_SIZE, lines: wrap(text, MIN_SIZE, w - pad * 2), fits: false, h };
  }
  const flat = String(text).replace(/\s*[\r\n]+\s*/g, ' ');
  /* Letters top to tail are 0.93 of the size. With a size asked for, a box too
     short for it is made taller (upwards, so the text stays on its line);
     without one, the text shrinks to the box. Width only ever shrinks it. */
  let size = size0 ? start : Math.min(start, Math.max(MIN_SIZE, (h - 0.2) / 0.9));
  const avail = w - pad * 2;
  const full = widthOf(flat, size);
  if (full > avail) size = Math.max(MIN_SIZE, Math.floor((size * avail / full) * 4) / 4);
  const tall = size0 ? Math.max(h, size * 0.93 + 0.4) : h;
  return { size, lines: [flat], fits: widthOf(flat, size) <= avail + 0.01, h: tall };
}

function textAppearance(text, field, w, h0, fontName, size0 = null) {
  const { color } = parseDA(field.da);
  const layout = layoutText(text, field, w, h0, size0);
  const { size, lines, h } = layout;
  const pad = 2;
  // A single line is clipped to the box itself: its boxes are barely taller
  // than the text, and an inset clip cuts the tops and tails off the letters.
  const clip = field.multiline
    ? `1 1 ${num(Math.max(0, w - 2))} ${num(Math.max(0, h - 2))} re W n`
    : `0 0 ${num(w)} ${num(h)} re W n`;
  const ops = ['/Tx BMC', 'q', clip, 'BT', `/${fontName} ${num(size)} Tf`, color];
  const lead = size * 1.15;
  let y = field.multiline ? h - pad - size * 0.8 : 0.21 * size + (h - 0.93 * size) / 2;
  lines.forEach((line, i) => {
    const encoded = winAnsi(line);
    const lw = widthOf(encoded, size);
    const x = field.q === 1 ? (w - lw) / 2 : field.q === 2 ? w - pad - lw : pad;
    ops.push(`1 0 0 1 ${num(x)} ${num(y - (field.multiline ? i * lead : 0))} Tm`);
    ops.push(`${stringOut(encoded)} Tj`);
  });
  ops.push('ET', 'Q', 'EMC');
  return { content: ops.join('\n'), size: layout.size, fits: layout.fits, daSize: parseDA(field.da).size, h };
}

/* ── The signature ─────────────────────────────────────────────────────── */

/**
 * Strokes drawn on a pad, `{ width, height, strokes: [[[x, y], …], …] }` with y
 * running down, fitted into a box on the page and drawn as lines — a vector
 * signature, a few hundred bytes, as sharp printed as on screen.
 */
function signatureContent(sig, [x1, y1, x2, y2]) {
  const bw = Math.abs(x2 - x1);
  const bh = Math.abs(y2 - y1);
  const left = Math.min(x1, x2);
  const bottom = Math.min(y1, y2);
  const pts = sig.strokes.flat();
  if (!pts.length) return null;
  const minX = Math.min(...pts.map((p) => p[0])); const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])); const maxY = Math.max(...pts.map((p) => p[1]));
  const sw = Math.max(1, maxX - minX);
  const sh = Math.max(1, maxY - minY);
  const pad = 1;
  const scale = Math.min((bw - pad * 2) / sw, (bh - pad * 2) / sh);
  const ox = left + (bw - sw * scale) / 2;
  const oy = bottom + (bh - sh * scale) / 2;
  const at = ([px, py]) => `${num(ox + (px - minX) * scale)} ${num(oy + (maxY - py) * scale)}`;
  const ops = ['q', '0 0 0 RG', '1 J', '1 j', `${num(Math.max(0.5, Math.min(1.2, bh / 14)))} w`];
  for (const stroke of sig.strokes) {
    if (!stroke.length) continue;
    ops.push(`${at(stroke[0])} m`);
    if (stroke.length === 1) ops.push(`${at(stroke[0])} l`);
    for (const p of stroke.slice(1)) ops.push(`${at(p)} l`);
    ops.push('S');
  }
  ops.push('Q');
  return ops.join('\n');
}

/* ── Filling ───────────────────────────────────────────────────────────── */

/**
 * Fill a form and answer `{ bytes, report }`.
 *
 *   values     `{ field: string | boolean }` — a string for a text box or a
 *              dropdown, true or false for a checkbox. A field not named is
 *              left exactly as it was.
 *   signature  `{ field, width, height, strokes }` — drawn in that field's box.
 *   textSize   one size for every box — a number, or the name of a field whose
 *              size to match. Every text box and dropdown is set to it, filled or
 *              blank, and so is the form's default, so nothing is left on auto.
 *              A box too short for it is made taller, upwards; only text too wide
 *              for its box is shrunk.
 *
 * `report.fields[name]` says, for every text box filled, the size it was drawn
 * at and whether it fitted; `report.unknown` names values for fields the form
 * does not have.
 */
export function fillForm(bytes, values, { signature = null, textSize = null } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = new Doc(data);
  const { acro, fields } = walkFields(doc);
  if (!acro) throw new Error('This PDF has no fillable fields.');
  const byName = new Map(fields.map((f) => [f.name, f]));
  // One size for every filled box: a number, or the size another field is set at.
  const size0 = typeof textSize === 'string'
    ? (parseDA(byName.get(textSize)?.da || '').size || null)
    : (Number(textSize) || null);

  let next = doc.size();
  const changed = new Map(); // num → { gen, value }
  const added = [];          // { num, value }
  const objectOf = (ref) => {
    if (changed.has(ref.r)) return changed.get(ref.r).value;
    const v = doc.get(ref);
    const copy = { d: { ...(v?.d || {}) } };
    if (v?.stream) copy.stream = v.stream;
    changed.set(ref.r, { gen: ref.g || 0, value: copy });
    return copy;
  };
  const addObject = (value) => {
    const n = next++;
    added.push({ num: n, value });
    return { r: n, g: 0 };
  };

  // One Helvetica of our own for every appearance: WinAnsi, so a dash or a
  // curly quote is drawn as itself whatever the form's own font resource says.
  const font = addObject({ d: { Type: { n: 'Font' }, Subtype: { n: 'Type1' }, BaseFont: { n: 'Helvetica' }, Encoding: { n: 'WinAnsiEncoding' } } });

  const report = { fields: {}, unknown: [], appearances: 0, signature: false };

  for (const [name, value] of Object.entries(values || {})) {
    const field = byName.get(name);
    if (!field) { report.unknown.push(name); continue; }
    const fieldObj = objectOf(field.ref);

    if (field.kind === 'check' || field.kind === 'radio') {
      const on = field.onState || 'Yes';
      const state = value === true || value === on || value === 'Yes' ? on : 'Off';
      fieldObj.d.V = { n: state };
      for (const w of field.widgets) {
        const wo = objectOf(w.ref);
        const states = Object.keys(doc.get(doc.get(doc.get(w.ref)?.d?.AP)?.d?.N)?.d || {});
        wo.d.AS = { n: states.includes(state) ? state : 'Off' };
      }
      continue;
    }
    if (field.kind !== 'text' && field.kind !== 'choice') continue;

    const text = field.dateFormat ? formatDateAs(value, field.dateFormat) : String(value ?? '');
    fieldObj.d.V = pdfText(text);
    for (const w of field.widgets) {
      const wo = objectOf(w.ref);
      const da = w.da || field.da;
      const { font: fontName } = parseDA(da);
      const [x1, y1, x2, y2] = w.rect;
      const bw = Math.abs(x2 - x1);
      const bh = Math.abs(y2 - y1);
      const ap = textAppearance(text, { ...field, da }, bw, bh, fontName, size0);
      if (ap.h > bh + 0.001) {
        // Taller upwards from its bottom edge — the line the text sits on.
        const left = Math.min(x1, x2); const bottom = Math.min(y1, y2);
        wo.d.Rect = [left, bottom, left + bw, bottom + ap.h];
      }
      const stream = addObject({
        d: {
          Type: { n: 'XObject' }, Subtype: { n: 'Form' }, BBox: [0, 0, bw, ap.h],
          Resources: { d: { Font: { d: { [fontName]: font } } } },
        },
        stream: bytesOf(ap.content),
      });
      wo.d.AP = { d: { N: stream } };
      /* The size it was drawn at is written into the field as well. Acrobat
         redraws a field from its own declared size whenever it saves or edits
         the form, so a field left at the form's 9 pt redrew too big for its box,
         and one set to auto size — tried once — redrew at 4 pt. Declaring the
         size drawn here makes the two agree. */
      if (text || size0) {
        wo.d.DA = { s: sizedDA(da, text ? ap.size : size0) };
        if (fieldObj !== wo && fieldObj.d.DA) fieldObj.d.DA = { s: sizedDA(textOf(fieldObj.d.DA), text ? ap.size : size0) };
      }
      report.appearances++;
      if (text) report.fields[name] = { size: ap.size, fits: ap.fits };
    }
  }

  /* With one size asked for, every box on the form says it — filled or not, on
     the box, on its field, and as the form's own default. BART's form defaults
     to auto (0), and Acrobat falls back to that default for any box that does
     not state a size of its own; a box filled later by hand in Acrobat then came
     out in whatever size auto chose. */
  if (size0) {
    for (const field of fields) {
      if (field.kind !== 'text' && field.kind !== 'choice') continue;
      const filled = Object.prototype.hasOwnProperty.call(values || {}, field.name) && String(values[field.name] ?? '') !== '';
      if (filled) continue;
      const fieldObj = objectOf(field.ref);
      for (const w of field.widgets) {
        const wo = objectOf(w.ref);
        wo.d.DA = { s: sizedDA(w.da || field.da, size0) };
      }
      if (fieldObj.d.DA) fieldObj.d.DA = { s: sizedDA(textOf(fieldObj.d.DA), size0) };
    }
  }

  /* The form itself. NeedAppearances is switched off: every filled box has its
     appearance drawn here, at the size asked for, and a viewer told to redraw
     them all (BART's re-saved template says so) draws them its own way instead.
     And which filler wrote the file is stamped in it, so a download can say. */
  const rootRef = doc.trailer.d.Root;
  const acroRef = doc.get(rootRef)?.d?.AcroForm;
  const acroObj = acroRef?.r !== undefined
    ? objectOf(acroRef)
    : (objectOf(rootRef).d.AcroForm = { d: { ...(acroRef?.d || {}) } });
  const formDA = textOf(doc.get(acroObj.d.DA));
  // Never left on auto (0): the form's default is what a box without a size of its own uses.
  if (size0 || !parseDA(formDA || '').size) acroObj.d.DA = { s: sizedDA(formDA, size0 || 9) };
  acroObj.d.NeedAppearances = false;
  acroObj.d.TrackPlanFiller = { s: `TAWR filler ${FILLER_VERSION}` };

  if (signature?.strokes?.length) {
    const field = byName.get(signature.field);
    const widget = field?.widgets?.[0];
    const pageRef = widget?.page;
    if (widget && pageRef) {
      const content = signatureContent(signature, widget.rect);
      if (content) {
        const page = objectOf(pageRef);
        const c = page.d.Contents;
        let existing = [];
        if (Array.isArray(c)) existing = c;
        else if (c != null) {
          const resolved = doc.get(c);
          existing = Array.isArray(resolved) ? resolved : [c];
        }
        // Wrapped, so whatever state the page's own drawing leaves behind cannot
        // move or recolour the signature.
        const open = addObject({ d: {}, stream: bytesOf('q') });
        const close = addObject({ d: {}, stream: bytesOf('Q') });
        const sig = addObject({ d: {}, stream: bytesOf(content) });
        page.d.Contents = [open, ...existing, close, sig];
        report.signature = true;
      }
    }
  }

  return { bytes: writeIncrement(doc, data, changed, added, next), report };
}

function writeIncrement(doc, data, changed, added, size) {
  const parts = [];
  let offset = data.length;
  const offsets = new Map();
  const push = (str) => {
    const b = typeof str === 'string' ? bytesOf(str) : str;
    parts.push(b);
    offset += b.length;
  };
  push('\n');
  const objects = [
    ...[...changed.entries()].map(([n, { gen, value }]) => ({ num: n, gen, value })),
    ...added.map((a) => ({ num: a.num, gen: 0, value: a.value })),
  ].sort((a, b) => a.num - b.num);
  for (const o of objects) {
    offsets.set(o.num, { offset, gen: o.gen });
    if (o.value.stream) {
      const d = { ...o.value.d, Length: o.value.stream.length };
      push(`${o.num} ${o.gen} obj\n${serialize({ d })}\nstream\n`);
      push(o.value.stream);
      push('\nendstream\nendobj\n');
    } else {
      push(`${o.num} ${o.gen} obj\n${serialize(o.value)}\nendobj\n`);
    }
  }

  const t = doc.trailer.d;
  const trailer = { Size: size, Root: t.Root, Prev: doc.startxref };
  if (t.Info) trailer.Info = t.Info;
  if (t.ID) trailer.ID = t.ID;

  // Runs of consecutive object numbers, as both kinds of cross-reference want them.
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  const runs = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && last.start + last.list.length === n) last.list.push(n);
    else runs.push({ start: n, list: [n] });
  }

  const xrefAt = offset;
  if (doc.xrefIsStream) {
    // The original's cross-reference is a stream; so is this one, uncompressed.
    const rows = [];
    const index = [];
    for (const run of runs) {
      index.push(run.start, run.list.length);
      for (const n of run.list) rows.push([1, offsets.get(n).offset, offsets.get(n).gen]);
    }
    index.push(size, 1);
    rows.push([1, xrefAt, 0]);
    const bin = new Uint8Array(rows.length * 7);
    rows.forEach(([type, off, gen], i) => {
      const p = i * 7;
      bin[p] = type;
      bin[p + 1] = (off >>> 24) & 0xff; bin[p + 2] = (off >>> 16) & 0xff;
      bin[p + 3] = (off >>> 8) & 0xff; bin[p + 4] = off & 0xff;
      bin[p + 5] = (gen >>> 8) & 0xff; bin[p + 6] = gen & 0xff;
    });
    const d = { ...trailer, Size: size + 1, Type: { n: 'XRef' }, W: [1, 4, 2], Index: index, Length: bin.length };
    push(`${size} 0 obj\n${serialize({ d })}\nstream\n`);
    push(bin);
    push('\nendstream\nendobj\n');
  } else {
    let table = 'xref\n';
    for (const run of runs) {
      table += `${run.start} ${run.list.length}\n`;
      for (const n of run.list) {
        const { offset: off, gen } = offsets.get(n);
        table += `${String(off).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
      }
    }
    push(`${table}trailer\n${serialize({ d: trailer })}\n`);
  }
  push(`startxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  out.set(data, 0);
  let p = data.length;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
