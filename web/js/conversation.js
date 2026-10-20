/**
 * A request's conversation: what the requester and the Track Allocation
 * Manager said about it, with the reasons given for its decisions, as one
 * thread — and what in it is new to whoever is reading.
 *
 * Comments are kept on the request they were said about, append-only (the
 * server's `tawr_comments`, or the request itself on the static site). A
 * revision starts with none of its own, so a request's thread is its own and
 * those of the requests it replaced: the one it revises (`supersedes`, back to
 * the first) and those consolidated into it (`merged_into`), each line saying
 * which. A reason given with a step — a rejection, BART's denial, a
 * cancellation — is already in the request's history, and is read from there.
 *
 * What is new to somebody is a comment by somebody else newer than the last
 * one they were shown (`seen_comment`, kept per person by the server).
 *
 * Pure: no DOM — tests/test_tawr.mjs reads it.
 *
 * Imports: nothing.
 */

/** The steps whose reason belongs in the conversation, as the thread names them. */
const STEPS = {
  reject: 'Rejected', deny: 'Denied by BART', cancel: 'Cancelled', approve: 'Approved',
  withdraw: 'Withdrawn', reopen: 'Reopened', revise: 'Revised',
};

const when = (iso) => Date.parse(iso) || 0;

/** The request and those it replaced, nearest first: `[{ record, how }]`, `how` null for the request itself. */
export function family(record, records = []) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const out = [];
  const seen = new Set();
  const visit = (r, how) => {
    if (!r || seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ record: r, how });
    if (r.supersedes) visit(byId.get(r.supersedes), 'revised');
    for (const m of records) if (m.merged_into === r.id) visit(m, 'consolidated');
  };
  visit(record, null);
  return out;
}

/**
 * The thread, oldest first: `[{ kind: 'comment' | 'step', id?, at, by, by_id?,
 * label?, text, on }]` — `on` is `{ id, how }` for a line said about a request
 * this one replaced, null for its own.
 */
export function thread(record, records = []) {
  const items = [];
  for (const { record: r, how } of family(record, records)) {
    const on = how ? { id: r.id, how } : null;
    for (const c of r.comments || []) items.push({ kind: 'comment', id: c.id, at: c.at, by: c.by, by_id: c.by_id, text: c.text, on });
    for (const h of r.history || []) {
      if (!h.note) continue;
      const label = STEPS[h.action] || String(h.action).replace(/^./, (x) => x.toUpperCase());
      items.push({ kind: 'step', at: h.at, by: h.by, label, text: h.note, on });
    }
  }
  return items.sort((a, b) => when(a.at) - when(b.at) || (a.kind === 'step' ? -1 : 1));
}

/** The comments on a request that are new to `userId`: somebody else's, newer than the last they were shown. */
export function unread(record, userId) {
  const seen = Number(record?.seen_comment) || 0;
  return (record?.comments || []).filter((c) => c.id > seen && String(c.by_id) !== String(userId));
}

/** The newest comment on a request: what to mark as shown once its thread is open. */
export function newestComment(record) {
  return (record?.comments || []).reduce((m, c) => Math.max(m, c.id), 0);
}
