/**
 * Minimal DEFLATE decompressor and ZIP reader.
 *
 * Exists so `.xlsx` files can be imported without a dependency: an xlsx is a
 * ZIP of XML parts, and the parts are almost always DEFLATE-compressed. The
 * browser's own DecompressionStream handles this when available (Chrome,
 * Edge, Firefox, Safari 16.4+); the hand-written inflater below is the
 * fallback so the feature works on any engine, offline, from `file://`.
 *
 * Implements RFC 1951 for stored, fixed-Huffman and dynamic-Huffman blocks —
 * which is everything a spreadsheet writer emits.
 *
 * Imports: nothing (leaf).
 */

/* ── Huffman decoding ──────────────────────────────────────────────────── */

/** Build a canonical Huffman decode table from a list of code lengths. */
function buildTree(lengths) {
  const maxBits = Math.max(...lengths, 0);
  const blCount = new Array(maxBits + 1).fill(0);
  for (const len of lengths) if (len) blCount[len]++;

  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  // Map "length:code" to a symbol. A flat object lookup is fast enough here
  // and keeps the implementation short and auditable.
  const table = new Map();
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol];
    if (!len) continue;
    table.set(len * 65536 + nextCode[len], symbol);
    nextCode[len]++;
  }
  return { table, maxBits };
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  bits(n) {
    while (this.bitCount < n) {
      if (this.pos >= this.bytes.length) throw new Error('Unexpected end of compressed data');
      this.bitBuffer |= this.bytes[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << n) - 1);
    this.bitBuffer >>>= n;
    this.bitCount -= n;
    return value;
  }

  /** Huffman codes are stored most-significant-bit first. */
  decode(tree) {
    let code = 0;
    for (let len = 1; len <= tree.maxBits; len++) {
      code = (code << 1) | this.bits(1);
      const symbol = tree.table.get(len * 65536 + code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('Invalid Huffman code');
  }

  alignToByte() {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLiteral = null;
let fixedDistance = null;

function fixedTrees() {
  if (!fixedLiteral) {
    const lengths = new Array(288);
    for (let i = 0; i < 144; i++) lengths[i] = 8;
    for (let i = 144; i < 256; i++) lengths[i] = 9;
    for (let i = 256; i < 280; i++) lengths[i] = 7;
    for (let i = 280; i < 288; i++) lengths[i] = 8;
    fixedLiteral = buildTree(lengths);
    fixedDistance = buildTree(new Array(30).fill(5));
  }
  return [fixedLiteral, fixedDistance];
}

/**
 * Inflate a raw DEFLATE stream (no zlib header).
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function inflateRaw(data) {
  const reader = new BitReader(data);
  let output = new Uint8Array(Math.max(1024, data.length * 4));
  let length = 0;

  const push = (byte) => {
    if (length >= output.length) {
      const bigger = new Uint8Array(output.length * 2);
      bigger.set(output);
      output = bigger;
    }
    output[length++] = byte;
  };

  let final = false;
  while (!final) {
    final = reader.bits(1) === 1;
    const type = reader.bits(2);

    if (type === 0) {
      reader.alignToByte();
      const len = data[reader.pos] | (data[reader.pos + 1] << 8);
      reader.pos += 4; // skip LEN and NLEN
      for (let i = 0; i < len; i++) push(data[reader.pos++]);
      continue;
    }

    let literalTree;
    let distanceTree;

    if (type === 1) {
      [literalTree, distanceTree] = fixedTrees();
    } else if (type === 2) {
      const hlit = reader.bits(5) + 257;
      const hdist = reader.bits(5) + 1;
      const hclen = reader.bits(4) + 4;

      const codeLengths = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) codeLengths[CODE_LENGTH_ORDER[i]] = reader.bits(3);
      const codeTree = buildTree(codeLengths);

      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const symbol = reader.decode(codeTree);
        if (symbol < 16) {
          lengths.push(symbol);
        } else if (symbol === 16) {
          const previous = lengths[lengths.length - 1];
          const repeat = reader.bits(2) + 3;
          for (let i = 0; i < repeat; i++) lengths.push(previous);
        } else if (symbol === 17) {
          const repeat = reader.bits(3) + 3;
          for (let i = 0; i < repeat; i++) lengths.push(0);
        } else {
          const repeat = reader.bits(7) + 11;
          for (let i = 0; i < repeat; i++) lengths.push(0);
        }
      }

      literalTree = buildTree(lengths.slice(0, hlit));
      distanceTree = buildTree(lengths.slice(hlit));
    } else {
      throw new Error('Invalid DEFLATE block type');
    }

    for (;;) {
      const symbol = reader.decode(literalTree);
      if (symbol === 256) break;
      if (symbol < 256) {
        push(symbol);
        continue;
      }
      const lengthIndex = symbol - 257;
      const copyLength = LENGTH_BASE[lengthIndex] + reader.bits(LENGTH_EXTRA[lengthIndex]);
      const distSymbol = reader.decode(distanceTree);
      const distance = DIST_BASE[distSymbol] + reader.bits(DIST_EXTRA[distSymbol]);
      const from = length - distance;
      if (from < 0) throw new Error('Invalid back-reference in compressed data');
      for (let i = 0; i < copyLength; i++) push(output[from + i]);
    }
  }

  return output.subarray(0, length);
}

/**
 * Decompress using the platform where it exists, falling back to the
 * implementation above. Always returns a promise for one call shape.
 */
export async function inflate(data) {
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      /* fall through to the JavaScript inflater */
    }
  }
  return inflateRaw(data);
}

/* ══════════════════════════════════════════════════════════════════════════
   ZIP reading
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Read a ZIP archive from an ArrayBuffer.
 * Returns a Map of path → Uint8Array. Only the stored (0) and deflate (8)
 * methods are supported, which covers every spreadsheet writer in practice.
 */
export async function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Locate the End Of Central Directory record by scanning backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66_000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP archive (no end-of-directory record).');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const files = new Map();
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // Re-read the local header: its extra field length can differ.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith('/')) {
      if (method === 0) files.set(name, raw);
      else if (method === 8) files.set(name, await inflate(raw));
      // Any other method (bzip2, LZMA) is left out rather than corrupting data.
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/** Decode a ZIP entry as UTF-8 text. */
export function zipText(files, path) {
  const entry = files.get(path);
  return entry ? new TextDecoder('utf-8').decode(entry) : null;
}
