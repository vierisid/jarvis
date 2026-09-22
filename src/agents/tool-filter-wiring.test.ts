/**
 * The tool relevance filter, wired into the real orchestrator loops.
 *
 * The unit tests under `src/actions/tools/tool-relevance/` cover the pure
 * functions. These drive `AgentOrchestrator` and `runSubAgent` themselves,
 * because every defect worth catching here lives in the WIRING: which set
 * reaches `chatTier`, whether an admission takes effect on the next
 * iteration, whether the default-off posture is genuinely a no-op.
 *
 * The properties asserted are the ones #483 makes load-bearing:
 *   - a filtered turn that keeps a shell also keeps the framed readers;
 *   - the escape hatch actually returns a capability, end to end;
 *   - nothing changes at all when the filter is off.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import type {
  LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMTool, LLMToolCall,
} from '../llm/provider.ts';
import {
  isFramedPerception, isFloorEligible,
} from '../actions/tools/tool-relevance/authority-classes.ts';
import {
  setToolFilterPolicy, resetToolFilterPolicy, type ToolFilterPolicy,
} from '../actions/tools/tool-relevance/policy.ts';
import type { RoleDefinition } from '../roles/types.ts';

const ROLE = {
  id: 'test-role', name: 'Test Role', description: 'A test role.',
  responsibilities: ['Test things'], autonomous_actions: [], approval_required: [],
  tools: [], authority_level: 5,
} as unknown as RoleDefinition;

const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: ['ollama:qwen2.5:7b'] };

/** Records the tool list handed to the provider on each call. */
class RecordingProvider implements LLMProvider {
  name = 'ollama';
  readonly seen: Array<LLMTool[]> = [];
  private queue: LLMResponse[];
  constructor(responses: LLMResponse[]) { this.queue = [...responses]; }

  async chat(_messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    this.seen.push([...(opts?.tools ?? [])]);
    return this.queue.shift() ?? {
      content: 'done', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 },
      model: 'scripted', finish_reason: 'stop',
    };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('not used'); }
  async listModels(): Promise<string[]> { return ['qwen2.5:7b']; }

  /** Names offered on the nth provider call (0-based). */
  names(n: number): Set<string> { return new Set((this.seen[n] ?? []).map((t) => t.name)); }
}

/** Also records the `tool` results the loop feeds back, to read the catalogue. */
class CatalogueCapturingProvider extends RecordingProvider {
  constructor(responses: LLMResponse[], private readonly sink: string[]) { super(responses); }
  override async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    for (const m of messages) {
      if (m.role === 'tool' && typeof m.content === 'string') this.sink.push(m.content);
    }
    return super.chat(messages, opts);
  }
}

function call(name: string, args: Record<string, unknown> = {}): LLMResponse {
  const tc: LLMToolCall = { id: `c${Math.random()}`, name, arguments: args };
  return {
    content: '', tool_calls: [tc], usage: { input_tokens: 1, output_tokens: 1 },
    model: 'scripted', finish_reason: 'tool_use',
  };
}
const done = (t = 'done'): LLMResponse => ({
  content: t, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
  model: 'scripted', finish_reason: 'stop',
});

function makeOrchestrator(provider: LLMProvider): AgentOrchestrator {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({ medium: { provider: 'ollama', model: 'qwen2.5:7b' } });
  const orch = new AgentOrchestrator();
  orch.setLLMManager(m);
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  orch.setToolRegistry(registry);
  orch.setToolFilterProviders({ ollama: { kind: 'ollama' } });
  orch.createPrimary(ROLE);
  return orch;
}

const PERCEPTION = BUILTIN_TOOLS.filter(isFramedPerception).map((t) => t.name);

describe('the filter wired into processMessage', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('is a complete no-op when the policy is off', async () => {
    resetToolFilterPolicy();
    const provider = new RecordingProvider([done()]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'set a goal to ship the release this week');
    expect(provider.seen[0]!.length).toBe(BUILTIN_TOOLS.length);
    expect(provider.names(0).has('discover_tools')).toBe(false);
    // Byte-identical to what the unfiltered path would have sent.
    expect(provider.seen[0]!.map((t) => t.name)).toEqual(BUILTIN_TOOLS.map((t) => t.name));
  });

  it('drops most of the set on a knowledge turn and offers the hatch', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([done()]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'set a goal to ship the release this week');
    const offered = provider.names(0);
    expect(offered.size).toBeLessThan(BUILTIN_TOOLS.length);
    expect(offered.has('discover_tools')).toBe(true);
    for (const t of BUILTIN_TOOLS.filter(isFloorEligible)) expect(offered.has(t.name)).toBe(true);
  });

  it('never offers run_command without the framed readers', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([done()]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'run the build and check the logs');
    const offered = provider.names(0);
    expect(offered.has('run_command')).toBe(true);
    for (const p of PERCEPTION) expect(`${p}:${offered.has(p)}`).toBe(`${p}:true`);
  });

  it('a research ask keeps the browser tools', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([done()]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'research the competitor landscape and write it up');
    const offered = provider.names(0);
    for (const t of BUILTIN_TOOLS.filter((x) => x.category === 'browser')) {
      expect(`${t.name}:${offered.has(t.name)}`).toBe(`${t.name}:true`);
    }
  });
});

describe('the escape hatch, end to end', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('admitting run_command makes it available on the next iteration, with the framed readers', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([
      call('discover_tools', { names: ['run_command'] }),
      done('ok'),
    ]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'set a goal to ship the release this week');

    // Iteration 1: a knowledge turn, no shell.
    expect(provider.names(0).has('run_command')).toBe(false);
    expect(provider.names(0).has('discover_tools')).toBe(true);

    // Iteration 2: the admission took effect, and the invariant came with it.
    const after = provider.names(1);
    expect(after.has('run_command')).toBe(true);
    for (const p of PERCEPTION) expect(`${p}:${after.has(p)}`).toBe(`${p}:true`);
  });

  it('the no-argument catalogue marks hidden tools as hidden', async () => {
    // The bug this pins: passing the full registry as the "exposed" set
    // marks every tool available, so the model is told nothing is hidden
    // and has no reason to ask for anything. The `names` path still worked,
    // which is why this needs its own test rather than being implied by
    // the admission one.
    setToolFilterPolicy(ON);
    const captured: string[] = [];
    const provider = new CatalogueCapturingProvider(
      [call('discover_tools', {}), done()], captured,
    );
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'set a goal to ship the release this week');

    const catalogue = captured.join('\n');
    expect(catalogue).toContain('[hidden]');
    // run_command was not selected for a goals turn, so it must read hidden.
    expect(catalogue).toMatch(/- run_command \[hidden\]/);
    // get_system_info is floor, so it must read available.
    expect(catalogue).toMatch(/- get_system_info \[available\]/);
    expect(catalogue).toContain(`${BUILTIN_TOOLS.length} tools exist`);
  });

  it('admitting an unregistered name conjures nothing and does not fail the turn', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([
      call('discover_tools', { names: ['totally_made_up'] }),
      done('ok'),
    ]);
    const orch = makeOrchestrator(provider);
    const out = await orch.processMessage('sys', 'set a goal to ship the release');
    expect(out).toBe('ok');
    expect(provider.names(1).has('totally_made_up')).toBe(false);
  });

  it('the hatch is inert when the filter is off', async () => {
    // With nothing hidden there is nothing to discover, and answering
    // anyway would make a disabled feature model-callable.
    resetToolFilterPolicy();
    const provider = new RecordingProvider([
      call('discover_tools', { names: ['run_command'] }),
      done('ok'),
    ]);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'hello');
    // It fell through to the registry, which does not have it.
    const primary = orch.getPrimary()!;
    expect(primary).toBeDefined();
    expect(provider.seen[1]!.length).toBe(BUILTIN_TOOLS.length);
  });
});

describe('the eligibility gate at the call site', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('a frontier tier is never filtered even with the policy on', async () => {
    setToolFilterPolicy({ enabled: true, maxParamsB: 20, models: [] });
    const provider = new RecordingProvider([done()]);
    provider.name = 'openai';
    const m = new LLMManager();
    m.registerProvider(provider);
    m.setTierMap({ medium: { provider: 'openai', model: 'gpt-5.4' } });
    const orch = new AgentOrchestrator();
    orch.setLLMManager(m);
    const registry = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) registry.register(t);
    orch.setToolRegistry(registry);
    orch.setToolFilterProviders({ openai: { kind: 'openai' } });
    orch.createPrimary(ROLE);

    await orch.processMessage('sys', 'set a goal to ship the release');
    expect(provider.seen[0]!.length).toBe(BUILTIN_TOOLS.length);
  });
});

describe('processTaskCall', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('answers every sibling tool call when the clarify branch fires', async () => {
    // A tool_use with no matching tool_result is rejected by the providers
    // when the conversation is replayed on resume. Latent before
    // discover_tools existed; likely now that a confused small model can
    // ask for a tool and say "I need more info" in one batch.
    const batch: LLMResponse = {
      content: '',
      tool_calls: [
        { id: 't1', name: 'discover_tools', arguments: {} },
        { id: 't2', name: 'get_system_info', arguments: {} },
        { id: 't3', name: 'ask_for_clarification', arguments: { question: 'which one?' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'scripted', finish_reason: 'tool_use',
    };
    const provider = new RecordingProvider([batch]);
    const orch = makeOrchestrator(provider);
    const result = await orch.processTaskCall({
      systemPrompt: 'sys', userMessage: 'do the thing', tier: 'medium', subsystem: 'test',
    });
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') return;
    const assistant = result.conversation.find((m) => m.role === 'assistant' && m.tool_calls);
    const ids = new Set((assistant?.tool_calls ?? []).map((c) => c.id));
    const answered = new Set(
      result.conversation.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    );
    for (const id of ids) expect(`${id}:${answered.has(id)}`).toBe(`${id}:true`);
  });

  it('appends ask_for_clarification after the filter, not inside it', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([done()]);
    const orch = makeOrchestrator(provider);
    await orch.processTaskCall({
      systemPrompt: 'sys', userMessage: 'set a goal to ship the release', tier: 'medium', subsystem: 'test',
    });
    const offered = provider.names(0);
    expect(offered.has('ask_for_clarification')).toBe(true);
    expect(offered.size).toBeLessThan(BUILTIN_TOOLS.length + 1);
  });
});

describe('getRealtimeTools', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('is never filtered, even with the policy on', () => {
    // A realtime session's tools are fixed at buildSessionUpdate time, so a
    // filter there would break per-turn refiltering AND the escape hatch at
    // once: discover_tools could not take effect because the list cannot
    // change. A dead-end hatch is worse than no filter.
    setToolFilterPolicy(ON);
    const orch = makeOrchestrator(new RecordingProvider([]));
    const tools = orch.getRealtimeTools();
    expect(tools.length).toBe(BUILTIN_TOOLS.length);
    expect(tools.some((t) => t.name === 'discover_tools')).toBe(false);
  });
});
