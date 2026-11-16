import { expect, test } from 'bun:test';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { dashboardAttentionSnapshot } from '../navigation/notifications';
import { documentDecisionCount, isInProgress, listedNoticeCount, needsYouCount, pendingByWorkflow, plainDecisionTitle, relativeTime, siblingNote } from './needs-you';

const row = (over: Record<string, unknown> = {}) => ({ decisionId: 'x', title: 'Send report', state: 'pending', kind: 'permission', supportedActions: ['approve_permission', 'inspect'], ...over }) as any;

test('one count: document decisions with actions, other rows still asking, and human inputs; nothing approved and waiting', () => {
  // The Today card used to count every document row (inspect-only ones included, which the other list also holds)
  // while the badge counted notifications, so the numbers drifted apart.
  const documents = documentDecisionCount([{ actions: ['approve', 'inspect'] }, { actions: [] }, { actions: [] }]);
  expect(documents).toBe(1);
  const others = [row(), row({ state: 'failed', supportedActions: ['inspect'] }), row({ state: 'awaiting_execution', supportedActions: ['inspect'] }), row({ state: 'in_flight', supportedActions: ['inspect'] })];
  expect(needsYouCount({ documents, others, humanInputs: 2 })).toBe(1 + 2 + 2);
  // An unread other list is unknown, not a reason to hide the rest.
  expect(needsYouCount({ documents, others: null, humanInputs: 2 })).toBe(3);
});

test('approved items waiting to run or running are in progress, everything else still asks', () => {
  expect(isInProgress(row({ state: 'awaiting_execution' }))).toBe(true);
  expect(isInProgress(row({ state: 'in_flight' }))).toBe(true);
  for (const state of ['pending', 'failed', 'blocked', 'unknown', 'denied']) expect(isInProgress(row({ state }))).toBe(false);
});

test('titles are plain words, never raw tool ids', () => {
  expect(plainDecisionTitle(row({ title: 'workflow_ask', state: 'failed', supportedActions: ['inspect'] }))).toBe('A workflow step that asks the AI failed');
  expect(plainDecisionTitle(row({ title: 'read_file', state: 'blocked', supportedActions: ['inspect'] }))).toBe('Reading a file was blocked');
  expect(plainDecisionTitle(row({ title: 'update_leads', state: 'failed', supportedActions: ['inspect'] }))).toBe('Update leads failed');
  expect(plainDecisionTitle(row({ title: 'write_file' }))).toBe('Writing a file needs your permission');
  expect(plainDecisionTitle(row({ title: '' }))).toBe('A workflow request');
  // Real sentences are left alone.
  expect(plainDecisionTitle(row({ title: 'Send notification: Morning reminder' }))).toBe('Send notification: Morning reminder');
});

test('repeat requests from one workflow say so, with a relative time', () => {
  const rows = [1, 2, 3].map(() => row({ review: { workflowName: 'Morning reminder' } })).concat([row({ review: { workflowName: 'Other' } })]);
  const counts = pendingByWorkflow(rows);
  expect(siblingNote(counts.get('Morning reminder'))).toBe('3 waiting from this workflow');
  expect(siblingNote(counts.get('Other'))).toBeNull();
  const now = Date.UTC(2026, 10, 10, 12);
  expect(relativeTime(now - 20_000, now)).toBe('just now');
  expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
  expect(relativeTime(now - 26 * 3_600_000, now)).toBe('1 day ago');
});

test('a held-runs note is never counted, and listed notices add to the count', () => {
  const others = [row(), row({ kind: 'held', state: 'pending', supportedActions: ['inspect'] })];
  expect(needsYouCount({ documents: 0, others, humanInputs: 0 })).toBe(1);
  expect(needsYouCount({ documents: 0, others, humanInputs: 0, notices: 2 })).toBe(3);
});

test('notices count exactly what the room lists: unread rows, and pending approvals only while they are listed', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'n', kind: 'system', title: 't', text: '', timestamp: 1, tone: 'neutral', unread: true, ...over }) as any;
  const items = [
    item({ id: 'stored', stored: true }), item({ id: 'live' }), item({ id: 'read', unread: false }),
    item({ id: 'approval', kind: 'approval', unread: false }),
    // Clarifiers and repeat-backs have their own cards; the caller adds those.
    item({ id: 'clarifier', kind: 'clarifier' }), item({ id: 'repeat', kind: 'repeat-back' }),
  ];
  const decisions = (on: boolean) => new BriefCapabilities([{ id: 'decisions', provider: { readiness: () => 'ready' } as never }], on ? ['decisions'] : []).snapshot();
  // With decisions on, approvals are the permission list's rows, not counted here twice.
  expect(listedNoticeCount(dashboardAttentionSnapshot(true, items, decisions(true)))).toBe(2);
  // With decisions off the room lists the approval, read or not, so it counts.
  expect(listedNoticeCount(dashboardAttentionSnapshot(true, items, decisions(false)))).toBe(3);
  // Disconnected, the list shows nothing, so nothing is counted.
  expect(listedNoticeCount(dashboardAttentionSnapshot(false, items, decisions(true)))).toBe(0);
});
