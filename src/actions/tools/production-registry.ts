/**
 * Every tool a running daemon registers, built from the real factories.
 *
 * `BUILTIN_TOOLS` is only part of what the agent can call. The daemon also
 * registers nine tools from factories (`src/daemon/index.ts`,
 * `src/daemon/agent-service.ts`) and, when `sites.enabled`, eight more from
 * `createSiteBuilderTools`. Anything that wants to reason about "the tools
 * that exist" has to include those, and #503 is what happens when it does
 * not: `manage_workflow` and all eight site-builder tools -- one of them a
 * real `sh -c` shell -- had no Authority action, and the coverage test that
 * existed to catch exactly that walked `BUILTIN_TOOLS` and so never saw them.
 *
 * The factories take runtime dependencies (a project manager, a trigger
 * manager, an approval manager) that a test or a benchmark has no business
 * starting, so each is built with a stub.
 *
 * Most factories only capture their dependency in a closure, and an empty
 * stub is enough. FOUR read theirs while building, which is why their stubs
 * are shaped rather than empty: `delegate.ts` and `agents.ts` both do
 * `Array.from(deps.specialists.keys())` to build the description and THROW on
 * `{}`; `manage-workflow.ts` reads `deps.library?.length` (safe only for the
 * optional chain); `createSiteBuilderTools` tests `githubManager` for
 * truthiness to decide whether `site_github_push` exists at all. A factory
 * that starts reading its dependency therefore surfaces as a loud `skipped`
 * entry rather than a silent hole -- which is the property callers rely on.
 *
 * A factory that will not build is reported in `skipped` rather than silently
 * dropped: a short list quietly reduces coverage, which is the same failure
 * mode as the gap this module exists to close. Callers that depend on
 * completeness must assert `skipped` is empty.
 *
 * LIMIT, and it is the important one: this list is hand-maintained and reads
 * no daemon code. Registering a tool in `src/daemon/*.ts` without adding it
 * here relocates #503 rather than fixing it -- the coverage test would stay
 * green over a set that no longer matches production. `daemon-registration-
 * drift` in builtin-tool-coverage.test.ts is the backstop for that: it pins
 * the registration call sites themselves, so a new one fails a test until
 * someone updates FACTORIES.
 */

import { BUILTIN_TOOLS } from './builtin.ts';
import type { ToolDefinition } from './registry.ts';

/**
 * Stand-in for a runtime dependency. Safe because every factory below only
 * captures its argument in a closure; none calls into it while building.
 */
const stub = (x: unknown) => x as never;

type Factory = { label: string; build: () => Promise<ToolDefinition[]> };

const FACTORIES: Factory[] = [
  { label: 'content_pipeline', build: async () => [(await import('./content.ts')).contentPipelineTool] },
  { label: 'commitments', build: async () => [(await import('./commitments.ts')).commitmentsTool] },
  { label: 'create_document', build: async () => [(await import('./documents.ts')).documentTool] },
  { label: 'research_queue', build: async () => [(await import('./research.ts')).researchQueueTool] },
  { label: 'manage_goals', build: async () => [(await import('./goals.ts')).createManageGoalsTool(stub({}))] },
  { label: 'manage_workflow', build: async () => [(await import('./manage-workflow.ts')).createManageWorkflowTool(stub({}))] },
  { label: 'request_approval', build: async () => [(await import('./approval-tool.ts')).createRequestApprovalTool(stub({}))] },
  {
    label: 'delegate_task',
    build: async () => [(await import('./delegate.ts'))
      .createDelegateTool(stub({ specialists: new Map([['research-analyst', {}]]) }))],
  },
  {
    // Reads deps.specialists while building the description, like delegate.
    label: 'manage_agents',
    build: async () => [(await import('./agents.ts'))
      .createManageAgentsTool(stub({ specialists: new Map() }))],
  },
  {
    // All eight at once. The third argument MUST be truthy: `site_github_push`
    // is spread in conditionally on `githubManager` (src/sites/builder-tools.ts),
    // so building with two stubs yields seven tools and silently omits the one
    // that publishes the project off-device.
    label: 'site-builder',
    build: async () => (await import('../../sites/builder-tools.ts'))
      .createSiteBuilderTools(stub({}), stub({}), stub({})),
  },
];

export type ProductionRegistry = {
  tools: ToolDefinition[];
  /** Factories that could not be built here, by label. Must be empty for a coverage claim. */
  skipped: string[];
};

export async function buildProductionRegistry(): Promise<ProductionRegistry> {
  const extra: ToolDefinition[] = [];
  const skipped: string[] = [];
  for (const f of FACTORIES) {
    try {
      extra.push(...await f.build());
    } catch (err) {
      skipped.push(`${f.label} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { tools: [...BUILTIN_TOOLS, ...extra], skipped };
}
