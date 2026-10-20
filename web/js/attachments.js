/**
 * What may be sent with a request, how a file is named and how big it may be:
 * the browser's copy of operations.ATTACH_TYPES and clean_file_name, so the
 * static site refuses what the server would, and says so before uploading.
 *
 * Pure: no DOM — tests/test_tawr.mjs reads it.
 *
 * Imports: nothing.
 */

export const ATTACH_MAX = 20 * 1024 * 1024;
export const ATTACH_PER_REQUEST = 20;

/** Documents, drawings, photos, emails — never a page or a program — and the type each is kept as. */
export const ATTACH_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
  zip: 'application/zip',
};

/** For a file picker's `accept`. */
export const ATTACH_ACCEPT = Object.keys(ATTACH_TYPES).map((e) => `.${e}`).join(',');

/** A file's own name, without a folder, control characters or anything a file system refuses. */
export function cleanFileName(name) {
  let n = String(name ?? '').split(/[\\/]/).pop();
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*]+/g, '').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot + 1) : '';
    n = ext && ext.length <= 8 ? `${n.slice(0, dot).slice(0, 110).trimEnd()}.${ext}` : n.slice(0, 120);
  }
  return n;
}

/** The type a file is kept as, by its extension; null for one that may not be attached. */
export function fileType(name) {
  const n = cleanFileName(name);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? ATTACH_TYPES[n.slice(dot + 1).toLowerCase()] || null : null;
}

/** Why a file cannot be attached — `{ message, status }` — or null. As operations.add_attachment. */
export function attachProblem(name, size, already = 0) {
  if (!cleanFileName(name) || !fileType(name)) {
    return { status: 415, message: 'only documents, drawings, photos, emails and zip files can be attached (PDF, Word, Excel, PowerPoint, CSV, text, PNG, JPEG, TIFF, DWG, DXF, MSG, EML, ZIP)' };
  }
  if (!size) return { status: 400, message: 'the file is empty' };
  if (size > ATTACH_MAX) return { status: 413, message: 'a file is at most 20 MB' };
  if (already >= ATTACH_PER_REQUEST) return { status: 409, message: `a request carries at most ${ATTACH_PER_REQUEST} files` };
  return null;
}

/** "840 bytes", "12 KB", "3.4 MB". */
export function sizeText(n) {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
