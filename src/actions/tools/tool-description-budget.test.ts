/**
 * Guards the description trim from #504.
 *
 * The six daemon-registered tools below were 14,072 B of emitted JSON schema,
 * 36% of the whole tool-schema budget that ships on every request. Trimming
 * them is only safe while the text that remains still does its job, so this
 * pins the four things a byte-count alone cannot see:
 *
 *   1. A per-tool byte ceiling, so nobody re-fattens them back.
 *   2. The DISCRIMINATORS -- the words that separate a tool from the
 *      neighbour a model would otherwise confuse it with, and the
 *      preconditions/side effects it would otherwise violate. A cut that
 *      drops one of these is a selection regression that no test would
 *      otherwise catch.
 *   3. The two structural contracts on the description's shape. The first
 *      SENTENCE becomes the `discover_tools` catalogue line, and the first
 *      LINE is all the workflow composer prompt shows. Both truncate, so
 *      both helpers below are copied from their originals rather than
 *      approximated -- an approximation here passes while the real surface
 *      renders a line ending in "th...".
 *   4. That every advertised `enum` value is one the tool's own `execute`
 *      actually accepts. `validateParameters` REJECTS an out-of-enum value,
 *      so a `case` label renamed without its enum turns a working call into
 *      a hard failure.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { toolDefToLLMTool } from './builtin.ts';
import type { ToolDefinition } from './registry.ts';
import { contentPipelineTool } from './content.ts';
import { commitmentsTool } from './commitments.ts';
import { documentTool } from './documents.ts';
import { createManageGoalsTool } from './goals.ts';
import { createManageWorkflowTool } from './manage-workflow.ts';
import { createRequestApprovalTool } from './approval-tool.ts';
import { renderToolSpecLines } from './workflow-composer.ts';

const stub = (x: unknown) => x as never;

/**
 * `manage_workflow` has two shapes. With a library index it carries four
 * extra lines about `suggestedInstalls`; the daemon builds that variant for
 * every install that is NOT host-managed, i.e. the common one. Measuring
 * only the no-library build would leave the shipped variant uncovered.
 */
const workflowNoLibrary = createManageWorkflowTool(stub({}));
const workflowWithLibrary = createManageWorkflowTool(
  stub({ library: [{ id: 'x', displayName: 'X', description: 'x' }] }),
);

/**
 * Ceilings are the measured post-#504 size plus a small margin. They are a
 * ratchet, not a target: a change that needs more room should say why in its
 * own commit rather than nudging the number.
 */
const TOOLS: { tool: ToolDefinition; ceiling: number }[] = [
  { tool: workflowNoLibrary, ceiling: 2650 },
  { tool: contentPipelineTool, ceiling: 1750 },
  { tool: createRequestApprovalTool(stub({})), ceiling: 1650 },
  { tool: createManageGoalsTool(stub({})), ceiling: 1500 },
  { tool: commitmentsTool, ceiling: 1500 },
  { tool: documentTool, ceiling: 1300 },
];

const bytes = (t: ToolDefinition) =>
  JSON.stringify(toolDefToLLMTool(t)).length;

/**
 * Copied verbatim from `tool-relevance/discover.ts summarise()`, which is
 * also what `bench/tool-relevance/cases.ts` derives its prompts from.
 */
function summarise(description: string): string {
  const cut = description.search(/\.\s/);
  const first = cut > 0 ? description.slice(0, cut + 1) : description;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first.trim();
}

/** Copied verbatim from `workflow-composer.ts firstLine()`. */
function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t.length > 100 ? `${t.slice(0, 97)}...` : t;
  }
  return '';
}

describe('#504 tool description budget', () => {
  for (const { tool, ceiling } of TOOLS) {
    it(`${tool.name} stays under ${ceiling} B of emitted schema`, () => {
      expect(bytes(tool)).toBeLessThanOrEqual(ceiling);
    });
  }

  it('manage_workflow stays bounded in its library variant too', () => {
    // The suggest-install paragraph is the difference; it must not become a
    // licence to regrow the rest.
    expect(bytes(workflowWithLibrary)).toBeLessThanOrEqual(2950);
    expect(bytes(workflowWithLibrary)).toBeGreaterThan(bytes(workflowNoLibrary));
  });

  it('the six together stay well under a third of the budget', () => {
    const total = TOOLS.reduce((s, { tool }) => s + bytes(tool), 0);
    // 14,072 B before #504. The point of the ceiling is that the trim holds.
    expect(total).toBeLessThanOrEqual(10_000);
  });
});

describe('#504 descriptions keep their discriminators', () => {
  const cases: [ToolDefinition, string[]][] = [
    // Nearest neighbours are write_file (same "save some text" shape) and
    // content_pipeline. The tool is NAMED create_document, so the other
    // verbs have to be spelled out or the name misinforms.
    [documentTool, ['write_file', 'content_pipeline', 'download', 'append', 'update', 'list']],
    // Nearest neighbour is create_document. append_body vs set_body is the
    // constraint whose violation silently truncates the user's draft.
    [contentPipelineTool, ['create_document', 'append_body', 'set_body', 'advance', 'regress']],
    // Two neighbours: manage_goals (an OKR, not a task) and manage_workflow
    // (recurring, not one-off). The trigger words genuinely overlap.
    [commitmentsTool, ['manage_goals', 'manage_workflow', 'due date']],
    // Nearest neighbour is commitments.
    [createManageGoalsTool(stub({})), ['commitments', '0.0-1.0']],
    // The anti-bypass clause is the entire point of the tool: gating by tool
    // name is defeated by driving browser/desktop tools to the same end.
    // This is a security gate, so the pin is exhaustive.
    [
      createRequestApprovalTool(stub({})),
      [
        'BEFORE', 'MUST', 'REGARDLESS', 'browser_click',
        'APPROVAL REQUIRED', '[APPROVED]', '[DENIED]', '[EXPIRED]', 'STOP', 'read-only',
      ],
    ],
    // compose-vs-create steering, the DISABLED-then-publish contract, and the
    // CODE-step refusal. manage-workflow.test.ts and flow-code-steps.test.ts
    // pin some of these too; kept here so the set reads in one place.
    [
      workflowNoLibrary,
      ['compose { name, description }', 'Composed flows are DISABLED', 'empty: true', 'REFUSED', 'no tool action'],
    ],
  ];

  for (const [tool, needles] of cases) {
    for (const needle of needles) {
      it(`${tool.name} still says "${needle}"`, () => {
        expect(tool.description).toContain(needle);
      });
    }
  }

  it('the empty flag still steers a described workflow to compose', () => {
    // "Required by create" alone reads as a formality to satisfy, which is
    // exactly the silent-empty-flow failure the flag exists to prevent.
    expect(workflowNoLibrary.parameters.empty!.description).toContain('compose');
  });

  it('list_runs still advertises its per-flow filter', () => {
    expect(workflowNoLibrary.parameters.flow!.description).toContain('list_runs');
  });
});

describe('#504 description shape contracts', () => {
  for (const { tool } of TOOLS) {
    it(`${tool.name} opens with a line the composer renders whole`, () => {
      const line = firstLine(tool.description);
      // firstLine() truncates past 100 chars; a truncated tool listing is a
      // line that stops mid-word.
      expect(line.endsWith('...')).toBe(false);
      expect(line.length).toBeLessThanOrEqual(100);
      // The composer shows this line and nothing else, so it has to be a
      // complete thought.
      expect(line).toMatch(/[.:]$/);
    });

    it(`${tool.name} opens with a catalogue entry that stands alone`, () => {
      const entry = summarise(tool.description);
      expect(entry.endsWith('...')).toBe(false);
      expect(entry).not.toContain('\n');
    });

    it(`${tool.name} is plain ASCII`, () => {
      const all = [tool.description, ...Object.values(tool.parameters).map(p => p.description)];
      for (const s of all) expect(s).toMatch(/^[\x00-\x7F]*$/);
    });
  }
});

/**
 * Every advertised enum value must be a `case` the tool's own switch handles.
 * Read from source rather than by calling execute(), which would need the
 * vault, the goal service and a workflow runtime.
 */
describe('#504 enum values match the implementation', () => {
  const sources: [ToolDefinition, string][] = [
    [documentTool, 'documents.ts'],
    [contentPipelineTool, 'content.ts'],
    [commitmentsTool, 'commitments.ts'],
    [createManageGoalsTool(stub({})), 'goals.ts'],
    [workflowNoLibrary, 'manage-workflow.ts'],
  ];

  for (const [tool, file] of sources) {
    it(`${tool.name} advertises exactly the actions its switch handles`, () => {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      // Deduped: a value can be cased more than once in a file (#503 added a
      // second run/delete switch for the authority gates), and this compares
      // sets, not occurrences.
      const handled = [...new Set([...src.matchAll(/^\s*case ["']([a-z_]+)["']:/gm)].map(m => m[1]!))];
      const advertised = tool.parameters.action?.enum ?? [];
      expect(advertised.length).toBeGreaterThan(0);
      // Set EQUALITY, both directions. Advertising a value the switch does
      // not handle is the obvious bug; the dangerous one is the reverse --
      // a new `case` whose value is missing from the enum is hard-rejected
      // by validateParameters, so the feature ships unreachable.
      expect([...new Set(advertised)].sort()).toEqual([...handled].sort());
    });
  }
});

/**
 * The composer is a THIRD model-facing surface, and it renders its own
 * summary rather than the JSON schema. When #504 moved action values from
 * prose into `enum`, that surface stopped showing them until `enum` was
 * plumbed through -- and an unrendered enum is worse than prose, because
 * `validateParameters` rejects the guess the composer then has to make.
 */
describe('#504 the composer surface shows enum values', () => {
  it('renders the allowed values on the param line', () => {
    const lines = renderToolSpecLines({
      name: 'content_pipeline',
      description: 'Track publishable content.',
      params: [
        { name: 'action', type: 'string', required: true, description: 'What to do.', enum: ['list', 'get'] },
        { name: 'id', type: 'string', required: false, description: 'Content item id.' },
      ],
    });
    expect(lines.join('\n')).toContain('param action (string, REQUIRED, one of: list|get)');
    // A param without an enum must not grow an empty "one of:".
    expect(lines.join('\n')).toContain('param id (string)');
    expect(lines.join('\n')).not.toContain('one of: )');
  });

  it('carries enum through the tool spec the daemon hands the composer', () => {
    // Mirrors the mapping at src/daemon/index.ts listDetailed(). If that
    // drops `enum`, the composer is back to guessing.
    const mapped = Object.entries(contentPipelineTool.parameters).map(([name, p]) => ({
      name, type: p.type, required: p.required, description: p.description, enum: p.enum,
    }));
    const action = mapped.find(p => p.name === 'action')!;
    expect(action.enum).toEqual(contentPipelineTool.parameters.action!.enum!);
    expect(renderToolSpecLines({ name: 'x', params: mapped }).join('\n')).toContain('one of: list|get|');
  });
});
