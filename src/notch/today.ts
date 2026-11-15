/**
 * "Today": what Jarvis did since midnight, as one read-only list.
 *
 * Nothing is recorded for it. The list is read, each time it is opened, from
 * what the product already keeps: approved actions with a receipt that says
 * they happened, and promises that were kept. It is the notch's view of those
 * records, not a second record of them.
 *
 * What it leaves out, and why: work that needed no approval is written to the
 * audit trail by tool name only, with no sentence a person could read, so it
 * is not listed. A list of what was done must not guess at what was done.
 */
import { approvalIntentParts, boundedApprovalLabel } from '../authority/approval-delivery.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { NotchBlock } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** One thing that was done. */
export interface NotchTodayRow {
  at: number;
  text: string;
  /** Where the row comes from, for the small word on its right. */
  kind: 'approved' | 'promise' | 'mail';
  /** In place of the small word: what a sent mail cost. */
  small?: string;
}

export interface NotchTodayDeps {
  /** Approved actions, newest first. */
  executedApprovals(limit: number): ApprovalRequest[];
  /** Promises that were kept: `{ what, completed_at }`. */
  keptPromises?(): { what: string; completed_at: number | null }[];
  /** Replies Jarvis sent from the notch since a moment, each with what it cost. */
  sentMail?(since: number): { at: number; text: string; small: string }[];
  now?: () => number;
}

/** The most rows the list shows. */
export const NOTCH_TODAY_MAX = 12;

/** Midnight before `now`, on this machine's clock. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The most of one thing's sentence a row of the list carries. A row wraps, so this is several lines. */
const ROW_CHARS = 220;

/**
 * What an approved action did, as the sentence its approval showed: one
 * line, with a mark if it had to be cut. The toast's own wording of this is
 * cut to a toast's width, which loses the end of a shell command; a row of
 * this list has room for all of it.
 */
function doneSentence(request: ApprovalRequest): string {
  const { action } = approvalIntentParts(request);
  const whole = boundedApprovalLabel(action, action.length).trim();
  const points = [...whole];
  return points.length <= ROW_CHARS ? whole : `${points.slice(0, ROW_CHARS - 1).join('').trimEnd()}…`;
}

/** What was done today, newest first. */
export function notchToday(deps: NotchTodayDeps): NotchTodayRow[] {
  const now = (deps.now ?? Date.now)();
  return notchDoneBetween(deps, startOfDay(now), now);
}

/** What was done between two moments, newest first: the morning and evening lines count it (day.ts). */
export function notchDoneBetween(deps: NotchTodayDeps, since: number, now: number): NotchTodayRow[] {
  const rows: NotchTodayRow[] = [];
  for (const request of deps.executedApprovals(200)) {
    // Done means a receipt that says so: one that was refused, failed, or may
    // not have happened is not listed as done.
    if (request.status !== 'executed' || (request.execution_outcome ?? 'committed') !== 'committed') continue;
    const at = request.executed_at ?? request.decided_at ?? request.created_at;
    if (at < since || at > now) continue;
    const text = doneSentence(request);
    if (text) rows.push({ at, text, kind: 'approved' });
  }
  for (const promise of deps.keptPromises?.() ?? []) {
    const at = promise.completed_at;
    if (at === null || at < since || at > now) continue;
    rows.push({ at, text: promise.what, kind: 'promise' });
  }
  for (const sent of deps.sentMail?.(since) ?? []) {
    if (sent.at < since || sent.at > now) continue;
    const points = [...sent.text];
    rows.push({ at: sent.at, text: points.length <= ROW_CHARS ? sent.text : `${points.slice(0, ROW_CHARS - 1).join('').trimEnd()}…`, kind: 'mail', small: sent.small });
  }
  return rows.sort((a, b) => b.at - a.at);
}

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The list as the blocks of a sheet. */
export function notchTodayBlocks(rows: NotchTodayRow[]): NotchBlock[] {
  if (rows.length === 0) return [{ kind: 'note', say: ['Nothing done yet today.'] }];
  const shown = rows.slice(0, NOTCH_TODAY_MAX);
  const blocks: NotchBlock[] = shown.map((row) => ({
    kind: 'row', lead: clock(row.at), say: [row.text], small: row.kind === 'mail' ? `sent · ${row.small ?? ''}`.replace(/ · $/, '') : row.kind === 'promise' ? 'promised' : 'approved',
  }));
  if (rows.length > shown.length) blocks.push({ kind: 'note', say: [`And ${rows.length - shown.length} more, in the dashboard.`] });
  return blocks;
}

/** What yes at rest opens when nothing waits: the list, until it is closed. */
export function notchTodayScript(deps: NotchTodayDeps): (stage: NotchStage) => Promise<void> {
  return async (stage) => {
    const rows = notchToday(deps);
    const title = rows.length === 0 ? 'Today' : rows.length === 1 ? 'Today: 1 thing done' : `Today: ${rows.length} things done`;
    await stage.sheet([title], notchTodayBlocks(rows));
  };
}
