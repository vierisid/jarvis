/**
 * Q-05: a changed default computer cannot silently move a pinned workflow.
 * Before pins, every run picked the most recently enrolled connected computer
 * again, so a new enrollment or the usual one being offline moved the work;
 * these drive the run's machine scope the way a step does.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from '../db';
import { createFlow, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { readBindingPins } from '../db/repos/binding-pins';
import { getRunMachineBinding } from '../db/repos/run-machine-binding';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { isNoLocalTools, setNoLocalTools } from '../../actions/tools/local-tools-guard';
import { getMachineScope } from '../../actions/machine-scope';
import { withWorkflowMachineBinding } from './machine-binding';
import { PieceCatalog } from './piece-catalog';
import { ActionOutcomeError } from '../../actions/action-outcome';

const TOOL = '@jarvispieces/piece-jarvis-tool';
type Machine = { id: string; name: string; connected: boolean; capabilities: string[]; session: string };
let machines: Machine[] = [];
const computer = (id: string, connected = true): Machine => ({ id, name: `Computer ${id}`, connected, capabilities: ['desktop', 'filesystem', 'browser'], session: `session-${id}` });
const originalManager = getSidecarManager();
const originalNoLocal = isNoLocalTools();

beforeEach(() => {
  initWorkflowDb(':memory:');
  machines = [computer('a'), computer('b')];
  const manager = { listSidecars: () => machines,
    getConnectionSessionId: (id: string) => machines.find(s => s.id === id && s.connected)?.session ?? null };
  setSidecarManagerRef(manager as any);
  configureWorkflowReadiness({
    pieces: new PieceCatalog([{ name: TOOL, displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } }] as any),
    tool: name => ['desktop_list_windows', 'desktop_launch_app', 'desktop_click', 'browser_navigate'].includes(name) ? { params: [] } : null,
    machines: () => machines as any,
    localTools: () => !isNoLocalTools(),
  });
});
afterEach(() => { setSidecarManagerRef(originalManager!); setNoLocalTools(originalNoLocal); closeWorkflowDb(); });

/** An enabled flow whose step lists the desktop's windows, pinned as enabling pins it. */
function enabledFlow(toolName = 'desktop_list_windows') {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Desktop routine', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'look', type: 'PIECE', settings: { pieceName: TOOL, actionName: 'invoke', input: { toolName, params: {} } } } } as any });
  updateFlowStatus(flow.id, 'ENABLED');
  const run = () => createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' }).id;
  return { flowId: flow.id, run };
}
const scoped = <T>(runId: string, act: () => T) => withWorkflowMachineBinding({ runId, projectId: DEFAULT_IDS.project }, act);
const resolve = (runId: string) => scoped(runId, () => getMachineScope()!.resolveTarget(undefined, 'desktop'));
const blockedCode = (act: () => unknown) => {
  try { act(); return null; } catch (error) { expect(error).toBeInstanceOf(ActionOutcomeError); return (error as ActionOutcomeError).outcome; }
};

test('a computer enrolled after the flow was enabled does not take over its later runs', () => {
  const flow = enabledFlow();
  expect(readBindingPins(flow.flowId)!.machine).toEqual({ sidecarId: 'a', name: 'Computer a' });
  machines = [computer('new'), ...machines];
  const runId = flow.run();
  expect(resolve(runId)).toBe('a');
  expect(getRunMachineBinding(runId)).toMatchObject({ sidecarId: 'a', selectedBy: 'pinned' });
});

for (const tool of ['desktop_launch_app', 'desktop_click', 'browser_navigate']) test(`${tool} pins its machine when enabled, before its first run`, () => {
  const flow = enabledFlow(tool);
  expect(readBindingPins(flow.flowId)!.machine).toEqual({ sidecarId: 'a', name: 'Computer a' });
  machines = [computer('new'), ...machines];
  expect(resolve(flow.run())).toBe('a');
});

test('the pinned computer offline: the run waits on it and dispatch is blocked, no other computer does the work', () => {
  const flow = enabledFlow();
  machines[0]!.connected = false;
  const runId = flow.run();
  expect(resolve(runId)).toBe('a');
  expect(blockedCode(() => scoped(runId, () => getMachineScope()!.assertDispatch('a', 'desktop'))))
    .toMatchObject({ status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', effect: 'not_started' });
});

test('the pinned computer removed or re-enrolled is a typed blocker naming it, never a replacement', () => {
  const flow = enabledFlow();
  machines = [computer('a-rotated'), computer('b')];
  expect(blockedCode(() => resolve(flow.run()))).toMatchObject({ status: 'blocked', code: 'WORKFLOW_MACHINE_REPLACED', effect: 'not_started',
    message: 'The computer this workflow was enabled for (Computer a) is no longer enrolled. No action was dispatched. '
      + 'Enable or publish the workflow again to choose a computer; do not replay completed work.' });
});

test('a flow pinned to this computer stays here when a sidecar enrolls later, and stops if local tools are turned off', () => {
  machines = [];
  const flow = enabledFlow();
  expect(readBindingPins(flow.flowId)!.machine).toEqual({ sidecarId: null, name: 'this computer' });
  machines = [computer('laptop')];
  expect(resolve(flow.run())).toBeNull();
  setNoLocalTools(true);
  expect(blockedCode(() => resolve(flow.run()))).toMatchObject({ code: 'WORKFLOW_MACHINE_UNAVAILABLE' });
});

/** An enabled flow whose one step delegates to `role`. */
function delegatingFlow(role: string, enable = true) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Agent routine', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'agent', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-agent', actionName: 'delegate',
      input: { goal: 'Write the note', role } } } } as any });
  if (enable) updateFlowStatus(flow.id, 'ENABLED');
  return { flowId: flow.id, versionId: version.id };
}
const withRoles = () => configureWorkflowReadiness({
  pieces: new PieceCatalog([{ name: TOOL, displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } },
    { name: '@jarvispieces/piece-jarvis-agent', displayName: '', description: '', actions: { delegate: { name: 'delegate', displayName: '', description: '' } } }] as any),
  machines: () => machines as any, localTools: () => !isNoLocalTools(), roles: () => new Set(['computer-operator', 'writer']),
  roleTools: id => ({ 'computer-operator': ['desktop_click', 'browser_navigate'], writer: ['file-ops'] } as Record<string, string[]>)[id] ?? null });

test('a delegation whose role works the screen pins its computer when enabled; one that does not, does not (#1314 M2)', () => {
  withRoles();
  expect(readBindingPins(delegatingFlow('computer-operator').flowId)!.machine).toEqual({ sidecarId: 'a', name: 'Computer a' });
  expect(readBindingPins(delegatingFlow('writer').flowId)!.machine).toBeNull();
});

test('a computer action names its computer exactly; part of a name is not a choice (#1314 M2)', () => {
  // A draft's run: nothing pinned, so the step's own target decides.
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Draft', trigger: { name: 'trigger', type: 'EMPTY' } as any });
  const run = () => createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' }).id;
  machines = [computer('a'), { ...computer('b'), name: 'Studio workstation' }];
  for (const capability of ['desktop', 'browser'] as const) {
    expect(blockedCode(() => scoped(run(), () => getMachineScope()!.resolveTarget('Studio', capability))))
      .toMatchObject({ code: 'WORKFLOW_TARGET_AMBIGUOUS' });
  }
  // Other capabilities keep the old partial match; the full name still finds it.
  expect(scoped(run(), () => getMachineScope()!.resolveTarget('Studio', 'filesystem'))).toBe('b');
  expect(scoped(run(), () => getMachineScope()!.resolveTarget('Studio workstation', 'browser'))).toBe('b');
});

test('a computer pinned with nobody choosing runs no computer action (#1314 review)', async () => {
  const { getWorkflowDb } = await import('../db');
  const { getFlowVersion } = await import('../db/repos/flow-version');
  const { bindingPinIssues, pinUnpinnedEnabledFlows } = await import('../db/repos/binding-pins');
  withRoles();
  const flow = delegatingFlow('computer-operator');
  // As the startup pass meets a flow with no pins: it pins the one computer that serves it, unattended.
  getWorkflowDb().run('UPDATE flow SET binding_pins = NULL WHERE id = ?', [flow.flowId]);
  machines = [computer('a')];
  pinUnpinnedEnabledFlows();
  expect(readBindingPins(flow.flowId)!.machine).toEqual({ sidecarId: 'a', name: 'Computer a', unattended: true });
  // A delegation is not refused whole: its agent may never touch a screen. Its screen calls are.
  expect(bindingPinIssues(flow.flowId, flow.versionId, getFlowVersion(flow.versionId)!.trigger)).toEqual([]);
  const runId = createFlowRun({ flowId: flow.flowId, flowVersionId: flow.versionId, status: 'RUNNING' }).id;
  const delegated = <T>(act: () => T) => withWorkflowMachineBinding({ runId, projectId: DEFAULT_IDS.project }, act, { delegated: true });
  expect(blockedCode(() => delegated(() => getMachineScope()!.resolveTarget(undefined, 'browser'))))
    .toMatchObject({ code: 'WORKFLOW_MACHINE_UNPINNED', message: expect.stringContaining('pinned with nobody choosing') });
  expect(getRunMachineBinding(runId)).toBeNull();
  // A person enabling it chooses: the same computer, no longer unattended.
  const { pinFlowBindings } = await import('../db/repos/binding-pins');
  pinFlowBindings(flow.flowId);
  expect(readBindingPins(flow.flowId)!.machine).toEqual({ sidecarId: 'a', name: 'Computer a' });
  expect(delegated(() => getMachineScope()!.resolveTarget(undefined, 'browser'))).toBe('a');
});

test('a delegation to a browser role is not blocked whole when no computer could be pinned, only its browser calls (#1314 review)', async () => {
  withRoles();
  machines = [];
  setNoLocalTools(true);
  const flow = delegatingFlow('computer-operator');
  expect(readBindingPins(flow.flowId)!.machine).toBeNull();
  const { bindingPinIssues } = await import('../db/repos/binding-pins');
  const { getFlowVersion } = await import('../db/repos/flow-version');
  expect(bindingPinIssues(flow.flowId, flow.versionId, getFlowVersion(flow.versionId)!.trigger)).toEqual([]);
  const runId = createFlowRun({ flowId: flow.flowId, flowVersionId: flow.versionId, status: 'RUNNING' }).id;
  const delegated = <T>(act: () => T) => withWorkflowMachineBinding({ runId, projectId: DEFAULT_IDS.project }, act, { delegated: true });
  expect(blockedCode(() => delegated(() => getMachineScope()!.resolveTarget(undefined, 'browser'))))
    .toMatchObject({ code: 'WORKFLOW_MACHINE_UNPINNED', message: expect.stringContaining('No computer could be pinned') });
});

test('a default-role screenshot is refused with a remedy that works: the role, not enabling again (#1314 review)', async () => {
  withRoles();
  const flow = delegatingFlow('writer');
  expect(readBindingPins(flow.flowId)!.machine).toBeNull();
  const runId = createFlowRun({ flowId: flow.flowId, flowVersionId: flow.versionId, status: 'RUNNING' }).id;
  expect(blockedCode(() => withWorkflowMachineBinding({ runId, projectId: DEFAULT_IDS.project },
    () => getMachineScope()!.resolveTarget(undefined, 'screenshot'), { delegated: true })))
    .toMatchObject({ code: 'WORKFLOW_MACHINE_UNPINNED', message: expect.stringContaining('computer-operator') });
});

test('an enabled flow with a direct screen step and no pinned computer is blocked before it runs, saying how to fix it (#1314 M2)', async () => {
  const { bindingPinIssues } = await import('../db/repos/binding-pins');
  const { getWorkflowDb } = await import('../db');
  const flow = enabledFlow('browser_navigate');
  getWorkflowDb().run(`UPDATE flow SET binding_pins = json_set(binding_pins, '$.machine', json('null')) WHERE id = ?`, [flow.flowId]);
  const { getFlowVersion } = await import('../db/repos/flow-version');
  const versionId = readBindingPins(flow.flowId)!.versionId;
  expect(bindingPinIssues(flow.flowId, versionId, getFlowVersion(versionId)!.trigger)).toEqual([expect.objectContaining({
    code: 'WORKFLOW_MACHINE_UNPINNED', message: expect.stringContaining('Enable the workflow to pin its computer, or name the computer in the step.') })]);
});
