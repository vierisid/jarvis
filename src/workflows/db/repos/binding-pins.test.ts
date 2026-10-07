import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../index';
import { encryptJson, setEncryptionKey } from '../encryption';
import { bindNativeCredentials } from '../credential-migration';
import { createFlow, getFlow, updateFlowStatus } from './flow';
import { createDraftVersion, updateDraftVersion } from './flow-version';
import { publishFlowVersion } from './flow-publication';
import { assertFlowReady, assertVersionReady, configureWorkflowReadiness, versionReadiness, WorkflowReadinessError } from './flow-readiness';
import { deleteConnection, getConnection, upsertConnection } from './app-connection';
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

/** Readiness services belong to one database handle. */
function configureServices() {
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
}

beforeEach(() => {
  initWorkflowDb(':memory:');
  setEncryptionKey(Buffer.alloc(32, 0x52));
  machines = [machine('laptop', true)];
  localTools = true;
  grant = 'grant-a';
  configureServices();
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

  test('renaming a connection, changing its status or saving the same credential again pauses nothing', () => {
    const connection = connect();
    const { flowId } = published(send());
    const save = (changes: Partial<Parameters<typeof upsertConnection>[0]>) => upsertConnection({ externalId: 'account',
      pieceName: 'private-piece', displayName: 'Account', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: 'first' }, ...changes });
    // The dashboard's PATCH sends every edit through the upsert with the stored value.
    save({ displayName: 'Renamed in the dashboard' });
    save({ status: 'ERROR' });
    save({ status: 'ACTIVE' });
    save({});
    expect(getConnection(connection.id)!.credentialGeneration).toBe(0);
    expect(blockers(flowId)).toEqual([]);
    save({ value: { secret_text: 'another account' } });
    expect(getConnection(connection.id)!.credentialGeneration).toBe(1);
    expect(blockers(flowId)).toEqual([expect.stringMatching(/^The credential stored in connection account was replaced since/)]);
  });

  test('re-encrypting the stored credential (the credential migration) does not pause anything', () => {
    // On a database file: the migration's recovery file names the database it belongs to.
    closeWorkflowDb();
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-binding-pins-'));
    try {
      initWorkflowDb(join(dir, 'workflows.db'));
      configureServices();
      const connection = connect();
      const { flowId } = published(send());
      // The unbound envelope an earlier build stored, which the migration seals to its row.
      getWorkflowDb().run('UPDATE app_connection SET value = ? WHERE id = ?', [encryptJson({ secret_text: 'first' }), connection.id]);
      expect(bindNativeCredentials(getWorkflowDb(), join(dir, 'recovery.enc'), 'test').bound).toBe(1);
      expect(getConnection(connection.id)!.value).toEqual({ secret_text: 'first' });
      expect(blockers(flowId)).toEqual([]);
    } finally {
      closeWorkflowDb();
      rmSync(dir, { recursive: true, force: true });
      initWorkflowDb(':memory:');
    }
  });

  test('a connection named in any input, not only auth, is pinned and checked', () => {
    connect();
    connect('second');
    const step = { ...send(), settings: { ...send().settings, input: { auth: "{{connections['account']}}", header: "Bearer {{connections['second']}}" } } };
    const { flowId } = published(step);
    expect(Object.keys(readBindingPins(flowId)!.connections).sort()).toEqual(['account', 'second']);
    connect('second', 'rotated');
    expect(blockers(flowId)).toEqual([expect.stringMatching(/^The credential stored in connection second was replaced since/)]);
  });

  test('saving the live draft is an edit, not an acceptance: a replaced credential stays a blocker', () => {
    connect();
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: 'Live', trigger: graph(send()) });
    updateFlowStatus(flow.id, 'ENABLED');
    connect('account', 'pasted from another account');
    updateDraftVersion(draft.id, { displayName: 'Live, renamed' });
    expect(blockers(flow.id)).toEqual([expect.stringMatching(/^The credential stored in connection account was replaced since/)]);
    // Naming it again after dropping it from the draft does not slip the change through either.
    updateDraftVersion(draft.id, { trigger: graph(readFile()) });
    updateDraftVersion(draft.id, { trigger: graph(send()) });
    expect(blockers(flow.id)).toHaveLength(1);
    updateFlowStatus(flow.id, 'ENABLED');
    expect(blockers(flow.id)).toEqual([]);
  });

  test('a connection that did not resolve when pinned is pinned as unresolved; connecting it later pauses the flow', () => {
    const { flowId, versionId } = published(send('jarvis:google'));
    // Waiting for a reconnect at the first start of this build.
    grant = null;
    getWorkflowDb().run('UPDATE flow SET binding_pins = NULL');
    expect(pinUnpinnedEnabledFlows()).toBe(1);
    expect(readBindingPins(flowId)!.connections['jarvis:google']).toEqual({ kind: 'unresolved' });
    // Reconnected, perhaps to another account.
    grant = 'grant-b';
    expect(blockers(flowId)).toEqual([expect.stringMatching(/^Connection jarvis:google was reconnected since this workflow was enabled\./)]);
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'jarvis:google'))
      .toStartWith('Connection jarvis:google was reconnected since this workflow was enabled.');
  });

  test('publishing again with nothing new to publish accepts the change, on the dashboard and in chat', async () => {
    connect();
    const { flowId } = published(send());
    connect('account', 'pasted from another account');
    // The dashboard's Publish button sends no version.
    publishFlowVersion(flowId);
    expect(blockers(flowId)).toEqual([]);
    connect('account', 'and another');
    await createManageWorkflowTool({}).execute({ action: 'publish', flow: flowId });
    expect(blockers(flowId)).toEqual([]);
  });

  test('the assistant cannot accept a change on its own: enabling or publishing it asks a person first', () => {
    connect();
    const { flowId } = published(send());
    const gate = (action: string, flow = flowId) => createManageWorkflowTool({}).authorityGate!({ action, flow });
    expect(gate('enable')).toBeNull();
    expect(gate('publish')).toBeNull();
    connect('account', 'pasted from another account');
    for (const action of ['enable', 'publish']) {
      expect(gate(action)).toEqual({ actionCategory: 'write_data', confirm: 'always',
        intent: expect.stringContaining('accept: The credential stored in connection account was replaced; it may now act as a different account.') });
    }
    // A flow nothing was accepted for yet has nothing to accept again.
    const fresh = createFlow({});
    createDraftVersion({ flowId: fresh.id, displayName: 'Fresh', trigger: graph(send()) });
    expect(gate('enable', fresh.id)).toBeNull();
    // Another computer counts too: the laptop sleeps, and enabling now would pin the connected desktop.
    const onLaptop = published(readFile()).flowId;
    machines = [machine('laptop', false), machine('desk', true)];
    expect(gate('enable', onLaptop)).toMatchObject({ confirm: 'always',
      intent: expect.stringContaining('The computer it runs on changes from Computer laptop to Computer desk.') });
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

  test('saving the live draft keeps the computer while it fits the steps, and follows a computer the steps name', () => {
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: 'Live', trigger: graph(readFile()) });
    updateFlowStatus(flow.id, 'ENABLED');
    expect(readBindingPins(flow.id)!.machine).toEqual({ sidecarId: 'laptop', name: 'Computer laptop' });
    // The laptop sleeps and a desktop is connected while the person edits: the pin does not move.
    machines = [machine('laptop', false), machine('desk', true)];
    updateDraftVersion(draft.id, { displayName: 'Live, edited' });
    expect(readBindingPins(flow.id)!.machine).toEqual({ sidecarId: 'laptop', name: 'Computer laptop' });
    // Naming a computer in the steps is choosing it.
    updateDraftVersion(draft.id, { trigger: graph(readFile('Computer desk')) });
    expect(readBindingPins(flow.id)!.machine).toEqual({ sidecarId: 'desk', name: 'Computer desk' });
    // A pinned computer that was removed stays a blocker; a save does not pick another.
    machines = [machine('laptop', true)];
    updateDraftVersion(draft.id, { trigger: graph(readFile()) });
    expect(readBindingPins(flow.id)!.machine).toEqual({ sidecarId: 'desk', name: 'Computer desk' });
    expect(blockers(flow.id)).toEqual([expect.stringContaining('(Computer desk) is no longer enrolled')]);
  });

  test('the startup pass sees --no-local-tools, which reaches the tools only later in startup', () => {
    const daemon = readFileSync(join(import.meta.dir, '../../../daemon/index.ts'), 'utf8');
    const wiring = daemon.slice(daemon.indexOf('configureWorkflowReadiness({'), daemon.indexOf('pinUnpinnedEnabledFlows()'));
    expect(wiring).toContain('localTools: () => !config.noLocalTools && !isNoLocalTools()');
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

  test('a connection removed after the resolver found it is refused, not handed out unbound', () => {
    const connection = connect();
    const { flowId, versionId } = published(send());
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
    // Between the resolver's answer and this check.
    deleteConnection(connection.id);
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'account'))
      .toBe('Connection account was removed while this run asked for it. Its credential was not handed out; start a new run once the connection is right.');
    expect(listRunConnectionBindings(run.id)[0]!.refusal).toBeDefined();
  });

  test("the run API shows which connection and what happened, never a managed grant's fingerprint", () => {
    const { flowId, versionId } = published(send('jarvis:google'));
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
    expect(enforceRunConnectionBinding(run.id, getFlow(flowId)!.project_id, 'jarvis:google')).toBeNull();
    expect(listRunConnectionBindings(run.id)[0]!.identity).toEqual({ kind: 'managed', source: 'google', grant: 'grant-a' });
    expect(getFlowRun(run.id)!.connectionBindings).toEqual([{ externalId: 'jarvis:google', identity: { kind: 'managed', source: 'google' }, boundAt: expect.any(Number) }]);
  });

  test('a run of an unpinned flow binds what it finds; a fetch outside any run is left alone', () => {
    connect();
    const flow = createFlow({});
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Unpinned', trigger: graph(send()) });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    expect(enforceRunConnectionBinding(run.id, flow.project_id, 'account')).toBeNull();
    connect('account', 'swapped');
    expect(enforceRunConnectionBinding(run.id, flow.project_id, 'account')).toStartWith('The credential stored in connection account was replaced during this run');
    expect(enforceRunConnectionBinding('trigger-poll', flow.project_id, 'account')).toBeNull();
  });
});
