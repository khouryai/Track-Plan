/**
 * Small DOM helpers shared by the views: building elements, toasts, dialogs
 * and a context menu. Nothing here knows about the look-ahead or TAWRs.
 *
 * Imports: nothing (leaf).
 */

/**
 * An element: `el('button', { class: 'x', text: 'Go', onClick }, [children])`.
 * `null`, `false` and `undefined` children are skipped (a raw `append(null)`
 * would insert the word "null").
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

/* ── Toasts ────────────────────────────────────────────────────────────── */

export function toast(message, tone = 'info', ms = 4500) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = el('div', { class: `toast toast-${tone}`, text: message });
  host.append(t);
  setTimeout(() => t.remove(), tone === 'bad' ? ms * 2 : ms);
  return t;
}

/* ── Dialogs ───────────────────────────────────────────────────────────── */

/**
 * A modal. `actions`: `[{ label, kind: 'primary'|'danger'|undefined, onClick(handle), keepOpen }]`.
 * Escape and the backdrop close it; focus goes to the first field, else the
 * primary button.
 */
export function openModal({ title, subtitle = '', body, actions = [{ label: 'Close' }], size = '', onClose = null }) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: `modal ${size ? `modal-${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const handle = {
    close() {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (onClose) onClose();
    },
    box,
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); handle.close(); }
  };
  const foot = el('div', { class: 'modal-foot' }, actions.map((a) => el('button', {
    type: 'button',
    class: a.kind === 'primary' ? '' : a.kind === 'danger' ? 'danger' : 'secondary',
    dataset: a.id ? { action: a.id } : {},
    text: a.label,
    onClick: async (e) => {
      if (a.onClick) {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await a.onClick(handle); } finally { btn.disabled = false; }
      }
      if (!a.keepOpen) handle.close();
    },
  })));
  box.append(
    el('div', { class: 'modal-head' }, [el('h2', { text: title }), subtitle ? el('p', { class: 'small', text: subtitle }) : null]),
    el('div', { class: 'modal-body' }, [body]),
    foot,
  );
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) handle.close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  requestAnimationFrame(() => {
    const first = box.querySelector('.modal-body input:not([type=checkbox]):not([readonly]), .modal-body textarea:not([readonly]), .modal-body select');
    (first || foot.querySelector('button:not(.secondary)') || foot.querySelector('button'))?.focus();
  });
  return handle;
}

export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: el('p', { text: message }),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Cancel' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', id: 'confirm', onClick: () => { answered = true; resolve(true); } },
      ],
    });
  });
}

/** A question with a text answer; null if cancelled. */
export function promptDialog({ title, message = '', label = '', value = '', confirmLabel = 'OK', required = false, multiline = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = multiline ? el('textarea', { rows: '3' }) : el('input', { type: 'text' });
    input.value = value;
    const err = el('p', { class: 'msg err' });
    openModal({
      title,
      body: el('div', {}, [message ? el('p', { text: message }) : null, el('label', {}, [label, input]), err]),
      onClose: () => { if (!answered) resolve(null); },
      actions: [
        { label: 'Cancel' },
        {
          label: confirmLabel, kind: 'primary', id: 'confirm', keepOpen: true,
          onClick: (h) => {
            if (required && !input.value.trim()) { err.textContent = 'This is needed.'; return; }
            answered = true;
            resolve(input.value.trim());
            h.close();
          },
        },
      ],
    });
  });
}

/* ── Context menu ──────────────────────────────────────────────────────── */

let openMenu = null;

/** `items`: `[{ label, onClick, disabled, hint }]` or `'-'` for a divider. */
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = el('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    if (!it) continue;
    menu.append(el('button', {
      type: 'button', role: 'menuitem', class: 'ctx-item', disabled: it.disabled || null, title: it.hint || null,
      dataset: it.id ? { action: it.id } : {},
      onClick: () => { closeMenu(); it.onClick?.(); },
    }, [el('span', { text: it.label }), it.hint ? el('span', { class: 'ctx-hint', text: it.hint }) : null]));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  openMenu = menu;
  menuOpener = document.activeElement;
  // A key can be pressed at once; only the click that opened the menu must not close it.
  document.addEventListener('keydown', escape, true);
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  menu.querySelector('button:not([disabled])')?.focus();
  return menu;
}

let menuOpener = null;
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function escape(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  const back = menuOpener;
  closeMenu();
  if (back?.isConnected) back.focus({ preventScroll: true }); // the shortcuts keep working where they were
}

export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', escape, true);
}

/* ── Downloads ─────────────────────────────────────────────────────────── */

/** Hand bytes to the browser as a file, and say so — a download has no other visible result. */
export function saveFile(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Downloaded ${name}`, 'good');
}

/** A CSV cell: quoted where needed, and a leading = + - @ written as text so Excel does not run it. */
export function csvField(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ── Dates as people read them ─────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utc = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);

/** "Mon 2 Nov" */
export function dayLabel(iso) {
  const d = utc(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "2 Nov 2026" */
export function dateLabel(iso) {
  const d = utc(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "16 Oct 2026, 14:05" for a timestamp, in the reader's own time. */
export function stampLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
