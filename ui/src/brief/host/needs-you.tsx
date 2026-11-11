import React, { createContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { QueuedDecision } from '../../../../src/brief/decision-contracts';
import { attentionView, type AttentionSnapshot } from '../navigation/notifications';

/**
 * Needs you has four sources: document decisions that offer an action, the
 * other queued decisions (permissions, recoveries, failed or blocked steps),
 * workflow input requests, and what the room lists from the notification owner
 * (unread notifications, saved workflow reminders among them, and voice
 * confirmations). Today, the sidebar badge and the room all count them through
 * `needsYouCount`, so the number is the same everywhere.
 */

/** Approved and waiting to run, or running: nothing is asked of the user any more. */
export const isInProgress = (row: Pick<QueuedDecision, 'state'>) => row.state === 'awaiting_execution' || row.state === 'in_flight';

/** Document decisions the user can act on. Inspect-only rows belong to the other list. */
export const documentDecisionCount = (rows: ReadonlyArray<{ actions: readonly unknown[] }> | null | undefined) =>
  rows?.filter(row => row.actions.length > 0).length ?? 0;

/** A grouped note for runs held behind a workflow's card limit (#1365): read-only, never a decision. */
export const isHeldNote = (row: Pick<QueuedDecision, 'kind'>) => (row.kind as string) === 'held';

/** Rows that still ask something of the user. An unknown (unread) other list counts as none. */
export const needsAttention = (rows: readonly QueuedDecision[] | null) => rows?.filter(row => !isInProgress(row) && !isHeldNote(row)) ?? [];

/**
 * Notification rows the room actually lists that still count: unread ones, and a
 * pending approval (listed here only while decisions are off) even once read. Read
 * notices are history. A list that is not ready shows nothing, so counts nothing.
 */
export function listedNoticeCount(snapshot: AttentionSnapshot): number {
  const view = attentionView(snapshot);
  return view.status === 'ready' ? view.items.filter(item => item.unread || item.source === 'approval').length : 0;
}

export function needsYouCount({ documents, others, humanInputs, notices = 0 }: {
  documents: number; others: readonly QueuedDecision[] | null; humanInputs: number;
  /** Unread notification rows and voice confirmations the room shows. */
  notices?: number;
}): number {
  return documents + needsAttention(others).length + humanInputs + notices;
}

/** "5 min ago" style label; anything under a minute is "just now". */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const TOOL_PHRASES: Record<string, string> = {
  workflow_ask: 'A workflow step that asks the AI', workflow_notify: 'A workflow notification',
  workflow_delegate: 'A workflow step that hands work to an agent', workflow_start: 'A workflow step that starts another workflow',
  workflow_meeting_briefs: 'A workflow step that prepares meeting briefs',
  read_file: 'Reading a file', write_file: 'Writing a file', run_command: 'Running a command', run_skill: 'Running a skill',
};
/** Tool ids carry no spaces and at least one separator. Sentences and names do not look like that. */
const RAW_ID = /^[a-z][a-z0-9]*(?:[_.:][a-z0-9()]+)+$/i;
const VERB: Partial<Record<QueuedDecision['state'], string>> = { failed: 'failed', blocked: 'was blocked', unknown: 'may not have finished', denied: 'was denied', expired: 'expired' };
const phrase = (id: string) => TOOL_PHRASES[id] ?? (id.startsWith('workflow_') ? 'A workflow step' : id.replace(/[_.:()]+/g, ' ').trim().replace(/^./, c => c.toUpperCase()));

/** A card title in plain words. Real sentences pass through; a raw tool id never reaches the screen. */
export function plainDecisionTitle(row: Pick<QueuedDecision, 'title' | 'state' | 'kind' | 'supportedActions'>): string {
  const title = row.title.trim();
  if (!title) return 'A workflow request';
  if (!RAW_ID.test(title)) return title;
  const asks = row.kind === 'permission' && row.supportedActions.includes('approve_permission');
  const verb = asks ? 'needs your permission' : VERB[row.state] ?? (isInProgress(row) ? 'is approved' : 'needs a look');
  return `${phrase(title)} ${verb}`;
}

/** The workflow a row came from, when the server named it. */
export const workflowLabel = (row: Pick<QueuedDecision, 'review' | 'workflow'>) => row.review?.workflowName ?? (row.workflow ? 'Workflow request' : 'Jarvis request');
/** When the request was raised: the run start for permission cards, else the row's own time. */
export const askedAt = (row: Pick<QueuedDecision, 'review' | 'createdAt'>) => row.review?.requestedAt ?? (row.createdAt || null);

/** How many rows of each named workflow are waiting, so repeats can say so. */
export function pendingByWorkflow(rows: readonly QueuedDecision[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) { const name = row.review?.workflowName; if (name) counts.set(name, (counts.get(name) ?? 0) + 1); }
  return counts;
}
export const siblingNote = (count: number | undefined) => count && count > 1 ? `${count} waiting from this workflow` : null;

export type NeedsYouState = { count: number; others: QueuedDecision[] | null; failed: boolean; reload(): void; clear(): void; inbox: ReactNode };
/** Provided once by the workspace so every room reads the same list and count. Absent in isolated renders. */
export const NeedsYouContext = createContext<NeedsYouState | null>(null);

/**
 * Reads the other queued decisions on a timer. `paused` leaves the reading to a shared owner.
 * Each read fetches one document per row, so outside Needs you the owner polls less often.
 */
export function useOtherDecisions(read: () => Promise<QueuedDecision[]>, enabled: boolean, paused = false, intervalMs = 10_000) {
  const [rows, setRows] = useState<QueuedDecision[] | null>(null), [failed, setFailed] = useState(false), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (paused) return;
    let alive = true, reading = false;
    const load = async () => { if (!enabled || reading) return; reading = true;
      try { const next = await read(); if (alive) { setRows(next); setFailed(false); } }
      catch { if (alive) { setRows(null); setFailed(true); } }
      finally { reading = false; }
    };
    void load(); const timer = setInterval(() => void load(), intervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, epoch, paused, intervalMs]);
  const reload = useCallback(() => setEpoch(n => n + 1), []), clear = useCallback(() => setRows(null), []);
  return { rows, failed, reload, clear };
}
