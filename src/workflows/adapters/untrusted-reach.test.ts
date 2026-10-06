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
 * The needle for premise 2 is the REPO IMPORT PATH, not the field names, and
 * that is the whole trick.
 *
 * Field names do not work: `manage_workflow` leaks `sample_data` without ever
 * spelling it, because `actGet` returns whole `FlowVersion` objects and the field
 * rides along inside them -- so a `sampleData` grep is green on the exact
 * regression this guard cites.
 *
 * Naming the accessors (`getFlowRun`, `getFlowVersion`, ...) does not work
 * either: `flow-version.ts` also exports `listVersions`, `createDraftVersion`,
 * `updateDraftVersion` and `lockVersion`, and `flow-run.ts` exports `updateRun`
 * and `createFlowRun`, all returning the same objects. An accessor list is a list
 * to forget to extend.
 *
 * Importing the repo module at all is the thing that cannot be done quietly, so
 * that is what is matched. The field names are kept as a second, weaker net for
 * a file that receives an object it did not fetch.
 *
 * Two limits, stated rather than implied. The grep is ONE HOP deep: a file that
 * re-exports an object it got from a reviewed file is not seen here and has to be
 * reviewed by hand (`goals/work-items.ts` is exactly that case -- see its row).
 * And the walk is rooted at `src/`, so the `ui/` dashboard tree is outside it;
 * that tree is person-facing, not a model boundary.
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

/**
 * Every production source file under src/, read once. Several tests below sweep
 * the tree for a handful of needles each, and re-reading it per needle costs
 * seconds for nothing.
 *
 * The vendored workflow engine is skipped: a separate tree with its own
 * conventions, holding plenty of `sampleData`/`failedStep` of its own and
 * importing none of the daemon's framing, so walking it finds only noise.
 */
const SOURCES: ReadonlyMap<string, string> = new Map(
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => !f.startsWith('workflows/activepieces/'))
    .sort()
    .map((rel) => [rel, readFileSync(join(SRC, rel), 'utf8')]),
);

const productionFiles = (): string[] => [...SOURCES.keys()];

const filesContaining = (needle: string): string[] =>
  [...SOURCES].filter(([, text]) => text.includes(needle)).map(([rel]) => rel);

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
 * Files OUTSIDE src/workflows/ that hold a run or a version object. The
 * `workflows/` prefix is a PROXY for "has left the data plane", not a proof of
 * one: `workflows/api/routes.ts` serves `sampleData` out over HTTP from inside
 * the tree. It is a good enough proxy because that surface and the `ui/`
 * dashboard are person-facing rather than model-facing, and this guard is about
 * model boundaries; both are reviewed out of band.
 *
 * Every row is either closed or person-facing. One FRAMES what it hands a
 * model; the others hold an object without handing captured step output to a
 * model at all, and each says why:
 *
 *   actions/tools/manage-workflow.ts   CLOSED by #582, and it was the real
 *                                     exposure #573 surfaced. get_run's
 *                                     `steps`, list_runs' `failedStep` and
 *                                     `get`'s `sample_data` (riding inside the
 *                                     whole `FlowVersion` it returns) reached
 *                                     the chat model unframed. All three now
 *                                     return one framed block wrapping the
 *                                     action's JSON, with the payload capped
 *                                     inside the tool so the dispatch's own
 *                                     `MAX_TOOL_RESULT_CHARS` cap cannot slice
 *                                     the closing delimiter off. Drawn at READ
 *                                     time, so the run record and `sample_data`
 *                                     never gain a per-message nonce -- which
 *                                     is the claim that matters here, and NOT
 *                                     the wider "nothing persists one": the
 *                                     delegation effect record
 *                                     (runtime/effect-boundary.ts) and
 *                                     `tasks.paused_conversation` both do,
 *                                     benignly, since each replays one complete
 *                                     block with one nonce. It did NOT join
 *                                     `UNTRUSTED_TOOL_NAMES`, so the reach
 *                                     table and the I1 repair are untouched.
 *                                     This row stays listed because the file
 *                                     still HOLDS a run and a version, which is
 *                                     what this guard tracks.
 *   goals/work-items.ts                OPEN-ish, and the one row the one-hop
 *                                     limit bites on. It puts the WHOLE
 *                                     `FlowRun` on `WorkItem.run`, `run.steps`
 *                                     included, and `goals/work-item-routes.ts`
 *                                     serves `listWorkItems`/`getWorkItem`
 *                                     straight over HTTP -- a person-facing
 *                                     surface, not a model, so it is accepted;
 *                                     but that downstream file spells none of
 *                                     these needles and is reviewed by hand.
 *                                     Separately it copies
 *                                     `failedStep.errorMessage` into
 *                                     `blocker.reason`, which goals/rhythm.ts
 *                                     then DOES frame at the prompt boundary --
 *                                     the precedent this whole decision follows.
 *   actions/tools/workflow-composer.ts BENIGN. It imports only the
 *                                     `FlowTriggerNode` TYPE, so it holds no run
 *                                     or version at all, and its `sampleData`
 *                                     reads are `trigger.sampleData` off the
 *                                     PIECE CATALOG -- a piece's own upstream
 *                                     output sample, never a run's capture.
 *   awareness/suggestion-composer.ts   BENIGN. Calls `createDraftVersion`, so it
 *                                     holds a freshly created `FlowVersion`
 *                                     whose `sampleData` is empty by
 *                                     construction. It writes a draft; it reads
 *                                     no run.
 *   brief/contracts.ts                BENIGN. Imports only workflow status
 *                                     TYPES for wire references. It fetches no
 *                                     run/version and exports no captured step
 *                                     payload. contracts.test.ts checks that
 *                                     the browser bundle cannot import a
 *                                     workflow repository at runtime.
 *   brief/adapters.ts                 BENIGN. projectWorkflowRef receives a
 *                                     version but copies only its id, flowId
 *                                     ownership check and state into an exact
 *                                     identity/status projection. It never
 *                                     forwards the object or captured payload
 *                                     to a model. adapters.test.ts supplies
 *                                     hostile extra fields and verifies none
 *                                     are read or returned. readBriefProvider
 *                                     is a generic gated reader, with no live
 *                                     provider registered in F-01; future
 *                                     providers still need boundary review.
 *   brief/composition.ts              BENIGN. Calls createDraftVersion and
 *                                     keeps only its newly created id in a
 *                                     durable job receipt. It reads no run or
 *                                     existing version, and supplies only the
 *                                     saved user specification to the composer.
 *                                     composition.test.ts writes hostile step
 *                                     capture data to a completed draft and
 *                                     verifies receipt/read/replay and later
 *                                     model prompts never include that data.
 *   daemon/api-routes.ts               BENIGN. Holds a whole `FlowVersion` but
 *                                     reads only `displayName`/`schemaVersion`
 *                                     off it, and answers HTTP rather than a
 *                                     model.
 *   goals/workflow-bridge.ts           BENIGN. Holds a whole
 *                                     `FlowVersion`/`FlowRun` but reads only ids
 *                                     and state.
 *
 * A new entry here means a new file holding a run or a version outside the
 * workflow tree. Decide what frames it before adding it -- "holds a whole object"
 * is enough to land here, because that is how the sample_data leak travelled.
 */
const REVIEWED_STEP_OUTPUT_READERS = [
  'actions/tools/manage-workflow.ts',
  'actions/tools/workflow-composer.ts',
  'awareness/suggestion-composer.ts',
  'brief/adapters.ts',
  'brief/composition.ts',
  'brief/contracts.ts',
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
   * The match is on the RECEIVER rather than on a bare method name, because
   * `TriggerManager.unregister` and any number of `Map.clear()` calls are
   * unrelated and matching the method alone drowns the signal in them. The
   * receiver alternation covers the aliases the repo actually uses -- daemon/
   * index.ts does `const toolReg = orchestrator.getToolRegistry()` -- and is
   * case-insensitive so `deps.toolRegistry.clear()` is not missed for want of a
   * capital T. An alias outside this list would evade it; that is the known limit
   * of doing this textually.
   */
  test('a bounded tool name cannot be re-registered with different semantics', () => {
    const registry = new ToolRegistry();
    const def = { name: 'read_file', description: 'd', category: 'file-ops', parameters: {}, execute: async () => 'x' };
    registry.register(def);
    expect(() => registry.register({ ...def, execute: async () => 'attacker' })).toThrow();
  });

  test('nothing removes a tool from a registry in production', () => {
    const removal = /\b(registry|toolreg|toolregistry|reg)\.(unregister|clear)\(/i;
    const removing = productionFiles()
      .filter((rel) => removal.test(SOURCES.get(rel)!))
      // registry.ts DEFINES the two methods; the point is that nobody calls them.
      .filter((rel) => rel !== 'actions/tools/registry.ts');
    expect(removing).toEqual([]);

    // Non-vacuous: the methods really do exist, so the hazard is real rather
    // than hypothetical, and this test is guarding something.
    const registrySource = SOURCES.get('actions/tools/registry.ts')!;
    expect(registrySource).toContain('unregister(');
    expect(registrySource).toContain('clear(');
  });
});

describe('#573 premise 2: the routes out of the workflow data plane are enumerated', () => {
  test('only the reviewed files outside src/workflows hold a run or a version object', () => {
    const readers = new Set<string>();
    for (const needle of [
      // Importing either repo at all. Accessor-agnostic, so a newly added
      // accessor cannot slip past, and it catches the whole-object pass-through
      // that the field names miss.
      'workflows/db/repos/flow-run', 'workflows/db/repos/flow-version',
      // The field names, as a weaker second net for a file that receives an
      // object it did not fetch itself.
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
