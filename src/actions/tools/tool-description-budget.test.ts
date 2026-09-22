/**
 * Guards the description trim from #504.
 *
 * The six daemon-registered tools below were 14,160 B of emitted JSON schema,
 * 36% of the whole tool-schema budget that ships on every request. Trimming
 * them is only safe while the text that remains still does its job, so this
 * pins the three things a byte-count alone cannot see:
 *
 *   1. A per-tool byte ceiling, so nobody re-fattens them back.
 *   2. The DISCRIMINATORS -- the words that separate a tool from the
 *      neighbour a model would otherwise confuse it with, and the
 *      preconditions/side effects it would otherwise violate. A cut that
 *      drops one of these is a selection regression that no test would
 *      otherwise catch.
 *   3. The two structural contracts on the description's shape: the first
 *      sentence becomes the `discover_tools` catalogue line (see
 *      `tool-relevance/discover.ts summarise()`, 160-char cap) and the first
 *      LINE is all the workflow composer prompt shows
 *      (`workflow-composer.ts renderToolSpecLines`). Both must stand alone.
 */

import { describe, expect, it } from 'bun:test';
import { toolDefToLLMTool } from './builtin.ts';
import type { ToolDefinition } from './registry.ts';
import { contentPipelineTool } from './content.ts';
import { commitmentsTool } from './commitments.ts';
import { documentTool } from './documents.ts';
import { createManageGoalsTool } from './goals.ts';
import { createManageWorkflowTool } from './manage-workflow.ts';
import { createRequestApprovalTool } from './approval-tool.ts';

const stub = (x: unknown) => x as never;

/**
 * Ceilings are the measured post-#504 size plus a small margin. They are a
 * ratchet, not a target: a change that needs more room should say why in its
 * own commit rather than nudging the number.
 */
const TOOLS: { tool: ToolDefinition; ceiling: number }[] = [
  { tool: createManageWorkflowTool(stub({})), ceiling: 2700 },
  { tool: contentPipelineTool, ceiling: 1750 },
  { tool: createRequestApprovalTool(stub({})), ceiling: 1600 },
  { tool: createManageGoalsTool(stub({})), ceiling: 1500 },
  { tool: commitmentsTool, ceiling: 1500 },
  { tool: documentTool, ceiling: 1300 },
];

const bytes = (t: ToolDefinition) =>
  Buffer.byteLength(JSON.stringify(toolDefToLLMTool(t)), 'utf8');

/** Mirrors `discover.ts summarise()` / `bench/tool-relevance/cases.ts`. */
const firstSentence = (d: string) => {
  const cut = d.search(/\.\s/);
  return (cut > 0 ? d.slice(0, cut) : d).trim();
};

/** Mirrors `workflow-composer.ts firstLine()`. */
const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? '';

describe('#504 tool description budget', () => {
  for (const { tool, ceiling } of TOOLS) {
    it(`${tool.name} stays under ${ceiling} B of emitted schema`, () => {
      expect(bytes(tool)).toBeLessThanOrEqual(ceiling);
    });
  }

  it('the six together stay well under a third of the budget', () => {
    const total = TOOLS.reduce((s, { tool }) => s + bytes(tool), 0);
    // 14,160 B before #504. The point of the ceiling is that the trim holds.
    expect(total).toBeLessThanOrEqual(10_000);
  });
});

describe('#504 descriptions keep their discriminators', () => {
  const cases: [ToolDefinition, string[]][] = [
    // Nearest neighbours are write_file (same "save some text" shape) and
    // content_pipeline. The tool is NAMED create_document, so the other
    // verbs have to be spelled out or the name misinforms.
    [documentTool, ['write_file', 'content_pipeline', 'download', 'append', 'read, update or list']],
    // Nearest neighbour is create_document. append_body vs set_body is the
    // constraint whose violation silently truncates the user's draft.
    [contentPipelineTool, ['create_document', 'append_body', 'set_body', 'advance', 'regress']],
    // Nearest neighbour is manage_goals.
    [commitmentsTool, ['manage_goals', 'due date']],
    // Nearest neighbour is commitments.
    [createManageGoalsTool(stub({})), ['commitments', '0.0-1.0']],
    // The anti-bypass clause is the entire point of the tool: gating by tool
    // name is defeated by driving browser/desktop tools to the same end.
    [
      createRequestApprovalTool(stub({})),
      ['REGARDLESS', 'browser_click', '[APPROVED]', '[DENIED]', '[EXPIRED]', 'STOP', 'read-only'],
    ],
    // compose-vs-create steering, the DISABLED-then-publish contract, and the
    // CODE-step refusal. manage-workflow.test.ts and flow-code-steps.test.ts
    // pin some of these too; kept here so the set reads in one place.
    [
      createManageWorkflowTool(stub({})),
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
});

describe('#504 description shape contracts', () => {
  for (const { tool } of TOOLS) {
    it(`${tool.name} opens with a self-contained sentence`, () => {
      const line = firstLine(tool.description);
      // The composer shows this line and nothing else, so a line that stops
      // mid-clause is a broken tool listing.
      expect(line).toMatch(/[.:]$/);
      // The discover_tools catalogue truncates past 160 chars.
      expect(firstSentence(tool.description).length).toBeLessThanOrEqual(160);
    });

    it(`${tool.name} is plain ASCII`, () => {
      const all = [tool.description, ...Object.values(tool.parameters).map(p => p.description)];
      for (const s of all) expect(s).toMatch(/^[\x00-\x7F]*$/);
    });
  }
});
