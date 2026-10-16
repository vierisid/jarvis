import { afterEach, expect, test } from 'bun:test';
import { closeWorkflowDb } from '../../workflows/db';
import { createFlow } from '../../workflows/db/repos/flow';
import { createDraftVersion } from '../../workflows/db/repos/flow-version';
import { fixture } from './fixtures.test';
import { createSqliteResultReader } from './reader';
import { hash } from './input';
afterEach(closeWorkflowDb);

test('returns the exact persisted graph/title, not a newer unrelated flow', () => {
  const f = fixture(), other = createFlow({ projectId: f.owner.projectId });
  createDraftVersion({ flowId: other.id, displayName: 'Unrelated', trigger: { name: 'other', type: 'EMPTY' } });
  const r = f.services.reader.read(f.owner, f.job);
  expect(r).toMatchObject({ state: 'saved', title: f.version.displayName, graph: f.version.trigger,
    artifact: f.job.artifact, activation: 'disabled', versionState: 'DRAFT', nodeIds: ['trigger', 'draft'] });
  expect(f.db.query('SELECT * FROM flow_run').all()).toHaveLength(0);
  expect(f.db.query('SELECT status, published_version_id FROM flow WHERE id = ?').get(f.flow.id)).toEqual({ status: 'DISABLED', published_version_id: null });
});
test('fresh readiness changes when a required input is removed, without a success claim', () => {
  const f = fixture();
  const graph = structuredClone(f.version.trigger); graph.nextAction!.settings!.input = {};
  f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  const r = f.services.reader.read(f.owner, f.job);
  expect(r).toMatchObject({ state: 'saved', readiness: { ready: false } });
  if (r.state !== 'saved') throw Error();
  expect(r.missingBindings.length).toBeGreaterThan(0);
});
test('reads no captured output, model response, qualification or version-private fields into the result', () => {
  const f = fixture();
  f.db.run('UPDATE flow_version SET sample_data = ?, sample_input = ?, notes = ? WHERE id = ?',
    ['{"capture":"PRIVATE CAPTURE"}', '{"sample":"PRIVATE SAMPLE"}', '["PRIVATE NOTE"]', f.version.id]);
  const json = JSON.stringify(f.services.reader.read(f.owner, f.job));
  for (const secret of ['PRIVATE', 'sampleData', 'sampleInput', '"notes":', 'previousResponse', 'specification']) expect(json).not.toContain(secret);
});
for (const who of ['actor', 'project'] as const) test(`receipt lookup isolates ${who}`, () => {
  const f = fixture(), owner = { ...f.owner, [who === 'actor' ? 'actorId' : 'projectId']: 'other' };
  expect(f.services.reader.read(owner, f.job)).toEqual({ state: 'absent' });
});
test('a receipt cannot authorize a flow in another project', () => {
  const f = fixture(); f.db.run('UPDATE flow SET project_id = ? WHERE id = ?', ['foreign', f.flow.id]);
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow('artifact_unavailable');
});
for (const change of ['flow', 'version', 'composition', 'composition_owner', 'composition_state', 'metadata', 'version_owner'] as const) test(`rejects ${change} deletion/mismatch`, () => {
  const f = fixture();
  if (change === 'flow') f.db.run('DELETE FROM flow WHERE id = ?', [f.flow.id]);
  if (change === 'version') f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]);
  if (change === 'composition') f.db.run('DELETE FROM workflow_composition');
  if (change === 'composition_owner') f.db.run("UPDATE workflow_composition SET project_id = 'other'");
  if (change === 'composition_state') f.db.run("UPDATE workflow_composition SET state = 'FAILED'");
  if (change === 'metadata') f.db.run("UPDATE flow SET metadata = '{}' WHERE id = ?", [f.flow.id]);
  if (change === 'version_owner') f.db.run('UPDATE flow_version SET flow_id = ? WHERE id = ?', [createFlow().id, f.version.id]);
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow('artifact_unavailable');
});
for (const change of ['enabled', 'published', 'locked', 'replacement'] as const) test(`never presents ${change} as the original disabled draft`, () => {
  const f = fixture();
  if (change === 'enabled') f.db.run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [f.flow.id]);
  if (change === 'published') f.db.run('UPDATE flow SET published_version_id = ? WHERE id = ?', [f.version.id, f.flow.id]);
  if (change === 'locked') f.db.run("UPDATE flow_version SET state = 'LOCKED' WHERE id = ?", [f.version.id]);
  if (change === 'replacement') {
    const v = createDraftVersion({ flowId: f.flow.id, displayName: 'New version' });
    f.db.run('UPDATE flow_version SET updated = ? WHERE id = ?', [f.version.updated + 1000, v.id]);
  }
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow(['enabled', 'published'].includes(change) ? 'activation_changed' : 'version_changed');
});
test('digest conflicts, incomplete receipts and absent storage fail closed', () => {
  const f = fixture();
  expect(() => f.services.reader.read(f.owner, { ...f.job, requestDigest: hash('different') })).toThrow('identity_mismatch');
  f.db.run('UPDATE onboarding_draft_receipt SET version_id = NULL');
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow('incomplete_result');
  f.db.exec('DROP TABLE onboarding_draft_receipt');
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow('storage_unavailable');
});
for (const graph of [null, { name: 'same', type: 'EMPTY', nextAction: { name: 'same', type: 'PIECE' } },
  { name: 'trigger', type: 'EMPTY', children: 'not an array' }]) test('rejects malformed or ambiguous inspector identities', () => {
  const f = fixture(); f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  expect(() => f.services.reader.read(f.owner, f.job)).toThrow('invalid_graph');
});
test('tracks branch and loop nodes and invalidates a changed graph revision', () => {
  const f = fixture();
  const r = f.services.reader.read(f.owner, f.job); if (r.state !== 'saved') throw Error();
  const graph = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'router', type: 'ROUTER', children: [null,
    { name: 'loop', type: 'LOOP_ON_ITEMS', firstLoopAction: { name: 'nested', type: 'EMPTY' } }] } };
  f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  const next = f.services.reader.read(f.owner, f.job); if (next.state !== 'saved') throw Error();
  expect(next.nodeIds).toEqual(['trigger', 'router', 'loop', 'nested']);
  expect(next.contentRevision).not.toBe(r.contentRevision);
});
test('constructing the reader does not provision tables and a replaced vault is rejected', () => {
  const f = fixture(), reader = createSqliteResultReader(f.db); closeWorkflowDb(); fixture();
  expect(() => reader.read(f.owner, f.job)).toThrow('binding_missing');
});

test('connection metadata is rechecked on every read, with no credential decryption or execution', () => {
  const f = fixture(), graph = structuredClone(f.version.trigger);
  graph.nextAction!.settings!.input!.auth = '{{connections.mail}}';
  f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  const missing = f.services.reader.read(f.owner, f.job); if (missing.state !== 'saved') throw Error();
  expect(missing.readiness.ready).toBe(false);
  expect(missing.missingBindings.some(i => i.code === 'CONNECTION_BINDING')).toBe(true);
  // Readiness reads metadata only; this deliberately is not decryptable credential material.
  f.db.run(`INSERT INTO app_connection (id, external_id, display_name, type, scope, status, piece_name, piece_version, project_id, value, created, updated)
    VALUES ('connection', 'mail', 'Mail', 'SECRET_TEXT', 'PROJECT', 'ACTIVE', 'jarvis-ask', '1', ?, 'UNREADABLE PRIVATE CREDENTIAL', 1, 1)`, [f.owner.projectId]);
  const ready = f.services.reader.read(f.owner, f.job); if (ready.state !== 'saved') throw Error();
  expect(ready.readiness.ready).toBe(true); expect(JSON.stringify(ready)).not.toContain('PRIVATE CREDENTIAL');
  f.db.run("UPDATE app_connection SET status = 'MISSING'");
  const revoked = f.services.reader.read(f.owner, f.job); if (revoked.state !== 'saved') throw Error();
  expect(revoked.readiness.ready).toBe(false); expect(revoked.contentRevision).toBe(ready.contentRevision);
  expect(f.db.query('SELECT * FROM flow_run').all()).toHaveLength(0);
});
