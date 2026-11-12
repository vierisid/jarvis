/**
 * #1153 (owner decisions): a created or changed webhook secret meets a length
 * floor and is timestamped; a stored one keeps working as it is, and is never
 * moved back from timestamped. Applied on every write of a version.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../db/index';
import { createFlow } from '../../db/repos/flow';
import { publishFlowVersion } from '../../db/repos/flow-publication';
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

test('a stored short secret keeps working: edits elsewhere, and a copy into another flow of the project, keep it legacy', () => {
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

test('#1153 review: only a Webhook trigger secret in the same project counts as stored, not a step field named secret or another project', () => {
  const flow = createFlow({});
  const v = createDraftVersion({ flowId: flow.id, displayName: 'step', trigger: { name: 'trigger', type: 'EMPTY', settings: {},
    nextAction: { name: 'call', type: 'PIECE', settings: { pieceName: '@activepieces/piece-http', actionName: 'send_request', input: { secret: 'abc' } } } } as never });
  expect(() => updateDraftVersion(v.id, { trigger: hook({ secret: 'abc' }) })).toThrow(/at least 32 characters/);
  const elsewhere = createDraftVersion({ flowId: createFlow({ projectId: 'other-project' }).id, displayName: 'o' });
  getWorkflowDb().run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(hook({ secret: 'theirs' })), elsewhere.id]);
  expect(() => createDraftVersion({ flowId: createFlow({}).id, displayName: 'd', trigger: hook({ secret: 'theirs' }) })).toThrow(/at least 32 characters/);
});

test('#1153 review: an edit of an older version after a rollback keeps its stored secret and scheme', () => {
  const old = legacy('s3cret');
  const flowId = getFlowVersion(old)!.flowId;
  // A later version rotated the secret; the owner went back to the old one and edits it.
  createDraftVersion({ flowId, displayName: 'rotated', trigger: hook({ secret: LONG }) });
  const back = createDraftVersion({ flowId, displayName: 'back', trigger: hook({ secret: 's3cret', note: 'edited' }) });
  expect(inputOf(back.id)).toEqual({ secret: 's3cret', note: 'edited' });
});

test('#1153 review: a secret removed and set again is timestamped if any version held it timestamped', () => {
  const v = createDraftVersion({ flowId: createFlow({}).id, displayName: 'd', trigger: hook({ secret: LONG }) });
  const flowId = getFlowVersion(v.id)!.flowId;
  const cleared = createDraftVersion({ flowId, displayName: 'cleared', trigger: hook({}) });
  updateDraftVersion(cleared.id, { trigger: hook({ secret: LONG }) });
  expect(inputOf(cleared.id).signature_scheme).toBe('timestamped');
});

test('a secret that is not text is refused at save, never read as no secret', () => {
  const flow = createFlow({});
  for (const secret of [12345678901234567890123456789012, true, ['x'.repeat(40)], { v: 'x'.repeat(40) }]) {
    expect(() => createDraftVersion({ flowId: flow.id, displayName: 'd', trigger: hook({ secret }) })).toThrow(/must be text/);
    const v = createDraftVersion({ flowId: flow.id, displayName: 'd' });
    expect(() => updateDraftVersion(v.id, { trigger: hook({ secret }) })).toThrow(FlowVersionRequestError);
  }
});

test('the timestamp setting with no secret to sign with is refused on a webhook that had none; clearing a secret still works', () => {
  const flow = createFlow({});
  expect(() => createDraftVersion({ flowId: flow.id, displayName: 'd', trigger: hook({ signature_scheme: 'timestamped' }) })).toThrow(/no signing secret/);
  // The editor clears a secret by removing the key and leaves the scheme for the save to drop.
  const v = createDraftVersion({ flowId: createFlow({}).id, displayName: 'd', trigger: hook({ secret: LONG }) });
  updateDraftVersion(v.id, { trigger: hook({ signature_scheme: 'timestamped' }) });
  expect(inputOf(v.id)).toEqual({});
});

test('publishing refuses a webhook whose signing setup is unusable, with a plain message', () => {
  const flow = createFlow({});
  const v = createDraftVersion({ flowId: flow.id, displayName: 'd', trigger: hook({}) });
  // A draft written past the save rules, as an older install holds one.
  getWorkflowDb().run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(hook({ secret: ['x'.repeat(40)] })), v.id]);
  try { publishFlowVersion(flow.id); throw new Error('published'); }
  catch (error) { expect(error).toBeInstanceOf(FlowVersionRequestError); expect((error as Error).message).toMatch(/must be text/); }
});
