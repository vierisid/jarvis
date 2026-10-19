import { beforeEach, afterEach, test, expect } from 'bun:test';
import { AgentService } from './agent-service';
import { ConvOrchestrator } from '../agents/conv/conv-orchestrator';
import { TaskDispatcher } from '../agents/conv/task-dispatcher';
import { TaskRegistry } from '../agents/conv/task-registry';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { saveUserProfile } from '../vault/user-profile';
import { findFacts } from '../vault/facts';
import { MemoryForget } from '../brief/memory-forget';
import type { JarvisConfig } from '../config/types';
import type { RoleDefinition } from '../roles/types';
import type { LLMMessage, LLMProvider, LLMResponse } from '../llm/provider';

let saved: string | undefined;
beforeEach(() => { saved = process.env.JARVIS_BRIEF_MEMORY_USAGE; delete process.env.JARVIS_BRIEF_MEMORY_USAGE; initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = saved; });
const response: LLMResponse = { content: 'Fixture answer', model: 'fixture', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } };
const role = { id: 'fixture', name: 'Fixture', description: 'Test only', responsibilities: [], autonomous_actions: [], approval_required: [],
  authority_level: 5, tools: [], sub_roles: [], kpis: [] } as unknown as RoleDefinition;
for (const routerFirst of [false, true]) test(`real ${routerFirst ? 'router-first' : 'classic'} legacy AgentService refuses forgotten prepared profile and rebuilds next turn`, async () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'PRIVATE chemistry', work_role: 'Founder' });
  const fact = findFacts({ predicate: 'interests' })[0]!;
  const forget = new MemoryForget(getDb(), () => true), ready = forget.get(fact.id);
  if (ready.state !== 'ready') throw Error('Missing fixture');
  const seen: LLMMessage[][] = [];
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [],
    chat: async messages => { seen.push(structuredClone(messages)); return response; },
    async *stream(messages) { seen.push(structuredClone(messages)); yield { type: 'text', text: response.content }; yield { type: 'done', response }; } };
  const service = new AgentService({} as JarvisConfig), manager = service.getLLMManager(), orch = service.getOrchestrator();
  Object.assign(service, { role }); manager.registerProvider(provider);
  manager.setTierMap({ medium: { provider: 'fixture' }, ...(routerFirst ? { conversation: { provider: 'fixture' } } : {}) });
  orch.setLLMManager(manager); orch.createPrimary(role);
  if (routerFirst) {
    const registry = new TaskRegistry();
    const dispatcher = new TaskDispatcher(manager, registry, async () => ({ kind: 'completed', text: 'Task', conversation: [] }));
    Object.assign(service, { convOrchestrator: new ConvOrchestrator(manager, registry, dispatcher, 'Fixture') });
  }
  // Interrupt precisely after profile preparation, before the real provider hook.
  const key = routerFirst ? 'buildUserProfileBlock' : 'buildFullSystemPromptParts';
  const original = (service as any)[key].bind(service);
  (service as any)[key] = (...args: any[]) => {
    const built = original(...args); (service as any)[key] = original;
    forget.forget(fact.id, { requestId: 'forget-profile', expectedRevision: ready.revision, confirmed: true });
    return built;
  };
  const events = [];
  for await (const event of service.streamMessage('Hello').stream) events.push(event);
  expect(seen).toHaveLength(0); expect(JSON.stringify(events)).toContain('forgotten');
  for await (const _event of service.streamMessage('Hello again').stream) {}
  expect(seen).toHaveLength(1); expect(JSON.stringify(seen)).not.toContain('PRIVATE chemistry');
  expect(JSON.stringify(seen)).toContain('Founder');
  expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});

test('new realtime instructions withhold a forgotten profile name while retaining separate configured identity', () => {
  saveUserProfile({ preferred_name: 'Ada' });
  const fact = findFacts({ predicate: 'preferred_name' })[0]!, forget = new MemoryForget(getDb(), () => true);
  const ready = forget.get(fact.id); if (ready.state !== 'ready') throw Error('Missing fixture');
  forget.forget(fact.id, { requestId: 'forget-name', expectedRevision: ready.revision, confirmed: true });
  expect(new AgentService({} as JarvisConfig).buildRealtimeVoiceInstructions()).not.toContain('Ada');
  expect(new AgentService({ user: { name: 'Configured identity' } } as JarvisConfig).buildRealtimeVoiceInstructions()).toContain('Configured identity');
});
