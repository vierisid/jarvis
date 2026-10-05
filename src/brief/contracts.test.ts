import { expect, test } from 'bun:test';
import { briefContractExamples } from '../../docs/brief-contract-v1.examples.ts';
import type { BriefCancelTurn, BriefChatEvent, BriefPreparedOpportunity, BriefReadResult } from './contracts.ts';

test('documented JSON examples are the checked TypeScript contract examples', async () => {
  const json = await Bun.file(`${import.meta.dir}/../../docs/brief-contract-v1.examples.json`).json();
  expect(json).toEqual(briefContractExamples);
  expect(json.reads.map((read: { state: string }) => read.state)).toEqual(['loading', 'ready', 'empty', 'stale', 'unavailable', 'unsupported']);
});

test('wire contracts have no runtime workflow repository dependency', async () => {
  const runtimeRepos: string[] = [];
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/contracts.ts`], target: 'browser',
    plugins: [{
      name: 'reject-workflow-repository-runtime-imports',
      setup(build) {
        build.onResolve({ filter: /workflows\/db\/repos\// }, args => {
          runtimeRepos.push(args.path);
          throw new Error(`Wire contracts must not import a workflow repository at runtime: ${args.path}`);
        });
      },
    }],
  });
  expect(runtimeRepos).toEqual([]);
  expect(bundle.success).toBe(true);
  expect(bundle.outputs).toHaveLength(1);
});

// Checked by tsc, never invoked. A contract change must not quietly weaken these distinctions.
function rejectedShapes() {
  // @ts-expect-error Cancel is turn-scoped, not just conversation-scoped.
  const cancel: BriefCancelTurn = { conversationId: 'c' };
  // @ts-expect-error Terminal events cannot claim a still-running state.
  const event: BriefChatEvent['payload'] = { kind: 'terminal', state: 'running' };
  // @ts-expect-error Failed reads are not fabricated empty data.
  const read: BriefReadResult<string[]> = { state: 'unavailable', data: [] };
  // @ts-expect-error Stale readiness cannot advertise a ready prepared opportunity.
  const opportunity: BriefPreparedOpportunity = { ...briefContractExamples.preparedOpportunity, state: 'ready', readiness: { state: 'stale', checkedAt: 1 } };
  // @ts-expect-error A ready opportunity must pin an actual workflow version.
  const missingVersion: BriefPreparedOpportunity = { ...briefContractExamples.preparedOpportunity, workflow: null };
  const preparing: BriefPreparedOpportunity = {
    ...briefContractExamples.preparedOpportunity, state: 'preparing', workflow: null,
    compositionId: null, goal: null, previewBasis: null, evidence: [], readiness: { state: 'unchecked', checkedAt: null },
  };
  const accepted: BriefPreparedOpportunity = { ...briefContractExamples.preparedOpportunity, state: 'accepted' };
  return [cancel, event, read, opportunity, missingVersion, preparing, accepted];
}
