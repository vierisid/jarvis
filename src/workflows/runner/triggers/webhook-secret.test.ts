/**
 * #1153 (owner decisions): a created or changed webhook secret meets a length
 * floor and is timestamped; a stored one keeps working as it is, and is never
 * moved back from timestamped. Applied on every write of a version.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../db/index';
import { createFlow } from '../../db/repos/flow';
import { createDraftVersion, getFlowVersion, updateDraftVersion } from '../../db/repos/flow-version';
import { FlowVersionRequestError } from '../../db/repos/flow-version-ownership';
import { TIMESTAMPED_REPEAT_WINDOW_MS, WEBHOOK_SECRET_MIN_LENGTH, WEBHOOK_TIMESTAMP_TOLERANCE_S } from './webhook-secret';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const LONG = 'x'.repeat(WEBHOOK_SECRET_MIN_LENGTH);
const hook = (input: Record<string, unknown>) => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input } }) as never;
const inputOf = (versionId: string) => (getFlowVersion(versionId)!.trigger.settings!.input ?? {}) as Record<string, unknown>;
/** A version as an install before #1153 wrote it, past the save rules. */
function legacy(secret: string): string {
  const v = createDraftVersion({ flowId: createFlow({}).id, displayName: 'old' });
  getWorkflowDb().run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(hook({ secret })), v.id]);
  return v.id;
}

test('a new secret shorter than the floor is refused as a bad request, on create and on update', () => {
  const flow = createFlow({});
  const short = 'x'.repeat(WEBHOOK_SECRET_MIN_LENGTH - 1);
  expect(() => createDraftVersion({ flowId: flow.id, displayName: 'd', trigger: hook({ secret: short }) })).toThrow(FlowVersionRequestError);
  const v = createDraftVersion({ flowId: flow.id, displayName: 'd' });
  try { updateDraftVersion(v.id, { trigger: hook({ secret: short }) }); throw new Error('saved'); }
  catch (error) { expect(error).toBeInstanceOf(FlowVersionRequestError); expect((error as FlowVersionRequestError).status).toBe(400); }
});

test('a new secret at the floor is saved timestamped, whatever the writer asked', () => {
  const flow = createFlow({});
  const v = createDraftVersion({ flowId: flow.id, displayName: 'd', trigger: hook({ secret: LONG, signature_scheme: 'legacy' }) });
  expect(inputOf(v.id)).toEqual({ secret: LONG, signature_scheme: 'timestamped' });
});

test('a stored short secret keeps working: edits elsewhere, and a copy into another flow, keep it legacy', () => {
  const old = legacy('s3cret');
  updateDraftVersion(old, { trigger: hook({ secret: 's3cret', other: 1 }) });
  expect(inputOf(old)).toEqual({ secret: 's3cret', other: 1 });
  const copy = createDraftVersion({ flowId: createFlow({}).id, displayName: 'copy', trigger: hook({ secret: 's3cret' }) });
  expect(inputOf(copy.id)).toEqual({ secret: 's3cret' });
});

test('a legacy webhook may opt in to timestamps, and then is never moved back while it keeps its secret', () => {
  const old = legacy('s3cret');
  updateDraftVersion(old, { trigger: hook({ secret: 's3cret', signature_scheme: 'timestamped' }) });
  expect(inputOf(old).signature_scheme).toBe('timestamped');
  updateDraftVersion(old, { trigger: hook({ secret: 's3cret' }) });
  expect(inputOf(old).signature_scheme).toBe('timestamped');
  updateDraftVersion(old, { trigger: hook({ secret: 's3cret', signature_scheme: 'legacy' }) });
  expect(inputOf(old).signature_scheme).toBe('timestamped');
});

test('writing back the redacted secret the model reads is a changed, too-short secret: refused', () => {
  const old = legacy('s3cret');
  expect(() => updateDraftVersion(old, { trigger: hook({ secret: '[redacted]' }) })).toThrow(/at least 32 characters/);
  expect(inputOf(old).secret).toBe('s3cret');
});

test('removing the secret removes the scheme', () => {
  const v = createDraftVersion({ flowId: createFlow({}).id, displayName: 'd', trigger: hook({ secret: LONG }) });
  updateDraftVersion(v.id, { trigger: hook({ signature_scheme: 'timestamped' }) });
  expect(inputOf(v.id)).toEqual({});
});

test('a timestamped signature stays a repeat for the whole span its timestamp is accepted', () => {
  expect(TIMESTAMPED_REPEAT_WINDOW_MS).toBeGreaterThan(2 * WEBHOOK_TIMESTAMP_TOLERANCE_S * 1000);
});
