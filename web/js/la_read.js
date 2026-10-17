/**
 * Reading a look-ahead: the workbook's grid as a calendar, the marks and names
 * on it, who is away, and what it offers the timeline.
 *
 * Every bundle carries this — the timeline reads the look-ahead for its
 * suggestions, the phone app for its days — so it holds what reading needs and
 * nothing else. Storing a reading as rows and comparing two of them, which
 * only the calendar does, is `core/la_register.js`.
 *
 * **A Resource row belongs to the activity above it.** The workbook names who
 * is on an activity by adding a row underneath whose description reads
 * "Resource", with the names typed into the day cells; where and when are left
 * blank because they are the line above's. So it is read as part of that
 * activity rather than as one of its own — otherwise half the sheet is rows
 * called "Resource" with no location — and a name is never matched to a person
 * here. That happens against the roster, where an unmatched spelling can be
 * shown to somebody instead of guessed at.
 *
 * Copied from cx-timeline (src/core/lookahead.js, the reading half): the
 * workbook import reads a sheet into a calendar with `readGrid()` before
 * `lookahead.js` turns it into rows and cells.
 *
 * Imports: nothing (leaf).
 */

/* ── The Resource row ──────────────────────────────────────────────────── */

/**
 * Is this what the workbook writes under an activity to name who is on it?
 *
 * The 4WLA carries a row directly beneath each activity whose description cell
 * reads "Resource", and the day cells on it hold the names typed against that
 * activity. It is recognised by that one word and nothing else — folded for
 * case and punctuation, but not loosened any further. "Resource Names" is not
 * it: a rule that matched anything containing the word would swallow an
 * activity called "Resource mobilisation", and a row misread as a label is a
 * row of work that vanishes off the calendar.
 */
export function isResourceLabel(text) {
  return /^resources?$/.test(String(text ?? '').toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Which kind of absence a row's description names, or null.
 *
 * The workbook carries rows at the bottom that are not site work: "PTO",
 * "Office" and "Other Group / Project", with names typed into the day cells the
 * same way the Resource row carries them. They say where somebody is when they
 * are not on the project — off, at their desk, or on another group's work —
 * which is a fact about the person rather than about an activity, and it is the
 * fact the week plan and the huddle are otherwise missing entirely: a blank
 * against a name reads as "nobody planned this", when the sheet said exactly
 * why. Only PTO means they were not working; the rest are days like any other,
 * and they carry a category so the reports can group them.
 *
 * Strict for the reason `isResourceLabel()` is strict, and with the same two
 * failures in mind. A row misread as a label is a row of work that vanishes off
 * the calendar; a label misread as work is a row of names at no location that
 * every report then counts as scope. So the spellings are enumerated rather than
 * matched loosely — "Other" alone is not one of them, because it names nothing.
 */
export function absenceKind(text) {
  const folded = String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (/^(pto|paidtimeoff|timeoff|vacation|annualleave|holiday)$/.test(folded)) return 'pto';
  if (/^(office|officeday|inoffice|officebased)$/.test(folded)) return 'office';
  if (/^other(group|project)/.test(folded)) return 'other';
  return null;
}

/**
 * The three facts about each kind, in one table.
 *
 * They were spread across three modules — the label here, whether it counts as
 * leave inside `availability()`, and nothing at all about which category the
 * day belongs to — and the first time a kind was added that was three places to
 * remember. What each one *is*:
 *
 * **`leave`** decides whether the person was there at all. PTO is the only one:
 * somebody in the office or on another group's project is working, they can be
 * asked how the day went, and folding them into leave would put a person who
 * was at their desk down as absent.
 *
 * **`category`** is the seeded `rc_categories` row the day belongs to, matched
 * by name because that is what the schema seeds it as. A renamed category
 * simply stops matching and the day arrives uncategorised — ungrouped in the
 * reports rather than grouped wrongly, which is the right way for a
 * name match to fail.
 */
export const ABSENCE_KINDS = {
  pto:    { label: 'PTO',                   leave: true,  category: null },
  office: { label: 'Office',                leave: false, category: 'Office' },
  other:  { label: 'Other group / project', leave: false, category: 'Other project' },
};

/** What each kind is called on screen. One place, so three views cannot differ. */
export const ABSENCE_LABELS = Object.fromEntries(
  Object.entries(ABSENCE_KINDS).map(([kind, it]) => [kind, it.label])
);

/**
 * The people named in one cell.
 *
 * Typed by hand, so the separator is whatever was to hand: a comma, a slash, a
 * newline, an ampersand, a plus, the word "and", or simply two spaces where somebody
 * pressed the bar twice. Nothing is matched to a person here — that is the
 * roster's job, through the alias register — this only splits what was written.
 *
 * **Spacing is noise, not a name.** A cell reading `Victor ,Rosa` and one
 * reading `Victor, Rosa` are the same two people, so each piece is trimmed and
 * its own internal runs of whitespace are collapsed before it is handed on: a
 * name carrying a stray double space would otherwise fold to a different string
 * from the same name typed once, and match nobody for a reason no reader could
 * see. A newline inside a cell is a separator rather than a space, because that
 * is how a second name gets into one cell in Excel.
 */
export function resourceNames(text) {
  return String(text ?? '')
    /* "and" is tried before the two-space rule on purpose: an alternation is
       read left to right, so `\s{2,}` would otherwise eat the spaces around a
       spelled-out "and" and leave the word behind as a person. */
    .split(/\s+and\s+|[,;/\n&+]|\s{2,}/i)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/**
 * Every mark on an activity, the ones on its Resource row included.
 *
 * Whether a row has work on it is a question about the pair, not about the
 * activity line alone: the workbook sometimes paints the shift on the Resource
 * row instead. Both places that ask — `readGrid()` and the calendar's window —
 * have to ask it the same way, which is why it is a function and not two loops.
 */
export function marksOf(activity) {
  return activity?.resource ? [...activity.marks, ...activity.resource.marks] : (activity?.marks || []);
}

/* ── Reading the grid as a calendar ────────────────────────────────────── */

const WEEKDAYS = ['M', 'TU', 'W', 'TH', 'F', 'SA', 'SU'];

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/**
 * The one month a label names, or -1.
 *
 * A week straddling a boundary is labelled "August/September" in this
 * workbook, and a label naming two months anchors nothing — it is skipped
 * rather than resolved to the first of them.
 */
function oneMonth(label) {
  const text = String(label || '').toUpperCase();
  const hits = new Set();
  MONTH_NAMES.forEach((name, i) => {
    if (text.includes(name) || new RegExp(`\\b${name.slice(0, 3)}\\b`).test(text)) hits.add(i);
  });
  return hits.size === 1 ? [...hits][0] : -1;
}

/**
 * Give every day column a real date, or none of them one.
 *
 * The sheet carries months and day numbers and no year at all, so a year has
 * to come from somewhere else. Two things supply it, and the second is what
 * makes this safe to rely on rather than a guess:
 *
 * **The snapshot's own timestamp** says roughly when the window was current.
 * The look-ahead is maintained four to six weeks out, so the window brackets
 * the day it was read; that narrows the year to one of three candidates.
 *
 * **The weekday letters check the answer.** The sheet writes M, Tu, W beside
 * every day, and only one of the candidate years makes those letters come out
 * right — the same date is a different weekday in adjacent years. So the year
 * is not inferred and hoped for, it is *verified* against something the file
 * already says, and where the letters do not agree no dates are claimed at
 * all and everything that depends on them stands down.
 *
 * Mutates `days`, adding `date` (an ISO string) where it can.
 */
function datePlease(days, anchorISO) {
  if (!days.length) return false;

  /* Day numbers first: they are always present, and a drop from 30 to 1 is a
     month boundary whether or not anybody labelled it. That matters because
     the visible window often starts mid-month, with the label for that month
     sitting in a column the workbook has hidden. */
  const nums = [];
  for (let i = 0; i < days.length; i++) {
    const n = parseInt(String(days[i].day).replace(/\D/g, ''), 10);
    nums.push(Number.isFinite(n) && n >= 1 && n <= 31 ? n : (nums[i - 1] || 0) + 1);
  }

  let anchorAt = -1;
  let anchorMonth = -1;
  for (let i = 0; i < days.length; i++) {
    const m = oneMonth(days[i].label);
    if (m >= 0) { anchorAt = i; anchorMonth = m; break; }
  }
  if (anchorAt < 0) return false;

  const months = new Array(days.length).fill(-1);
  months[anchorAt] = anchorMonth;
  for (let i = anchorAt + 1; i < days.length; i++) {
    months[i] = nums[i] < nums[i - 1] ? (months[i - 1] + 1) % 12 : months[i - 1];
  }
  for (let i = anchorAt - 1; i >= 0; i--) {
    months[i] = nums[i] > nums[i + 1] ? (months[i + 1] + 11) % 12 : months[i + 1];
  }

  // Relative years: the axis only ever runs forwards, so a month going
  // backwards is the turn of a year.
  const rel = [0];
  for (let i = 1; i < days.length; i++) rel.push(rel[i - 1] + (months[i] < months[i - 1] ? 1 : 0));

  const anchorMs = Date.parse(`${String(anchorISO || '').slice(0, 10)}T00:00:00Z`);
  const base = Number.isFinite(anchorMs)
    ? new Date(anchorMs).getUTCFullYear()
    : new Date().getUTCFullYear();

  const LETTERS = ['SU', 'M', 'TU', 'W', 'TH', 'F', 'SA'];
  let bestYear = null;
  let bestScore = -1;
  for (const year of [base - 1, base, base + 1]) {
    let agree = 0;
    for (let i = 0; i < days.length; i++) {
      const ms = Date.UTC(year + rel[i], months[i], nums[i]);
      if (LETTERS[new Date(ms).getUTCDay()] === String(days[i].weekday).trim().toUpperCase()) agree++;
    }
    // Closeness to the snapshot breaks a tie; the letters decide otherwise.
    const mid = Date.UTC(year + rel[rel.length >> 1], months[days.length >> 1], nums[days.length >> 1]);
    const near = Number.isFinite(anchorMs) ? 1 - Math.min(1, Math.abs(mid - anchorMs) / 3.2e10) : 0;
    const score = agree + near;
    if (score > bestScore) { bestScore = score; bestYear = year; }
  }

  // Below this the letters are not agreeing and the reading is wrong. Saying
  // nothing is the only honest answer: a today line on the wrong column is
  // worse than no today line.
  const agreement = Math.floor(bestScore) / days.length;
  if (agreement < 0.9) return false;

  for (let i = 0; i < days.length; i++) {
    days[i].date = new Date(Date.UTC(bestYear + rel[i], months[i], nums[i]))
      .toISOString().slice(0, 10);
    days[i].month = `${MONTH_NAMES[months[i]].slice(0, 3)} ${bestYear + rel[i]}`;
  }
  return true;
}

/**
 * Turn a parsed sheet into something that can be drawn: days across the top,
 * activities down the side.
 *
 * Everything here is *found* rather than configured, and that is the point.
 * The look-ahead is a spreadsheet somebody maintains by hand: rows get
 * inserted, the window scrolls, columns are hidden and unhidden as the weeks
 * move. A layout pinned to "dates start at column H" would be wrong the first
 * time anybody inserted a column, and wrong silently — the grid would still
 * draw, against the wrong days.
 *
 * So the date axis is located by looking for the row of weekday letters, which
 * is the one row on the sheet whose content cannot be mistaken for anything
 * else. The day numbers sit directly above it and the month labels above
 * those; the columns it occupies are the calendar, and everything to the left
 * of them is what the activity *is*.
 *
 * No year is invented. The sheet does not carry one, and a date is not
 * something to infer from a month name — the axis is drawn as the workbook
 * writes it.
 */
export function readGrid(grid, { anchorISO = null } = {}) {
  const rows = (grid?.rows || []).slice().sort((a, b) => a.row - b.row);
  const empty = { days: [], meta: [], headings: [], activities: [], header: null };
  if (!rows.length) return empty;

  // The weekday row: the one where most values are M/Tu/W/Th/F/Sa/Su.
  let header = null;
  let best = 0;
  for (const row of rows) {
    const hits = row.cells.filter((c) => WEEKDAYS.includes(String(c.value ?? '').trim().toUpperCase()));
    if (hits.length > best && hits.length >= 7) {
      best = hits.length;
      header = row;
    }
  }
  if (!header) return empty;

  const dayCols = header.cells
    .filter((c) => WEEKDAYS.includes(String(c.value ?? '').trim().toUpperCase()))
    .map((c) => c.col)
    .sort((a, b) => a - b);
  const dayCol = new Set(dayCols);
  const firstDay = dayCols[0];

  const at = (row, col) => row?.cells.find((c) => c.col === col);
  const above = (n) => rows.filter((r) => r.row < header.row).slice(-n)[0] || null;
  const numbers = above(1);
  const months = above(2);

  /* The month label is a merged cell, so only the leftmost column of each
     block carries it. Carrying the last one forward is what merged means. */
  let month = '';
  const days = dayCols.map((col) => {
    const label = String(at(months, col)?.value ?? '').trim();
    if (label) month = label;
    return {
      col,
      month,
      // What the sheet actually wrote here, as opposed to what was carried
      // across the merge. Only a real label can anchor the calendar.
      label,
      day: String(at(numbers, col)?.value ?? '').trim(),
      weekday: String(at(header, col)?.value ?? '').trim(),
      weekend: ['SA', 'SU'].includes(String(at(header, col)?.value ?? '').trim().toUpperCase()),
    };
  });

  datePlease(days, anchorISO);

  /* The activity columns are whatever is used to the left of the calendar.
     Their headings are not reliably on any one row — this file labels some and
     not others — so they are numbered by position and named where a heading
     happens to exist above the first activity. */
  const body = rows.filter((r) => r.row > header.row);

  /* The row the sheet writes its column headings on.
     "Activity ID, Description of Work Activity, Location, SSWP, Party to Action,
     Work hours" sit together on one row above the calendar, and that row is found
     the way the weekday row is: it is the one, at or above the weekday row, with
     the most text left of the first day. Reading each column's nearest text
     upwards instead — which is what this did — takes whatever is closest, so a
     note typed in a gap row, or a label on the weekday row itself, stood in for
     the real heading of its column and the row of headings never showed. A
     single stray cell cannot win against a row of six. */
  const labelled = (row) => row.cells.filter((c) => c.col < firstDay && String(c.value ?? '').trim());
  let headingRow = null;
  for (const row of rows) {
    if (row.row > header.row) break;
    const count = labelled(row).length;
    if (count >= 2 && count >= (headingRow ? labelled(headingRow).length : 0)) headingRow = row;
  }

  /* The activity columns: every column left of the calendar that the body uses
     or the heading row names. A named column whose cells are all empty is still
     one of the sheet's columns — leaving it out would shift every heading after
     it onto the wrong values in the reader's head. */
  const metaCols = [...new Set([
    ...body.flatMap((r) => labelled(r).map((c) => c.col)),
    ...(headingRow ? labelled(headingRow).map((c) => c.col) : []),
  ])].sort((a, b) => a - b);

  /* What the sheet calls each of those columns: its cell on the heading row,
     and only where that row says nothing, the nearest text above the weekday
     row — the reading a sheet with its headings scattered over rows still needs.
     It is worth reading rather than guessing because one of these columns is the
     location, and knowing *which* is the difference between recording where the
     work is and recording nothing. An unlabelled column is ''. */
  const headings = metaCols.map((col) => {
    const own = String(at(headingRow, col)?.value ?? '').trim();
    if (own) return own;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].row > header.row) continue;
      const text = String(at(rows[i], col)?.value ?? '').trim();
      if (text) return text;
    }
    return '';
  });

  const activities = [];
  for (const row of body) {
    const meta = metaCols.map((col) => String(at(row, col)?.value ?? '').trim());
    const marks = row.cells
      .filter((c) => dayCol.has(c.col) && (String(c.value ?? '').trim() || c.hex))
      .map((c) => ({
        col: c.col,
        value: String(c.value ?? '').trim(),
        hex: c.hex || null,
        meaning: c.meaning || null,
        role: c.role || (c.hex ? 'shift' : null),
      }));

    // A row with neither a description nor a mark is spacing, not work.
    if (!meta.some(Boolean) && !marks.some((m) => m.value)) continue;

    /* A heading is a row whose *activity* cells are painted.
       That is a structural fact rather than a reading of the colour, and it is
       what makes it reliable: the shading that runs along the day columns of
       every row paints only the calendar, never the description beside it. So
       a section title is recognised without anybody having to tell the legend
       which of several near-identical greys means "divider".
       Only the columns *left* of the calendar count. `!dayCol.has(col)` also
       took in anything painted to the right of the last day — a totals column,
       a trailing border — and one of those turns every row in the workbook
       into a heading, which is how a whole file arrived on screen at once. */
    const heading = row.cells.some((c) => c.col < firstDay && c.hex);

    /* "PTO", "Office", "Other Group / Project": rows of names that are not
       site work.
       Unlike the Resource row they stand on their own — they sit at the bottom
       of the sheet and belong to nobody above them, because what they say is
       about the *person*, not about an activity. So they are emitted as rows in
       their own right, marked with the kind, and everything downstream reads
       `absence` to know this is not scope: `rowsFrom()` skips them so they can
       never be counted as work added or removed, and the calendar draws them
       with the names rather than with the activities. */
    const absence = absenceKind(meta.find((value) => absenceKind(value)) || '');
    if (!heading && absence) {
      activities.push({
        row: row.row, id: row.id || null, meta, marks, heading: false, highlighted: false,
        named: true, resource: null, absence,
      });
      continue;
    }

    /* The Resource row the workbook writes under an activity.
       It belongs to the activity above it rather than being one of its own: it
       carries no work of its own, it inherits where and when from the line it
       sits under, and drawn as a separate activity it would be a hundred and
       forty rows of the word "Resource". Its day cells are the names.

       **Directly above means the row directly above, on the sheet.** This used
       to take whichever activity happened to have been pushed last, however far
       up the sheet it was — so anything the parser stepped over on the way down
       silently re-parented the names. A hidden row is the case that bit: the
       workbook hides an activity, `parseSheet()` drops it before this ever sees
       it, and the Resource row underneath attached itself to the activity above
       the hidden one. Nothing on the calendar showed it, because the names were
       drawn against the row they were typed on — but the derived plan booked
       somebody onto an activity that is not in the 4WLA at all, which is exactly
       how it was found. `above.row === row.row - 1` is the whole test: a gap in
       the numbering means *something* was between them — hidden, skipped as
       spacing, or a band — and there is no honest way to say whose names these
       are.

       An orphan is dropped rather than drawn. It is a label row whatever it is
       attached to: pushed as an activity it would be the word "Resource" at no
       location, counted as scope by every report, which is worse than the wrong
       parent it replaces. */
    if (!heading && meta.some(isResourceLabel)) {
      const above = activities[activities.length - 1];
      if (above && above.row === row.row - 1 && !above.heading && !above.absence) {
        above.resource = {
          row: row.row,
          id: row.id || null,
          /* Where and when come from the activity above — that is what the
             workbook means by leaving them blank on this row. Anything typed
             here wins, so a resource working different hours can say so. */
          meta: meta.map((value, i) => value || above.meta[i] || ''),
          marks,
          names: marks.filter((m) => m.value).map((m) => ({ col: m.col, names: resourceNames(m.value) })),
        };
        above.highlighted = marksOf(above).some((m) => m.hex && m.role === 'shift');
      }
      continue;
    }

    /* "Highlighted" means at least one day carries paint that is *work*.
       Tested as `role === 'shift'` rather than `role !== 'ignore'`, which is
       not the same question and got the answer wrong: a `divider` is the grey
       the workbook paints its section bands in, and a row whose only colour is
       a divider or a weekend band has nothing scheduled on it — but it read as
       highlighted and survived into the grid.
       An unmapped colour still counts, because `applyLegend()` gives it
       `shift`: until somebody says what a colour is, the honest assumption is
       that it might be work, and hiding it would bury the rows that most need
       attention. */
    const highlighted = marks.some((m) => m.hex && m.role === 'shift');

    /* Whether anybody wrote down what this row *is*.
       A row of paint with no description is not an activity — it is a band, a
       spacer, or a fill somebody dragged too far — and putting it on the
       calendar asks the reader to work out which. It is hidden with the
       unscheduled rows rather than dropped, so the switch still brings it back. */
    const named = meta.some(Boolean);

    activities.push({ row: row.row, id: row.id || null, meta, marks, heading, highlighted, named, resource: null, absence: null });
  }

  return { days, meta: metaCols, headings, activities, header: header.row };
}

/**
 * Who the sheet says is away, and on which day.
 *
 * One entry per day cell written on a "PTO" or "Other Group / Project" row:
 * `{ kind, row, date, written }`, where `written` is the spelling that was
 * typed. Nothing is matched to a person here — that is the register's job, the
 * same as for the Resource row — and nothing is invented for a day the sheet
 * left blank.
 *
 * Derived at paint time rather than stored, for the reason the whole 4WLA
 * reading is: `rc_leave` is the record of leave somebody *booked*, and writing
 * the workbook into it would make the sheet's authorship indistinguishable from
 * a decision, go stale the moment somebody edited a cell, and need cancelling to
 * correct something nobody ever booked.
 */
export function absencesFrom(view) {
  const dayByCol = new Map((view?.days || []).map((d) => [d.col, d]));
  const out = [];
  for (const activity of view?.activities || []) {
    if (!activity.absence) continue;
    for (const mark of activity.marks) {
      const written = String(mark.value || '').trim();
      if (!written) continue;
      const day = dayByCol.get(mark.col);
      if (!day?.date) continue;
      out.push({ kind: activity.absence, row: activity.row, date: day.date, written });
    }
  }
  return out;
}

/**
 * Which of the activity columns is the location, off the sheet's own heading.
 *
 * Found, like the date axis, rather than configured — for the same reason and
 * with the same failure in mind: a column pinned by letter or by position is
 * wrong the first time somebody inserts one, and wrong *silently*, because the
 * rows still write and every one of them records the wrong place.
 *
 * The heading is what the workbook calls the column, so that is what is read.
 * `-1` means it says nothing recognisable, and the caller falls back to asking
 * the alias register which cell it knows — which is what this module did
 * everywhere before, and still the only answer available on a sheet with no
 * headings at all.
 */
export function locationColumnOf(view) {
  const headings = view?.headings || [];
  for (let i = 0; i < headings.length; i++) {
    if (/\blocations?\b/i.test(headings[i])) return i;
  }
  // "Site" is the other word this project's sheets use for it. Deliberately a
  // short list: a near miss here misfiles every row on the sheet at once.
  for (let i = 0; i < headings.length; i++) {
    if (/\bsite\b/i.test(headings[i])) return i;
  }
  return -1;
}

/**
 * The codes typed on an activity's day, each with whether it is struck out.
 *
 * "X.WIT" is one EIC and one BART witness, pieces between dots, spacing and
 * case ignored. A piece with a leading tilde — "X.~WIT" — is a resource that
 * was asked for and then cancelled while the activity itself went ahead: the
 * editor writes it, the calendar draws it struck through in red, and
 * `rc_cancelled_support_days` puts it in the cancellation log. Written into the
 * text rather than a column of its own so that it travels wherever the cell
 * already does — undo, copy, the published grid, every stored read.
 */
export function cellTokens(text) {
  const out = [];
  for (const piece of String(text ?? '').split('.')) {
    const t = piece.trim();
    const cancelled = t.startsWith('~');
    const code = (cancelled ? t.slice(1) : t).trim().toUpperCase();
    if (code) out.push({ code, cancelled });
  }
  return out;
}

/** "3 X · 1 WIT" — codes counted across days, in the order first met. */
export function countCodes(values, { cancelled = false } = {}) {
  const counts = new Map();
  for (const v of values || []) {
    for (const t of cellTokens(v)) {
      if (t.cancelled !== cancelled) continue;
      counts.set(t.code, (counts.get(t.code) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Whether a legend meaning says a day was cancelled — the one rule, the same
 * word `ingest()` looks for in the legend and `rc_cancelled_days` looks for in
 * the stored cells.
 */
export function isCancelMeaning(meaning) {
  return /cancel/i.test(String(meaning || ''));
}
