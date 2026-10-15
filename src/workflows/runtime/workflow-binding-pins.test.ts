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
const computer = (id: string, connected = true): Machine => ({ id, name: `Computer ${id}`, connected, capabilities: ['desktop', 'filesystem'], session: `session-${id}` });
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
    tool: name => name === 'desktop_list_windows' ? { params: [] } : null,
    machines: () => machines as any,
    localTools: () => !isNoLocalTools(),
  });
});
afterEach(() => { setSidecarManagerRef(originalManager!); setNoLocalTools(originalNoLocal); closeWorkflowDb(); });

/** An enabled flow whose step lists the desktop's windows, pinned as enabling pins it. */
function enabledFlow() {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Desktop routine', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'look', type: 'PIECE', settings: { pieceName: TOOL, actionName: 'invoke', input: { toolName: 'desktop_list_windows', params: {} } } } } as any });
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
