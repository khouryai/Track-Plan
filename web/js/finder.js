/**
 * The finder, and the list of keyboard shortcuts.
 *
 * Ctrl+K (⌘K on a Mac), "/" anywhere but a text box or the look-ahead's grid,
 * or Find in the header: type a request's number, a place, an activity's ID or
 * its words, or a screen. The arrows pick, Enter opens, Escape closes. What is
 * found is `find.js`'s to decide; where each thing opens is the caller's
 * (`go`), so this module knows nothing of the views.
 *
 * "?" lists the shortcuts, the same anywhere but a text box.
 *
 * Imports: find, tawr, links, store, ui.
 */

import { entries, search } from './find.js';
import { tawrShiftLabel } from './tawr.js';
import { linkLabel } from './links.js';
import * as S from './store.js';
import { el, clear, openModal, dayLabel } from './ui.js';

const KIND_LABEL = { request: 'Request', activity: 'Activity', place: 'Place', screen: 'Screen' };
let current = null;

/** "Ctrl" or "⌘", as this computer's keyboard says it. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

/**
 * Open the finder over the page. `source()` gives what to look through, as
 * `find.entries` takes it; `go(found)` opens what was picked.
 */
export function openFinder({ source, go }) {
  if (current) { current.input.focus(); return; }
  const list = entries({
    ...source(), statusName: (s) => S.store.workflow?.statuses?.[s] || s, shiftName: tawrShiftLabel, linkText: linkLabel, dayName: dayLabel,
  });
  const input = el('input', {
    type: 'search', class: 'finder-input', autocomplete: 'off', spellcheck: 'false', role: 'combobox',
    'aria-label': 'Find', 'aria-expanded': 'true', 'aria-controls': 'finder-list', 'aria-autocomplete': 'list',
    placeholder: 'Find a request, an activity, a place or a screen',
  });
  const listbox = el('ul', { id: 'finder-list', class: 'finder-list', role: 'listbox', 'aria-label': 'Found' });
  const hint = el('p', { class: 'finder-hint', text: 'Try #12, Daly City, C-W101, cable or Reports. ↑ ↓ to pick, Enter to open, Esc to close.' });
  const back = el('div', { class: 'finder-back' }, [
    el('div', { class: 'finder', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find' }, [input, listbox, hint]),
  ]);
  let found = [];
  let at = 0;

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    current = null;
  };
  const choose = (i) => {
    const f = found[i];
    if (!f) return;
    close();
    go(f);
  };
  const mark = () => {
    listbox.querySelectorAll('.finder-item').forEach((n, i) => { n.classList.toggle('on', i === at); n.setAttribute('aria-selected', String(i === at)); });
    if (found[at]) input.setAttribute('aria-activedescendant', `finder-${at}`); else input.removeAttribute('aria-activedescendant');
    listbox.querySelector('.finder-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  const draw = () => {
    found = search(list, input.value, { limit: 12 });
    at = Math.min(at, Math.max(0, found.length - 1));
    clear(listbox);
    if (input.value.trim() && !found.length) listbox.append(el('li', { class: 'finder-none', text: 'Nothing found.' }));
    found.forEach((f, i) => listbox.append(el('li', {
      id: `finder-${i}`, role: 'option', class: 'finder-item', dataset: { kind: f.kind, find: f.id },
      onMousedown: (e) => e.preventDefault(), // the box keeps the keyboard
      onClick: () => choose(i),
      onMousemove: () => { if (at !== i) { at = i; mark(); } },
    }, [
      el('span', { class: `finder-kind kind-${f.kind}`, text: KIND_LABEL[f.kind] }),
      el('span', { class: 'finder-title', text: f.title }),
      f.detail ? el('span', { class: 'finder-detail', text: f.detail }) : null,
    ])));
    mark();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(found.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(at);
    }
  };

  input.addEventListener('input', () => { at = 0; draw(); });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  current = { input };
  input.focus();
}

/** The keyboard shortcuts, by where they work. */
export function showShortcuts() {
  const groups = [
    ['Anywhere', [
      [`${MOD} K  or  /`, 'Find a request, an activity, a place or a screen'],
      ['?', 'This list'],
      ['Esc', 'Close a dialog, the finder or a menu'],
    ]],
    ['The look-ahead', [
      ['← → ↑ ↓', 'Move; with Shift, select several days'],
      ['Enter, F2, or just type', 'Write in the day or the cell'],
      ['Delete', 'Clear what is selected'],
      ['Alt 1 … Alt 5', 'Paint the selected days a shift, in the legend\'s order'],
      ['Alt 0', 'Take the colour off'],
      [`${MOD} Z  ·  ${MOD} Y`, 'Undo · redo'],
      [`${MOD} C  ·  ${MOD} V`, 'Copy · paste, the shift colours too'],
      ['Shift F10, or right-click', 'The day\'s menu: its history, painting, rows'],
    ]],
    ['A request', [
      [`${MOD} Enter`, 'Add the comment being written'],
    ]],
    ['The track plan', [
      ['Esc', 'Stop picking along the track'],
    ]],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    size: 'lg',
    body: el('div', { class: 'shortcuts' }, groups.map(([name, rows]) => el('section', {}, [
      el('h3', { text: name }),
      el('dl', {}, rows.flatMap(([keys, what]) => [el('dt', {}, [el('kbd', { text: keys })]), el('dd', { text: what })])),
    ]))),
  });
}
