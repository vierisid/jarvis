import { describe, expect, test } from 'bun:test';
import { flowIdOfTriggerHookRunId, triggerHookRunId } from './hook-run-id';

describe('trigger hook run ids', () => {
  test('round-trip the flow id for every hook kind, hyphens included', () => {
    for (const kind of ['enable', 'disable', 'poll'] as const) {
      for (const flowId of ['AbC123xyz0987654321Qw', 'flow-with-hyphens']) {
        expect(flowIdOfTriggerHookRunId(triggerHookRunId(kind, flowId, 1_700_000_000_000))).toBe(flowId);
      }
    }
  });

  test('anything else names no flow', () => {
    for (const runId of ['AbC123xyz0987654321Qw', 'quality-catalog', 'metadata-extract-runtime-install-x', 'poll-', 'poll-x', 'run-flow-1']) {
      expect(flowIdOfTriggerHookRunId(runId)).toBeNull();
    }
  });
});
