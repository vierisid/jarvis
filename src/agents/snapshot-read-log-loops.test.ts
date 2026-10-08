/**
 * #827: every orchestrator tool loop runs its tool calls inside a snapshot read
 * log of its OWN, so a remote browser card raised in that loop binds the
 * snapshot the loop read rather than the newest one any default-scope caller
 * took.
 *
 * The binding itself is proven in remote-snapshot-binding.test.ts against
 * explicit logs. This pins the other half, which those tests cannot see: that
 * `processMessage`, `streamMessage` and `processTaskCall` actually enter one,
 * that it is the same log for every call in one loop (or a snapshot and the
 * click after it would not meet), and a different one for each loop (or two
 * turns would share a record, which is the bug).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../llm/provider.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { currentLoopSnapshotReadLog, type SnapshotReadLog } from '../actions/tools/snapshot-read-log.ts';
import type { RoleDefinition } from '../roles/types.ts';

/**
 * Emits a `read_file` call until the buffer it is handed holds two tool
 * results, then a final text. Stateless, so the same provider drives a second
 * loop on the same orchestrator: only user and assistant text persist between
 * loops, so each loop's buffer starts with no tool results.
 */
class TwoCallProvider implements LLMProvider {
  name = 'reads';
  private next(m: LLMMessage[]): LLMResponse {
    const done = m.filter((x) => x.role === 'tool').length;
    if (done < 2) {
      const call: LLMToolCall = { id: 'c' + String(done + 1), name: 'read_file', arguments: {} };
      return { content: '', tool_calls: [call], usage: { input_tokens: 1, output_tokens: 1 }, model: 'reads', finish_reason: 'tool_use' };
    }
    return { content: 'done', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'reads', finish_reason: 'stop' };
  }
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> { return this.next(m); }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = this.next(m);
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    if (response.content) yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['reads']; }
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['file-ops'], authority_level: 10,
} as unknown as RoleDefinition;

const AUTHORITY = (): AuthorityConfig => ({
  default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
});

function build() {
  closeDb();
  initDatabase(':memory:');
  const seen: Array<SnapshotReadLog | undefined> = [];
  const llm = new LLMManager();
  const provider = new TwoCallProvider();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file', description: 't', category: 'file-ops', parameters: {},
    execute: async () => { seen.push(currentLoopSnapshotReadLog()); return 'ok'; },
  });
  const orch = new AgentOrchestrator();
  orch.setLLMManager(llm);
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(AUTHORITY()));
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(new AuditTrail());
  orch.createPrimary(ROLE);
  return { orch, seen };
}

const PROMPT = { static: 'role', dynamic: 'dyn' };

const LOOPS: Array<[string, (orch: AgentOrchestrator) => Promise<unknown>]> = [
  ['processMessage', (orch) => orch.processMessage(PROMPT, 'go', 'medium', 'reads', null)],
  ['streamMessage', async (orch) => {
    for await (const _ of orch.streamMessage(PROMPT, 'go', 'medium', 'reads', undefined, null)) { /* drain */ }
  }],
  ['processTaskCall', (orch) => orch.processTaskCall({ systemPrompt: PROMPT, userMessage: 'go', tier: 'medium', subsystem: 'reads', scope: null })],
];

afterEach(() => closeDb());

describe('each orchestrator loop reads into a snapshot log of its own (#827)', () => {
  for (const [name, run] of LOOPS) {
    test(name + ': one log for the whole loop, a fresh one for the next', async () => {
      const { orch, seen } = build();
      await run(orch);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeDefined();
      // The snapshot and the click after it in one loop must meet in one log.
      expect(seen[1]).toBe(seen[0]);

      // The next loop on the SAME orchestrator gets its own, or two turns on
      // two channels would share a record again.
      await run(orch);
      expect(seen).toHaveLength(4);
      expect(seen[2]).toBeDefined();
      expect(seen[2]).not.toBe(seen[0]);
      expect(seen[3]).toBe(seen[2]);
    });
  }
});

describe('a resumed task that replays a browser read fails closed (#827, review SEC-003)', () => {
  const resume = (history: LLMMessage[]) => async (orch: AgentOrchestrator) =>
    orch.processTaskCall({ systemPrompt: PROMPT, userMessage: 'the second one', tier: 'medium', subsystem: 'reads', scope: null, history });
  const withCall = (name: string): LLMMessage[] => [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'h1', name, arguments: {} }] },
    { role: 'tool', content: 'Page: x', tool_call_id: 'h1' },
  ];

  test('a buffer holding a browser_snapshot reply marks the log', async () => {
    const { orch, seen } = build();
    await resume(withCall('browser_snapshot'))(orch);
    expect(seen[0]?.resumedWithReads).toBe(true);
  });

  test('a buffer holding a browser_navigate reply marks the log', async () => {
    const { orch, seen } = build();
    await resume(withCall('browser_navigate'))(orch);
    expect(seen[0]?.resumedWithReads).toBe(true);
  });

  test('a buffer with no browser read, and a fresh call, do not', async () => {
    const { orch, seen } = build();
    await resume(withCall('read_file'))(orch);
    expect(seen[0]?.resumedWithReads).toBe(false);
    await LOOPS[2]![1](orch);
    expect(seen.at(-1)?.resumedWithReads).toBe(false);
  });
});
