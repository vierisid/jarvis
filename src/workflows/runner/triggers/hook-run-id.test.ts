import { describe, expect, test } from 'bun:test';
import { flowIdOfTriggerHookRunId, hookTriggerDigest, parseTriggerHookRunId, triggerHookRunId } from './hook-run-id';

describe('trigger hook run ids', () => {
  const trigger = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { input: { a: 1 } } };

  test('round-trip the flow, version and trigger digest for every hook kind, hyphens included', () => {
    for (const kind of ['enable', 'disable', 'poll'] as const) {
      for (const flowId of ['AbC123xyz0987654321Qw', 'flow-with-hyphens']) {
        const runId = triggerHookRunId(kind, flowId, { id: 'Ver123xyz0987654321Qw', trigger }, 1_700_000_000_000);
        expect(flowIdOfTriggerHookRunId(runId)).toBe(flowId);
        expect(parseTriggerHookRunId(runId)).toEqual({ flowId, versionId: 'Ver123xyz0987654321Qw', triggerDigest: hookTriggerDigest(trigger) });
      }
    }
  });

  test('the digest covers the trigger node only, not the steps after it', () => {
    expect(hookTriggerDigest({ ...trigger, nextAction: { name: 'step' } })).toBe(hookTriggerDigest(trigger));
    expect(hookTriggerDigest({ ...trigger, settings: { input: { a: 2 } } })).not.toBe(hookTriggerDigest(trigger));
  });

  test('anything else names no flow', () => {
    for (const runId of ['AbC123xyz0987654321Qw', 'quality-catalog', 'metadata-extract-runtime-install-x', 'poll-', 'poll-x', 'run-flow-1',
      'poll-flow-1abc', `poll-flow-${'0'.repeat(32)}-1abc`]) {
      expect(flowIdOfTriggerHookRunId(runId)).toBeNull();
    }
  });
});
