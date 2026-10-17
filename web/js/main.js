/**
 * The application: three views of one plan.
 *
 *   Look-ahead   the four-week look-ahead — activities, shifts painted by day,
 *                BART support typed in the cells — where each activity's
 *                Location is linked to the track plan
 *   TAWRs        the requests read off it, raised, submitted, approved,
 *                consolidated and downloaded as BART's form
 *   Track plan   the map: where every linked activity and request is, and
 *                where a location is picked
 *
 * This module loads what all three read, keeps it in `app`, and switches
 * between them. The views never import each other; they call `app`.
 *
 * Imports: store, lookahead, tawr, tawr_sync, map, ui, lookahead_view, tawr_view.
 */

import * as S from './store.js';
import * as LA from './lookahead.js';
import * as T from './tawr.js';
import { autoRaise } from './tawr_sync.js';
import * as M from './map.js';
import { el, clear, toast, openModal } from './ui.js';
import * as LookaheadView from './lookahead_view.js';
import * as TawrView from './tawr_view.js';

const $ = (s) => document.querySelector(s);
const VIEWS = ['lookahead', 'tawr', 'map'];

export const app = {
  data: null,
  locations: [],
  today: LA.todayISO(),
  view: 'lookahead',
  la: { model: LA.makeModel(), legend: LA.DEFAULT_LEGEND, codes: LA.DEFAULT_CODES, version: 0 },
  tawrs: [],
  merges: [],
  descriptions: [],
  settings: {},
  week: null, // the TAWR week in focus: highlighted on the look-ahead, open in TAWRs
};

/* ══════════════════════════════════════════════════════════════════════════
   Loading
   ═══════════════════════════════════════════════════════════════════════ */

app.reloadLookahead = async () => {
  const la = await S.getLookahead();
  app.la = { model: LA.makeModel(la.rows, la.cells), legend: la.legend, codes: la.codes, version: la.version };
};

app.reloadTawrs = async () => {
  const since = T.addDaysISO(T.mondayOf(app.today), -56);
  const [tawrs, merges, descriptions, settings] = await Promise.all([
    S.listTawrs(since),
    S.listMerges(),
    S.listDescriptions().catch(() => []),
    S.writer() ? S.getSettings().catch(() => ({})) : Promise.resolve({}),
  ]);
  app.tawrs = tawrs;
  app.merges = merges;
  app.descriptions = descriptions;
  app.settings = settings;
  updateCount();
  pushOverlay();
};

/** Drafts raised and brought up to date; quiet unless something was made. */
let raising = null;
app.raise = async ({ say = false } = {}) => {
  if (raising) return raising;
  raising = (async () => {
    try {
      const r = await autoRaise(app);
      if (r.made || r.updated) await app.reloadTawrs();
      if (r.made && (say || app.view !== 'tawr')) {
        toast(`${r.made} TAWR draft${r.made === 1 ? '' : 's'} raised from the look-ahead for ${r.weeks.length === 1 ? 'the week of ' + r.weeks[0] : `${r.weeks.length} weeks`}.`, 'good');
      }
      return r;
    } catch (err) {
      toast(`Could not update the TAWR drafts: ${err.message}`, 'bad');
      return null;
    } finally {
      raising = null;
    }
  })();
  return raising;
};

let raiseTimer = null;
/** The look-ahead changed: the drafts follow it, a moment after the edits stop. */
app.lookaheadChanged = () => {
  clearTimeout(raiseTimer);
  raiseTimer = setTimeout(() => { app.raise().then(() => { if (app.view === 'tawr') render(); }); }, 2500);
  pushOverlay();
};

/* ══════════════════════════════════════════════════════════════════════════
   The views
   ═══════════════════════════════════════════════════════════════════════ */

app.go = (view, { week = null } = {}) => {
  if (week) app.week = week;
  if (!VIEWS.includes(view)) view = 'lookahead';
  if (app.view === 'lookahead' && view !== 'lookahead') LookaheadView.leave?.();
  app.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('nav.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'map') { M.invalidate(); pushOverlay(); }
  render();
};

app.setWeek = (week) => {
  app.week = week;
  pushOverlay();
};

function render() {
  if (app.view === 'lookahead') LookaheadView.render($('#view-lookahead'), app);
  else if (app.view === 'tawr') TawrView.render($('#view-tawr'), app);
}
app.render = render;

/** Pick an activity's location on the map, then come back to where we were. */
app.pickLocation = async ({ title, link }) => {
  const back = app.view;
  app.go('map');
  const picked = await M.pickLocation({ title, link });
  app.go(back);
  return picked;
};

app.showOnMap = (link) => {
  app.go('map');
  setTimeout(() => M.showLink(link), 50);
};

app.showTawrOnMap = (record) => {
  app.week = record.week_start;
  app.go('map');
  setTimeout(() => M.showTawr(record), 50);
};

/** Weeks anybody might look at: the look-ahead's, and any with requests. */
app.weeks = () => {
  const out = new Set([...T.weeksWithWork(app.la.model), ...app.tawrs.map((t) => t.week_start)]);
  const due = T.dueWeek(app.today);
  // This week to the week after the one due: the look-ahead's window, at least.
  for (let w = T.mondayOf(app.today); w <= T.addDaysISO(due, 7); w = T.addDaysISO(w, 7)) out.add(w);
  const from = T.addDaysISO(T.mondayOf(app.today), -28);
  return [...out].filter((w) => w >= from).sort();
};

function pushOverlay() {
  const week = app.week;
  const weekEnd = T.addDaysISO(week, 6);
  const busy = new Set(LA.cellList(app.la.model).filter((c) => c.day >= week && c.day <= weekEnd && c.color).map((c) => c.row_id));
  const activities = app.la.model.rows
    .filter((r) => r.kind === 'activity' && (busy.has(r.id) || LA.resourcesOf(app.la.model, r.id).some((k) => busy.has(k.id))))
    .map((r) => ({ id: r.id, title: LA.rowTitle(r), link: r.link }));
  M.setOverlay({
    week,
    weeks: app.weeks().map((w) => ({ value: w, label: `Week of ${w}${w === T.dueWeek(app.today) ? ' (due now)' : ''}` })),
    tawrs: app.tawrs.filter((t) => t.week_start === week && !['superseded', 'consolidated'].includes(t.status)),
    activities,
    onWeek: (w) => { app.week = w; pushOverlay(); },
    onOpenTawr: (t) => { TawrView.focus(t.id); app.go('tawr', { week: t.week_start }); },
  });
}
app.pushOverlay = pushOverlay;

function updateCount() {
  const c = $('#tawr-count');
  const waiting = app.tawrs.filter((t) => (S.isManager() ? t.status === 'submitted' : t.status === 'draft') && t.week_start >= T.mondayOf(app.today));
  c.hidden = !waiting.length;
  c.textContent = String(waiting.length);
  c.title = S.isManager() ? `${waiting.length} waiting for your approval` : `${waiting.length} draft${waiting.length === 1 ? '' : 's'} to review and submit`;
}
app.updateCount = updateCount;

/* ══════════════════════════════════════════════════════════════════════════
   Who is using it
   ═══════════════════════════════════════════════════════════════════════ */

function renderWho() {
  const host = $('#who');
  clear(host);
  const u = S.store.user;
  if (!u) return;
  const label = S.store.workflow.roles[u.role];
  host.append(...[
    el('span', { class: `who role-${u.role}`, title: S.store.mode === 'local' ? 'This browser only — anyone can change role here. Run server.py for accounts.' : `Signed in as ${u.username}` }, [
      el('b', { text: u.name }), ` · ${label}`,
    ]),
    el('button', {
      type: 'button', class: 'secondary mini', text: S.store.mode === 'local' ? 'Switch' : 'Sign out',
      onClick: async () => {
        if (S.store.mode === 'local') { await askWho(); location.reload(); return; }
        await S.logout();
        location.reload();
      },
    }),
    S.isManager() && S.store.mode === 'server' ? el('button', { type: 'button', class: 'secondary mini', text: 'Accounts', onClick: accounts }) : null,
  ].filter(Boolean));
}

/** On the static site: say who you are and which role you are acting in. */
function askWho() {
  return new Promise((resolve) => {
    const name = el('input', { type: 'text', value: S.store.user?.name || '' });
    const roleSel = el('select', {}, Object.entries(S.store.workflow.roles).map(([v, l]) => el('option', { value: v, text: l })));
    roleSel.value = S.store.user?.role || 'requester';
    openModal({
      title: 'Who is using Track Plan?',
      subtitle: 'This copy is a static site: everything is kept in this browser, and the role you choose here is not checked by anybody. Run server.py for accounts that are.',
      body: el('div', { class: 'form-grid' }, [el('label', {}, ['Your name', name]), el('label', {}, ['Acting as', roleSel])]),
      onClose: () => resolve(S.store.user),
      actions: [{ label: 'Continue', kind: 'primary', id: 'acting', onClick: () => { S.setActing(name.value, roleSel.value); } }],
    });
  });
}

/** Server: sign in, or make the first account. */
function signIn() {
  return new Promise((resolve) => {
    const first = S.store.setupNeeded;
    const name = el('input', { type: 'text', autocomplete: 'name' });
    const user = el('input', { type: 'text', autocomplete: 'username' });
    const pass = el('input', { type: 'password', autocomplete: first ? 'new-password' : 'current-password' });
    const err = el('p', { class: 'msg err' });
    const go = async (h) => {
      try {
        if (first) await S.setupFirst(user.value.trim(), name.value.trim(), pass.value);
        else await S.login(user.value.trim(), pass.value);
        h.close();
        resolve(S.store.user);
      } catch (e) { err.textContent = e.message; }
    };
    const body = el('form', { class: 'form-grid', onSubmit: (e) => { e.preventDefault(); handle.box.querySelector('[data-action=signin]').click(); } }, [
      first ? el('label', {}, ['Your name', name]) : null,
      el('label', {}, ['Username', user]),
      el('label', {}, ['Password', pass]),
      el('button', { type: 'submit', hidden: true }),
      err,
    ]);
    const handle = openModal({
      title: first ? 'Make the first account' : 'Sign in to Track Plan',
      subtitle: first ? 'The first account is the Track Allocation Manager, who approves TAWRs and adds everybody else.' : '',
      body,
      actions: [{ label: first ? 'Create and sign in' : 'Sign in', kind: 'primary', id: 'signin', keepOpen: true, onClick: go }],
      onClose: () => { if (!S.store.user) setTimeout(() => signIn().then(resolve), 0); },
    });
  });
}

async function accounts() {
  const list = el('div');
  const draw = async () => {
    clear(list);
    const users = await S.listUsers();
    const table = el('table', { class: 'grid-table' }, [
      el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Active', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, users.map((u) => {
        const role = el('select', {}, Object.entries(S.store.workflow.roles).map(([v, l]) => el('option', { value: v, text: l })));
        role.value = u.role;
        const active = el('input', { type: 'checkbox' });
        active.checked = u.active;
        return el('tr', {}, [
          el('td', { text: u.name }), el('td', { text: u.username }), el('td', {}, [role]), el('td', {}, [active]),
          el('td', {}, [el('button', {
            type: 'button', class: 'secondary mini', text: 'Save',
            onClick: async () => {
              try { await S.updateUser(u.id, { role: role.value, active: active.checked }); toast(`${u.name} saved.`, 'good'); draw(); } catch (e) { toast(e.message, 'bad'); }
            },
          })]),
        ]);
      })),
    ]);
    const name = el('input', { placeholder: 'Name' });
    const username = el('input', { placeholder: 'Username' });
    const password = el('input', { type: 'password', placeholder: 'Password (8+ characters)' });
    const role = el('select', {}, Object.entries(S.store.workflow.roles).map(([v, l]) => el('option', { value: v, text: l })));
    list.append(table, el('h3', { text: 'Add an account' }), el('div', { class: 'row' }, [name, username, password, role, el('button', {
      type: 'button', text: 'Add',
      onClick: async () => {
        try {
          await S.addUser({ name: name.value, username: username.value, password: password.value, role: role.value });
          toast(`${name.value} added.`, 'good');
          draw();
        } catch (e) { toast(e.message, 'bad'); }
      },
    })]));
  };
  openModal({ title: 'Accounts', subtitle: 'One requester raises and submits TAWRs; the Track Allocation Manager approves them.', body: list, size: 'lg' });
  draw().catch((e) => toast(e.message, 'bad'));
}

/* ══════════════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════════ */

let polling = null;
function poll() {
  clearInterval(polling);
  if (S.store.mode !== 'server') return;
  polling = setInterval(async () => {
    if (document.hidden || LookaheadView.busy?.()) return;
    try {
      const v = await S.lookaheadVersion();
      if (v !== app.la.version) {
        await app.reloadLookahead();
        await app.reloadTawrs();
        if (app.view !== 'map') render();
        pushOverlay();
      }
    } catch { /* offline for a moment */ }
  }, 30000);
}

(async function boot() {
  try {
    const [data, tiles] = await Promise.all([
      fetch('data/map.json').then((r) => r.json()),
      fetch('tiles/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      S.init(),
    ]);
    app.data = data;
    app.locations = data.locations;
    document.querySelectorAll('nav.views button').forEach((b) => { b.onclick = () => app.go(b.dataset.view); });
    window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== app.view) app.go(v); });
    window.addEventListener('tp:signed-out', () => { toast('Signed out. Sign in again to carry on.', 'warn'); signIn().then(() => location.reload()); });
    M.initMap(data, tiles);
    if (S.store.mode === 'server' && !S.store.user) await signIn();
    if (S.store.mode === 'local' && !S.store.user) await askWho();
    renderWho();
    app.week = T.dueWeek(app.today);
    await app.reloadLookahead();
    await app.reloadTawrs();
    $('#loading').remove();
    const v = location.hash.slice(1);
    app.go(VIEWS.includes(v) ? v : 'lookahead');
    app.raise().then((r) => { if (r && (r.made || r.updated) && app.view !== 'map') render(); });
    poll();
  } catch (err) {
    console.error(err);
    $('#loading').textContent = `Could not start: ${err.message}`;
  }
}());
