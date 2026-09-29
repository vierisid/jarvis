/**
 * #571: the classic path and the router-first conv path enforce the site tool
 * scope IDENTICALLY.
 *
 * This is the assertion the issue actually turns on, and it is the one thing
 * neither of the other test files can state on its own: `tool-scope.test.ts`
 * proves the classic loop refuses, `conv/conv-path-scope.test.ts` proves the
 * conv chain refuses, and a fix that MOVED enforcement rather than extending it
 * would leave both of them green.
 *
 * So this drives the same tool call through all three of the orchestrator's
 * tool loops -- `processMessage` (classic non-streaming, and the loop a
 * commitment executes in), `streamMessage` (classic streaming chat, the loop
 * #570 threaded) and `processTaskCall` (the router-first task executor, the
 * loop #571 threaded) -- with the same registry and the same scope, and
 * asserts the outcome is the same in all three: not run, same refusal text,
 * one audit row, ledger untouched.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../llm/provider.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { PROJECT_SITE_CHAT_SCOPE, outOfScopeMessage, type TurnToolScope } from '../actions/tools/tool-scope.ts';
import { resetToolFilterPolicy, setToolFilterPolicy } from '../actions/tools/tool-relevance/policy.ts';
import type { RoleDefinition } from '../roles/types.ts';

/** Emits one tool call, then a final text. Used by all three loops. */
class OneCallProvider implements LLMProvider {
  name = 'parity';
  private calls = 0;
  /**
   * Every buffer the loop sent. This is how the tool RESULT is observed:
   * `processMessage` and `streamMessage` keep their working buffer local and
   * only persist the assistant text, so the refusal is visible where it
   * matters -- in what the next LLM call was handed.
   */
  seen: LLMMessage[][] = [];
  constructor(private readonly toolName: string) {}

  private next(): LLMResponse {
    this.calls++;
    if (this.calls === 1) {
      const call: LLMToolCall = { id: 'c1', name: this.toolName, arguments: {} };
      return {
        content: '', tool_calls: [call], usage: { input_tokens: 1, output_tokens: 1 },
        model: 'parity', finish_reason: 'tool_use',
      };
    }
    return {
      content: 'finished', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
      model: 'parity', finish_reason: 'stop',
    };
  }

  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
    this.seen.push([...m]);
    return this.next();
  }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    this.seen.push([...m]);
    const response = this.next();
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    if (response.content) yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['parity']; }
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['terminal', 'browser', 'file-ops'], authority_level: 10,
} as unknown as RoleDefinition;

const AUTHORITY = (): AuthorityConfig => ({
  default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
});

function build(toolName: string) {
  // Fresh DB per loop. `AuditTrail` writes to the process database, so three
  // orchestrators built in one test would otherwise read each other's rows and
  // the "exactly one out_of_scope row" assertion would count the loop before.
  closeDb();
  initDatabase(':memory:');
  const ran: string[] = [];
  const provider = new OneCallProvider(toolName);

  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });

  const registry = new ToolRegistry();
  const tool = (name: string, category: string): ToolDefinition => ({
    name, description: 't', category, parameters: {},
    execute: async () => { ran.push(name); return 'ok'; },
  });
  for (const t of [
    tool('run_command', 'terminal'), tool('read_file', 'file-ops'), tool('write_file', 'file-ops'),
    tool('list_directory', 'file-ops'), tool('delegate_task', 'delegation'),
    tool('manage_agents', 'delegation'), tool('site_write_file', 'site-builder'),
    tool('site_run_command', 'site-builder'), tool('commitments', 'productivity'),
  ]) registry.register(t);

  const audit = new AuditTrail();
  const orch = new AgentOrchestrator();
  orch.setLLMManager(llm);
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(AUTHORITY()));
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(audit);
  orch.createPrimary(ROLE);
  return { orch, ran, audit, provider };
}

/** The tool message the loop fed back into the NEXT model call. */
function refusalSeenByModel(provider: OneCallProvider): string | null {
  for (const buffer of [...provider.seen].reverse()) {
    const m = [...buffer].reverse().find((x) => x.role === 'tool');
    if (m) return String(m.content);
  }
  return null;
}

type Outcome = {
  ran: string[];
  /** The tool-result text the loop fed back to the model, if any. */
  toolResult: string | null;
  outOfScopeRows: string[];
  ledgerHas: boolean;
};

const PROMPT = { static: 'role', dynamic: 'dyn' };

/** Pull the tool message out of whatever buffer a loop left behind. */
function toolResultFrom(messages: readonly LLMMessage[]): string | null {
  const m = [...messages].reverse().find((x) => x.role === 'tool');
  return m ? String(m.content) : null;
}

async function viaProcessMessage(toolName: string, scope: TurnToolScope | null): Promise<Outcome> {
  const { orch, ran, audit, provider } = build(toolName);
  await orch.processMessage(PROMPT, 'work on the project', 'medium', 'parity', scope);
  return {
    ran,
    toolResult: refusalSeenByModel(provider),
    outOfScopeRows: audit.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope')).map((r) => r.tool_name),
    ledgerHas: ledgerHas(orch, toolName),
  };
}

async function viaStreamMessage(toolName: string, scope: TurnToolScope | null): Promise<Outcome> {
  const { orch, ran, audit, provider } = build(toolName);
  for await (const _ of orch.streamMessage(PROMPT, 'work on the project', 'medium', 'parity', undefined, scope)) {
    // drain
  }
  return {
    ran,
    toolResult: refusalSeenByModel(provider),
    outOfScopeRows: audit.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope')).map((r) => r.tool_name),
    ledgerHas: ledgerHas(orch, toolName),
  };
}

async function viaProcessTaskCall(toolName: string, scope: TurnToolScope | null): Promise<Outcome> {
  const { orch, ran, audit, provider } = build(toolName);
  const result = await orch.processTaskCall({
    systemPrompt: PROMPT,
    userMessage: 'work on the project',
    tier: 'medium',
    subsystem: 'parity',
    scope,
  });
  // Both the persisted task buffer and what the model was handed must carry
  // the refusal; they are the same message.
  const buffer = result.conversation as LLMMessage[];
  expect(toolResultFrom(buffer)).toBe(refusalSeenByModel(provider));
  return {
    ran,
    toolResult: refusalSeenByModel(provider),
    outOfScopeRows: audit.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope')).map((r) => r.tool_name),
    ledgerHas: ledgerHas(orch, toolName),
  };
}

function ledgerHas(orch: AgentOrchestrator, name: string): boolean {
  const primary = orch.getPrimary();
  if (!primary) return false;
  const ledger = (orch as unknown as {
    ledgerFor: (id: string) => { has: (n: string) => boolean };
  }).ledgerFor(primary.id);
  return ledger.has(name);
}

const LOOPS = [
  ['processMessage', viaProcessMessage],
  ['streamMessage', viaStreamMessage],
  ['processTaskCall', viaProcessTaskCall],
] as const;

const WITHHELD = ['run_command', 'read_file', 'write_file', 'list_directory', 'delegate_task', 'manage_agents'];

describe('all three tool loops enforce the scope identically', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
    // ON, because the ledger and the interceptors only exist with the filter
    // engaged, and that is where the widening bug lived.
    setToolFilterPolicy({ enabled: true, maxParamsB: 20, models: [] });
  });
  afterEach(() => { resetToolFilterPolicy(); closeDb(); });

  for (const name of WITHHELD) {
    test(`${name} is refused the same way in every loop`, async () => {
      const outcomes: Record<string, Outcome> = {};
      for (const [label, run] of LOOPS) {
        outcomes[label] = await run(name, PROJECT_SITE_CHAT_SCOPE);
      }
      const expected = outOfScopeMessage(PROJECT_SITE_CHAT_SCOPE, name);
      for (const [label, out] of Object.entries(outcomes)) {
        // Not run.
        expect(`${label}/${name}:ran=${out.ran.join(',')}`).toBe(`${label}/${name}:ran=`);
        // Same refusal text, byte for byte.
        expect(`${label}/${name}`).toBe(`${label}/${name}`);
        expect(out.toolResult).toBe(expected);
        // One audit row, same name.
        expect(`${label}/${name}:${out.outOfScopeRows.join(',')}`)
          .toBe(`${label}/${name}:out_of_scope(${name})`);
        // Shared ledger untouched, so the next chat is not widened.
        expect(`${label}/${name}:ledger=${out.ledgerHas}`).toBe(`${label}/${name}:ledger=false`);
      }
    });
  }

  for (const name of ['site_write_file', 'site_run_command', 'commitments']) {
    test(`${name} still runs in every loop under the same scope`, async () => {
      for (const [label, run] of LOOPS) {
        const out = await run(name, PROJECT_SITE_CHAT_SCOPE);
        expect(`${label}/${name}:ran=${out.ran.join(',')}`).toBe(`${label}/${name}:ran=${name}`);
        expect(`${label}/${name}:${out.outOfScopeRows.length}`).toBe(`${label}/${name}:0`);
      }
    });
  }

  test('without a scope every loop behaves exactly as before', async () => {
    // The no-regression half. A fix that moved enforcement rather than
    // extending it would show up here as a main-chat turn losing a tool.
    for (const name of WITHHELD) {
      for (const [label, run] of LOOPS) {
        const out = await run(name, null);
        expect(`${label}/${name}:ran=${out.ran.join(',')}`).toBe(`${label}/${name}:ran=${name}`);
        expect(`${label}/${name}:${out.outOfScopeRows.length}`).toBe(`${label}/${name}:0`);
      }
    }
  });
});
