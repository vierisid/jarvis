import { expect, test } from 'bun:test';
import type { BriefChatEvent, BriefChatPayload, BriefConversation } from '../../../../src/brief/contracts';
import type { ConversationMessage } from '../../../../src/vault/conversations';
import { ConversationStore, type ChatSnapshot } from './store';

const conversation = (id: string, order = 0, workspaceId = 'workspace'): BriefConversation => ({ conversationId: id, workspaceId, title: id, revision: '1', tab: { open: true, order }, lastMessageAt: null });
const row = (id: string, content: string, created_at = 10): ConversationMessage => ({ id, content, conversation_id: 'a', role: 'assistant', created_at, tool_calls: null });
const event = (sequence: number, payload: BriefChatPayload, conversationId = 'a'): BriefChatEvent => ({ conversationId, turnId: `turn-${conversationId}`, requestId: `request-${conversationId}`, eventId: `event-${conversationId}-${sequence}`, sequence, payload });
const snapshot = (sequence: number, content: string, events: BriefChatEvent[] = []): ChatSnapshot => ({ conversationId: 'a', sequence, nextSequence: sequence, hasMore: false, subscribed: true, events,
  turns: [{ conversationId: 'a', turnId: 'turn-a', requestId: 'request-a', state: 'running', speak: false, attachments: [], userMessageId: 'user-a', assistantMessageId: 'answer', createdAt: 9 }],
  messages: { items: [row('answer', content)], nextCursor: 'older' } });
function fixture(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const store = new ConversationStore(storage);
  store.restoreTabs({ workspaceId: 'workspace', activeConversationId: 'a', revision: '1', tabs: [conversation('a'), conversation('b', 1)] });
  return store;
}

test('out-of-order and duplicate events reconstruct ordered text and never regress a terminal turn', () => {
  const store = fixture(); store.setVisible(true);
  store.applyEvent(event(7, { kind: 'terminal', state: 'completed' }), 10);
  store.applyEvent(event(5, { kind: 'delta', messageId: 'answer', text: 'world' }), 10);
  store.applyEvent(event(3, { kind: 'status', state: 'running' }), 10);
  const first = event(4, { kind: 'delta', messageId: 'answer', text: 'Hello ' });
  store.applyEvent(first, 10); store.applyEvent(first, 10);
  expect(store.getSnapshot().conversations.a?.messages.map(m => m.content)).toEqual(['Hello world']);
  expect(store.getSnapshot().conversations.a?.turns['turn-a']?.state).toBe('completed');
  expect(store.getSnapshot().conversations.a?.unread).toEqual([]);
  expect(store.getSnapshot().conversations.b?.messages).toEqual([]);
});

test('canonical snapshots do not double replay text, regress newer text or reset consumed history', () => {
  const store = fixture();
  store.applyEvent(event(5, { kind: 'delta', messageId: 'answer', text: 'world' }), 10);
  store.applySnapshot(snapshot(5, 'Hello world', [event(4, { kind: 'delta', messageId: 'answer', text: 'Hello ' })]));
  store.applyHistory('a', { items: [row('old', 'Old answer', 1)], nextCursor: null });
  store.applyEvent(event(8, { kind: 'delta', messageId: 'answer', text: '!' }), 10);
  store.applySnapshot(snapshot(6, 'Hello world', [event(5, { kind: 'delta', messageId: 'answer', text: 'world' })]));
  store.applySnapshot(snapshot(2, 'stale'));
  expect(store.getSnapshot().conversations.a?.messages.map(m => m.content)).toEqual(['Old answer', 'Hello world!']);
  expect(store.getSnapshot().conversations.a?.history.cursor).toBeNull();
  expect(store.getSnapshot().conversations.a?.sequence).toBe(8);
});

test('late history fills missing IDs without overwriting live output or selected conversation', () => {
  const store = fixture();
  store.applyEvent(event(2, { kind: 'delta', messageId: 'answer', text: 'New text' }), 10);
  store.select('b'); store.setDraft('b', 'Keep B');
  store.applyHistory('a', { items: [row('old', 'Old', 1), row('answer', 'New')], nextCursor: null });
  expect(store.getSnapshot().activeId).toBe('b');
  expect(store.getSnapshot().conversations.b?.draft).toBe('Keep B');
  expect(store.getSnapshot().conversations.b?.messages).toEqual([]);
  expect(store.getSnapshot().conversations.a?.messages.map(m => m.content)).toEqual(['Old', 'New text']);
});

test('activity and approval transitions are scoped, deduplicated and monotonic', () => {
  const store = fixture();
  store.applyEvent(event(10, { kind: 'activity', activity: { activityId: 'activity', phase: 'completed', summary: 'Done', refs: [] } }), 10);
  store.applyEvent(event(8, { kind: 'activity', activity: { activityId: 'activity', phase: 'started', summary: 'Starting', refs: [] } }), 10);
  store.applyEvent(event(11, { kind: 'approval', approvalId: 'approval', status: 'approved' }), 10);
  store.applyEvent(event(9, { kind: 'approval', approvalId: 'approval', status: 'pending' }), 10);
  expect(store.getSnapshot().conversations.a?.activity.activity?.phase).toBe('completed');
  expect(store.getSnapshot().conversations.a?.approvals.approval?.status).toBe('approved');
  expect(Object.keys(store.getSnapshot().conversations.b?.activity ?? {})).toHaveLength(0);
});

test('draft, attachment references, scroll and unread survive reload, with workspace isolation', () => {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const store = fixture(storage);
  store.setDraft('a', 'Draft A'); store.setDraft('b', 'Draft B');
  store.setAttachments('a', [{ attachmentId: 'file', name: 'file.txt', size: 4, mediaType: 'text/plain' }]);
  store.setScroll('a', { top: 321, atBottom: false });
  const delta = event(4, { kind: 'delta', messageId: 'answer', text: 'Secret canonical output' });
  store.applyEvent(delta, 10); store.applyEvent(delta, 10);
  expect(store.getSnapshot().conversations.a?.unread).toEqual(['answer']);
  expect([...records.values()].join()).not.toContain('Secret canonical output');
  const restored = fixture(storage);
  expect(restored.getSnapshot().conversations.a).toMatchObject({ draft: 'Draft A', scroll: { top: 321, atBottom: false }, unread: ['answer'] });
  expect(restored.getSnapshot().conversations.a?.attachments[0]?.attachmentId).toBe('file');
  restored.setVisible(true); restored.applyEvent(delta, 10);
  expect(restored.getSnapshot().conversations.a?.unread).toEqual([]);
  restored.select('b'); restored.applyEvent(delta, 10);
  expect(restored.getSnapshot().conversations.a?.unread).toEqual([]);
  restored.restoreTabs({ workspaceId: 'other', activeConversationId: 'a', revision: '1', tabs: [conversation('a', 0, 'other')] });
  expect(restored.getSnapshot().conversations.a?.draft).toBe('');
  expect(restored.getSnapshot().conversations.a?.attachments).toEqual([]);
});

test('unread is per answer, remains while the panel is hidden, and clears only for the viewed chat', () => {
  const store = fixture();
  for (const sequence of [1, 2, 3]) store.applyEvent(event(sequence, { kind: 'delta', messageId: 'answer', text: 'x' }), 10);
  store.applyEvent(event(1, { kind: 'delta', messageId: 'answer-b', text: 'y' }, 'b'), 10);
  expect(store.getSnapshot().conversations.a?.unread).toHaveLength(1);
  store.setVisible(true);
  expect(store.getSnapshot().conversations.a?.unread).toEqual([]);
  expect(store.getSnapshot().conversations.b?.unread).toEqual(['answer-b']);
  store.select('b'); expect(store.getSnapshot().conversations.b?.unread).toEqual([]);
});

test('corrupt or quota-limited storage leaves chat usable and reports failed persistence', () => {
  const store = fixture({ getItem: () => '{invalid', setItem: () => { throw new Error('Quota'); } });
  store.setDraft('a', 'Still here');
  expect(store.getSnapshot().conversations.a?.draft).toBe('Still here');
  expect(store.getSnapshot().persistenceError).toContain('could not be saved');
});

test('compacting a stream retains older locally received messages outside the snapshot tail', () => {
  const store = fixture();
  store.applyEvent(event(1, { kind: 'message', message: { conversationId: 'a', turnId: 'turn-a', requestId: 'request-a', messageId: 'older-user', role: 'user', content: 'Keep this history', createdAt: 1 } }), 1);
  store.applySnapshot(snapshot(5, 'Latest answer'));
  expect(store.getSnapshot().conversations.a?.messages.map(m => m.content)).toEqual(['Keep this history', 'Latest answer']);
});

test('other windows cannot overwrite a saved draft or attachment by scrolling or receiving events', () => {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const first = fixture(storage), second = fixture(storage);
  first.setDraft('a', 'New draft in first window');
  first.setAttachments('a', [{ attachmentId: 'file-a', name: 'A', size: 1, mediaType: 'text/plain' }]);
  second.setScroll('a', { top: 200, atBottom: false });
  second.applyEvent(event(1, { kind: 'delta', messageId: 'background', text: 'B update' }, 'b'), 10);
  second.setDraft('b', 'Independent B draft');
  expect(fixture(storage).getSnapshot().conversations.a?.draft).toBe('New draft in first window');
  first.setVisible(true);
  let restored = fixture(storage);
  expect(restored.getSnapshot().conversations.a?.draft).toBe('New draft in first window');
  expect(restored.getSnapshot().conversations.a?.attachments[0]?.attachmentId).toBe('file-a');
  expect(restored.getSnapshot().conversations.a?.scroll.top).toBe(200);
  expect(restored.getSnapshot().conversations.b?.draft).toBe('Independent B draft');
  // An explicit edit to the same field wins, but unrelated later writes cannot undo it.
  second.setDraft('a', 'Latest explicit edit'); first.setScroll('b', { top: 5, atBottom: false });
  restored = fixture(storage);
  expect(restored.getSnapshot().conversations.a?.draft).toBe('Latest explicit edit');
});

test('legacy drafts remain readable while new field writes preserve concurrent edits', () => {
  const key = 'jarvis.brief.chat.v1.workspace';
  const legacy = JSON.stringify({ version: 1, conversations: { a: { draft: 'Legacy draft', attachments: [], scroll: { top: 3, atBottom: false }, unread: [], readSequence: 0 } } });
  const records = new Map([[key, legacy]]);
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const first = fixture(storage), second = fixture(storage);
  expect(first.getSnapshot().conversations.a?.draft).toBe('Legacy draft');
  first.setDraft('a', 'Updated'); second.setScroll('a', { top: 10, atBottom: false });
  expect(fixture(storage).getSnapshot().conversations.a).toMatchObject({ draft: 'Updated', scroll: { top: 10 } });
  expect(records.get(key)).toBe(legacy);
});

test('replayed failure stays scoped and does not replace a later successful turn', () => {
  const store = fixture();
  const failure = event(2, { kind: 'terminal', state: 'failed', error: { code: 'failed', message: 'Old failure' } });
  store.applyEvent(event(1, { kind: 'message', message: { conversationId: 'a', turnId: 'turn-a', requestId: 'request-a', messageId: 'user', role: 'user', content: 'First', createdAt: 1 } }), 1);
  store.applyEvent(failure, 1);
  store.select('b');
  expect(store.getSnapshot().conversations.b?.error).toBeNull();
  const next = { conversationId: 'a', turnId: 'next', requestId: 'next-request' };
  store.applyEvent({ ...next, eventId: 'next-user', sequence: 3, payload: { kind: 'message', message: { ...next, messageId: 'next-user', role: 'user', content: 'Again', createdAt: 3 } } }, 3);
  store.applyEvent({ ...next, eventId: 'next-done', sequence: 4, payload: { kind: 'terminal', state: 'completed' } }, 3);
  store.applyEvent(failure, 1);
  expect(store.getSnapshot().conversations.a?.error).toBeNull();
  expect(store.getSnapshot().conversations.a?.turns['turn-a']?.error?.message).toBe('Old failure');
});
