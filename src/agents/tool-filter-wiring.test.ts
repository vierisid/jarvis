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
import { buildProductionRegistry } from '../actions/tools/production-registry.ts';
import type { ToolDefinition } from '../actions/tools/registry.ts';
import { runSubAgent, type SubAgentResult } from './sub-agent-runner.ts';
import { AuthorityEngine } from '../authority/engine.ts';
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

/** Streams scripted responses, recording the tool list of each call. */
class StreamingRecordingProvider extends RecordingProvider {
  override async *stream(messages: LLMMessage[] = [], opts?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const r = await this.chat(messages, opts);
    for (const tc of r.tool_calls) yield { type: 'tool_call', tool_call: tc };
    if (r.content) yield { type: 'text', text: r.content };
    yield { type: 'done', response: r };
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

function makeOrchestrator(provider: LLMProvider, tools: readonly ToolDefinition[] = BUILTIN_TOOLS): AgentOrchestrator {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({ medium: { provider: 'ollama', model: 'qwen2.5:7b' } });
  const orch = new AgentOrchestrator();
  orch.setLLMManager(m);
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  orch.setToolRegistry(registry);
  orch.setToolFilterProviders({ ollama: { kind: 'ollama' } });
  orch.createPrimary(ROLE);
  return orch;
}

const PERCEPTION = BUILTIN_TOOLS.filter(isFramedPerception).map((t) => t.name);

/**
 * The production registry, with every tool's `execute` replaced by a stub:
 * these tests assert what is OFFERED and must never touch the machine,
 * whichever tool a scripted model calls.
 */
const PROD: ToolDefinition[] = (await buildProductionRegistry()).tools
  .map((t) => ({ ...t, execute: async () => `stub ${t.name}` }));

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

describe('across turns and off-list calls', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it("#483's mid-task repro, end to end: the follow-up keeps ui_act and browser_navigate", async () => {
    // Turn 1 `open notepad`, turn 2 `now remember that I did that`. Under
    // #475 turn 2 lost ui_act and browser_navigate and kept run_command.
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([call('ui_act', { id: 1, action: 'click' }), done(), done()]);
    const orch = makeOrchestrator(provider, PROD);
    await orch.processMessage('sys', 'open notepad and type hello');
    // Pad turn 2 past the selection window, so turn 1's text cannot select
    // anything and only the ledger can keep what turn 1 used.
    await orch.processMessage('sys', `${'x '.repeat(4500)}now remember that I did that`);
    const turn2 = provider.names(provider.seen.length - 1);
    expect(turn2.has('ui_act')).toBe(true);
    expect(turn2.has('browser_navigate')).toBe(true);
    if (turn2.has('run_command')) for (const p of PERCEPTION) expect(`${p}:${turn2.has(p)}`).toBe(`${p}:true`);
  });

  it('an off-list unframed fetch is not run while framed readers are hidden, and comes back with them', async () => {
    // The Tool Guide in the system prompt names every tool whatever the
    // filter kept, so a small model can call one it was not offered.
    // Dispatching it would be #475's substitution through a side door: the
    // offered set kept the framing invariant and the dispatch did not.
    setToolFilterPolicy(ON);
    const results: string[] = [];
    const ran: string[] = [];
    const tools = PROD.map((t) => (t.name === 'list_directory'
      ? { ...t, execute: async () => { ran.push(t.name); return 'listing'; } }
      : t));
    const provider = new CatalogueCapturingProvider([call('list_directory', { path: '/tmp' }), done()], results);
    const orch = makeOrchestrator(provider, tools);
    const rows: Array<Record<string, unknown>> = [];
    orch.setAuditTrail({ log: (r: Record<string, unknown>) => { rows.push(r); return r; } } as never);
    await orch.processMessage('sys', 'set a goal to ship the release this week');

    // Audited as what it was: an off-list admission (not a discover_tools
    // call) and a refusal that did not execute.
    expect(rows.map((r) => [r.tool_name, r.authority_decision, r.executed])).toEqual([
      ['off_list_call(list_directory)', 'allowed', true],
      ['list_directory', 'denied', false],
    ]);

    const first = provider.names(0);
    expect(first.has('list_directory')).toBe(false);
    expect(first.has('browser_navigate')).toBe(false);

    expect(ran).toEqual([]);
    expect(results.some((r) => r.startsWith('[NOT RUN] list_directory'))).toBe(true);

    const next = provider.names(1);
    expect(next.has('list_directory')).toBe(true);
    for (const p of PERCEPTION) expect(`${p}:${next.has(p)}`).toBe(`${p}:true`);
  });

  it('an off-list framed reader runs as it would unfiltered, and the set is recomputed', async () => {
    setToolFilterPolicy(ON);
    const ran: string[] = [];
    const tools = PROD.map((t) => (t.name === 'browser_snapshot'
      ? { ...t, execute: async () => { ran.push(t.name); return 'page'; } }
      : t));
    const provider = new RecordingProvider([call('browser_snapshot'), done()]);
    const orch = makeOrchestrator(provider, tools);
    await orch.processMessage('sys', 'set a goal to ship the release this week');
    expect(provider.names(0).has('browser_snapshot')).toBe(false);
    expect(ran).toEqual(['browser_snapshot']);
    expect(provider.names(1).has('browser_snapshot')).toBe(true);
  });

  it('the off-list call stays exposed on the next turn, through the ledger rather than the text', async () => {
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([call('list_directory', { path: '/tmp' }), done(), done()]);
    const orch = makeOrchestrator(provider, PROD);
    await orch.processMessage('sys', 'set a goal to ship the release this week');
    await orch.processMessage('sys', 'thanks');
    expect(provider.names(2).has('list_directory')).toBe(true);
  });

  it('an offered call does not recompute: the set stays byte-stable across the loop', async () => {
    // Recomputing on every dispatch would invalidate the cached prefix on
    // every iteration; only a widening may change the list mid-turn.
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([call('manage_goals', { action: 'list' }), done()]);
    const orch = makeOrchestrator(provider, PROD);
    await orch.processMessage('sys', 'set a goal to ship the release this week');
    expect(provider.seen[1]!.map((t) => t.name)).toEqual(provider.seen[0]!.map((t) => t.name));
  });

  it("consecutive router-first tasks share the primary's ledger, so task 2 keeps task 1's tools", async () => {
    // processTaskCall sees only the user's latest message; the dialogue
    // rides in as system context, which selection does not read. A fresh
    // ledger per task was the mid-task strip on the router-first path.
    setToolFilterPolicy(ON);
    const provider = new RecordingProvider([call('list_directory', { path: '/tmp' }), done(), done()]);
    const orch = makeOrchestrator(provider, PROD);
    await orch.processTaskCall({
      systemPrompt: 'sys', userMessage: 'list the files in /tmp', tier: 'medium', subsystem: 'test',
    });
    expect(provider.names(0).has('list_directory')).toBe(true);
    await orch.processTaskCall({
      systemPrompt: 'sys', userMessage: 'set a goal to ship it this week', tier: 'medium', subsystem: 'test',
    });
    expect(provider.names(2).has('list_directory')).toBe(true);
  });

  it('processTaskCall: a refused off-list call in a batch leaves no tool_call unanswered', async () => {
    setToolFilterPolicy(ON);
    const ran: string[] = [];
    const tools = PROD.map((t) => ({ ...t, execute: async () => { ran.push(t.name); return `stub ${t.name}`; } }));
    const batch: LLMResponse = {
      content: '',
      tool_calls: [
        { id: 'k1', name: 'run_command', arguments: { command: 'echo x' } },
        { id: 'k2', name: 'manage_goals', arguments: { action: 'list' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 }, model: 'scripted', finish_reason: 'tool_use',
    };
    const provider = new RecordingProvider([batch, done()]);
    const orch = makeOrchestrator(provider, tools);
    const result = await orch.processTaskCall({
      systemPrompt: 'sys', userMessage: 'set a goal to ship the release this week', tier: 'medium', subsystem: 'test',
    });
    expect(ran).toEqual(['manage_goals']);
    const answered = new Map(result.conversation.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.content)]));
    expect(answered.get('k1')).toStartWith('[NOT RUN] run_command');
    expect(answered.get('k2')).toBe('stub manage_goals');
    const next = provider.names(1);
    expect(next.has('run_command')).toBe(true);
    for (const p of PERCEPTION) expect(`${p}:${next.has(p)}`).toBe(`${p}:true`);
  });

  it('with the filter off, an unknown tool is not answered with a pointer to discover_tools', async () => {
    // discover_tools is neither offered nor intercepted when the filter is
    // off; pointing at it sent the model round a loop.
    resetToolFilterPolicy();
    const results: string[] = [];
    const provider = new CatalogueCapturingProvider([call('web_search', { q: 'x' }), done()], results);
    const orch = makeOrchestrator(provider);
    await orch.processMessage('sys', 'look something up');
    const reply = results.find((r) => r.includes('web_search'));
    expect(reply).toBeDefined();
    expect(reply).not.toContain('discover_tools');
  });
});

describe('streamMessage', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  async function drain(it: AsyncIterable<LLMStreamEvent>): Promise<void> {
    for await (const _ of it) { /* consume */ }
  }

  it('filters on the main chat path when every reachable model is small', async () => {
    setToolFilterPolicy(ON);
    const provider = new StreamingRecordingProvider([done()]);
    const orch = makeOrchestrator(provider, PROD);
    await drain(orch.streamMessage('sys', 'set a goal to ship the release this week'));
    expect(provider.seen[0]!.length).toBeLessThan(PROD.length);
    expect(provider.names(0).has('discover_tools')).toBe(true);
  });

  it('refuses an off-list shell on the streaming path too', async () => {
    setToolFilterPolicy(ON);
    const ran: string[] = [];
    const tools = PROD.map((t) => ({ ...t, execute: async () => { ran.push(t.name); return 'x'; } }));
    const provider = new StreamingRecordingProvider([call('run_command', { command: 'echo x' }), done()]);
    const orch = makeOrchestrator(provider, tools);
    await drain(orch.streamMessage('sys', 'set a goal to ship the release this week'));
    expect(ran).toEqual([]);
    expect(provider.names(0).has('run_command')).toBe(false);
    expect(provider.names(1).has('run_command')).toBe(true);
    for (const p of PERCEPTION) expect(`${p}:${provider.names(1).has(p)}`).toBe(`${p}:true`);
  });

  it('a frontier fallbackTier keeps the list whole, even though the requested tier is small', async () => {
    // agent-service streams on `conversation` with `medium` as the
    // caller-supplied retry tier, which TIER_FALLBACK never mentions. The
    // gate must see it, or the frontier model gets the filtered list the
    // moment the small one fails before first output.
    setToolFilterPolicy(ON);
    const provider = new StreamingRecordingProvider([done()]);
    const orch = makeOrchestrator(provider, PROD);
    const m = new LLMManager();
    m.registerProvider(provider);
    m.setTierMap({
      conversation: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'ollama', model: 'claude-sonnet-proxy' },
    });
    orch.setLLMManager(m);
    await drain(orch.streamMessage('sys', 'set a goal to ship the release this week', 'conversation', 'test', 'medium'));
    expect(provider.seen[0]!.length).toBe(PROD.length);
  });
});

describe('runSubAgent', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('a call to a hidden shell is not run, and the next provider call carries it with the framed readers', async () => {
    setToolFilterPolicy(ON);
    // A scoped registry with every browser tool, the shell and one
    // non-browsing tool. A turn that selects only that tool hides both the
    // browser and the shell -- the shape in which a hidden shell call would
    // strand a fetch unframed.
    const scoped = PROD.filter((t) => t.category === 'browser'
      || ['run_command', 'manage_goals'].includes(t.name));
    const registry = new ToolRegistry();
    for (const t of scoped) registry.register(t);

    const seen: string[][] = [];
    const replies: LLMResponse[] = [call('run_command', { command: 'echo fetched' }), done()];
    const manager = {
      getTierMap: () => ({ medium: { provider: 'ollama', model: 'qwen2.5:7b' } }),
      chatTier: async (_tier: string, _sub: string, _msgs: LLMMessage[], opts?: LLMOptions) => {
        seen.push((opts?.tools ?? []).map((t) => t.name));
        return replies.shift() ?? done();
      },
    } as unknown as LLMManager;
    const history: Array<{ role: string; content: unknown }> = [];
    const agent = {
      id: 'child', agent: { role: { id: 'fixture', name: 'Fixture', description: '', responsibilities: [] }, authority: { max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {},
      addMessage: (role: string, content: unknown) => history.push({ role, content }), getMessages: () => history,
    } as never;

    const result = await runSubAgent({
      agent, task: 'set a goal to ship the release this week', context: '', llmManager: manager, toolRegistry: registry,
      toolFilterProviders: { ollama: { kind: 'ollama' } },
    });
    // Not run: the offered set was hiding every framed reader.
    const toolResults = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolResults.some((r) => r.startsWith('[NOT RUN] run_command'))).toBe(true);
    expect(toolResults.some((r) => r.includes('stub run_command'))).toBe(false);

    // The ask selects the goals group: no shell, no browser.
    expect(seen[0]!.includes('run_command')).toBe(false);
    expect(seen[0]!.includes('browser_navigate')).toBe(false);
    expect(seen[0]!.includes('discover_tools')).toBe(true);
    // The model called it anyway. The very next provider call carries it,
    // and every framed reader the registry has.
    expect(seen[1]!.includes('run_command')).toBe(true);
    for (const t of scoped.filter(isFramedPerception)) {
      expect(`${t.name}:${seen[1]!.includes(t.name)}`).toBe(`${t.name}:true`);
    }
  });
});

describe('runSubAgent pause and resume', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { resetToolFilterPolicy(); });

  it('a hidden shell queued behind a paused call is still refused on resume', async () => {
    // The buffer at a pause ends on an assistant turn whose later calls were
    // never reached. Seeding those used to put the shell into the exposed
    // set, so the resume dispatched it without the off-list check.
    setToolFilterPolicy(ON);
    const ran: string[] = [];
    const scoped = PROD.filter((t) => t.category === 'browser'
      || ['run_command', 'manage_goals', 'write_file'].includes(t.name))
      .map((t) => ({ ...t, execute: async () => { ran.push(t.name); return `stub ${t.name}`; } }));
    const registry = new ToolRegistry();
    for (const t of scoped) registry.register(t);

    const batch: LLMResponse = {
      content: '',
      tool_calls: [
        { id: 'p1', name: 'write_file', arguments: { path: '/tmp/x', content: 'y' } },
        { id: 'p2', name: 'run_command', arguments: { command: 'echo fetched' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 }, model: 'scripted', finish_reason: 'tool_use',
    };
    const replies: LLMResponse[] = [batch, done()];
    const manager = {
      getTierMap: () => ({ medium: { provider: 'ollama', model: 'qwen2.5:7b' } }),
      chatTier: async () => replies.shift() ?? done(),
    } as unknown as LLMManager;
    const history: Array<{ role: string; content: unknown }> = [];
    const agent = () => ({
      id: 'child', agent: { role: { id: 'fixture', name: 'Fixture', description: '', responsibilities: [] }, authority: { max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {},
      addMessage: (role: string, content: unknown) => history.push({ role, content }), getMessages: () => history,
    } as never);
    const engine = new AuthorityEngine({ default_level: 10, governed_categories: ['write_data'] as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' } as never);
    const audit = { log: (r: Record<string, unknown>) => r } as never;
    const approval = { effectId: 'effect', approvalId: 'approval', waitpointId: 'waitpoint' };
    const common = {
      task: 'set a goal to ship the release this week', context: '', llmManager: manager, toolRegistry: registry,
      toolFilterProviders: { ollama: { kind: 'ollama' as const } }, authorityEngine: engine, auditTrail: audit, maxIterations: 3,
    };

    const paused: SubAgentResult = await runSubAgent({ ...common, agent: agent(),
      governedTools: async () => ({ kind: 'paused', approval }) });
    expect(paused.terminationReason).toBe('paused');
    expect(paused.paused?.remaining.map((c) => c.name)).toEqual(['run_command']);

    const resumed = await runSubAgent({ ...common, agent: agent(),
      governedTools: async () => ({ kind: 'executed', result: 'written' }),
      resume: {
        messages: paused.messages, toolsUsed: paused.toolsUsed, tokensUsed: paused.tokensUsed, sequence: paused.sequence!,
        iteration: paused.paused!.iteration, taint: paused.taint ?? [], failedToolCalls: paused.failedToolCalls ?? [],
        pending: paused.paused!,
      } });
    expect(ran).toEqual([]);
    const results = resumed.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.content)]);
    expect(results.find(([id]) => id === 'p2')?.[1]).toStartWith('[NOT RUN] run_command');
    expect(resumed.toolsUsed).not.toContain('run_command');
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
