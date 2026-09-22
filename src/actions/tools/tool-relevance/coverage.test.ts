/**
 * Every builtin tool must carry a REVIEWED reach classification.
 *
 * Modelled on src/authority/builtin-tool-coverage.test.ts, and for the same
 * reason. `outsideReach` defaults an undeclared tool to `fetch`, which is the
 * safe side -- it can never reach the floor and it always forces the framed
 * readers to stay. But "safe by default" is not "reviewed": a perception tool
 * that quietly defaults to `fetch` would drag the whole 9.7 kB union into
 * every turn that keeps it, and nobody would notice because nothing fails.
 *
 * So this test pins the classification of every builtin by name. Registering
 * a tool without deciding what it can reach fails here.
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../builtin.ts';
import { outsideReach, isFloorEligible, isFramedPerception, isInvariantTrigger, type OutsideReach } from './authority-classes.ts';

/**
 * The reviewed classification of every tool in BUILTIN_TOOLS.
 *
 * `framed` entries are DERIVED from isUntrustedSourceTool and are listed
 * here only so the test fails loudly if the framing set changes underneath
 * the filter -- adding a tool to UNTRUSTED_TOOL_NAMES should be a deliberate
 * act in both places.
 */
const EXPECTED: Record<string, OutsideReach> = {
  // framed -- wrapped, defanged, taint-marking
  browser_navigate: 'framed',
  browser_snapshot: 'framed',
  browser_click: 'framed',
  browser_type: 'framed',
  browser_hover: 'framed',
  browser_press_key: 'framed',
  browser_scroll: 'framed',
  browser_screenshot: 'framed',
  browser_upload_file: 'framed',
  browser_evaluate: 'framed',
  desktop_snapshot: 'framed',
  desktop_find_element: 'framed',
  desktop_list_windows: 'framed',
  ui_snapshot: 'framed',
  ui_act: 'framed',
  run_skill: 'framed',
  record_skill: 'framed',
  read_file: 'framed',
  get_clipboard: 'framed',

  // fetch -- the model can aim these outside, and the result is not framed
  run_command: 'fetch',          // a shell is a general-purpose fetcher (curl)
  capture_screen: 'fetch',       // an image cannot be delimiter-framed
  desktop_screenshot: 'fetch',   // likewise
  list_directory: 'fetch',       // filenames are attacker-authored; model picks the path

  // replay -- stored text of mixed provenance, but not aimable outside
  manage_skills: 'replay',
  // Remote-authored strings (hostname, os, capabilities, each unavailable
  // capability's `reason`) straight off the sidecar's register frame. Not
  // aimable, so not `fetch` -- but emphatically not `inert`, and it must not
  // sit in a floor that no input can remove.
  list_sidecars: 'replay',

  // inert -- the model cannot aim these outside
  write_file: 'inert',
  set_clipboard: 'inert',
  get_system_info: 'inert',
  desktop_click: 'inert',
  desktop_type: 'inert',
  desktop_press_keys: 'inert',
  desktop_launch_app: 'inert',
  desktop_focus_window: 'inert',
};

describe('reach classification coverage', () => {
  test('every builtin tool has a reviewed classification', () => {
    const unreviewed = BUILTIN_TOOLS
      .filter((t) => !Object.hasOwn(EXPECTED, t.name))
      .map((t) => `${t.name} (category "${t.category}")`);
    expect(unreviewed).toEqual([]);
  });

  test('the reviewed classification matches what the code computes', () => {
    const drift = BUILTIN_TOOLS
      .filter((t) => Object.hasOwn(EXPECTED, t.name) && outsideReach(t) !== EXPECTED[t.name])
      .map((t) => `${t.name}: reviewed ${EXPECTED[t.name]}, computed ${outsideReach(t)}`);
    expect(drift).toEqual([]);
  });

  test('the table names no tool that is not registered', () => {
    const registered = new Set(BUILTIN_TOOLS.map((t) => t.name));
    expect(Object.keys(EXPECTED).filter((n) => !registered.has(n))).toEqual([]);
  });

  test('the floor is exactly the reviewed set, and it is small', () => {
    // Spelled out rather than computed: "never droppable" is the strongest
    // statement this design makes, so a change to the floor must be a
    // deliberate edit to this list and not a side effect of two predicates.
    // `write_file` and `set_clipboard` were here while the ceiling was
    // write_data (302); an unconstrained model-chosen file write has no
    // business being undroppable on a "set a goal" turn.
    expect(BUILTIN_TOOLS.filter(isFloorEligible).map((t) => t.name).sort()).toEqual([
      'get_system_info',
    ]);
  });

  test('the framed perception set is exactly the reviewed list', () => {
    // This is the set the invariant repair restores, so it gets the same
    // by-name lock as the floor. It is what surfaced browser_upload_file.
    expect(BUILTIN_TOOLS.filter(isFramedPerception).map((t) => t.name).sort()).toEqual([
      'browser_click', 'browser_evaluate', 'browser_hover', 'browser_navigate',
      'browser_press_key', 'browser_screenshot', 'browser_scroll', 'browser_snapshot',
      'browser_type', 'desktop_find_element', 'desktop_list_windows', 'desktop_snapshot',
      'get_clipboard', 'read_file', 'ui_act', 'ui_snapshot',
    ]);
  });

  test('the framed actors are excluded from the perception set', () => {
    for (const n of ['browser_upload_file', 'run_skill', 'record_skill']) {
      const t = BUILTIN_TOOLS.find((x) => x.name === n)!;
      expect(`${n}:${outsideReach(t)}`).toBe(`${n}:framed`);
      expect(`${n}:${isFramedPerception(t)}`).toBe(`${n}:false`);
    }
  });
});

/**
 * The tools registered by the daemon rather than shipped in BUILTIN_TOOLS.
 * They are not importable without their runtime dependencies, so this pins
 * the decision by name against a stand-in definition -- enough to catch
 * "someone changed the reach table and forgot these".
 */
describe('daemon-registered tool classification', () => {
  const EXPECTED_RUNTIME: Record<string, { category: string; reach: OutsideReach }> = {
    // fetch: `run` executes a composed workflow that can hold an HTTP step,
    // and `get_run` returns those step outputs. The model picks the workflow.
    manage_workflow: { category: 'automation', reach: 'fetch' },
    // fetch: a sub-agent browses and reports in its own unwrapped words, and
    // the model writes the task, so it aims it. Authority level is 1
    // (spawn_agent), so a rank-based rule would have missed both of these.
    delegate_task: { category: 'delegation', reach: 'fetch' },
    manage_agents: { category: 'delegation', reach: 'fetch' },
    // fetch: `create(what, when_due)` schedules an unattended agent turn
    // whose entire text the model writes, executed after a 5s default cancel
    // window with "use your tools (browser, terminal, file operations)", and
    // replays the output through `get` unframed. Strictly more aimable than
    // manage_workflow. It must never be the last tool standing on a
    // "remind me" turn.
    commitments: { category: 'tasks', reach: 'fetch' },
    // fetch: `add` takes a topic (a URL is legal) and `list` replays a
    // stored `result`. Inert today only because ResearchQueue.complete() has
    // no caller since the heartbeat was removed -- a deletion nothing
    // enforces is not a safety property.
    research_queue: { category: 'productivity', reach: 'fetch' },
    // replay: stored records, no parameter that names an outside resource.
    create_document: { category: 'documents', reach: 'replay' },
    content_pipeline: { category: 'content', reach: 'replay' },
    manage_goals: { category: 'goals', reach: 'replay' },
    // inert: returns the person's decision on an approval card.
    request_approval: { category: 'authority', reach: 'inert' },
  };

  test('each daemon-registered tool classifies as reviewed', () => {
    for (const [name, { category, reach }] of Object.entries(EXPECTED_RUNTIME)) {
      const stand_in = { name, description: 'x', category, parameters: {}, execute: async () => '' };
      expect(`${name}:${outsideReach(stand_in)}`).toBe(`${name}:${reach}`);
    }
  });

  test('request_approval is the only daemon-registered tool in the floor', () => {
    const floor = Object.entries(EXPECTED_RUNTIME)
      .filter(([name, { category }]) => isFloorEligible({ name, description: 'x', category, parameters: {}, execute: async () => '' }))
      .map(([name]) => name);
    expect(floor).toEqual(['request_approval']);
  });

  test('commitments is a trigger: it schedules an unattended agent turn', () => {
    // The tool takes free-text `what` plus `when_due`. A commitment it
    // creates has no `commitment_work` row, so the executor picks it up and
    // dispatches handleMessage(prompt, 'system') with "[COMMITMENT
    // EXECUTION - MANDATORY] ... Execute it NOW using your tools ...
    // browser, terminal, file operations", after a 5s default cancel
    // window. The output is replayed unframed by `get`. If this is ever
    // reclassified as `replay` it becomes the only tool standing on a
    // "remind me" turn and an unhardened, unaudited escape hatch.
    const t = { name: 'commitments', description: 'x', category: 'tasks', parameters: {}, execute: async () => '' };
    expect(outsideReach(t)).toBe('fetch');
    expect(isInvariantTrigger(t)).toBe(true);
    expect(isFloorEligible(t)).toBe(false);
  });

  test('research_queue is a trigger, not merely inert-by-dead-code', () => {
    const t = { name: 'research_queue', description: 'x', category: 'productivity', parameters: {}, execute: async () => '' };
    expect(outsideReach(t)).toBe('fetch');
    expect(isInvariantTrigger(t)).toBe(true);
  });

  test('a synthetic tool is inert and never a trigger, but never floor either', () => {
    // Rank 100 by fiat so the escape hatch does not itself pull the framed
    // readers back in on every filtered turn; floor-ineligible because it
    // has no explicit action-map entry.
    for (const name of ['discover_tools', 'ask_for_clarification']) {
      const t = { name, description: 'x', category: 'general', parameters: {}, execute: async () => '' };
      expect(`${name}:${outsideReach(t)}`).toBe(`${name}:inert`);
      expect(`${name}:${isInvariantTrigger(t)}`).toBe(`${name}:false`);
      expect(`${name}:${isFloorEligible(t)}`).toBe(`${name}:false`);
    }
  });

  test('the site-builder tools are never floor-eligible and always triggers', () => {
    // Unmapped in TOOL_ACTION_MAP and undeclared here, so rank Infinity and
    // reach `fetch`. One of them, site_run_command, is a real shell.
    for (const name of ['site_run_command', 'site_write_file', 'site_read_file', 'site_github_push']) {
      const t = { name, description: 'x', category: 'site-builder', parameters: {}, execute: async () => '' };
      expect(`${name}:${outsideReach(t)}`).toBe(`${name}:fetch`);
      expect(`${name}:${isFloorEligible(t)}`).toBe(`${name}:false`);
    }
  });
});
