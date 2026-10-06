import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { ToolRegistry } from '../actions/tools/registry';
import { reportExecutionActivity } from '../actions/progress-context';
import type { LLMStreamEvent } from '../llm/provider';
import type { WSMessage } from '../comms/websocket';
import { BriefConversationProvider } from './conversations';
import { BriefChatTransport, type ScopedChatInput } from './chat-transport';
import { BriefCapabilities } from './capabilities';
import { registerConversations } from './registrations/conversations';
import { registerChatTransport } from './registrations/chat-transport';
import { registerChatProgress } from './registrations/chat-progress';
import type { BriefActivity, BriefChatEvent, BriefSendTurn } from './contracts';
import { ConversationStore, orderedActivities } from '../../ui/src/brief/chat/store';
import { ChatTurnRepository } from '../vault/chat-turns';
import { createGoal } from '../vault/goals';
import { createFact } from '../vault/facts';
import { createEntity } from '../vault/entities';

afterEach(() => closeDb());
const done = (): LLMStreamEvent => ({ type: 'done', response: { content: 'Answer', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' } });
const activities = (events: BriefChatEvent[]) => events.flatMap(event => event.payload.kind === 'activity' ? [event.payload.activity] : []);
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('Fixture timed out'); await Bun.sleep(1); } }
function fixture(script: (input: ScopedChatInput) => AsyncIterable<LLMStreamEvent>, enabled = true, registered = true) {
  initDatabase(':memory:', { quiet: true });
  const conversations = new BriefConversationProvider();
  const frames = new Map<ServerWebSocket<unknown>, WSMessage[]>();
  const transport = new BriefChatTransport({ db: getDb(), concurrency: 2, send: (socket, event) => frames.get(socket)!.push(event),
    runner: { ready: () => true, stream: input => ({ stream: script(input), onComplete: async () => {} }) } });
  const caps = new BriefCapabilities([...registerConversations(conversations), ...registerChatTransport(transport), ...(registered ? registerChatProgress(transport) : [])],
    ['conversations', 'chatTransport', ...(enabled ? ['chatProgress' as const] : [])]);
  const client = () => { const socket = {} as ServerWebSocket<unknown>; frames.set(socket, []); return socket; };
  const input = (name: string): BriefSendTurn => ({ conversationId: conversations.repository.create({ title: name }).conversationId, turnId: `turn-${name}`, requestId: `request-${name}`, text: name });
  const send = (socket: ServerWebSocket<unknown>, payload: BriefSendTurn) => transport.handle({ type: 'brief_chat_send', payload, timestamp: 0 }, socket, caps);
  const events = (socket: ServerWebSocket<unknown>) => frames.get(socket)!.flatMap(frame => frame.type === 'brief_chat_event' ? [frame.payload as BriefChatEvent] : []);
  return { transport, conversations, frames, caps, client, input, send, events };
}

for (const [enabled, registered] of [[true, true], [false, true], [true, false]] as const) test(`typed progress is opt-in and requires its live provider (enabled=${enabled}, registered=${registered})`, async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'Fixture', category: 'files', parameters: {}, execute: async () => 'PRIVATE RESULT' });
  const f = fixture(async function* () { await registry.execute('read_file', { token: 'PRIVATE ARGUMENT' }); yield done(); }, enabled, registered);
  const socket = f.client();
  try {
    await f.send(socket, f.input('A')); await f.transport.idle();
    const rows = activities(f.events(socket));
    expect(rows).toHaveLength(enabled && registered ? 2 : 0);
    if (rows.length) {
      expect(rows.map(row => row.phase)).toEqual(['started', 'completed']);
      expect(rows[0]?.activityId).toBe(rows[1]?.activityId);
    }
    expect(JSON.stringify(f.frames.get(socket))).not.toContain('PRIVATE');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('canonical evidence references expose only existing IDs, never stored goal or fact content', async () => {
  let goalId = '', factId = '';
  const f = fixture(async function* () {
    reportExecutionActivity({ kind: 'task', executionId: 'task', phase: 'completed', refs: [
      { kind: 'goal', id: goalId }, { kind: 'fact', id: factId }, { kind: 'goal', id: 'absent' }, { kind: 'run', id: 'absent' },
    ] });
    yield done();
  });
  const socket = f.client();
  try {
    goalId = createGoal('PRIVATE goal title', 'objective', { description: 'PRIVATE goal details' }).id;
    factId = createFact(createEntity('person', 'PRIVATE name').id, 'fixture', 'PRIVATE fact value').id;
    await f.send(socket, f.input('A')); await f.transport.idle();
    expect(activities(f.events(socket))).toHaveLength(1);
    expect(activities(f.events(socket))[0]?.refs).toEqual([
      { kind: 'goal', id: goalId, revision: null }, { kind: 'fact', id: factId, revision: null },
    ]);
    expect(JSON.stringify(f.frames.get(socket))).not.toContain('PRIVATE');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('interleaved real tools stay in their originating conversations and late completion cannot undo cancellation', async () => {
  const releases = new Map<string, () => void>();
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Fixture', category: 'browser', parameters: {}, execute: args => new Promise(resolve => {
    releases.set(String(args.name), () => resolve('PRIVATE malicious source text'));
  }) });
  const f = fixture(async function* (input) { await registry.execute('web_search', { name: input.text, token: 'PRIVATE' }); yield done(); });
  const a = f.input('A'), b = f.input('B'), ownerA = f.client(), ownerB = f.client(), legacy = f.client();
  try {
    await f.send(ownerA, a); await f.send(ownerB, b); await until(() => releases.size === 2);
    await f.transport.handle({ type: 'brief_chat_cancel', payload: { conversationId: a.conversationId, turnId: a.turnId, requestId: a.requestId }, timestamp: 0 }, ownerA, f.caps);
    releases.get('A')!(); releases.get('B')!(); await f.transport.idle();
    expect(activities(f.events(ownerA)).map(row => row.phase)).toEqual(['started', 'failed']);
    expect(activities(f.events(ownerB)).map(row => row.phase)).toEqual(['started', 'completed']);
    expect(f.events(ownerA).every(event => event.conversationId === a.conversationId)).toBe(true);
    expect(f.events(ownerB).every(event => event.conversationId === b.conversationId)).toBe(true);
    expect(f.events(legacy)).toEqual([]); expect(JSON.stringify([...f.frames.values()])).not.toContain('PRIVATE');
    expect(f.transport.repository.get(a).state).toBe('cancelled'); expect(f.transport.repository.get(b).state).toBe('completed');
  } finally { for (const release of releases.values()) release(); f.transport.stop(); await f.transport.idle(); }
});

test('tool failure stays distinct from a completed answer; paged replay restores identical still, ordered rows', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'Fixture', category: 'files', parameters: {}, execute: async () => { throw Error('PRIVATE fake credential error'); } });
  const f = fixture(async function* () {
    reportExecutionActivity({ kind: 'task', executionId: 'PRIVATE intent', phase: 'started' });
    try { await registry.execute('read_file', { secret: 'PRIVATE' }); } catch { /* The model can still answer about a failed tool. */ }
    for (let i = 0; i < 510; i++) yield { type: 'text', text: '.' };
    reportExecutionActivity({ kind: 'task', executionId: 'PRIVATE intent', phase: 'completed' });
    reportExecutionActivity({ kind: 'task', executionId: 'PRIVATE intent', phase: 'started' });
    yield done();
  });
  const socket = f.client(), input = f.input('A');
  try {
    await f.send(socket, input); await f.transport.idle();
    const live = new ConversationStore(); live.restoreTabs(f.conversations.repository.tabs());
    for (const event of f.events(socket)) live.applyEvent(event, 10);
    const restored = new ConversationStore(); restored.restoreTabs(f.conversations.repository.tabs());
    let after = 0, pages = 0;
    while (true) {
      const snapshot = f.transport.repository.snapshot(input.conversationId, after); pages++;
      restored.applySnapshot({ ...snapshot, subscribed: !snapshot.hasMore });
      expect(orderedActivities(restored.getSnapshot().conversations[input.conversationId]!).every(row => !row.live)).toBe(true);
      if (!snapshot.hasMore) break; after = snapshot.nextSequence;
    }
    const rows = orderedActivities(restored.getSnapshot().conversations[input.conversationId]!);
    expect(pages).toBeGreaterThan(1);
    expect(rows.map(row => [row.kind, row.phase])).toEqual([['task', 'completed'], ['tool', 'failed']]);
    expect(rows).toEqual(orderedActivities(live.getSnapshot().conversations[input.conversationId]!));
    expect(restored.getSnapshot().conversations[input.conversationId]?.turns[input.turnId]?.state).toBe('completed');
    expect(JSON.stringify(f.frames.get(socket))).not.toContain('PRIVATE');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('restart settles unfinished activities once without claiming an interrupted answer succeeded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f06-recovery-'));
  try {
    const file = join(directory, 'fixture.db'); initDatabase(file, { quiet: true });
    let repository = new ChatTurnRepository(getDb());
    const input = { conversationId: repository.conversations.create().conversationId, turnId: 'turn', requestId: 'request', text: 'Hello' };
    repository.accept(input); repository.start(input);
    const activity: BriefActivity = { activityId: 'stable-activity', kind: 'tool', order: 1, phase: 'started', summary: 'Reading a file.', refs: [] };
    repository.activity(input, { kind: 'activity', activity });
    closeDb(); initDatabase(file, { quiet: true }); repository = new ChatTurnRepository(getDb());
    repository.recover(); const snapshot = repository.snapshot(input.conversationId, 0); repository.recover();
    expect(repository.snapshot(input.conversationId, 0)).toEqual(snapshot);
    expect(activities(snapshot.events).map(row => [row.activityId, row.phase])).toEqual([['stable-activity', 'started'], ['stable-activity', 'failed']]);
    expect(repository.get(input).state).toBe('failed');
    expect(repository.activity(input, { kind: 'activity', activity: { ...activity, phase: 'completed' } })).toBeNull();
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});
