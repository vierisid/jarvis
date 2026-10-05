import { afterEach, expect, test } from 'bun:test';
import { AgentService } from './agent-service.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { ConvOrchestrator, type ConvTaskEvent } from '../agents/conv/conv-orchestrator.ts';
import { TaskDispatcher } from '../agents/conv/task-dispatcher.ts';
import { TaskRegistry } from '../agents/conv/task-registry.ts';
import { LLMManager } from '../llm/manager.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { ScopedChatInput } from '../brief/chat-transport.ts';

afterEach(() => closeDb());
const role = { id: 'fixture', name: 'Fixture', authority_level: 5, tools: [], sub_roles: [] } as unknown as RoleDefinition;
const response = (content = ''): LLMResponse => ({ content, tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' });
async function collect(stream: AsyncIterable<LLMStreamEvent | unknown>) { const result: unknown[] = []; for await (const event of stream) result.push(event); return result; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('Fixture timed out'); await Bun.sleep(1); } }
const input = (name: string, controller: AbortController): ScopedChatInput => ({ conversationId: name, turnId: `turn-${name}`, requestId: `request-${name}`,
  text: `Question ${name}`, history: [{ role: 'user', content: `Private history ${name}` }], contextKey: `brief:workspace:${name}`, signal: controller.signal });

test('classic scoped AgentService streams never read or mutate the shared primary history', async () => {
  initDatabase(':memory:', { quiet: true });
  const captured = new Map<string, { messages: LLMMessage[]; signal: AbortSignal; release: () => void }>();
  const provider: LLMProvider = {
    name: 'fixture', listModels: async () => [], chat: async () => response(),
    async *stream(messages, options) {
      const text = String(messages.at(-1)!.content);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const signal = options!.signal!;
      const stop = () => release();
      signal.addEventListener('abort', stop, { once: true });
      captured.set(text, { messages: structuredClone(messages), signal, release });
      try {
        yield { type: 'text', text: `Reply ${text}` };
        await gate; signal.throwIfAborted();
        yield { type: 'done', response: response(`Reply ${text}`) };
      } finally { signal.removeEventListener('abort', stop); }
    },
  };
  const service = new AgentService({} as JarvisConfig);
  const manager = service.getLLMManager(); manager.registerProvider(provider); manager.setTierMap({ medium: { provider: 'fixture' } });
  const orchestrator = service.getOrchestrator(); orchestrator.setLLMManager(manager); const primary = orchestrator.createPrimary(role);
  primary.addMessage('user', 'LEGACY PRIVATE HISTORY');
  const before = structuredClone(primary.getMessages());
  const a = new AbortController(), b = new AbortController();
  const stream = (name: string, controller: AbortController) => { const turn = input(name, controller); return service.streamMessage(turn.text, 'websocket', undefined, null, turn.contextKey, turn).stream; };
  const first = collect(stream('A', a)).then(() => null, error => error);
  const second = collect(stream('B', b));
  await until(() => captured.size === 2);
  a.abort(new Error('A stopped')); captured.get('Question B')!.release();
  expect(await first).toBeInstanceOf(Error); await second;
  expect(captured.get('Question A')!.signal.aborted).toBe(true);
  expect(captured.get('Question B')!.signal.aborted).toBe(false);
  for (const name of ['A', 'B']) {
    const text = JSON.stringify(captured.get(`Question ${name}`)!.messages);
    expect(text).toContain(`Private history ${name}`);
    expect(text).not.toContain(`Private history ${name === 'A' ? 'B' : 'A'}`);
    expect(text).not.toContain('LEGACY PRIVATE HISTORY');
  }
  expect(primary.getMessages()).toEqual(before);
});

test('a cancelled classic turn cannot dispatch a late tool call', async () => {
  initDatabase(':memory:', { quiet: true });
  const abort = new AbortController(); let executions = 0;
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], chat: async () => response(),
    async *stream() {
      yield { type: 'tool_call', tool_call: { id: 'late', name: 'fixture_tool', arguments: {} } };
      yield { type: 'done', response: { ...response(), finish_reason: 'tool_use' } };
    } };
  const manager = new LLMManager(); manager.registerProvider(provider); manager.setTierMap({ medium: { provider: 'fixture' } });
  const tools = new ToolRegistry(); tools.register({ name: 'fixture_tool', description: 'Fixture', category: 'file-ops', parameters: {}, execute: async () => { executions++; return 'done'; } });
  const orchestrator = new AgentOrchestrator(); orchestrator.createPrimary(role); orchestrator.setLLMManager(manager); orchestrator.setToolRegistry(tools);
  const run = async () => {
    for await (const event of orchestrator.streamMessage('system', 'call tool', undefined, undefined, undefined, null, { history: [], contextKey: 'brief:a', signal: abort.signal })) {
      if (event.type === 'tool_call') abort.abort(new Error('Stopped before dispatch'));
    }
  };
  await expect(run()).rejects.toThrow('Stopped before dispatch');
  expect(executions).toBe(0);
});

test('router-first AgentService uses explicit history and compaction identity instead of channel history', async () => {
  initDatabase(':memory:', { quiet: true });
  addMessage(getOrCreateConversation('websocket').id, { role: 'user', content: 'LEGACY CHANNEL SECRET' });
  const seen: LLMMessage[][] = []; const keys: string[] = [];
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], chat: async () => response(),
    async *stream(messages) { seen.push(structuredClone(messages)); yield { type: 'text', text: 'Done' }; yield { type: 'done', response: response('Done') }; } };
  const service = new AgentService({} as JarvisConfig);
  const manager = service.getLLMManager(); manager.registerProvider(provider); manager.setTierMap({ conversation: { provider: 'fixture' } });
  const registry = new TaskRegistry();
  const dispatcher = new TaskDispatcher(manager, registry, async () => ({ kind: 'completed', text: 'Task', conversation: [] }));
  Object.assign(service, { convOrchestrator: new ConvOrchestrator(manager, registry, dispatcher, 'Fixture'),
    dialogueCompactor: { compact: async (key: string, history: LLMMessage[]) => { keys.push(key); return history; } } });
  for (const name of ['A', 'B']) {
    const turn = input(name, new AbortController());
    await collect(service.streamMessage(turn.text, 'websocket', undefined, null, turn.contextKey, turn).stream);
  }
  expect(keys).toEqual(['brief:workspace:A', 'brief:workspace:B']);
  expect(JSON.stringify(seen[0])).toContain('Private history A'); expect(JSON.stringify(seen[0])).not.toContain('Private history B');
  expect(JSON.stringify(seen[1])).toContain('Private history B'); expect(JSON.stringify(seen)).not.toContain('LEGACY CHANNEL SECRET');
});

test('router task progress and cancellation stay with their conversation during concurrent delegation', async () => {
  initDatabase(':memory:', { quiet: true });
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], chat: async () => response(),
    async *stream(messages) {
      if (messages.some(message => message.role === 'tool')) {
        yield { type: 'text', text: 'Finished' }; yield { type: 'done', response: response('Finished') }; return;
      }
      yield { type: 'tool_call', tool_call: { id: crypto.randomUUID(), name: 'delegate', arguments: { tier: 'medium', template: 'write', intent: 'Write response' } } };
      yield { type: 'done', response: { ...response(), finish_reason: 'tool_use' } };
    } };
  const manager = new LLMManager(); manager.registerProvider(provider); manager.setTierMap({ conversation: { provider: 'fixture' }, low: { provider: 'fixture' } });
  const registry = new TaskRegistry();
  const running = new Map<string, { signal: AbortSignal; release: () => void }>();
  const dispatcher = new TaskDispatcher(manager, registry, async args => {
    await new Promise<void>(resolve => {
      const release = () => { args.signal.removeEventListener('abort', release); resolve(); };
      running.set(args.contextKey!, { signal: args.signal, release });
      args.signal.addEventListener('abort', release, { once: true });
    });
    args.signal.throwIfAborted();
    return { kind: 'completed', text: 'Result', conversation: [] };
  });
  const conv = new ConvOrchestrator(manager, registry, dispatcher, 'Fixture');
  const a = new AbortController(), b = new AbortController();
  const eventsA: ConvTaskEvent[] = [], eventsB: ConvTaskEvent[] = [];
  const first = collect(conv.streamTurn('A', {}, { scope: null, contextKey: 'brief:A', signal: a.signal }, event => eventsA.push(event))).then(() => null, error => error);
  await until(() => running.has('brief:A'));
  const second = collect(conv.streamTurn('B', {}, { scope: null, contextKey: 'brief:B', signal: b.signal }, event => eventsB.push(event)));
  await until(() => running.has('brief:B'));
  expect(eventsA.every(event => event.record.contextKey === 'brief:A')).toBe(true);
  expect(eventsB.every(event => event.record.contextKey === 'brief:B')).toBe(true);
  a.abort(new Error('Cancel only A')); running.get('brief:B')!.release();
  expect(await first).toBeInstanceOf(Error); await second;
  expect(running.get('brief:A')!.signal.aborted).toBe(true); expect(running.get('brief:B')!.signal.aborted).toBe(false);
  expect(eventsA.at(-1)?.type).toBe('task_cancelled'); expect(eventsB.at(-1)?.type).toBe('task_completed');
});

test('task-tier cancellation reaches the in-flight model request', async () => {
  initDatabase(':memory:', { quiet: true });
  const abort = new AbortController(); let received: AbortSignal | undefined;
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], async *stream() {},
    async chat(_messages: LLMMessage[], options?: LLMOptions) {
      received = options?.signal;
      return await new Promise<LLMResponse>((_resolve, reject) => received!.addEventListener('abort', () => reject(received!.reason), { once: true }));
    } };
  const manager = new LLMManager(); manager.registerProvider(provider); manager.setTierMap({ medium: { provider: 'fixture' } });
  const orchestrator = new AgentOrchestrator(); orchestrator.setLLMManager(manager);
  const pending = orchestrator.processTaskCall({ systemPrompt: 'system', userMessage: 'task', tier: 'medium', subsystem: 'fixture', scope: null, signal: abort.signal, contextKey: 'brief:a' });
  const result = pending.then(() => null, error => error);
  await until(() => received !== undefined); abort.abort(new Error('Task stopped'));
  expect(await result).toBeInstanceOf(Error); expect(received!.aborted).toBe(true);
});
