import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../index';
import { setEncryptionKey } from '../encryption';
import { createFlow, getFlow, updateFlowStatus } from './flow';
import { createDraftVersion, updateDraftVersion } from './flow-version';
import { publishFlowVersion } from './flow-publication';
import { assertFlowReady, assertVersionReady, configureWorkflowReadiness, versionReadiness, WorkflowReadinessError } from './flow-readiness';
import { deleteConnection, upsertConnection } from './app-connection';
import { createFlowRun, getFlowRun } from './flow-run';
import { enforceRunConnectionBinding, listRunConnectionBindings, pinUnpinnedEnabledFlows, readBindingPins } from './binding-pins';
import { PieceCatalog } from '../../runtime/piece-catalog';
import { CredentialResolver, type JarvisConnectionSource } from '../../credentials/adapter';
import type { SidecarInfo } from '../../../sidecar/types';
import { createManageWorkflowTool } from '../../../actions/tools/manage-workflow';

const TOOL = '@jarvispieces/piece-jarvis-tool';
const machine = (id: string, connected: boolean, capabilities = ['filesystem', 'desktop']): SidecarInfo =>
  ({ id, name: `Computer ${id}`, enrolled_at: '2026-10-01', last_seen_at: null, status: 'enrolled', connected, capabilities } as SidecarInfo);
let machines: SidecarInfo[] = [];
let localTools = true;
let grant: string | null = 'grant-a';
const managed: JarvisConnectionSource = { id: 'google', canResolve: id => id.startsWith('jarvis:google'),
  resolve: async () => null, identity: () => grant };

beforeEach(() => {
  initWorkflowDb(':memory:');
  setEncryptionKey(Buffer.alloc(32, 0x52));
  machines = [machine('laptop', true)];
  localTools = true;
  grant = 'grant-a';
  const credentials = new CredentialResolver();
  credentials.register(managed);
  configureWorkflowReadiness({
    pieces: new PieceCatalog([
      { name: 'private-piece', displayName: '', description: '', auth: { type: 'SECRET_TEXT' }, actions: { send: { name: 'send', displayName: '', description: '' } } },
      { name: TOOL, displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } },
    ] as any),
    credentials,
    tool: name => name === 'read_file' ? { params: [{ name: 'path', type: 'string', required: true }, { name: 'target', type: 'string', required: false }] } : null,
    machines: () => machines,
    localTools: () => localTools,
  });
});
afterEach(() => { setEncryptionKey(null); closeWorkflowDb(); });

const connect = (externalId = 'account', secret = 'first') => upsertConnection({ externalId, pieceName: 'private-piece',
  displayName: 'Account', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: secret } });
const send = (auth = 'account', next?: object) => ({ name: auth.replace(/\W/g, '_'), type: 'PIECE',
  settings: { pieceName: 'private-piece', actionName: 'send', input: { auth: `{{connections['${auth}']}}` } }, ...(next ? { nextAction: next } : {}) });
const readFile = (target?: string) => ({ name: 'read', type: 'PIECE',
  settings: { pieceName: TOOL, actionName: 'invoke', input: { toolName: 'read_file', params: { path: '/tmp/report.csv', ...(target ? { target } : {}) } } } });
const graph = (first: object) => ({ name: 'trigger', type: 'EMPTY', nextAction: first }) as any;
function published(first: object) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Pinned', trigger: graph(first) });
  publishFlowVersion(flow.id);
  return { flowId: flow.id, versionId: version.id };
}
const blockers = (flowId: string) => {
  try { assertFlowReady(flowId); return []; }
  catch (error) { expect(error).toBeInstanceOf(WorkflowReadinessError); return (error as WorkflowReadinessError).readiness.issues.filter(i => i.code === 'BINDING_STALE').map(i => i.message); }
};

describe('pins are what a person accepted when publishing or enabling', () => {
  test('publishing pins each connection the steps name and the computer the flow runs on', () => {
    const connection = connect();
    const { flowId, versionId } = published(send('account', readFile()));
    expect(readBindingPins(flowId)).toMatchObject({ schemaVersion: 1, versionId,
      connections: { account: { kind: 'native', connectionId: connection.id, generation: 0 } },
      machine: { sidecarId: 'laptop', name: 'Computer laptop' } });
    expect(blockers(flowId)).toEqual([]);
  });

  test('a credential replaced under the same connection pauses the flow until it is enabled again', () => {
    connect();
    const { flowId } = published(send());
    connect('account', 'pasted from another account');
    expect(blockers(flowId)).toEqual(['The credential stored in connection account was replaced since this workflow was enabled. '
      + 'It may now act as a different account. Check the connection, then enable or publish the workflow again to accept it.']);
    // Every admission site refuses; enabling again is the person accepting it.
    expect(() => assertVersionReady(flowId, getFlow(flowId)!.published_version_id!)).toThrow(WorkflowReadinessError);
    updateFlowStatus(flowId, 'ENABLED');
    expect(blockers(flowId)).toEqual([]);
    expect(readBindingPins(flowId)!.connections.account).toMatchObject({ generation: 1 });
  });

  test('a connection deleted and created again pauses it too, and so does publishing being the only acceptance', () => {
    const first = connect();
    const { flowId } = published(send());
    deleteConnection(first.id);
    connect();
    expect(blockers(flowId)).toEqual([expect.stringMatching(/^Connection account was deleted and created again since this workflow was enabled\./)]);
    publishFlowVersion(flowId, getFlow(flowId)!.published_version_id!);
    expect(blockers(flowId)).toEqual([]);
  });

  test('re-encrypting the stored credential (a key rotation) does not pause anything', () => {
    const connection = connect();
    const { flowId } = published(send());
    // Key rotation and migration rewrite the ciphertext directly, never through the upsert.
    getWorkflowDb().run('UPDATE app_connection SET value = value, updated = ? WHERE id = ?', [Date.now(), connection.id]);
    expect(blockers(flowId)).toEqual([]);
  });

  test('a managed connection reconnected pauses the flow; revoked, it is not ready at all', () => {
    const { flowId } = published(send('jarvis:google'));
    expect(readBindingPins(flowId)!.connections['jarvis:google']).toEqual({ kind: 'managed', source: 'google', grant: 'grant-a' });
    grant = 'grant-b';
    expect(blockers(flowId)).toEqual([expect.stringMatching(/^Connection jarvis:google was reconnected since this workflow was enabled\./)]);
    grant = null;
    expect(() => assertFlowReady(flowId)).toThrow(/Managed connection is not connected or was revoked/);
  });

  test('pins belong to the version they were taken from', () => {
    connect();
    const { flowId } = published(send());
    connect('account', 'replaced');
    const draft = createDraftVersion({ flowId, displayName: 'Next', trigger: graph(send()) });
    expect(versionReadiness(flowId, draft.id).issues.filter(i => i.code === 'BINDING_STALE')).toEqual([]);
  });

  test('enabling an unpublished flow pins its latest draft, and editing that live draft pins again', () => {
    connect();
    connect('second');
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: 'Live', trigger: graph(send()) });
    updateFlowStatus(flow.id, 'ENABLED');
    expect(Object.keys(readBindingPins(flow.id)!.connections)).toEqual(['account']);
    updateDraftVersion(draft.id, { trigger: graph(send('account', send('second'))) });
    expect(Object.keys(readBindingPins(flow.id)!.connections).sort()).toEqual(['account', 'second']);
  });

  test('startup pins enabled flows that have no pins, and leaves the rest alone', () => {
    connect();
    const enabled = published(send());
    const disabled = published(send());
    updateFlowStatus(disabled.flowId, 'DISABLED');
    getWorkflowDb().run('UPDATE flow SET binding_pins = NULL');
    expect(pinUnpinnedEnabledFlows()).toBe(1);
    expect(readBindingPins(enabled.flowId)).not.toBeNull();
    expect(readBindingPins(disabled.flowId)).toBeNull();
  });
});

describe('the computer a flow is pinned to', () => {
  const pinOf = (first: object) => readBindingPins(published(first).flowId)!.machine;

  test('the most recently enrolled computer that serves the step, preferring a connected one, else this computer', () => {
    machines = [machine('new', false), machine('old', true)];
    expect(pinOf(readFile())).toEqual({ sidecarId: 'old', name: 'Computer old' });
    // A laptop asleep at publish time is still the one pinned, never a silent fallback to this computer.
    machines = [machine('asleep', false)];
    expect(pinOf(readFile())).toEqual({ sidecarId: 'asleep', name: 'Computer asleep' });
    machines = [machine('desk', true, ['desktop'])];
    expect(pinOf(readFile())).toEqual({ sidecarId: null, name: 'this computer' });
    localTools = false;
    expect(pinOf(readFile())).toBeNull();
  });

  test('a literal target pins exactly that computer; a partial name or a target from run data stays unpinned', () => {
    machines = [machine('laptop', true), machine('work-laptop', true)];
    expect(pinOf(readFile('Computer laptop'))).toEqual({ sidecarId: 'laptop', name: 'Computer laptop' });
    expect(pinOf(readFile('work-lap'))).toBeNull();
    expect(pinOf(readFile('{{trigger.machine}}'))).toBeNull();
  });

  test('at startup nobody is choosing: a computer is pinned only when the choice does not depend on which one is connected', () => {
    machines = [machine('laptop', false), machine('desk', true)];
    const several = published(readFile());
    const named = published(readFile('Computer laptop'));
    getWorkflowDb().run('UPDATE flow SET binding_pins = NULL');
    expect(pinUnpinnedEnabledFlows()).toBe(2);
    // Computers may not have reconnected yet: with two that could serve it, its runs choose as before.
    expect(readBindingPins(several.flowId)!.machine).toBeNull();
    expect(readBindingPins(named.flowId)!.machine).toEqual({ sidecarId: 'laptop', name: 'Computer laptop' });
    // A person enabling it again chooses, the connected one first.
    updateFlowStatus(several.flowId, 'ENABLED');
    expect(readBindingPins(several.flowId)!.machine).toEqual({ sidecarId: 'desk', name: 'Computer desk' });
    // With only one, it is that one, asleep or not.
    machines = [machine('laptop', false)];
    getWorkflowDb().run('UPDATE flow SET binding_pins = NULL WHERE id = ?', [several.flowId]);
    expect(pinUnpinnedEnabledFlows()).toBe(1);
    expect(readBindingPins(several.flowId)!.machine).toEqual({ sidecarId: 'laptop', name: 'Computer laptop' });
  });

  test('a pinned computer that is no longer enrolled blocks admission', () => {
    const { flowId } = published(readFile());
    machines = [machine('replacement', true)];
    expect(blockers(flowId)).toEqual(['The computer this workflow was enabled for (Computer laptop) is no longer enrolled. '
      + 'Enable or publish the workflow again to choose a computer.']);
    updateFlowStatus(flowId, 'ENABLED');
    expect(readBindingPins(flowId)!.machine).toEqual({ sidecarId: 'replacement', name: 'Computer replacement' });
  });
});

describe('a run hands out the connection identity it started with', () => {
  test('the first fetch binds; a credential replaced during the run is refused and stays inspectable', async () => {
    connect();
    const { flowId, versionId } = published(send());
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account')).toBeNull();
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account')).toBeNull();
    // Replaced while the run waits on an approval, or between an engine retry's attempts.
    connect('account', 'another account');
    const refusal = 'The credential stored in connection account was replaced during this run, after the run first used it. '
      + 'Its credential was not handed out; start a new run once the connection is right.';
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account')).toBe(refusal);
    // Re-enabling the flow accepts it for later runs, never for this one.
    updateFlowStatus(flowId, 'ENABLED');
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account')).toBe(refusal);
    expect(getFlowRun(run.id)!.connectionBindings).toEqual([expect.objectContaining({ externalId: 'account', refusal: { message: refusal, at: expect.any(Number) } })]);
    // The engine reports a refused fetch as a bare loading error; the run shows why.
    const shown = String(await createManageWorkflowTool({}).execute({ action: 'get_run', run_id: run.id }));
    expect(shown).toContain('"bindingRefusals":[{"connection":"account","reason":"The credential stored in connection account was replaced during this run');
  });

  test('a run of a pinned flow refuses a connection changed since enabling, even on its first fetch', () => {
    connect();
    const { flowId, versionId } = published(send());
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
    connect('account', 'changed after the run was admitted');
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account'))
      .toStartWith('The credential stored in connection account was replaced since this workflow was enabled.');
    expect(listRunConnectionBindings(run.id)[0]!.refusal).toBeDefined();
  });

  test('a run of an unpinned flow binds what it finds; missing connections and non-runs are left to their own paths', () => {
    connect();
    const flow = createFlow({});
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Unpinned', trigger: graph(send()) });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    expect(enforceRunConnectionBinding(run.id, flow.project_id, 'account')).toBeNull();
    connect('account', 'swapped');
    expect(enforceRunConnectionBinding(run.id, flow.project_id, 'account')).toStartWith('The credential stored in connection account was replaced during this run');
    expect(enforceRunConnectionBinding(run.id, flow.project_id, 'nowhere')).toBeNull();
    expect(enforceRunConnectionBinding('trigger-poll', flow.project_id, 'account')).toBeNull();
  });
});
