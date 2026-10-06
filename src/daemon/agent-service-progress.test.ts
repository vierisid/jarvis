import { afterEach, expect, test } from 'bun:test';
import { AgentService } from './agent-service';
import { initDatabase, closeDb } from '../vault/schema';
import { ToolRegistry } from '../actions/tools/registry';
import { withExecutionProgress } from '../actions/progress-context';
import { BriefProgressProjector } from '../brief/progress';
import type { BriefActivity } from '../brief/contracts';
import type { LLMProvider, LLMResponse } from '../llm/provider';
import type { RoleDefinition } from '../roles/types';
import type { JarvisConfig } from '../config/types';

afterEach(() => closeDb());
test('the real classic model loop reports actual tool failure and never proposed calls or raw provider text as activity', async () => {
  initDatabase(':memory:', { quiet: true });
  const response: LLMResponse = { content: 'Answer', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' };
  let modelCalls = 0, toolCalls = 0;
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], chat: async () => response,
    async *stream() {
      if (modelCalls++ === 0) {
        yield { type: 'tool_call', tool_call: { id: 'PRIVATE model id', name: 'read_file', arguments: { path: 'PRIVATE path' } } };
        yield { type: 'done', response: { ...response, finish_reason: 'tool_use', content: 'PRIVATE generated reasoning' } };
      } else { yield { type: 'text', text: 'Answer' }; yield { type: 'done', response }; }
    } };
  const service = new AgentService({} as JarvisConfig), manager = service.getLLMManager(), orchestrator = service.getOrchestrator();
  manager.registerProvider(provider); manager.setTierMap({ medium: { provider: 'fixture' } }); orchestrator.setLLMManager(manager);
  orchestrator.createPrimary({ id: 'fixture', name: 'Fixture', tools: ['file-ops'], sub_roles: [], authority_level: 5 } as unknown as RoleDefinition);
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'Fixture', category: 'file-ops', parameters: {}, execute: async () => { toolCalls++; throw Error('PRIVATE credential error'); } });
  orchestrator.setToolRegistry(registry);
  const projector = new BriefProgressProjector(), rows: BriefActivity[] = [];
  await withExecutionProgress(event => { const row = projector.project(event); if (row) rows.push(row); }, async () => {
    const input = { conversationId: 'a', turnId: 'turn', requestId: 'request', text: 'Inspect', history: [], contextKey: 'brief:a', signal: new AbortController().signal };
    for await (const _event of service.streamMessage(input.text, 'websocket', undefined, null, input.contextKey, input).stream) { /* Consume model output without any real provider or post-processing. */ }
  });
  expect(toolCalls).toBe(1); expect(modelCalls).toBe(2);
  expect(rows.map(row => row.phase)).toEqual(['started', 'failed']);
  expect(rows[0]?.activityId).toBe(rows[1]?.activityId);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');
});
