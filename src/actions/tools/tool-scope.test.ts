/**
 * #561: a project-scoped site chat is held to the site tool set.
 *
 * The prompt already told the model to use `site_read_file` / `site_write_file`
 * and forbade the generic ones. Two things this file has to prove, because
 * both were measured to be false before it:
 *
 *  - the contract is now the registry's, not the prompt's: a withheld tool
 *    cannot be offered, cannot be revealed by `discover_tools`, and -- the one
 *    that actually matters -- cannot be run by calling it off-list, which the
 *    filter otherwise admits and dispatches;
 *  - the relevance filter no longer SUBSTITUTES the generic tool for the site
 *    one. On "install react-router in the project" it used to offer
 *    `run_command` and withhold `site_run_command`. The before/after here is
 *    the measurement, kept as a test so it cannot quietly come back.
 *
 * And one thing that is not in the issue but was measured while fixing it:
 * withholding ALONE made an ordinary site ask worse, not better -- with the
 * generic tools gone and nothing pinned, "install react-router in the project"
 * matched no trigger at all and the turn was offered no file tool of any kind.
 * Hence the pinned category, and hence the assertions that every ordinary site
 * ask still gets the whole site set.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../../vault/schema.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import { ToolRegistry, type ToolDefinition } from './registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../../authority/engine.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { buildProductionRegistry } from './production-registry.ts';
import { decideTools, invariantViolationCount, resetInvariantViolationCount } from './tool-relevance/filter.ts';
import { isFramedPerception } from './tool-relevance/authority-classes.ts';
import { ToolExposureLedger, DISCOVER_TOOLS, NOT_RUN_MARKER } from './tool-relevance/ledger.ts';
import { resetToolFilterPolicy, setToolFilterPolicy, type ToolFilterPolicy } from './tool-relevance/policy.ts';
import {
  ALL_SCOPES, PROJECT_SITE_CHAT_SCOPE, isScopePinned, outOfScopeMessage, toolInScope, toolsInScope,
} from './tool-scope.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import type { TierMap } from '../../llm/tiers.ts';

const PROD = await buildProductionRegistry();
/** Every tool a running daemon registers, which is what a site chat's registry is. */
const ALL = PROD.tools;
const SCOPED = toolsInScope(ALL, PROJECT_SITE_CHAT_SCOPE);

const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: [] };
const TIERS: TierMap = { medium: { provider: 'ollama', model: 'qwen2.5:7b' } };
const PROVIDERS = { ollama: { kind: 'ollama' as const } };

/** The four the prompt names, plus the two that hand them to a sub-agent. */
const GENERIC = ['read_file', 'write_file', 'list_directory', 'run_command', 'delegate_task', 'manage_agents'];
const SITE = ['site_read_file', 'site_write_file', 'site_list_files', 'site_run_command',
  'site_create_project', 'site_git_commit', 'site_github_push', 'site_delete_file'];

/** Asks that reach for something the scope withheld, so the site surface stands in. */
const SUBSTITUTING_ASKS = [
  'install react-router in the project',
  'read src/App.tsx and fix the button colour',
  'what files are in the project?',
  'npm run build the project and show me the errors',
  'add a postinstall script to package.json',
  'run the tests in the project',
];

/** Asks with nothing to do with the project, typed into the same composer. */
const UNRELATED_ASKS = [
  'put this in a note',
  'set a goal to ship by friday',
  'draft a reply to that email',
  'remind me to deploy this tomorrow',
];

/**
 * What I1's union repair may restore alongside a site actor. Not a wish list:
 * it is read from the real classifier, so the assertion below tracks the
 * invariant rather than a snapshot of it.
 */
const FRAMED_PERCEPTION = new Set(ALL.filter((t) => isFramedPerception(t)).map((t) => t.name));

/** Ordinary things a person types into the Sites page composer. */
const SITE_ASKS = [
  'install react-router in the project',
  'add a hero section to the landing page',
  'read src/App.tsx and fix the button colour',
  'change the vite config to use port 4000',
  'run the tests in the project',
  'what files are in the project?',
  'update the Makefile dev target',
  'commit and push the site to github',
  'npm run build the project and show me the errors',
  'add a postinstall script to package.json',
  'make the header sticky',
  'why is the preview blank?',
];

function offered(ask: string, scoped: boolean): Set<string> {
  const decision = decideTools({
    all: scoped ? SCOPED : ALL,
    messages: [{ role: 'user', content: ask }],
    ledger: new ToolExposureLedger(),
    tier: 'medium',
    tiers: TIERS,
    providers: PROVIDERS,
    policy: ON,
    ...(scoped ? { scope: PROJECT_SITE_CHAT_SCOPE } : {}),
  });
  return new Set(decision.tools.map((t) => t.name));
}

describe('the scope itself', () => {
  test('the production registry built completely', () => {
    // Every claim below is quantified over the real registry. A factory that
    // stopped building would shrink it silently.
    expect(PROD.skipped).toEqual([]);
  });

  test('every withheld name is a tool that really exists', () => {
    // A typo, or a rename of `run_command`, would leave the scope withholding
    // nothing and the prompt back to being unenforced prose.
    const registered = new Set(ALL.map((t) => t.name));
    for (const name of PROJECT_SITE_CHAT_SCOPE.withheld) {
      expect(`${name}:${registered.has(name)}`).toBe(`${name}:true`);
    }
  });

  test('it withholds the generic file and shell tools and nothing else', () => {
    expect([...PROJECT_SITE_CHAT_SCOPE.withheld].sort()).toEqual([...GENERIC].sort());
    const dropped = ALL.filter((t) => !SCOPED.includes(t)).map((t) => t.name).sort();
    expect(dropped).toEqual([...GENERIC].sort());
  });

  test('the site tools survive, and so does the rest of the assistant', () => {
    const names = new Set(SCOPED.map((t) => t.name));
    for (const name of SITE) expect(`${name}:${names.has(name)}`).toBe(`${name}:true`);
    // The Sites page composer is still a chat box: "remind me to deploy this
    // tomorrow" and "put this in a note" must keep working.
    for (const name of ['commitments', 'create_document', 'manage_goals', 'browser_navigate', 'get_clipboard']) {
      expect(`${name}:${names.has(name)}`).toBe(`${name}:true`);
    }
  });

  test('the pinned category is the site tools', () => {
    for (const tool of ALL) {
      expect(`${tool.name}:${isScopePinned(tool, PROJECT_SITE_CHAT_SCOPE)}`)
        .toBe(`${tool.name}:${tool.category === 'site-builder'}`);
    }
  });

  test('no scope means no change at all', () => {
    expect(toolsInScope(ALL, null)).toBe(ALL);
    expect(toolsInScope(ALL, undefined)).toBe(ALL);
    expect(toolInScope(null, 'run_command')).toBe(true);
    expect(isScopePinned({ category: 'site-builder' }, null)).toBe(false);
  });

  test('a malformed scope withholds what it can and pins nothing', () => {
    // Fail direction: a smaller tool list, never a wider one.
    const broken = { id: 'x', label: 'x', withheld: null as unknown as ReadonlySet<string>, pinnedCategories: null as unknown as string[] };
    expect(toolInScope(broken, 'run_command')).toBe(true);
    expect(isScopePinned({ category: 'site-builder' }, broken)).toBe(false);
  });
});

describe('the substitution #561 measured', () => {
  test('"install react-router in the project" no longer gets the generic shell', () => {
    const ask = 'install react-router in the project';
    const before = offered(ask, false);
    const after = offered(ask, true);
    // The measured starting point: the filter preferred the generic one.
    expect(before.has('run_command')).toBe(true);
    expect(before.has('site_run_command')).toBe(false);
    // And after: the substitution cannot happen, because the tool is not there.
    expect(after.has('run_command')).toBe(false);
    expect(after.has('site_run_command')).toBe(true);
  });

  test('no ordinary site ask is offered a generic file or shell tool', () => {
    for (const ask of SITE_ASKS) {
      const names = offered(ask, true);
      const leaked = GENERIC.filter((n) => names.has(n));
      expect(`${ask}:${leaked.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('every ordinary site ask can at least see the project', () => {
    // The framed readers are always in: read_data, path-confined, framed, and
    // no invariant trigger, so they cost nothing.
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const names = offered(ask, true);
      const missing = ['site_read_file', 'site_list_files'].filter((n) => !names.has(n));
      expect(`${ask}:${missing.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('an ask that reaches for a withheld tool gets the whole site surface', () => {
    // Withholding without this made the turn worse than before the change:
    // the site group is triggered by build intent only, so "install
    // react-router in the project" and "what files are in the project?"
    // matched nothing once the generic tools were gone, and the chat was left
    // with no way to touch the project at all.
    for (const ask of SUBSTITUTING_ASKS) {
      const names = offered(ask, true);
      const missing = SITE.filter((n) => !names.has(n));
      expect(`${ask}:${missing.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('an unrelated ask is not handed the site actors, the shell or the loud tools', () => {
    // The regression this pins: pinning the surface unconditionally made
    // I1's union repair fire every turn, so "put this in a note" went from 4
    // offered tools to 27 -- browser_evaluate (same authority rank as
    // run_command), ui_act, the desktop actuators and the clipboard, none of
    // them asked for, and each previously reachable only through an AUDITED
    // admission.
    for (const ask of ['put this in a note', 'set a goal to ship by friday', 'draft a reply to that email']) {
      const names = offered(ask, true);
      const loud = ['site_run_command', 'site_delete_file', 'site_github_push',
        'browser_evaluate', 'ui_act', 'get_clipboard', 'desktop_snapshot'].filter((n) => names.has(n));
      expect(`${ask}:${loud.join(',')}`).toBe(`${ask}:`);
      // And the blast radius itself, so growth cannot go unnoticed.
      expect(`${ask}:${names.size <= 10}`).toBe(`${ask}:true`);
    }
  });

  test('a scoped turn never offers more than the same unscoped turn plus the site surface', () => {
    // A scope may only ever narrow, or swap the generic surface for the site
    // one. It must not be a way to be offered MORE than an ordinary chat is.
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const after = offered(ask, true);
      const extra = [...after].filter((n) => !offered(ask, false).has(n) && !SITE.includes(n));
      // The framing repair may restore framed perception tools alongside a
      // site actor; nothing else may appear.
      const unexpected = extra.filter((n) => !FRAMED_PERCEPTION.has(n));
      expect(`${ask}:${unexpected.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('pinning does not break the framing invariant', () => {
    // The pins go in at the candidate step, so normalizeToolSet still judges
    // them: an unframed site actor cannot be offered while a framed site
    // reader is hidden.
    resetInvariantViolationCount();
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) offered(ask, true);
    expect(invariantViolationCount()).toBe(0);
  });

  test('a non-site ask in a site chat still gets its own tool', () => {
    expect(offered('remind me to deploy this tomorrow', true).has('commitments')).toBe(true);
  });
});

describe('the two things a future change could silently undo', () => {
  /** Source with comment lines dropped, so a claim in a comment cannot satisfy a guard. */
  async function code(rel: string): Promise<string> {
    const text = await Bun.file(new URL(rel, import.meta.url)).text();
    return text.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  }

  test('no turn points the process-wide default cwd at a site project', async () => {
    // #570 added this as the guard on its amplifier fix, and #571 retired that
    // argument -- the conv path is scoped now, so a site chat has no generic
    // file or shell tool for a project-pointed cwd to aim. The guard stays,
    // because its SURVIVING reason is the stronger one and #571 does not
    // address it: `_defaultCwd` is a module-level global read by every tool
    // resolution on the process (actions/tools/local-tools-guard.ts), not a
    // per-turn value. Pointing it at a project aims the generic tools of every
    // OTHER concurrent chat at that project's tree -- chats the site scope
    // does not cover, because they carry no projectId. A per-turn control
    // cannot close a process-wide one.
    //
    // ws-service argues this at length in a comment, and a comment cannot fail.
    const ws = await code('../../daemon/ws-service.ts');
    expect(ws).not.toContain('setDefaultCwd(');
    // Nothing else in the daemon may set one either.
    for (const rel of ['../../daemon/agent-service.ts', '../../daemon/index.ts']) {
      const src = await code(rel);
      expect(`${rel}:${src.includes('setDefaultCwd(')}`).toBe(`${rel}:false`);
    }
  });

  test('both branches of streamMessageInner carry the scope and the site block', async () => {
    // This replaces #570's guard, which pinned the conv branch as KNOWN
    // UNSCOPED (`streamMessageConv(text, channel)`) so that threading the
    // site context through without the scope would fail rather than pass
    // quietly. #571 threaded both, so the guard is inverted rather than
    // deleted: the failure it was there to catch -- one branch of this fork
    // carrying less than the other -- is still the failure worth catching.
    const src = await code('../../daemon/agent-service.ts');
    const conv = /return this\.streamMessageConv\(([^)]*)\);/.exec(src);
    expect(conv).not.toBeNull();
    expect(conv![1]).toBe('text, channel, siteContext, scope');
    // ...and the classic branch, unchanged.
    expect(src).toContain('this.orchestrator.streamMessage(systemPrompt, text, undefined, undefined, undefined, scope)');
    // The non-streaming fork too: `handleMessage` has the same conv/classic
    // split and the same way of quietly dropping half the turn.
    expect(src).toContain('this.handleMessageConv(text, channel, scope)');
    expect(src).toContain('this.orchestrator.processMessage(systemPrompt, text, undefined, undefined, scope ?? null)');
  });

  test('the conv task runner hands the scope to processTaskCall', async () => {
    // The conv branch is only threaded if the scope survives the last hop.
    // ConvOrchestrator -> TaskDispatcher -> this closure -> processTaskCall
    // is where the hosted path's tool registry actually is, so a runner that
    // accepts a scope and forgets to pass it is the whole bug again, one
    // level down and harder to see.
    const src = await code('../../daemon/agent-service.ts');
    const call = /processTaskCall\(\{([\s\S]*?)\n        \}\)/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('scope,');
  });

  test('every path that appends a site block also appends the scope notice', async () => {
    // The prompt half. A turn that is handed the site block but not the
    // notice is being told to use the site tools by one paragraph while the
    // cached tool guide above it still documents `run_command` -- which is
    // the state #561 started from. conv-path-scope.test.ts mirrors this
    // assembly in its runner, so without this guard the mirror could keep
    // passing after production stopped doing it.
    const src = await code('../../daemon/agent-service.ts');
    const appendsSite = [...src.matchAll(/siteContext/g)].length;
    expect(appendsSite).toBeGreaterThan(0);
    // Four assembly sites, one per turn entry that builds a system prompt:
    // the classic stream, the image stream, the classic non-streaming
    // handleMessage, and the conv task runner. Each must reference the
    // notice, and the count is pinned so a fifth entry point cannot be added
    // without deciding about it.
    expect([...src.matchAll(/scopeSystemNote\(/g)].length).toBe(4);
  });

  test('every tool loop in the orchestrator decides about the scope explicitly', async () => {
    // `scope` is required on the private helpers so tsc catches a loop that
    // forgets it; this is the other half -- a loop passing `null` must be
    // doing it on purpose, and there must be no loop that neither passes a
    // scope nor passes null.
    const src = await code('../../agents/orchestrator.ts');
    const calls = [...src.matchAll(/this\.decideTurnTools\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) {
      expect(`${args}|${/,\s*(null|turnScope)\s*$/.test(args)}`).toBe(`${args}|true`);
    }
    const execs = [...src.matchAll(/this\.executeTool\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(execs.length).toBeGreaterThanOrEqual(3);
    for (const args of execs) {
      expect(`${args}|${/,\s*(null|turnScope)\s*$/.test(args)}`).toBe(`${args}|true`);
    }
    // ...and at least some of them must pass a REAL scope. Without this, a
    // future edit could set every site back to `null` -- the exact #571 bug --
    // and the "decided explicitly" assertion above would still pass.
    const live = (xs: string[]) => xs.filter((a) => /,\s*turnScope\s*$/.test(a)).length;
    expect(live(calls)).toBeGreaterThanOrEqual(4);
    expect(live(execs)).toBeGreaterThanOrEqual(3);
    // The ledger is the other thing a loop must not do unscoped: it is shared
    // process-wide, so noting a refused tool widens every other chat.
    const notes = [...src.matchAll(/this\.noteToolUse\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    for (const args of notes) {
      expect(`${args}|${/,\s*turnScope\s*$/.test(args)}`).toBe(`${args}|true`);
    }
    // And the two interceptors. These were the last `null`s to be found: an
    // off-list ADMISSION adds the name to that same shared ledger, so a loop
    // that scopes dispatch but not the interceptor refuses the call and
    // widens every other chat anyway.
    for (const fn of ['handleDiscoveryCall', 'handleOffListCall']) {
      const sites = [...src.matchAll(new RegExp(`this\\.${fn}\\(([^)]*)\\)`, 'g'))].map((m) => m[1]!);
      expect(`${fn}:${sites.length >= 3}`).toBe(`${fn}:true`);
      for (const args of sites) {
        expect(`${fn}(${args})|${/,\s*(null|turnScope)\s*$/.test(args)}`).toBe(`${fn}(${args})|true`);
      }
      expect(`${fn}:${sites.filter((a) => /,\s*turnScope\s*$/.test(a)).length >= 3}`).toBe(`${fn}:true`);
    }
  });

  test('no scope withholds request_approval', () => {
    // `executeToolInner` answers `request_approval` and returns BEFORE the
    // scope check, because gating the authority mechanism with the authority
    // mechanism would recurse. Harmless while nothing withholds it; a scope
    // that did would be silently unenforced, so the invariant is asserted
    // here rather than left to be discovered.
    for (const scope of ALL_SCOPES) {
      expect(`${scope.id}:${scope.withheld.has('request_approval')}`).toBe(`${scope.id}:false`);
    }
  });
});

describe('enforcement at dispatch, not just selection', () => {
  // The part that makes this a contract. The relevance filter is recoverable
  // by design: a tool it withholds can be asked back with discover_tools, and
  // an off-list call to a registered tool is admitted and then RUN. A scope
  // has to answer in a different place, or "restricted" would mean "offered
  // slightly less often".
  const role = {
    id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
    tools: ['terminal', 'browser', 'file-ops'], authority_level: 10,
  } as unknown as RoleDefinition;

  const config = (): AuthorityConfig => ({
    default_level: 10,
    governed_categories: [],
    overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
  });

  type Exec = {
    executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> },
      signal?: AbortSignal, taint?: Set<string>, scope?: unknown) => Promise<unknown>;
    handleDiscoveryCall: (tc: { id: string; name: string; arguments: Record<string, unknown> },
      exposed: ReadonlySet<string>, ledger: ToolExposureLedger, scope?: unknown) => { result: string } | null;
  };

  let calls: string[];
  let orch: AgentOrchestrator;

  beforeEach(() => {
    initDatabase(':memory:');
    setToolFilterPolicy(ON);
    calls = [];
    const registry = new ToolRegistry();
    const t = (name: string, category: string): ToolDefinition => ({
      name, description: 't', category, parameters: {},
      execute: async () => { calls.push(name); return 'ok'; },
    });
    for (const tool of [t('run_command', 'terminal'), t('read_file', 'file-ops'), t('write_file', 'file-ops'),
      t('list_directory', 'file-ops'), t('delegate_task', 'delegation'),
      t('site_write_file', 'site-builder'), t('site_run_command', 'site-builder')]) {
      registry.register(tool);
    }
    orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine(config()));
    orch.setApprovalManager(new ApprovalManager());
    orch.createPrimary(role);
  });
  afterEach(() => {
    resetToolFilterPolicy();
    closeDb();
  });

  const exec = (name: string, scope: unknown) =>
    (orch as unknown as Exec).executeTool({ id: 't', name, arguments: {} }, undefined, new Set<string>(), scope);

  test('a withheld tool called anyway is not run', async () => {
    for (const name of GENERIC.filter((n) => n !== 'manage_agents')) {
      const out = String(await exec(name, PROJECT_SITE_CHAT_SCOPE));
      expect(`${name}:${out.includes('no tool named')}`).toBe(`${name}:true`);
      expect(`${name}:${out.includes('site project chat')}`).toBe(`${name}:true`);
    }
    // Nothing ran. This is the assertion the whole issue comes down to.
    expect(calls).toEqual([]);
  });

  test('the refusal names the replacement and is not an authority denial', async () => {
    const out = String(await exec('run_command', PROJECT_SITE_CHAT_SCOPE));
    // "[AUTHORITY DENIED]" would read as "ask the user to approve this" and
    // invite a retry; this is an absence, not a decision.
    expect(out).not.toContain('AUTHORITY DENIED');
    expect(out).toContain('site_*');
    expect(out).toBe(outOfScopeMessage(PROJECT_SITE_CHAT_SCOPE, 'run_command'));
  });

  test('the site tools still run in the same turn', async () => {
    // `calls` is the evidence, not the returned string: a site reader's output
    // comes back wrapped in the #529 untrusted-content frame.
    expect(String(await exec('site_write_file', PROJECT_SITE_CHAT_SCOPE))).toContain('ok');
    expect(String(await exec('site_run_command', PROJECT_SITE_CHAT_SCOPE))).toContain('ok');
    expect(calls).toEqual(['site_write_file', 'site_run_command']);
  });

  test('without a scope the same calls run as before', async () => {
    expect(String(await exec('run_command', null))).toContain('ok');
    expect(String(await exec('read_file', undefined))).toContain('ok');
    expect(calls).toEqual(['run_command', 'read_file']);
  });

  test('the attempt leaves an audit row', async () => {
    // An off-list refusal and a discover_tools admission both write a row, and
    // this is the same class of event: a model in the chat with the highest
    // injection risk reaching for the generic shell. Without a row it is the
    // one thing in the turn that leaves no trace.
    const trail = new AuditTrail();
    orch.setAuditTrail(trail);
    await exec('run_command', PROJECT_SITE_CHAT_SCOPE);
    const rows = trail.query({ limit: 20 }).filter((r) => r.tool_name.includes('out_of_scope'));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tool_name).toBe('out_of_scope(run_command)');
    expect(rows[0]!.executed).toBeFalsy();
    expect(rows[0]!.authority_decision).toBe('denied');
    // The category is the tool's own, not a flattened read_data: a row saying
    // a shell was reached for is the point.
    expect(rows[0]!.action_category).toBe('execute_command');
  });

  test('the refusal tells the model not to come back, and marks the call not run', async () => {
    // The cached tool guide in the system prompt still documents every
    // registered tool, so without this the model has a standing invitation to
    // retry, and each retry is a full billed turn. The marker is what a
    // durable buffer looks for to skip a call when a turn is resumed.
    const out = String(await exec('read_file', PROJECT_SITE_CHAT_SCOPE));
    expect(out.startsWith(NOT_RUN_MARKER)).toBe(true);
    expect(out).toContain('will not become available');
  });

  test('a name nothing registers still reads as unknown, not out of scope', async () => {
    const out = String(await exec('invented_tool', PROJECT_SITE_CHAT_SCOPE));
    expect(out).toContain('no tool named "invented_tool"');
    expect(out).not.toContain('site project chat');
  });

  test('discover_tools cannot reveal a withheld tool', async () => {
    const answer = (orch as unknown as Exec).handleDiscoveryCall(
      { id: 'd', name: DISCOVER_TOOLS, arguments: {} },
      new Set(['site_write_file']),
      new ToolExposureLedger(),
      PROJECT_SITE_CHAT_SCOPE,
    );
    expect(answer).not.toBeNull();
    const catalogue = answer!.result;
    for (const name of GENERIC) {
      // As a whole name: `site_write_file` contains `write_file`, and the
      // catalogue is full of site tools.
      const mentioned = new RegExp(`(?<![a-z_])${name}(?![a-z_])`).test(catalogue);
      expect(`${name}:${mentioned}`).toBe(`${name}:false`);
    }
    expect(catalogue).toContain('site_run_command');
  });
});
