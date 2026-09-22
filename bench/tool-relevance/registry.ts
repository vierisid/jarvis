/**
 * Build a tool set that matches what a real daemon registers.
 *
 * `BUILTIN_TOOLS` is 33 tools; a running daemon registers nine more from
 * factories (plus eight site-builder tools when sites are enabled). Measuring
 * only the builtins understates the schema budget by 43%, and it hides the
 * tools that matter most to the economics -- `manage_workflow` alone is the
 * single largest schema in the product.
 *
 * The factories take runtime dependencies this harness has no business
 * starting, so each is constructed with a stub and skipped if it will not
 * build. Every skip is reported: a silently short list would quietly change
 * every number below it.
 */

import { BUILTIN_TOOLS } from '../../src/actions/tools/builtin.ts';
import type { ToolDefinition } from '../../src/actions/tools/registry.ts';

const stub = (x: unknown) => x as never;

type Factory = { label: string; build: () => Promise<ToolDefinition> };

const FACTORIES: Factory[] = [
  { label: 'content_pipeline', build: async () => (await import('../../src/actions/tools/content.ts')).contentPipelineTool },
  { label: 'commitments', build: async () => (await import('../../src/actions/tools/commitments.ts')).commitmentsTool },
  { label: 'create_document', build: async () => (await import('../../src/actions/tools/documents.ts')).documentTool },
  { label: 'research_queue', build: async () => (await import('../../src/actions/tools/research.ts')).researchQueueTool },
  { label: 'manage_goals', build: async () => (await import('../../src/actions/tools/goals.ts')).createManageGoalsTool(stub({})) },
  { label: 'manage_workflow', build: async () => (await import('../../src/actions/tools/manage-workflow.ts')).createManageWorkflowTool(stub({})) },
  { label: 'request_approval', build: async () => (await import('../../src/actions/tools/approval-tool.ts')).createRequestApprovalTool(stub({})) },
  {
    label: 'delegate_task',
    build: async () => (await import('../../src/actions/tools/delegate.ts'))
      .createDelegateTool(stub({ specialists: new Map([['research-analyst', {}]]) })),
  },
  {
    label: 'manage_agents',
    build: async () => {
      const mod = await import('../../src/actions/tools/agents.ts') as Record<string, unknown>;
      for (const key of Object.keys(mod)) {
        const fn = mod[key];
        // Only zero-or-one-arg factories, and only ones whose name looks
        // like a builder. Probing every export blindly calls the module's
        // async ACTION helpers, whose rejected promises escape this
        // synchronous try and surface as unhandled rejections.
        if (typeof fn !== 'function' || !/^create/.test(key)) continue;
        try {
          const t = (fn as (d: unknown) => ToolDefinition)(stub({ specialists: new Map() }));
          if (t && typeof t === 'object' && 'name' in t && t.name === 'manage_agents') return t;
        } catch { /* try the next export */ }
      }
      throw new Error('manage_agents factory not found');
    },
  },
];

export type ProductionRegistry = {
  tools: ToolDefinition[];
  /** Factories that could not be built here, by label. */
  skipped: string[];
};

export async function buildProductionRegistry(): Promise<ProductionRegistry> {
  const extra: ToolDefinition[] = [];
  const skipped: string[] = [];
  for (const f of FACTORIES) {
    try {
      extra.push(await f.build());
    } catch (err) {
      skipped.push(`${f.label} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { tools: [...BUILTIN_TOOLS, ...extra], skipped };
}
