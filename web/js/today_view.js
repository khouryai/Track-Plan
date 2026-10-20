/**
 * The start page: what needs the person looking, today.
 *
 * Opens first. Each item says what is waiting and where to go to deal with it
 * (`today.js` decides which, for the role); then the deadlines ahead, the
 * access approved for this week and next, and the deadlines as a calendar —
 * a link a calendar subscribes to on a server, a file to import on the static
 * site.
 *
 * Imports: today, tawr, lookahead, links, learn, store, ui.
 */

import { attention, figures, deadlines, onTrack, calendarIcs } from './today.js';
import * as T from './tawr.js';
import * as LA from './lookahead.js';
import { hasLink, resolveLocationText } from './links.js';
import { suggestLink } from './learn.js';
import * as S from './store.js';
import { el, clear, toast, dayLabel, saveFile, confirmDialog } from './ui.js';

const GO_LABEL = { tawr: 'Open the TAWRs', map: 'Show on the track plan', lookahead: 'Open the look-ahead' };
const STATUS_PLURAL = { draft: 'drafts', submitted: 'submitted', approved: 'approved', rejected: 'rejected', denied: 'denied by BART', cancelled: 'cancelled' };

/** The weeks with work on the look-ahead or requests raised: what has a deadline worth saying. */
const weeksWithSomething = (app) => [...new Set([...T.weeksWithWork(app.la.model), ...app.tawrs.map((t) => t.week_start)])].sort();
const TONE_WORD = { bad: 'Late', you: 'Your turn', wait: 'Waiting', info: 'For information' };

/** Look-ahead activities with work in the next four weeks and no location the track plan knows. */
function unlinkedActivities(app) {
  const days = LA.windowDays(T.mondayOf(app.today), 4);
  return LA.rowsInWindow(app.la.model, days)
    .filter((r) => r.kind === 'activity' && !hasLink(r.link) && !resolveLocationText(r.location, app.locations));
}

export function render(root, app) {
  clear(root);
  const role = S.role();
  const unlinked = unlinkedActivities(app);
  const suggestions = app.learning ? unlinked.filter((r) => suggestLink(app.learning, r)).length : 0;
  const items = attention({
    records: app.tawrs, today: app.today, role, capacity: T.parseCapacity(app.settings?.support_capacity),
    sections: app.data?.power?.sections || [], unlinked: unlinked.length, suggestions, label: dayLabel, userId: S.store.user?.id ?? null,
  });
  const mine = items.filter((i) => i.tone === 'bad' || i.tone === 'you');
  const page = el('div', { class: 'today' });
  root.append(page);

  page.append(el('div', { class: 'today-head' }, [
    el('h2', { text: `Today · ${dayLabel(app.today)} ${app.today.slice(0, 4)}` }),
    el('p', { class: 'small', text: mine.length
      ? `${mine.length} thing${mine.length === 1 ? '' : 's'} waiting on you${S.store.user ? `, ${S.store.user.name}` : ''}.`
      : `Nothing is waiting on you${S.store.user ? `, ${S.store.user.name}` : ''}.` }),
  ]));

  /* The figures: how much is waiting where, each a way there. */
  page.append(el('div', { class: 'today-figures', role: 'group', 'aria-label': 'At a glance' }, figures({
    records: app.tawrs, today: app.today, sections: app.data?.power?.sections || [], userId: S.store.user?.id ?? null,
  }).map((f) => el('button', {
    type: 'button', class: `figure${f.n ? ' some' : ''}`, dataset: { figure: f.key },
    'aria-label': `${f.n} — ${f.label}`, disabled: !f.n || null,
    onClick: () => app.go(f.go.view, { week: f.go.week || null }),
  }, [el('span', { class: 'figure-n', text: String(f.n) }), el('span', { class: 'figure-label', text: f.label })]))));

  /* What needs doing, most pressing first. */
  page.append(el('section', { class: 'today-block', 'aria-label': 'What needs attention' }, [
    el('h3', { text: 'What needs attention' }),
    items.length ? el('ul', { class: 'needs-you' }, items.map((i) => el('li', { class: `need tone-${i.tone}`, dataset: { need: i.key } }, [
      el('span', { class: 'need-tone', text: TONE_WORD[i.tone] }),
      el('div', { class: 'need-text' }, [el('div', { class: 'need-title', text: i.title }), i.detail ? el('div', { class: 'small', text: i.detail }) : null]),
      el('button', {
        type: 'button', class: i.tone === 'you' || i.tone === 'bad' ? 'mini' : 'secondary mini', text: GO_LABEL[i.go.view],
        onClick: () => app.go(i.go.view, { week: i.go.week || null }),
      }),
    ]))) : el('p', { class: 'empty', text: 'Nothing needs attention: no drafts coming due, nothing to approve, nothing waiting on BART.' }),
  ]));

  /* The weeks ahead and their deadlines. */
  const ahead = deadlines(app.tawrs, app.today, weeksWithSomething(app), { weeks: 6 });
  /* A deadline matters while something is still to go in: a week whose requests are all in says so instead. */
  const badge = (d) => {
    const open = ['draft', 'rejected', 'denied'].reduce((n, st) => n + (d.counts[st] || 0), 0);
    return open || !Object.keys(d.counts).length ? el('span', { class: `badge tone-${d.state.tone}`, text: d.state.label })
      : el('span', { class: 'badge tone-ok', text: 'Nothing left to submit' });
  };
  page.append(el('section', { class: 'today-block' }, [
    el('h3', { text: 'Deadlines ahead' }),
    el('p', { class: 'small', text: `Each week's requests go to BART ${T.TAWR_LEAD_DAYS} days before its first day of work.` }),
    ahead.length ? el('table', { class: 'grid-table deadlines' }, [
      el('thead', {}, [el('tr', {}, ['Week of', 'Due', '', 'Where its requests stand'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, ahead.map((d) => el('tr', { dataset: { week: d.week } }, [
        el('td', {}, [el('button', { type: 'button', class: 'link', text: dayLabel(d.week), onClick: () => app.go('tawr', { week: d.week }) })]),
        el('td', { text: dayLabel(d.deadline) }),
        el('td', {}, [badge(d)]),
        el('td', { class: 'small', text: Object.entries(d.counts).map(([st, n]) => `${n} ${n === 1 ? S.store.workflow.statuses[st]?.toLowerCase() || st : STATUS_PLURAL[st] || st}`).join(' · ') || 'nothing raised yet' }),
      ]))),
    ]) : el('p', { class: 'empty', text: 'No work on the look-ahead in the coming weeks.' }),
  ]));

  /* The access approved: where the track is had, this week and next. */
  const access = onTrack(app.tawrs, app.today, T.addDaysISO(T.mondayOf(app.today), 13));
  page.append(el('section', { class: 'today-block' }, [
    el('h3', { text: 'On the track, this week and next' }),
    access.length ? el('table', { class: 'grid-table on-track' }, [
      el('thead', {}, [el('tr', {}, ['Day', 'Shift', 'Request', 'Work', 'BART'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, access.map((a) => el('tr', {}, [
        el('td', { text: dayLabel(a.date) }),
        el('td', { text: `${T.tawrShiftLabel(a.record.shift)} ${a.start && a.end ? `${a.start}–${a.end}` : ''}` }),
        el('td', {}, [el('button', { type: 'button', class: 'link', text: `#${a.record.id} ${a.record.location_name}`, onClick: () => app.openTawr(a.record) })]),
        el('td', { class: 'small', text: (a.record.source?.activities || []).map((x) => x.title).join('; ') }),
        el('td', { class: 'small', text: a.record.bart?.answer === 'granted' ? `Granted${a.record.bart.ref ? ` · ${a.record.bart.ref}` : ''}` : a.record.bart?.sent_on ? 'Waiting for BART' : 'Not sent yet' }),
      ]))),
    ]) : el('p', { class: 'empty', text: 'No access approved for this week or next yet.' }),
  ]));

  page.append(calendarBlock(app));
}

/** The deadlines in somebody's own calendar: a link it subscribes to, or a file to import. */
function calendarBlock(app) {
  const block = el('section', { class: 'today-block', id: 'today-calendar' }, [
    el('h3', { text: 'Deadlines in your calendar' }),
  ]);
  if (S.store.mode === 'local') {
    block.append(
      el('p', { class: 'small', text: 'Each week\'s TAWR deadline (with a reminder the day before) and every day of approved access, as a file Outlook, Google Calendar or Apple Calendar imports. On the static site it is a copy as things stand: download it again when they change.' }),
      el('button', {
        type: 'button', class: 'mini', dataset: { action: 'calendar-download' }, text: 'Download the calendar (.ics)',
        onClick: () => {
          // The weeks with work or requests, as the server's feed has them.
          saveFile(`TAWR deadlines ${app.today}.ics`, calendarIcs({ records: app.tawrs, weekList: weeksWithSomething(app), today: app.today }), 'text/calendar');
        },
      }),
    );
    return block;
  }
  const out = el('div', { class: 'calendar-link' });
  const show = (url) => {
    clear(out);
    const input = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Calendar link', dataset: { calendar: 'url' } });
    out.append(input, el('button', {
      type: 'button', class: 'secondary mini', text: 'Copy',
      onClick: async () => { input.select(); try { await navigator.clipboard.writeText(url); toast('Calendar link copied.', 'good'); } catch { toast('Select the link and copy it.', 'warn'); } },
    }), el('p', { class: 'small', text: 'Add it to your calendar as a calendar from the internet (Outlook: Add calendar → Subscribe from web; Google: Other calendars → From URL). Keep it to yourself: anybody with the link can read the deadlines.' }));
  };
  block.append(
    el('p', { class: 'small', text: 'A link your calendar subscribes to: each week\'s TAWR deadline, with a reminder the day before, and every day of approved access — kept up to date by the server.' }),
    el('div', { class: 'inline' }, [
      el('button', {
        type: 'button', class: 'mini', dataset: { action: 'calendar-link' }, text: 'Make my calendar link',
        onClick: async () => {
          try { show(await S.calendarLink()); } catch (err) { toast(err.message, 'bad'); }
        },
      }),
      el('button', {
        type: 'button', class: 'secondary mini', dataset: { action: 'calendar-stop' }, text: 'Stop my link',
        onClick: async () => {
          if (!(await confirmDialog({ title: 'Stop your calendar link?', message: 'A calendar subscribed to it stops updating. Making a new link replaces it.', confirmLabel: 'Stop it' }))) return;
          try { await S.stopCalendarLink(); clear(out); toast('Your calendar link no longer works.', 'good'); } catch (err) { toast(err.message, 'bad'); }
        },
      }),
    ]),
    out,
  );
  return block;
}
