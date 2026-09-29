/**
 * #571: the site chat's tool scope reaches the ROUTER-FIRST path.
 *
 * #570 enforced the scope in three places -- the candidate set, the
 * `discover_tools` catalogue and dispatch -- all hanging off the loop
 * `AgentService.streamMessage` reaches when NO conversation tier is
 * configured. Every hosted install has one, so `streamMessageInner` took the
 * conv branch instead, which dropped both `siteContext` and `scope` and never
 * reached that loop. Hosted was the pre-#561 state exactly.
 *
 * These tests drive the real chain -- ConvOrchestrator -> TaskDispatcher ->
 * runner -> AgentOrchestrator.processTaskCall -> registry -- with a scripted
 * conv tier that delegates and a scripted task tier that then reaches for the
 * generic shell. What they assert is not that the tool was hidden (the filter
 * does that, recoverably, and on a hosted install it does not even run: the
 * hosted tier models are frontier-vetoed, so `decideTools` returns everything
 * it was given). What they assert is that the call DID NOT RUN.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../../vault/schema.ts';
import { LLMManager } from '../../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../../llm/provider.ts';
import { AgentOrchestrator } from '../orchestrator.ts';
import { ToolRegistry, type ToolDefinition } from '../../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../../authority/engine.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { PROJECT_SITE_CHAT_SCOPE, scopeSystemNote, type TurnToolScope } from '../../actions/tools/tool-scope.ts';
import { NOT_RUN_MARKER } from '../../actions/tools/tool-relevance/ledger.ts';
import { resetToolFilterPolicy, setToolFilterPolicy } from '../../actions/tools/tool-relevance/policy.ts';
import { currentTurnScopeId } from '../../actions/tools/turn-scope-store.ts';
import { TaskRegistry } from './task-registry.ts';
import { TaskDispatcher, type TaskRunner } from './task-dispatcher.ts';
import { ConvOrchestrator, SITE_CHAT_ROUTING_NOTE } from './conv-orchestrator.ts';
import type { RoleDefinition } from '../../roles/types.ts';

/** Responses handed out by tier, so the conv tier and the task tier can differ. */
class TieredProvider implements LLMProvider {
  name = 'scripted';
  /** Every system+user buffer the TASK tier was called with. */
  taskBuffers: LLMMessage[][] = [];
  /**
   * The tool NAMES offered on each task-tier call. This is how a mid-turn
   * recompute is observed: the bug it catches is not a call that runs, it is a
   * withheld tool reappearing in the list handed to the model.
   */
  toolListsSeen: string[][] = [];
  constructor(
    private conv: LLMResponse[],
    private task: LLMResponse[],
  ) {}

  /** Queue another task-tier response, e.g. for the second run of a resume. */
  pushTask(...responses: LLMResponse[]): void { this.task.push(...responses); }

  private isConv(opts?: LLMOptions): boolean {
    // The conv tier is the only caller that passes the CONV_TOOLS surface.
    return (opts?.tools ?? []).some((t) => t.name === 'delegate');
  }

  async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    const queue = this.isConv(opts) ? this.conv : this.task;
    if (!this.isConv(opts)) {
      this.taskBuffers.push([...messages]);
      this.toolListsSeen.push((opts?.tools ?? []).map((t) => t.name));
    }
    return queue.shift() ?? {
      content: 'done', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 },
      model: 'scripted', finish_reason: 'stop',
    };
  }

  async *stream(messages: LLMMessage[], opts?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(messages, opts);
    if (response.content) yield { type: 'text', text: response.content };
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['scripted']; }
}

function toolCall(name: string, args: Record<string, unknown>, content = ''): LLMResponse {
  const call: LLMToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  return {
    content, tool_calls: [call], usage: { input_tokens: 1, output_tokens: 1 },
    model: 'scripted', finish_reason: 'tool_use',
  };
}
function textResponse(content: string): LLMResponse {
  return {
    content, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
    model: 'scripted', finish_reason: 'stop',
  };
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['terminal', 'browser', 'file-ops'], authority_level: 10,
} as unknown as RoleDefinition;

const AUTHORITY = (): AuthorityConfig => ({
  default_level: 10,
  governed_categories: [],
  overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 },
  emergency_state: 'normal',
});

/** The whole hosted chain, wired the way `AgentService.registerProviders` wires it. */
function buildStack(conv: LLMResponse[], task: LLMResponse[]) {
  const ran: string[] = [];
  /** The ambient turn scope id observed from inside a tool's own execution. */
  const observed: { scopeId?: string } = {};
  const provider = new TieredProvider(conv, task);
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({
    conversation: { provider: provider.name },
    medium: { provider: provider.name },
    low: { provider: provider.name },
  });

  const registry = new ToolRegistry();
  const tool = (name: string, category: string): ToolDefinition => ({
    name, description: 't', category, parameters: {},
    execute: async () => {
      ran.push(name);
      // What `createCommitment` reads to stamp its row.
      observed.scopeId = currentTurnScopeId();
      return 'ok';
    },
  });
  for (const t of [
    tool('run_command', 'terminal'), tool('read_file', 'file-ops'),
    tool('write_file', 'file-ops'), tool('list_directory', 'file-ops'),
    tool('delegate_task', 'delegation'), tool('manage_agents', 'delegation'),
    tool('site_write_file', 'site-builder'), tool('site_run_command', 'site-builder'),
    tool('commitments', 'productivity'),
  ]) registry.register(t);

  const audit = new AuditTrail();
  const orchestrator = new AgentOrchestrator();
  orchestrator.setLLMManager(llm);
  orchestrator.setToolRegistry(registry);
  orchestrator.setAuthorityEngine(new AuthorityEngine(AUTHORITY()));
  orchestrator.setApprovalManager(new ApprovalManager());
  orchestrator.setAuditTrail(audit);
  orchestrator.createPrimary(ROLE);

  const taskRegistry = new TaskRegistry();
  /** Mirrors the production runner in daemon/agent-service.ts. */
  const runner: TaskRunner = async ({ tier, subsystem, originalMessage, signal, history, scope, siteContext }) => {
    // Assembled the same way daemon/agent-service.ts assembles it, including
    // the scope notice. `tool-scope.test.ts` pins that the production runner
    // really does both, so this mirror cannot drift into passing alone.
    const dynamic = [
      'dyn',
      ...(siteContext ? [siteContext] : []),
      ...(scope ? [scopeSystemNote(scope)] : []),
    ].join('\n\n');
    return await orchestrator.processTaskCall({
      systemPrompt: { static: 'role prompt', dynamic },
      userMessage: originalMessage,
      tier,
      subsystem,
      history: history as LLMMessage[] | undefined,
      signal,
      scope,
    });
  };
  const dispatcher = new TaskDispatcher(llm, taskRegistry, runner);
  const conversation = new ConvOrchestrator(llm, taskRegistry, dispatcher, 'persona');
  return {
    conversation, dispatcher, taskRegistry, ran, audit, provider, orchestrator,
    get scopeIdSeenByTool(): string | undefined { return observed.scopeId; },
  };
}

const DELEGATE = (intent: string) =>
  toolCall('delegate', { tier: 'medium', template: 'general', intent }, 'On it.');

/** The chat key ws-service builds for a project-scoped chat. */
const SITE_CONTEXT_KEY = 'site:proj-a';

async function drain(
  stack: ReturnType<typeof buildStack>,
  message: string,
  scope: TurnToolScope | null,
  siteContext?: string,
  contextKey: string | undefined = scope ? SITE_CONTEXT_KEY : undefined,
) {
  const out: string[] = [];
  for await (const ev of stack.conversation.streamTurn(message, {}, {
    scope,
    ...(contextKey ? { contextKey } : {}),
    ...(siteContext ? { siteContext } : {}),
  })) {
    if (ev.type === 'text' && ev.text) out.push(ev.text);
  }
  return out.join('');
}

describe('#571 the conv path enforces the scope at dispatch', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  it('a withheld tool called on the task tier is not run', async () => {
    const stack = buildStack(
      [DELEGATE('install react-router'), textResponse('Done.')],
      [toolCall('run_command', { command: 'npm i react-router' }), textResponse('installed')],
    );
    await drain(stack, 'install react-router in the project', PROJECT_SITE_CHAT_SCOPE);
    // The assertion the whole issue comes down to.
    expect(stack.ran).toEqual([]);
  });

  it('the refusal is an absence, marked not-run, naming the site replacement', async () => {
    const stack = buildStack(
      [DELEGATE('read the app file'), textResponse('Done.')],
      [toolCall('read_file', { path: 'src/App.tsx' }), textResponse('read it')],
    );
    await drain(stack, 'read src/App.tsx', PROJECT_SITE_CHAT_SCOPE);
    // The refusal lands in the task tier's buffer as the tool result, so the
    // second task-tier call is where it is visible.
    const buffer = stack.provider.taskBuffers.at(-1) ?? [];
    const refusal = buffer.find((m) => m.role === 'tool' && String(m.content).includes('no tool named'));
    expect(refusal).toBeDefined();
    const body = String(refusal!.content);
    expect(body.startsWith(NOT_RUN_MARKER)).toBe(true);
    expect(body).not.toContain('AUTHORITY DENIED');
    expect(body).toContain('site project chat');
    expect(body).toContain('site_*');
    expect(body).toContain('will not become available');
  });

  it('the attempt leaves an out_of_scope audit row', async () => {
    const stack = buildStack(
      [DELEGATE('run the build'), textResponse('Done.')],
      [toolCall('run_command', { command: 'npm run build' }), textResponse('built')],
    );
    await drain(stack, 'npm run build the project', PROJECT_SITE_CHAT_SCOPE);
    const rows = stack.audit.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope'));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tool_name).toBe('out_of_scope(run_command)');
    expect(rows[0]!.executed).toBeFalsy();
    expect(rows[0]!.action_category).toBe('execute_command');
  });

  it('every withheld tool is refused, including the two delegation hops', async () => {
    for (const name of ['run_command', 'read_file', 'write_file', 'list_directory', 'delegate_task', 'manage_agents']) {
      const stack = buildStack(
        [DELEGATE('do the thing'), textResponse('Done.')],
        [toolCall(name, {}), textResponse('done')],
      );
      await drain(stack, 'work on the project', PROJECT_SITE_CHAT_SCOPE);
      expect(`${name}:${stack.ran.join(',')}`).toBe(`${name}:`);
    }
  });

  it('the site tools still run on the same path', async () => {
    const stack = buildStack(
      [DELEGATE('write the hero'), textResponse('Done.')],
      [toolCall('site_write_file', { project_id: 'p', path: 'src/Hero.tsx' }), textResponse('written')],
    );
    await drain(stack, 'add a hero section to the landing page', PROJECT_SITE_CHAT_SCOPE);
    expect(stack.ran).toEqual(['site_write_file']);
  });

  it('a non-site tool in a site chat is untouched', async () => {
    // The scope is not "site tools only": the Sites composer is a general
    // chat box that happens to carry a projectId.
    const stack = buildStack(
      [DELEGATE('remind them'), textResponse('Done.')],
      [toolCall('commitments', { action: 'create', what: 'deploy' }), textResponse('reminded')],
    );
    await drain(stack, 'remind me to deploy this tomorrow', PROJECT_SITE_CHAT_SCOPE);
    expect(stack.ran).toEqual(['commitments']);
  });

  it('a refused call does not widen the shared exposure ledger for other chats', async () => {
    // The ledger is the PRIMARY agent's - one set for the whole process,
    // shared by every chat - and `decideTools` keeps anything in it
    // unconditionally. Both tool loops call `noteToolUse` BEFORE dispatch,
    // where the refusal lives, so without the scope gate a site chat's
    // refused `run_command` was pinned into the next MAIN-chat turn's offered
    // set, permanently and with no audit row anywhere: the scope's own
    // enforcement widening the neighbouring chat.
    setToolFilterPolicy({ enabled: true, maxParamsB: 20, models: [] });
    try {
      const stack = buildStack(
        [DELEGATE('install react-router'), textResponse('Done.')],
        [toolCall('run_command', { command: 'npm i' }), textResponse('installed')],
      );
      await drain(stack, 'install react-router in the project', PROJECT_SITE_CHAT_SCOPE);
      expect(stack.ran).toEqual([]);
      const primary = stack.orchestrator.getPrimary()!;
      const ledger = (stack.orchestrator as unknown as {
        ledgerFor: (id: string) => { has: (n: string) => boolean };
      }).ledgerFor(primary.id);
      expect(ledger.has('run_command')).toBe(false);
    } finally {
      resetToolFilterPolicy();
    }
  });

  it('a widened turn does not re-offer the withheld tools for the rest of the turn', async () => {
    // A `discover_tools` admission or an off-list call sets `widened`, which
    // recomputes the turn's tool list mid-loop. That recompute was the last
    // place on the hosted path still passing `null`, so one admission re-offered
    // `read_file`/`write_file`/`list_directory` to a project-scoped site chat
    // for every remaining iteration -- dispatch still refused them, but the
    // candidate-set layer the module doc promises had collapsed, and each retry
    // was a billed iteration plus an `out_of_scope` row for a call the tool list
    // had just invited.
    setToolFilterPolicy({ enabled: true, maxParamsB: 20, models: [] });
    try {
      const stack = buildStack(
        [DELEGATE('read the app file'), textResponse('Done.')],
        [
          // Admit an IN-scope tool: enough to set `widened`.
          toolCall('discover_tools', { names: ['commitments'] }),
          toolCall('read_file', { path: 'src/App.tsx' }),
          textResponse('done'),
        ],
      );
      await drain(stack, 'read src/App.tsx and fix the button colour', PROJECT_SITE_CHAT_SCOPE);
      // Nothing withheld ever appears in a tool list handed to the model.
      const offeredNames = stack.provider.toolListsSeen.flat();
      const leaked = [...PROJECT_SITE_CHAT_SCOPE.withheld].filter((n) => offeredNames.includes(n));
      expect(leaked).toEqual([]);
      // And the call still did not run.
      expect(stack.ran).toEqual([]);
    } finally {
      resetToolFilterPolicy();
    }
  });

  it('without a scope the same conv turn runs the generic tool as before', async () => {
    // The control. A conv-path turn in the MAIN chat must be unchanged.
    const stack = buildStack(
      [DELEGATE('install react-router'), textResponse('Done.')],
      [toolCall('run_command', { command: 'npm i react-router' }), textResponse('installed')],
    );
    await drain(stack, 'install react-router', null);
    expect(stack.ran).toEqual(['run_command']);
    expect(stack.audit.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope'))).toEqual([]);
  });
});

describe('#571 what the two tiers are told', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  it('the site block reaches the task tier, not the router', async () => {
    const siteContext = '# Site Builder\nPROJECT-SPECIFIC-MARKER\n';
    const stack = buildStack(
      [DELEGATE('write the hero'), textResponse('Done.')],
      [textResponse('written')],
    );
    await drain(stack, 'add a hero section', PROJECT_SITE_CHAT_SCOPE, siteContext);
    const taskSystem = (stack.provider.taskBuffers[0] ?? [])
      .filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    expect(taskSystem).toContain('PROJECT-SPECIFIC-MARKER');
  });

  it('the router gets the short routing note and no project data', async () => {
    const siteContext = '# Site Builder\nPROJECT-SPECIFIC-MARKER\n';
    const seen: string[] = [];
    const stack = buildStack([textResponse('Sure.')], []);
    // Re-read what the conv tier was handed by intercepting the provider.
    const original = stack.provider.chat.bind(stack.provider);
    stack.provider.chat = async (messages: LLMMessage[], opts?: LLMOptions) => {
      if ((opts?.tools ?? []).some((t) => t.name === 'delegate')) {
        seen.push(messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n'));
      }
      return original(messages, opts);
    };
    await drain(stack, 'add a hero section', PROJECT_SITE_CHAT_SCOPE, siteContext);
    expect(seen.length).toBeGreaterThan(0);
    // The routing fact, yes. The repo-written file listing, no: the router
    // has no tools to act on it and every field in it is model- or
    // repo-written (sites/prompt-context.ts).
    expect(seen[0]).toContain(SITE_CHAT_ROUTING_NOTE);
    expect(seen[0]).not.toContain('PROJECT-SPECIFIC-MARKER');
  });

  it('the scope notice corrects the cached tool guide on the task tier', async () => {
    const stack = buildStack([DELEGATE('x'), textResponse('Done.')], [textResponse('ok')]);
    await drain(stack, 'work on the project', PROJECT_SITE_CHAT_SCOPE);
    const taskSystem = (stack.provider.taskBuffers[0] ?? [])
      .filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    expect(taskSystem).toContain('Tools this chat does not have');
    for (const name of PROJECT_SITE_CHAT_SCOPE.withheld) {
      expect(`${name}:${taskSystem.includes(name)}`).toBe(`${name}:true`);
    }
  });

  it('an UNSCOPED turn carrying a site context is not told it is a project chat', async () => {
    // The combination that matters and was briefly broken: `siteContext` is
    // not a "this is a project chat" signal. The MAIN dashboard chat passes
    // the multi-project list block there and the pebble passes its panel
    // context, both with `scope: null`. Keying the routing note on
    // `scope || siteContext` therefore told every main-chat and every pebble
    // turn on a hosted install that it was bound to a single Site Builder
    // project -- a false statement that also names a routing decision.
    const mainChatBlock = '# Site Builder\n\nYou have access to 3 project(s):\n- alpha\n- beta\n';
    const stack = buildStack([textResponse('Sure.')], []);
    const seen: string[] = [];
    const original = stack.provider.chat.bind(stack.provider);
    stack.provider.chat = async (messages: LLMMessage[], opts?: LLMOptions) => {
      if ((opts?.tools ?? []).some((t) => t.name === 'delegate')) {
        seen.push(messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n'));
      }
      return original(messages, opts);
    };
    await drain(stack, 'what projects do I have?', null, mainChatBlock);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toContain(SITE_CHAT_ROUTING_NOTE);
    // ...and the same turn WITH a scope does get it.
    const scoped = buildStack([textResponse('Sure.')], []);
    const scopedSeen: string[] = [];
    const orig2 = scoped.provider.chat.bind(scoped.provider);
    scoped.provider.chat = async (messages: LLMMessage[], opts?: LLMOptions) => {
      if ((opts?.tools ?? []).some((t) => t.name === 'delegate')) {
        scopedSeen.push(messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n'));
      }
      return orig2(messages, opts);
    };
    await drain(scoped, 'fix the header', PROJECT_SITE_CHAT_SCOPE, mainChatBlock);
    expect(scopedSeen[0]).toContain(SITE_CHAT_ROUTING_NOTE);
  });

  it('an unscoped conv turn gets neither block', async () => {
    const stack = buildStack([DELEGATE('x'), textResponse('Done.')], [textResponse('ok')]);
    await drain(stack, 'what is the weather', null);
    const taskSystem = (stack.provider.taskBuffers[0] ?? [])
      .filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    expect(taskSystem).not.toContain('Tools this chat does not have');
  });
});

describe('#571 the scope survives persistence and resume', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  it('the originating scope is recorded on the task request', async () => {
    const stack = buildStack([DELEGATE('x'), textResponse('Done.')], [textResponse('ok')]);
    await drain(stack, 'work on the project', PROJECT_SITE_CHAT_SCOPE);
    const records = stack.taskRegistry.recentResults(5);
    expect(records.length).toBeGreaterThan(0);
    // On the RECORD, not on the model-shaped request object, and it is the
    // CHAT key (project included), not the scope's id.
    expect(records[0]!.contextKey).toBe('site:proj-a');
    expect((records[0]!.request as Record<string, unknown>).scope_id).toBeUndefined();
  });

  it('a conv LLM cannot set, clear or forge the scope id', async () => {
    // `handleToolCall` builds the request field by field and spreads
    // nothing, so a scope_id in the model's arguments is inert. The turn's
    // own scope is what lands on the row.
    const forged = toolCall('delegate', {
      tier: 'medium', template: 'general', intent: 'x', scope_id: 'not_a_real_scope',
    }, 'On it.');
    const stack = buildStack([forged, textResponse('Done.')], [textResponse('ok')]);
    await drain(stack, 'work on the project', PROJECT_SITE_CHAT_SCOPE);
    expect(stack.taskRegistry.recentResults(5)[0]!.contextKey).toBe('site:proj-a');

    // And the reverse: a model trying to ADD a scope id on an unscoped turn
    // cannot invent one either (it would only ever narrow, but it must not
    // be model-driven at all).
    const stack2 = buildStack([forged, textResponse('Done.')], [textResponse('ok')]);
    await drain(stack2, 'what is the weather', null);
    expect(stack2.taskRegistry.recentResults(5)[0]!.contextKey).toBeUndefined();
  });

  it('a dispatch in a site chat runs under the scope, not merely records it', async () => {
    const stack = buildStack(
      [textResponse('')],
      [toolCall('run_command', { command: 'npm i' }), textResponse('done')],
    );
    await stack.dispatcher.dispatch(
      { tier: 'medium', template: 'general', intent: 'x', original_message: 'install it' },
      { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY },
    );
    expect(stack.ran).toEqual([]);
  });

  it('a scoped dispatch without the user\'s verbatim message is refused, not run on the paraphrase', async () => {
    // `original_message ?? intent` would hand the task tier the router's
    // paraphrase, which is also what the relevance filter selects on.
    const stack = buildStack([textResponse('')], [textResponse('done')]);
    const envelope = await stack.dispatcher.dispatch(
      { tier: 'medium', template: 'general', intent: 'Update the hero on the website' },
      { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY },
    );
    expect(envelope.status).toBe('failed');
    expect(envelope.error).toBe('missing_original_message');
    // An UNSCOPED turn keeps the old fallback behaviour.
    const ok = await stack.dispatcher.dispatch(
      { tier: 'medium', template: 'general', intent: 'Update the hero on the website' },
      { scope: null },
    );
    expect(ok.status).toBe('completed');
  });
});

describe('#571 a resume cannot cross a chat boundary', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  /** Pause a task under `scope`, returning the stack and the paused task id. */
  async function paused(scope: TurnToolScope | null) {
    const stack = buildStack(
      [textResponse('')],
      // The task tier asks for clarification, which pauses it.
      [toolCall('ask_for_clarification', { question: 'Which page?' })],
    );
    const envelope = await stack.dispatcher.dispatch(
      { tier: 'medium', template: 'general', intent: 'x', original_message: 'add a hero' },
      { scope, ...(scope ? { contextKey: SITE_CONTEXT_KEY } : {}) },
    );
    expect(envelope.status).toBe('needs_input');
    return { stack, id: envelope.task_id };
  }

  it('a site task cannot be resumed from a chat that is not that site chat', async () => {
    const { stack, id } = await paused(PROJECT_SITE_CHAT_SCOPE);
    const out = await stack.dispatcher.resume(id, 'the home page', { scope: null });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('scope_mismatch');
    expect(stack.ran).toEqual([]);
  });

  it('a non-site task cannot be dragged into a site chat and starved there', async () => {
    // The direction a union merge got wrong: the task legitimately needs the
    // generic tools, and resuming it under the site scope would withhold them
    // and then tell it to use site_* tools for a project that does not exist.
    const { stack, id } = await paused(null);
    const out = await stack.dispatcher.resume(id, 'go ahead', { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('scope_mismatch');
  });

  it('two DIFFERENT site projects are different chats, not one "site" context', async () => {
    // There is one `PROJECT_SITE_CHAT_SCOPE` object for every project-scoped
    // chat, so a check that compared scopes would call project A's chat and
    // project B's chat the same context: A's task summaries would render into
    // B's router prompt, and a task paused in A would be resumable from B,
    // replaying A's persisted tool results. The stored key carries the project
    // for exactly this reason.
    const { stack, id } = await paused(PROJECT_SITE_CHAT_SCOPE);
    expect(stack.taskRegistry.get(id)!.contextKey).toBe(SITE_CONTEXT_KEY);

    const otherProject = { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: 'site:proj-b' };
    const out = await stack.dispatcher.resume(id, 'go ahead', otherProject);
    expect(out.status).toBe('failed');
    expect(out.error).toBe('scope_mismatch');

    // And project B's router prompt does not list project A's task.
    const handle = (stack.conversation as unknown as {
      handleToolCall: (
        call: { id: string; name: string; arguments: Record<string, unknown> },
        turn: { userMessage: string; scope: TurnToolScope | null; contextKey?: string },
      ) => Promise<{ envelope: unknown }>;
    });
    const checked = await handle.handleToolCall(
      { id: 'c', name: 'check_task', arguments: { task_id: id } },
      { userMessage: 'x', ...otherProject },
    );
    expect((checked.envelope as { error?: string }).error).toContain('not found');
  });

  it('a resume in the chat that started it works, and is still scoped', async () => {
    const { stack, id } = await paused(PROJECT_SITE_CHAT_SCOPE);
    // Second run: the model now reaches for the generic shell.
    stack.provider.pushTask(toolCall('run_command', { command: 'npm i' }));
    stack.provider.pushTask(textResponse('done'));
    const out = await stack.dispatcher.resume(id, 'the home page', { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY });
    expect(out.status).toBe('completed');
    expect(stack.ran).toEqual([]);
  });

  it('a row whose scope id this build no longer defines fails closed', async () => {
    const { stack, id } = await paused(PROJECT_SITE_CHAT_SCOPE);
    // Simulate a renamed or removed scope constant.
    const record = stack.taskRegistry.get(id)!;
    (record as { contextKey?: string }).contextKey = 'a_key_this_build_no_longer_produces';
    const out = await stack.dispatcher.resume(id, 'the home page', { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('scope_mismatch');
  });

  it('another chat context\'s task is not visible to check_task or cancel_task', async () => {
    // The router chooses these ids itself, against a process-global registry
    // shared by every chat and channel, and the check_task reply carries the
    // task's intent and full result summary. "not found" is the answer for
    // someone else's task, indistinguishable from an unknown id.
    const { stack, id } = await paused(null);
    const handle = (stack.conversation as unknown as {
      handleToolCall: (
        call: { id: string; name: string; arguments: Record<string, unknown> },
        turn: { userMessage: string; scope: TurnToolScope | null; contextKey?: string },
      ) => Promise<{ envelope: unknown }>;
    });
    const siteTurn = { userMessage: 'x', scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY };

    const checked = await handle.handleToolCall({ id: 'c', name: 'check_task', arguments: { task_id: id } }, siteTurn);
    expect((checked.envelope as { error?: string }).error).toContain('not found');

    const cancelled = await handle.handleToolCall({ id: 'c', name: 'cancel_task', arguments: { task_id: id } }, siteTurn);
    expect((cancelled.envelope as { error?: string }).error).toContain('not found');
    // Still alive: the abort never reached it.
    expect(stack.taskRegistry.get(id)!.status).toBe('needs_input');

    // ...and from its OWN context both work.
    const ownTurn = { userMessage: 'x', scope: null };
    const own = await handle.handleToolCall({ id: 'c', name: 'check_task', arguments: { task_id: id } }, ownTurn);
    expect((own.envelope as { status?: string }).status).toBe('needs_input');
  });

  it('a pause with several calls in one batch keeps every tool_use paired', async () => {
    // Stripping system messages is only safe if they are head-only AND the
    // assistant/tool sequence is complete. The pause branch emits a `[Not run:
    // ...]` tool result for every sibling of the clarify call, so a batch pause
    // is still a valid buffer -- a provider rejects a `tool_use` with no
    // matching `tool_result`, and that rejection would only show up on resume.
    const batch: LLMResponse = {
      content: '',
      tool_calls: [
        { id: 'a1', name: 'site_write_file', arguments: { project_id: 'p', path: 'x' } },
        { id: 'a2', name: 'ask_for_clarification', arguments: { question: 'Which page?' } },
        { id: 'a3', name: 'site_run_command', arguments: { project_id: 'p', command: 'npm i' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'scripted',
      finish_reason: 'tool_use',
    };
    const stack = buildStack([textResponse('')], [batch]);
    const envelope = await stack.dispatcher.dispatch(
      { tier: 'medium', template: 'general', intent: 'x', original_message: 'add a hero' },
      { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY },
    );
    expect(envelope.status).toBe('needs_input');

    const buffer = stack.taskRegistry.get(envelope.task_id)!.pausedConversation as LLMMessage[];
    expect(buffer.some((m) => m.role === 'system')).toBe(false);
    // Every id the assistant asked for has a result.
    const asked = buffer.flatMap((m) => m.tool_calls ?? []).map((c) => c.id).sort();
    const answered = buffer.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
    expect(asked).toEqual(['a1', 'a2', 'a3']);
    expect(answered).toEqual(asked);
    // And the resume replays it intact, with fresh system messages on the front.
    stack.provider.pushTask(textResponse('done'));
    const resumed = await stack.dispatcher.resume(envelope.task_id, 'the home page', { scope: PROJECT_SITE_CHAT_SCOPE, contextKey: SITE_CONTEXT_KEY });
    expect(resumed.status).toBe('completed');
    const replayed = stack.provider.taskBuffers.at(-1)!;
    expect(replayed[0]!.role).toBe('system');
    const replayedAsked = replayed.flatMap((m) => m.tool_calls ?? []).map((c) => c.id).sort();
    const replayedAnswered = replayed.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
    expect(replayedAnswered).toEqual(replayedAsked);
  });

  it('the paused buffer carries no system messages, so the site block cannot outlive its turn', async () => {
    const { stack, id } = await paused(PROJECT_SITE_CHAT_SCOPE);
    const buffer = stack.taskRegistry.get(id)!.pausedConversation as { role: string }[];
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('#571 what a scoped turn leaves behind for LATER turns', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  it('a tool run in a site chat can see the originating scope, which is how a commitment records it', async () => {
    // The route that matters for the `commitments` gap is not ws-service's
    // heuristic auto-created row -- that comes from the user's own words and is
    // stamped explicitly -- but the row the MODEL writes through the in-scope
    // `commitments` tool. It is the one in-scope tool whose whole effect is to
    // schedule a later turn, and that turn runs on the background agent, which
    // does not carry this scope. `createCommitment` defaults `scope_id` from the
    // ambient turn scope, so what has to hold is that the ambient scope is
    // visible from inside the tool's own execution.
    const stack = buildStack(
      [DELEGATE('remind them'), textResponse('Done.')],
      [toolCall('commitments', { action: 'create', what: 'deploy the site' }), textResponse('reminded')],
    );
    await drain(stack, 'remind me to deploy this tomorrow', PROJECT_SITE_CHAT_SCOPE);
    // The tool ran: the scope deliberately leaves `commitments` alone.
    expect(stack.ran).toEqual(['commitments']);
    expect(stack.scopeIdSeenByTool).toBe(PROJECT_SITE_CHAT_SCOPE.id);
  });

  it('an unscoped turn leaves no ambient scope, so the row stays unstamped', async () => {
    const stack = buildStack(
      [DELEGATE('remind them'), textResponse('Done.')],
      [toolCall('commitments', { action: 'create', what: 'deploy' }), textResponse('reminded')],
    );
    await drain(stack, 'remind me to deploy this tomorrow', null);
    expect(stack.ran).toEqual(['commitments']);
    expect(stack.scopeIdSeenByTool).toBeUndefined();
  });

  it('the ambient scope does not leak past the tool call that set it', async () => {
    // It is entered per tool call, not per turn, and it is a module global, so
    // the one thing that must not happen is it surviving into unrelated work.
    const stack = buildStack(
      [DELEGATE('x'), textResponse('Done.')],
      [toolCall('commitments', {}), textResponse('ok')],
    );
    await drain(stack, 'remind me to deploy this tomorrow', PROJECT_SITE_CHAT_SCOPE);
    expect(stack.scopeIdSeenByTool).toBe(PROJECT_SITE_CHAT_SCOPE.id);
    // Outside any tool call there is no ambient scope.
    expect(currentTurnScopeId()).toBeUndefined();
  });
});
