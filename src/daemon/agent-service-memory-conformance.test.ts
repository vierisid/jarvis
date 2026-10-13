import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from './agent-service';
import { ConvOrchestrator } from '../agents/conv/conv-orchestrator';
import { TaskDispatcher, type TaskRunner } from '../agents/conv/task-dispatcher';
import { TaskRegistry } from '../agents/conv/task-registry';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, correctFact, findFacts } from '../vault/facts';
import { saveUserProfile } from '../vault/user-profile';
import { withMemoryRecall } from '../vault/memory-use-context';
import { MemoryForget } from '../brief/memory-forget';
import type { JarvisConfig } from '../config/types';
import type { RoleDefinition } from '../roles/types';
import type { LLMMessage, LLMProvider, LLMResponse } from '../llm/provider';

let dir: string, file: string, saved: string | undefined;
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_MEMORY_USAGE; delete process.env.JARVIS_BRIEF_MEMORY_USAGE;
  dir = mkdtempSync(join(tmpdir(), 'q16-agent-')); file = join(dir, 'vault.db'); initDatabase(file, { quiet: true });
});
afterEach(() => {
  closeDb(); rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = saved;
});
const response: LLMResponse = { content: 'Fixture answer', model: 'fixture', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } };
const role = { id: 'fixture', name: 'Fixture', description: 'Test only', responsibilities: [], autonomous_actions: [], approval_required: [],
  authority_level: 5, tools: [], sub_roles: [], kpis: [] } as unknown as RoleDefinition;
function change(id: string, mutation: 'correct' | 'forget') {
  if (mutation === 'correct') { correctFact(id, 'Current value', 'Owner correction'); return; }
  const service = new MemoryForget(getDb(), () => true), ready = service.get(id);
  if (ready.state !== 'ready') throw Error('Missing fact');
  service.forget(id, { requestId: crypto.randomUUID(), expectedRevision: ready.revision, confirmed: true });
}
function stack(routerFirst: boolean, provider: LLMProvider) {
  const service = new AgentService({} as JarvisConfig), manager = service.getLLMManager(), orch = service.getOrchestrator();
  Object.assign(service, { role }); manager.registerProvider(provider);
  manager.setTierMap({ low: { provider: 'fixture' }, medium: { provider: 'fixture' }, ...(routerFirst ? { conversation: { provider: 'fixture' } } : {}) });
  orch.setLLMManager(manager); orch.createPrimary(role);
  if (routerFirst) {
    const registry = new TaskRegistry();
    const dispatcher = new TaskDispatcher(manager, registry, async () => ({ kind: 'completed', text: 'Task', conversation: [] }));
    Object.assign(service, { convOrchestrator: new ConvOrchestrator(manager, registry, dispatcher, 'Fixture') });
  }
  return { service, manager, orch };
}
for (const router of [false, true]) for (const source of ['profile', 'recall'] as const) for (const mutation of ['correct', 'forget'] as const) {
  test(`${router ? 'router' : 'classic'} chat fences ${source} ${mutation} and rebuilds on the next turn`, async () => {
    const fact = source === 'profile'
      ? (saveUserProfile({ preferred_name: 'Ada Finch', interests: 'Original value' }), findFacts({ predicate: 'interests' })[0]!)
      : createFact(createEntity('person', 'Ada Finch').id, 'editor', 'Original value', { confirmed: true });
    const seen: LLMMessage[][] = [];
    const provider: LLMProvider = { name: 'fixture', listModels: async () => [],
      chat: async messages => { seen.push(structuredClone(messages)); return response; },
      async *stream(messages) { seen.push(structuredClone(messages)); yield { type: 'done', response }; } };
    const { service, manager } = stack(router, provider);
    // Pause at the manager entry, after real service preparation but before its
    // existing handoff guard. This also exercises lazy stream consumption.
    let pending = true;
    for (const name of ['chat', 'chatTier', 'stream', 'streamTier'] as const) {
      const original = manager[name].bind(manager);
      (manager as any)[name] = (...args: any[]) => {
        if (pending) { pending = false; change(fact.id, mutation); }
        return (original as any)(...args);
      };
    }
    const events = [];
    for await (const event of service.streamMessage('Ada Finch editor interests').stream) events.push(event);
    expect(seen).toHaveLength(0); expect(JSON.stringify(events)).toMatch(/changed|forgotten/);
    for await (const _event of service.streamMessage('Ada Finch editor interests').stream) {}
    expect(seen).toHaveLength(1);
    const systems = seen.flat().filter(m => m.role === 'system');
    expect(JSON.stringify(systems)).not.toContain('Original value');
    if (mutation === 'correct') expect(JSON.stringify(systems)).toContain('Current value');
    expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
  });
}
for (const mutation of ['correct', 'forget'] as const) test(`paused task refreshes memory after ${mutation} and disk restart`, async () => {
  const fact = createFact(createEntity('person', 'Ada Finch').id, 'editor', 'Original value', { confirmed: true });
  const seen: LLMMessage[][] = []; let pause = true;
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], async *stream() {}, chat: async messages => {
    seen.push(structuredClone(messages));
    if (pause) { pause = false; return { ...response, content: '', finish_reason: 'tool_use', tool_calls: [{ id: 'clarify', name: 'ask_for_clarification', arguments: { question: 'Continue?' } }] }; }
    return response;
  } };
  const makeDispatcher = () => {
    const { service, manager, orch } = stack(false, provider);
    const registry = new TaskRegistry({ db: () => getDb() }); registry.hydrate();
    const runner: TaskRunner = async args => withMemoryRecall(() => orch.processTaskCall({
      systemPrompt: service.buildFullSystemPromptParts('conv', 'Ada Finch editor'), userMessage: args.originalMessage,
      tier: args.tier, subsystem: args.subsystem, history: args.history as LLMMessage[] | undefined, signal: args.signal, scope: null,
    }));
    return { registry, dispatcher: new TaskDispatcher(manager, registry, runner) };
  };
  const first = makeDispatcher();
  const paused = await first.dispatcher.dispatch({ tier: 'medium', template: 'write', intent: 'Ada Finch editor' }, { scope: null });
  expect(paused.status).toBe('needs_input');
  expect(JSON.stringify(seen[0])).toContain('Original value');
  expect(first.registry.get(paused.task_id)!.pausedConversation!.some(m => (m as LLMMessage).role === 'system')).toBe(false);
  const stored = getDb().query('SELECT intent, original_message, paused_conversation FROM tasks WHERE id = ?').get(paused.task_id);
  change(fact.id, mutation); closeDb(); initDatabase(file, { quiet: true });
  expect(getDb().query('SELECT intent, original_message, paused_conversation FROM tasks WHERE id = ?').get(paused.task_id)).toEqual(stored);
  seen.length = 0;
  const resumed = await makeDispatcher().dispatcher.resume(paused.task_id, 'Continue', { scope: null });
  expect(resumed.status).toBe('completed');
  expect(JSON.stringify(seen.flat().filter(m => m.role === 'system'))).not.toContain('Original value');
  if (mutation === 'correct') expect(JSON.stringify(seen)).toContain('Current value');
  expect(JSON.stringify(seen)).toContain('Continue');
});
