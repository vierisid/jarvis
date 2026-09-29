/**
 * #573: a workflow step's tool result is NOT framed as untrusted content, and
 * that is a decision rather than an oversight. The argument lives on
 * `JarvisToolRegistryAdapter.execute` and in docs/WORKFLOW_AUTOMATION.md; this
 * file pins the two premises it rests on, because a comment cannot notice when
 * one of them stops being true.
 *
 * PREMISE 1: the reachable set is small, closed and known. Framing is refused
 * here partly on the strength of *which* untrusted-source tools a step can
 * actually name. Widen that set and the decision has to be made again.
 *
 * PREMISE 2: the places where a step's result reaches a MODEL are elsewhere, and
 * they are enumerated. This is the premise that actually carries the decision,
 * and it is the one that silently broke once already: `sample_data` auto-capture
 * (runner/handler.ts) made a plain `manage_workflow get` hand captured step
 * output to the chat model, and nothing failed when it landed. So the readers
 * are derived from source here too, in the idiom of
 * roles/untrusted-import-guard.test.ts.
 *
 * The needles for premise 2 are the REPO ENTRY POINTS, not the field names, and
 * that is the whole trick. Field names do not work: `manage_workflow` leaks
 * `sample_data` without ever spelling it, because `actGet` returns whole
 * `FlowVersion` objects and the field rides along inside them -- so a
 * `sampleData` grep is green on the exact regression this guard cites. Matching
 * the accessors that hand the objects out (`getFlowRun`, `listRuns`,
 * `getFlowVersion`, `getLatestDraft`) is shape-agnostic and catches the
 * pass-through case. The field names are kept as a second, weaker net.
 *
 * If this file goes red, the fix is almost certainly NOT to update the expected
 * value until it passes. It is to decide whether the #573 argument still holds.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOUNDED_TOOL_NAMES,
  GATED_TOOL_NAMES,
  OPAQUE_TOOL_NAMES,
} from '../runtime/effect-capabilities.ts';
import { isUntrustedSourceTool, markUntrustedToolResult } from '../../roles/untrusted.ts';
import { buildProductionRegistry } from '../../actions/tools/production-registry.ts';
import { JarvisToolRegistryAdapter } from './tool-registry.ts';
import { ToolRegistry, type ToolDefinition } from '../../actions/tools/registry.ts';

const SRC = join(import.meta.dir, '..', '..');

const productionFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    // Vendored workflow engine: a separate tree with its own conventions. It
    // holds plenty of `sampleData`/`failedStep` of its own and imports none of
    // the daemon's framing, so walking it finds only noise.
    .filter((f) => !f.startsWith('workflows/activepieces/'));

const filesContaining = (needle: string): string[] =>
  productionFiles()
    .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes(needle))
    .sort();

/**
 * PREMISE 1, the reviewed table.
 *
 * Every tool a `jarvis-tool` step can name, and whether its result is content
 * from outside the conversation.
 *
 * The eight `true` rows are what framing would have had to cover -- but not all
 * through one function. `browser_screenshot` returns a `ToolResult` with text and
 * image content blocks, not a string, and `markUntrustedToolResult` is
 * string-only; the chat path frames that shape through
 * `markUntrustedToolBlocks` instead. So "frame at the adapter" would have meant
 * both entry points, and the decision declines both.
 *
 * `toolEffectCapability` admits `BOUNDED_TOOLS`, `run_skill`, and anything
 * declaring `ToolDefinition.workflowEffect`; it refuses `OPAQUE_TOOLS`
 * outright. The set is closed today only because nothing declares
 * `workflowEffect` -- asserted separately below.
 */
const REVIEWED_REACHABLE: Record<string, boolean> = {
  // Untrusted sources. Framed and (mostly) taint-marking in a chat turn; plain
  // data in a workflow step, deliberately.
  read_file: true,
  get_clipboard: true,
  browser_snapshot: true,
  browser_screenshot: true,
  desktop_snapshot: true,
  desktop_find_element: true,
  desktop_list_windows: true,
  run_skill: true,
  // Not untrusted sources. capture_screen and desktop_screenshot taint a chat
  // turn but are not framed even there, so no framing decision reaches them.
  capture_screen: false,
  desktop_screenshot: false,
  get_system_info: false,
  list_directory: false,
  set_clipboard: false,
  write_file: false,
};

/**
 * PREMISE 2, the reviewed readers.
 *
 * Files OUTSIDE src/workflows/ that read a run's captured step output. Inside
 * the workflow runtime such a read is ordinary plumbing; outside it, the value
 * has left the data plane and is on its way to a model or a person, which is
 * where framing belongs.
 *
 * Each row is reviewed, which for two of them means "known-open boundary" rather
 * than "benign":
 *   actions/tools/manage-workflow.ts   OPEN. get_run's `steps`, list_runs'
 *                                     `failedStep` and `get`'s `sample_data`
 *                                     (inside the whole `FlowVersion` it
 *                                     returns) all reach the chat model
 *                                     unframed. The real exposure #573
 *                                     surfaced. Not yet filed as its own issue;
 *                                     see docs/WORKFLOW_AUTOMATION.md.
 *   actions/tools/workflow-composer.ts OPEN-ish. Reads `sampleData` while
 *                                     composing, so captured step output can
 *                                     reach the composer's model.
 *   goals/work-items.ts                BENIGN. Copies `failedStep.errorMessage`
 *                                     into `blocker.reason` -- which
 *                                     goals/rhythm.ts then DOES frame at the
 *                                     prompt boundary. The precedent this whole
 *                                     decision follows.
 *   daemon/api-routes.ts               BENIGN today. Holds a whole `FlowVersion`
 *                                     (getFlowVersion/getLatestDraft) but reads
 *                                     only `displayName`/`schemaVersion` off it,
 *                                     and answers HTTP rather than a model.
 *   goals/workflow-bridge.ts           BENIGN today. Holds a whole
 *                                     `FlowVersion`/`FlowRun` but reads only
 *                                     ids and state.
 *
 * A new entry here means a new route out of the workflow data plane. Decide what
 * frames it before adding it -- and note that "holds a whole object" is enough
 * to land here, because that is how the sample_data leak travelled.
 */
const REVIEWED_STEP_OUTPUT_READERS = [
  'actions/tools/manage-workflow.ts',
  'actions/tools/workflow-composer.ts',
  'daemon/api-routes.ts',
  'goals/work-items.ts',
  'goals/workflow-bridge.ts',
];

describe('#573 premise 1: the reachable tool set is closed and known', () => {
  test('the reachable set is exactly the reviewed table', () => {
    const reachable = [...BOUNDED_TOOL_NAMES, ...GATED_TOOL_NAMES].sort();
    expect(reachable).toEqual(Object.keys(REVIEWED_REACHABLE).sort());
  });

  test('nothing is both reachable and refused as opaque', () => {
    const both = [...BOUNDED_TOOL_NAMES, ...GATED_TOOL_NAMES].filter((n) => OPAQUE_TOOL_NAMES.has(n));
    expect(both).toEqual([]);
  });

  /**
   * A name LEAVING the opaque set is the quiet way to widen the reachable set,
   * so the refusals are pinned too. `browser_navigate` is the one that matters
   * most: it is the only tool that can point the browser at an arbitrary URL
   * directly. (`run_skill` can still navigate through a recorded skill step, so
   * this is not a claim that a flow cannot navigate -- see the docs.)
   */
  test('the opaque refusals still include the navigate and shell family', () => {
    for (const name of ['browser_navigate', 'browser_evaluate', 'run_command', 'record_skill']) {
      expect(`${name}:opaque=${OPAQUE_TOOL_NAMES.has(name)}`).toBe(`${name}:opaque=true`);
    }
  });

  /**
   * The untrusted-source verdict is DERIVED from each tool's real registered
   * category, not from a literal in this file. `isUntrustedSourceTool` keys
   * browser tools on `category === 'browser'`, so retagging `browser_snapshot`
   * would otherwise drop it from the set with no allowlist changing.
   */
  test('each reachable tool is the untrusted source the table says, by real category', async () => {
    const { tools, skipped } = await buildProductionRegistry();
    expect(skipped).toEqual([]);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const missing = Object.keys(REVIEWED_REACHABLE).filter((n) => !byName.has(n));
    expect(missing).toEqual([]);

    const drift: string[] = [];
    for (const [name, reviewed] of Object.entries(REVIEWED_REACHABLE)) {
      const tool = byName.get(name)!;
      const computed = isUntrustedSourceTool(tool.name, tool.category);
      if (computed !== reviewed) {
        drift.push(`${name} (category ${tool.category}): reviewed ${reviewed}, computed ${computed}`);
      }
    }
    expect(drift).toEqual([]);

    // The set is closed only while nothing declares `workflowEffect`: that field
    // is the one route into `toolEffectCapability` (it sets the floor directly,
    // effect-capabilities.ts) that no allowlist here watches. Asserted on the
    // real objects rather than by grepping for `workflowEffect:`, because the
    // grep misses shorthand, later assignment, and a space before the colon.
    expect(tools.filter((t) => t.workflowEffect !== undefined).map((t) => t.name)).toEqual([]);
  });

  /** Non-vacuous: the decision would be trivial if nothing reachable were untrusted. */
  test('the untrusted-source subset is the eight tools the decision is about', () => {
    const untrusted = Object.entries(REVIEWED_REACHABLE).filter(([, v]) => v).map(([n]) => n);
    expect(untrusted.length).toBe(8);
  });

  /**
   * A cheap second net over the same route as the runtime assertion above, which
   * is the one that actually closes it. `governedPieceToolDefinition` in
   * runtime/piece-effects.ts mints the shape for pieces and is never registered
   * in the ToolRegistry, so it is the one permitted producer.
   */
  test('no source file outside the workflow runtime spells a workflowEffect declaration', () => {
    const declarers = filesContaining('workflowEffect:').filter((rel) => rel !== 'workflows/runtime/piece-effects.ts');
    expect(declarers).toEqual([]);
  });

  /**
   * Reachability is decided by NAME, not by which definition holds the name, so
   * a re-registration under a bounded name would inherit its admission with
   * different semantics. Two things stop that, and both are asserted rather than
   * assumed: `register` refuses a duplicate, and nothing that handles a
   * ToolRegistry removes a tool first -- `unregister` AND `clear` both exist and
   * both have no production caller, and clear-then-register defeats the
   * duplicate throw exactly as well as unregister does.
   *
   * The match is on a `...registry.unregister(` / `...registry.clear(` RECEIVER
   * rather than on a bare method name: `TriggerManager.unregister` and any number
   * of `Map.clear()` calls are unrelated, and matching the method alone drowns
   * the signal in them. Case-insensitive on the receiver, so
   * `deps.toolRegistry.clear()` is not missed for want of a capital T.
   */
  test('a bounded tool name cannot be re-registered with different semantics', () => {
    const registry = new ToolRegistry();
    const def = { name: 'read_file', description: 'd', category: 'file-ops', parameters: {}, execute: async () => 'x' };
    registry.register(def);
    expect(() => registry.register({ ...def, execute: async () => 'attacker' })).toThrow();
  });

  test('nothing removes a tool from a registry in production', () => {
    const removal = /registry\.(unregister|clear)\(/i;
    const removing = productionFiles()
      .filter((rel) => removal.test(readFileSync(join(SRC, rel), 'utf8')))
      // registry.ts DEFINES the two methods; the point is that nobody calls them.
      .filter((rel) => rel !== 'actions/tools/registry.ts');
    expect(removing).toEqual([]);

    // Non-vacuous: the methods really do exist, so the hazard is real rather
    // than hypothetical, and this test is guarding something.
    const registrySource = readFileSync(join(SRC, 'actions/tools/registry.ts'), 'utf8');
    expect(registrySource).toContain('unregister(');
    expect(registrySource).toContain('clear(');
  });
});

describe('#573 premise 2: the routes out of the workflow data plane are enumerated', () => {
  test('only the reviewed files outside src/workflows read a run\'s captured step output', () => {
    const readers = new Set<string>();
    for (const needle of [
      // The accessors that hand a whole run or version out. These are the ones
      // that matter: a field can ride along inside the object unnamed.
      'getFlowRun', 'listRuns', 'getFlowVersion', 'getLatestDraft',
      // The field names, as a weaker second net.
      'sampleData', 'failedStep', 'run.steps',
    ]) {
      for (const rel of filesContaining(needle)) {
        if (!rel.startsWith('workflows/')) readers.add(rel);
      }
    }
    expect([...readers].sort()).toEqual([...REVIEWED_STEP_OUTPUT_READERS].sort());
  });
});

describe('#573: the adapter does not frame, and that is asserted not assumed', () => {
  const adapterFor = (name: string, category: string, execute: ToolDefinition['execute']) => {
    const registry = new ToolRegistry();
    registry.register({ name, description: 'd', category, parameters: {}, execute });
    return new JarvisToolRegistryAdapter(registry);
  };

  /**
   * The behavioural statement of the decision. `read_file` is an untrusted
   * source, so the same bytes in a chat turn come back wrapped; here they come
   * back exactly as the tool produced them, because a workflow step's consumer
   * is code.
   */
  test("an untrusted-source tool's result reaches the step unframed and byte-exact", async () => {
    const bytes = '{"apiUrl":"https://example.test","retries":3}';
    const out = await adapterFor('read_file', 'file-ops', async () => bytes).execute('read_file', {});

    expect(out).toBe(bytes);
    // Non-vacuous: the chat path really would have wrapped this.
    expect(markUntrustedToolResult('read_file', 'file-ops', bytes)).not.toBe(bytes);
    // The corruption the decision exists to avoid: a flow piping this into
    // write_file writes the file back unchanged, and JSON.parse still works.
    expect(() => JSON.parse(out as string)).not.toThrow();
  });

  test('a browser result reaches the step unframed too, matched by category', async () => {
    const page = 'heading "Invoices"\nbutton "Pay"';
    const out = await adapterFor('browser_snapshot', 'browser', async () => page).execute('browser_snapshot', {});
    expect(out).toBe(page);
    expect(markUntrustedToolResult('browser_snapshot', 'browser', page)).not.toBe(page);
  });
});
