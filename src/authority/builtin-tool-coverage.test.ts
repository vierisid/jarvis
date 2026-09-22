/**
 * Every builtin tool must carry an EXPLICIT Authority action.
 *
 * `getActionForTool` falls back to the tool's category and then to
 * `read_data`. That default is how a tool can ship gated at level 1 while
 * clicking buttons on the user's machine: give it a category no map knows
 * (`ui_act` shipped as `category: 'ui'`), and it silently resolves to
 * `read_data` - below the level check, outside the background-agent and
 * taint-gating profiles that govern `control_app`, and invisible to the
 * realtime blocked-categories list. Nothing failed; it just was not gated.
 *
 * `bounded-tools.test.ts` guards the workflow effect boundary, but only
 * across two hand-maintained sets, so a tool in neither slips past it. This
 * test walks BUILTIN_TOOLS itself: if you register a tool, name its action in
 * TOOL_ACTION_MAP.
 *
 * BUILTIN_TOOLS is not enough on its own -- see the second describe block.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import { buildProductionRegistry } from '../actions/tools/production-registry.ts';
import { TOOL_ACTION_MAP, getActionForTool } from './tool-action-map.ts';
import { REVIEWED_UI_TOOLS } from './ui-intent.ts';
import { AUTHORITY_REQUIREMENTS } from '../roles/authority.ts';

describe('builtin tool Authority coverage', () => {
  test('every builtin tool has an explicit TOOL_ACTION_MAP entry', () => {
    // `Object.hasOwn`, not `!TOOL_ACTION_MAP[name]`: the map is an object
    // literal, so the truthiness test is satisfied by an INHERITED key. A
    // tool named `constructor` or `toString` would read as mapped and
    // resolve to a Function, which then passes the level check in
    // engine.ts (`level < undefined` is false). See getActionForTool.
    const unmapped = BUILTIN_TOOLS.filter((t) => !Object.hasOwn(TOOL_ACTION_MAP, t.name))
      .map((t) => `${t.name} (category "${t.category}")`);
    expect(unmapped).toEqual([]);
  });

  test('every mapped action is a real Authority category', () => {
    for (const tool of BUILTIN_TOOLS) {
      const action = TOOL_ACTION_MAP[tool.name]!;
      expect(Object.hasOwn(AUTHORITY_REQUIREMENTS, action)).toBe(true);
    }
  });

  test('a tool that acts on the desktop or browser is never gated as a read', () => {
    // Tools whose effect reaches outside the daemon must clear more than
    // level 1. This is the property `ui_act` violated.
    const actors = ['ui_act', 'desktop_click', 'desktop_type', 'desktop_press_keys',
      'desktop_launch_app', 'desktop_focus_window', 'browser_click', 'browser_type', 'run_command',
      'run_skill', 'record_skill'];
    for (const name of actors) {
      const tool = BUILTIN_TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const action = getActionForTool(name, tool!.category);
      expect(action).not.toBe('read_data');
      expect(AUTHORITY_REQUIREMENTS[action]).toBeGreaterThanOrEqual(5);
    }
  });

  test('ui_act carries the same action as the desktop click it dispatches', () => {
    expect(TOOL_ACTION_MAP['ui_act']).toBe('control_app');
    expect(TOOL_ACTION_MAP['ui_act']).toBe(TOOL_ACTION_MAP['desktop_click']);
    expect(TOOL_ACTION_MAP['ui_snapshot']).toBe('read_data');
  });
});

/**
 * The same drift, one layer up. `REVIEWED_UI_TOOLS` (src/authority/ui-intent.ts)
 * is what makes a raw browser/desktop/structural mutation carry control_app and
 * a mandatory card; a tool missing from it keeps its static category and runs
 * with no review, which is the ungated state this boundary exists to end. The
 * set is matched by tool NAME, so a rename or a newly registered mutation is
 * silent: nothing throws, the tool simply stops being reviewed. These tests
 * force every tool in the three acting categories to be classified explicitly.
 */
describe('mandatory UI review coverage', () => {
  const UI_CATEGORIES: ReadonlySet<string> = new Set(['browser', 'desktop', 'ui']);

  /**
   * Observations. Note that browser_snapshot and browser_screenshot map to
   * access_browser rather than read_data, so "not a read_data entry" cannot
   * separate reads from mutations here -- they have to be named.
   */
  const UI_CATEGORY_READS: ReadonlySet<string> = new Set([
    'browser_snapshot', 'browser_screenshot',
    'desktop_list_windows', 'desktop_snapshot', 'desktop_screenshot', 'desktop_find_element',
    'ui_snapshot', 'manage_skills',
  ]);

  /** Replay/record a stored sequence; classified per call by their own authorityGate. */
  const PER_CALL_GATED: ReadonlySet<string> = new Set(['run_skill', 'record_skill']);

  test('every browser, desktop and structural builtin is explicitly classified', () => {
    const unclassified = BUILTIN_TOOLS
      .filter((t) => UI_CATEGORIES.has(t.category))
      .filter((t) => !REVIEWED_UI_TOOLS.has(t.name) && !UI_CATEGORY_READS.has(t.name) && !PER_CALL_GATED.has(t.name))
      .map((t) => `${t.name} (category "${t.category}")`);
    expect(unclassified).toEqual([]);
  });

  test('a reviewed name is never classified as a read as well', () => {
    expect([...REVIEWED_UI_TOOLS].filter((name) => UI_CATEGORY_READS.has(name))).toEqual([]);
  });

  test('every reviewed name is a builtin that still exists', () => {
    const names = new Set(BUILTIN_TOOLS.map((t) => t.name));
    expect([...REVIEWED_UI_TOOLS].filter((name) => !names.has(name))).toEqual([]);
  });
});

/**
 * The same guarantee, over the tools a real daemon actually registers.
 *
 * The first block walks BUILTIN_TOOLS, and that is why it did not catch #503.
 * `manage_workflow` and the eight `site-builder` tools are built by factories
 * at daemon start (src/daemon/index.ts) and appear in no static array, so all
 * nine sat outside every coverage check while `getActionForTool` resolved
 * them to `read_data` -- level 1, below the level check, outside the
 * background and taint profiles, and absent from the realtime
 * blocked-categories list. One of them, `site_run_command`, is a literal
 * `Bun.spawn(['sh','-c', cmd])`.
 *
 * So this block derives its set from `buildProductionRegistry()`, which calls
 * the real factories. Three of the assertions each close a different way the
 * guard could pass while covering nothing:
 *
 *   1. `skipped` is empty. A factory that will not build must FAIL the test,
 *      not quietly shrink the set it was supposed to check.
 *   2. the derived names equal a spelled-out list. Registering a tool then
 *      fails here until a human adds it, which turns "silently missing" into
 *      "deliberately reviewed". This is the pattern coverage.test.ts uses.
 *   3. every name has an `Object.hasOwn` entry in TOOL_ACTION_MAP. It has to
 *      be a property of the MAP, never of the resolved value: a
 *      `CATEGORY_ACTION_MAP['site-builder']` wildcard, or the fail-closed
 *      `execute_command` default, would satisfy any "does not resolve to
 *      read_data" phrasing while leaving every tool unreviewed.
 */
describe('daemon-registered tool Authority coverage', () => {
  /**
   * The MAXIMAL set: BUILTIN_TOOLS (33) plus the eight factory tools,
   * `manage_workflow`, and the eight site-builder tools. A given daemon
   * registers a subset -- `delegate_task` and `manage_agents` only when
   * specialists exist, `manage_goals` only when goals are enabled, the site
   * tools only when the site service starts -- and guarding the superset is
   * the point: a tool must be mapped whether or not this install happens to
   * switch it on. Update deliberately, and give the new tool a
   * TOOL_ACTION_MAP entry in the same change.
   */
  const EXPECTED_REGISTERED: readonly string[] = [
    'browser_click', 'browser_evaluate', 'browser_hover', 'browser_navigate',
    'browser_press_key', 'browser_screenshot', 'browser_scroll', 'browser_snapshot',
    'browser_type', 'browser_upload_file',
    'capture_screen', 'commitments', 'content_pipeline', 'create_document',
    'delegate_task',
    'desktop_click', 'desktop_find_element', 'desktop_focus_window', 'desktop_launch_app',
    'desktop_list_windows', 'desktop_press_keys', 'desktop_screenshot', 'desktop_snapshot',
    'desktop_type',
    'get_clipboard', 'get_system_info', 'list_directory', 'list_sidecars',
    'manage_agents', 'manage_goals', 'manage_skills', 'manage_workflow',
    'read_file', 'record_skill', 'request_approval', 'research_queue',
    'run_command', 'run_skill', 'set_clipboard',
    'site_create_project', 'site_delete_file', 'site_git_commit', 'site_github_push',
    'site_list_files', 'site_read_file', 'site_run_command', 'site_write_file',
    'ui_act', 'ui_snapshot', 'write_file',
  ];

  let registry: Awaited<ReturnType<typeof buildProductionRegistry>>;
  beforeAll(async () => { registry = await buildProductionRegistry(); });

  test('every factory builds; a skipped one is a coverage hole, not a caveat', () => {
    // Every test below presupposes this one: a factory that silently failed
    // would shrink the set they all check.
    expect(registry.skipped).toEqual([]);
  });

  test('the registered set is exactly the reviewed list', () => {
    expect([...new Set(registry.tools.map((t) => t.name))].sort()).toEqual([...EXPECTED_REGISTERED].sort());
  });

  test('every registered tool has an explicit TOOL_ACTION_MAP entry', () => {
    const unmapped = registry.tools.filter((t) => !Object.hasOwn(TOOL_ACTION_MAP, t.name))
      .map((t) => `${t.name} (category "${t.category}")`);
    expect(unmapped).toEqual([]);
  });

  test('every registered tool resolves to a real Authority category', () => {
    // Weak on its own: the fail-closed default IS a real category, so this
    // would pass against an empty map. It guards the map's VALUES (a typo
    // like 'write-data'); the explicit-entry test above is what guards
    // membership. Keep both.
    for (const tool of registry.tools) {
      const action = getActionForTool(tool.name, tool.category);
      expect(`${tool.name}:${Object.hasOwn(AUTHORITY_REQUIREMENTS, action)}`).toBe(`${tool.name}:true`);
    }
  });

  test('a tool that runs a shell is never gated as a read', () => {
    // The property #503 violated. site_run_command spawns `sh -c` with a
    // model-chosen command; site_create_project spawns the template CLI and
    // then `make install`, which execute third-party package code.
    //
    // Belt and braces: since the fallback itself now fails closed to
    // execute_command, this would pass even for an unmapped tool. The
    // explicit-entry test above is what actually discriminates.
    const byName = new Map(registry.tools.map((t) => [t.name, t]));
    for (const name of ['run_command', 'site_run_command', 'site_create_project']) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      const action = getActionForTool(name, tool!.category);
      expect(`${name}:${action}`).toBe(`${name}:execute_command`);
      expect(AUTHORITY_REQUIREMENTS[action]).toBeGreaterThanOrEqual(5);
    }
  });
});

/**
 * The backstop for the one hole the block above cannot see.
 *
 * `buildProductionRegistry` reads a hand-maintained `FACTORIES` list and no
 * daemon code. Register a tool in the daemon without adding it there and
 * every assertion above stays green over a set that no longer matches
 * production -- #503 relocated from TOOL_ACTION_MAP into FACTORIES, which is
 * no better.
 *
 * Nothing in the daemon can be imported here (starting it needs a database, a
 * browser and a sidecar), so this pins the registration CALL SITES as source
 * text instead. It is deliberately dumb: it does not prove the list is
 * complete, only that nobody added a registration without being made to look
 * at FACTORIES. A new `.register(...)` in one of these files fails this test
 * with the line that caused it.
 */
describe('daemon registration drift', () => {
  const DAEMON_FILES = [
    'src/daemon/index.ts',
    'src/daemon/agent-service.ts',
    'src/daemon/background-agent-service.ts',
  ];

  /**
   * Every tool-registry `.register(...)` argument in those files, reviewed.
   * Loop variables appear as `tool`. Adding a line here means checking that
   * `FACTORIES` in src/actions/tools/production-registry.ts builds it too.
   */
  const REVIEWED_REGISTRATIONS: readonly string[] = [
    // background-agent-service: NON_BROWSER_TOOLS, browser tools, desktop tools
    'background-agent-service.ts: tool',
    'background-agent-service.ts: tool',
    'background-agent-service.ts: tool',
    'background-agent-service.ts: commitmentsTool',
    'background-agent-service.ts: researchQueueTool',
    // agent-service: BUILTIN_TOOLS, then the factory tools
    'agent-service.ts: tool',
    'agent-service.ts: contentPipelineTool',
    'agent-service.ts: commitmentsTool',
    'agent-service.ts: researchQueueTool',
    'agent-service.ts: documentTool',
    'agent-service.ts: delegateTool',
    'agent-service.ts: agentTool',
    // index: the three registered at the composition root, plus site builder
    'index.ts: requestApprovalTool',
    'index.ts: manageWorkflowTool',
    'index.ts: tool',
    'index.ts: manageGoalsTool',
  ];

  test('no tool registration has been added without reviewing FACTORIES', async () => {
    const found: string[] = [];
    for (const path of DAEMON_FILES) {
      const text = await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
      const base = path.split('/').pop()!;
      // `<something>Reg|Registry.register(<arg>)`. Service-registry calls
      // (registry.register(wsService) and friends) use a bare `registry`
      // identifier, so requiring the Reg/Registry suffix on a tool-registry
      // receiver keeps them out without naming them.
      for (const m of text.matchAll(/\b(\w*(?:toolReg|toolRegistry|ToolRegistry|Reg))\.register\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        found.push(`${base}: ${m[2]}`);
      }
    }
    expect(found.sort()).toEqual([...REVIEWED_REGISTRATIONS].sort());
  });
});
