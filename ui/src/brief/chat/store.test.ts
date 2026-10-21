import { expect, test } from 'bun:test';
import type { BriefChatEvent, BriefChatPayload, BriefConversation } from '../../../../src/brief/contracts';
import type { ConversationMessage } from '../../../../src/vault/conversations';
import { ConversationStore, orderedActivities, type ChatSnapshot } from './store';
import type { BriefAttachmentRef } from '../../../../src/brief/attachment-contracts';

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

test('activity rows retain their first position and final phase across delayed starts and reconnect', () => {
  const store = fixture();
  const activity = (sequence: number, activityId: string, phase: 'started' | 'completed' | 'failed') => event(sequence, {
    kind: 'activity', activity: { activityId, kind: 'tool', order: activityId === 'first' ? 1 : 2, phase, summary: 'Safe fixed label.', refs: [] },
  });
  store.applyEvent(activity(2, 'second', 'started'), 10);
  expect(orderedActivities(store.getSnapshot().conversations.a!)[0]?.live).toBe(true);
  store.applyEvent(activity(3, 'first', 'failed'), 10);
  store.applyEvent(activity(1, 'first', 'started'), 10);
  store.applyEvent(activity(4, 'first', 'completed'), 10);
  const rows = orderedActivities(store.getSnapshot().conversations.a!);
  expect(rows.map(row => [row.activityId, row.phase, row.firstSequence, row.live])).toEqual([
    ['first', 'failed', 1, false], ['second', 'started', 2, true],
  ]);
  store.applySnapshot(snapshot(4, '', [activity(1, 'first', 'started'), activity(2, 'second', 'started'), activity(3, 'first', 'failed')]));
  expect(orderedActivities(store.getSnapshot().conversations.a!).map(row => [row.activityId, row.phase, row.live])).toEqual([
    ['first', 'failed', false], ['second', 'started', false],
  ]);
  expect(store.getSnapshot().conversations.b!.activity).toEqual({});
});

for (const source of ['event', 'snapshot-message', 'snapshot-turn', 'history'] as const) test(`canonical ${source} consumes attachments in a stale window and prevents resurrection`, () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const other = fixture(storage);
  const sent = { attachmentId: 'sent', name: 'sent.txt', mediaType: 'text/plain', size: 3, state: 'ready' as const };
  const newer = { ...sent, attachmentId: 'newer' };
  other.setAttachments('a', [sent]);
  const store = fixture(storage), stale = store.getSnapshot().conversations.a!.attachments;
  other.setAttachments('a', [sent, newer]);
  store.setDraft('a', 'Keep my next question');
  store.setAttachments('b', [{ ...sent, attachmentId: 'b-file' }]);
  const ref: BriefAttachmentRef = { ...sent, conversationId: 'a', kind: 'document', sha256: 'fixture', expiresAt: Date.now() + 60_000, state: 'accepted', turnId: 'turn-a' };
  const message: ConversationMessage = { ...row('user-a', 'Sent'), role: 'user', attachments: [ref] };
  if (source === 'event') store.applyEvent(event(1, { kind: 'message', message: { conversationId: 'a', turnId: 'turn-a', requestId: 'request-a', messageId: message.id, role: 'user', content: message.content, createdAt: message.created_at, attachments: [ref] } }), 10);
  else if (source === 'history') store.applyHistory('a', { items: [message], nextCursor: null });
  else {
    const sync = snapshot(1, 'Reply');
    if (source === 'snapshot-message') sync.messages.items.push(message);
    else sync.turns[0]!.attachments = [ref];
    store.applySnapshot(sync);
  }
  expect(store.getSnapshot().conversations.a!.attachments).toEqual([newer]);
  expect(store.getSnapshot().conversations.a!.draft).toBe('Keep my next question');
  expect(store.getSnapshot().conversations.b!.attachments[0]?.attachmentId).toBe('b-file');
  // A delayed composer operation must not resurrect an already bound ID.
  store.setAttachments('a', [...stale, newer]);
  expect(store.getSnapshot().conversations.a!.attachments).toEqual([newer]);
  expect(fixture(storage).getSnapshot().conversations.a!.attachments).toEqual([newer]);
});

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

/** A Storage-shaped fake with removal and enumeration, like window.localStorage. */
function deviceStorage(records = new Map<string, string>()) {
  return { records, getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); }, key: (index: number) => [...records.keys()][index] ?? null, get length() { return records.size; } };
}
const fieldKey = (id: string, field: string) => `jarvis.brief.chat.v1.workspace.field.${id}.${field}`;
const closed = (id: string) => ({ ...conversation(id), tab: { open: false, order: 0 } });
const file = (attachmentId: string) => ({ attachmentId, name: attachmentId, size: 1, mediaType: 'text/plain' });
/** Same storage, but every attachments write fails as if over quota. Keeps the live length getter. */
function quotaOnAttachments(storage: ReturnType<typeof deviceStorage>) {
  return { getItem: storage.getItem, removeItem: storage.removeItem, key: storage.key, get length() { return storage.length; },
    setItem: (key: string, value: string) => { if (key.endsWith('.attachments')) throw new Error('Quota'); storage.setItem(key, value); } };
}

test('a used and closed conversation leaves no storage keys, while an unsent draft survives close and reload (#1088)', () => {
  const storage = deviceStorage(), store = fixture(storage);
  store.setVisible(true);
  store.applyEvent(event(3, { kind: 'delta', messageId: 'answer', text: 'x' }), 10);
  store.applyEvent(event(2, { kind: 'delta', messageId: 'answer-b', text: 'y' }, 'b'), 10);
  store.setScroll('a', { top: 420, atBottom: false });
  store.setDraft('a', 'sent text'); store.acceptDraft('a', 'sent text');
  store.setAttachments('a', [{ attachmentId: 'file', name: 'file.txt', size: 4, mediaType: 'text/plain' }]); store.acceptAttachments('a', ['file']);
  store.setScroll('b', { top: 7, atBottom: false }); store.setDraft('b', 'unsent B');
  expect([...storage.records.keys()].filter(key => key.includes('.field.a.')).sort()).toEqual([fieldKey('a', 'readSequence'), fieldKey('a', 'scroll')]);
  store.putConversation(closed('a')); store.putConversation(closed('b'));
  expect([...storage.records.keys()]).toEqual([fieldKey('b', 'draft')]);
  // Reopening in this window restores its view; a fresh window reopens with the draft only.
  store.putConversation(conversation('a'), true);
  expect(storage.records.get(fieldKey('a', 'scroll'))).toBe(JSON.stringify({ top: 420, atBottom: false }));
  const fresh = new ConversationStore(storage);
  fresh.restoreTabs({ workspaceId: 'workspace', activeConversationId: 'b', revision: '1', tabs: [conversation('b')] });
  expect(fresh.getSnapshot().conversations.b).toMatchObject({ draft: 'unsent B', scroll: { top: 0, atBottom: true } });
});

test('opening a workspace sweeps view keys of conversations that are not open, never drafts or attachments (#1088)', () => {
  const records = new Map<string, string>([
    [fieldKey('gone', 'scroll'), JSON.stringify({ top: 9, atBottom: false })], [fieldKey('gone', 'readSequence'), '12'],
    [fieldKey('gone', 'unread'), '["m"]'], [fieldKey('gone', 'draft'), '"keep"'],
    [fieldKey('gone', 'attachments'), JSON.stringify([{ attachmentId: 'f', name: 'f', size: 1, mediaType: 'text/plain' }])],
    [fieldKey('a', 'scroll'), JSON.stringify({ top: 5, atBottom: false })],
    ['jarvis.brief.chat.v1.other.field.gone.scroll', '{"top":1,"atBottom":false}'], ['unrelated', 'x'],
  ]);
  const store = fixture(deviceStorage(records));
  expect([...records.keys()].sort()).toEqual([fieldKey('a', 'scroll'), fieldKey('gone', 'attachments'), fieldKey('gone', 'draft'),
    'jarvis.brief.chat.v1.other.field.gone.scroll', 'unrelated'].sort());
  expect(store.getSnapshot().conversations.a?.scroll.top).toBe(5);
  store.putConversation({ ...conversation('gone'), tab: { open: true, order: 2 } });
  expect(store.getSnapshot().conversations.gone).toMatchObject({ draft: 'keep', scroll: { top: 0 }, readSequence: 0 });
});

test('a field another window cleared reads empty, and acceptance does not revive its attachments (#1088)', () => {
  const storage = deviceStorage(), first = fixture(storage);
  first.setDraft('a', 'old draft'); first.setAttachments('a', [file('one'), file('two')]);
  const second = fixture(storage);
  second.setDraft('a', ''); second.setAttachments('a', []);
  expect(storage.records.has(fieldKey('a', 'draft'))).toBe(false); expect(storage.records.has(fieldKey('a', 'attachments'))).toBe(false);
  first.acceptAttachments('a', ['one']);
  expect(first.getSnapshot().conversations.a?.attachments).toEqual([]);
  expect(fixture(storage).getSnapshot().conversations.a).toMatchObject({ draft: '', attachments: [] });
});

test('clearing a legacy draft stores the empty value so the legacy copy cannot come back (#1088)', () => {
  const key = 'jarvis.brief.chat.v1.workspace';
  const legacy = JSON.stringify({ version: 1, conversations: { a: { draft: 'Legacy draft', attachments: [], scroll: { top: 3, atBottom: false }, unread: [], readSequence: 0 } } });
  const storage = deviceStorage(new Map([[key, legacy]])), store = fixture(storage);
  store.setDraft('a', ''); store.setScroll('a', { top: 0, atBottom: true });
  expect(fixture(storage).getSnapshot().conversations.a).toMatchObject({ draft: '', scroll: { top: 0, atBottom: true } });
  expect(storage.records.get(key)).toBe(legacy);
});

test('references this window could not save survive acceptance of another reference (#1088)', () => {
  const store = fixture(quotaOnAttachments(deviceStorage()));
  store.setAttachments('a', [file('one'), file('two')]);
  expect(store.getSnapshot().persistenceError).toContain('could not be saved');
  store.acceptAttachments('a', ['one']);
  expect(store.getSnapshot().conversations.a?.attachments.map(item => item.attachmentId)).toEqual(['two']);
});

test('a legacy reference does not make this window drop references it could not save (#1088)', () => {
  const legacy = JSON.stringify({ version: 1, conversations: { a: { draft: '', attachments: [file('legacy')], scroll: { top: 0, atBottom: true }, unread: [], readSequence: 0 } } });
  const store = fixture(quotaOnAttachments(deviceStorage(new Map([['jarvis.brief.chat.v1.workspace', legacy]]))));
  expect(store.getSnapshot().conversations.a?.attachments.map(item => item.attachmentId)).toEqual(['legacy']);
  store.setAttachments('a', [file('legacy'), file('new')]);
  store.acceptAttachments('a', ['legacy']);
  expect(store.getSnapshot().conversations.a?.attachments.map(item => item.attachmentId)).toEqual(['new']);
});

test('the sweep runs once per workspace load, not on every tab restore (#1088)', () => {
  const storage = deviceStorage(), store = fixture(storage);
  storage.setItem(fieldKey('elsewhere', 'scroll'), JSON.stringify({ top: 3, atBottom: false }));
  store.restoreTabs({ workspaceId: 'workspace', activeConversationId: 'b', revision: '2', tabs: [conversation('a'), conversation('b', 1)] });
  expect(storage.records.has(fieldKey('elsewhere', 'scroll'))).toBe(true);
  fixture(storage);
  expect(storage.records.has(fieldKey('elsewhere', 'scroll'))).toBe(false);
});

test('a window that only read saved references sees another window clear them (#1088)', () => {
  const storage = deviceStorage();
  fixture(storage).setAttachments('a', [file('one'), file('two')]);
  const reader = fixture(storage);
  expect(reader.getSnapshot().conversations.a?.attachments).toHaveLength(2);
  fixture(storage).setAttachments('a', []);
  reader.acceptAttachments('a', ['one']);
  expect(reader.getSnapshot().conversations.a?.attachments).toEqual([]);
});

test('references saved after this window cleared its own list survive a quota failure (#1088)', () => {
  const inner = deviceStorage(); let full = false;
  const storage = { ...quotaOnAttachments(inner), get length() { return inner.length; },
    setItem: (key: string, value: string) => { if (full && key.endsWith('.attachments')) throw new Error('Quota'); inner.setItem(key, value); } };
  const store = fixture(storage);
  store.setAttachments('a', [file('one')]); store.setAttachments('a', []);
  expect(inner.records.has(fieldKey('a', 'attachments'))).toBe(false);
  full = true; store.setAttachments('a', [file('two'), file('three')]);
  store.acceptAttachments('a', ['two']);
  expect(store.getSnapshot().conversations.a?.attachments.map(item => item.attachmentId)).toEqual(['three']);
});

test('switching workspaces away and back forgets which keys this window saw (#1088)', () => {
  const inner = deviceStorage(); let full = false;
  const storage = { ...quotaOnAttachments(inner), get length() { return inner.length; },
    setItem: (key: string, value: string) => { if (full && key.endsWith('.attachments')) throw new Error('Quota'); inner.setItem(key, value); } };
  const store = fixture(storage);
  store.setAttachments('a', [file('one')]);
  fixture(inner).setAttachments('a', []);
  store.restoreTabs({ workspaceId: 'other', activeConversationId: 'a', revision: '1', tabs: [conversation('a', 0, 'other')] });
  store.restoreTabs({ workspaceId: 'workspace', activeConversationId: 'a', revision: '1', tabs: [conversation('a')] });
  full = true; store.setAttachments('a', [file('two'), file('three')]);
  store.acceptAttachments('a', ['two']);
  expect(store.getSnapshot().conversations.a?.attachments.map(item => item.attachmentId)).toEqual(['three']);
});
