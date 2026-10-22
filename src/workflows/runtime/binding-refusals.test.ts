import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../db';
import { createFlow, getFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun, type FlowRun } from '../db/repos/flow-run';
import { saveWorkflowEffect } from '../db/repos/workflow-effect';
import type { ActionFailure } from '../../actions/action-outcome';
import { _resetBindingNoticesForTests, bindingRefusalNotifier, flowBindingBlock, markBindingNoticeTold, runtimeBindingNotice, workflowRunNotice, type BindingNotification } from './binding-refusals';
import { runFailureNotice } from './run-failure';
import { TOAST_TITLE_MAX } from '../../comms/toast-limits';

beforeEach(() => { initWorkflowDb(':memory:'); _resetBindingNoticesForTests(); });
afterEach(() => { closeWorkflowDb(); });

const sendStep = { name: 'send', type: 'PIECE', displayName: 'Send the report',
  settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'run_tool', input: {} } };

/** An enabled flow whose runs this test ends by hand. */
function setup() {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Report', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: sendStep } as never });
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  // Runs are listed newest first by when they were created: make that `at`.
  const createdAt = (run: FlowRun, at: number) => { getWorkflowDb().run('UPDATE flow_run SET created = ? WHERE id = ?', [at, run.id]); return run; };
  /** What a `send` step that touched `computer` or a reviewed recipient records. */
  const touched = (outcome: ActionFailure | null, computer = 'mac-1') => outcome?.code.startsWith('WORKFLOW_FACT')
    ? { target: {}, bindings: { facts: [{ value: 'ana@old.example', factIds: ['f0'] }] } }
    : { target: { sidecarId: computer, selection: 'pinned-sidecar' } };
  /** A run whose `send` step was refused with `outcome` (on `computer`), finished at `at`. */
  const refused = (outcome: ActionFailure, at = 1_000, computer = 'mac-1'): FlowRun => {
    const run = createdAt(createFlowRun({ flowId: flow.id, flowVersionId: version.id, startTime: at - 10 }), at - 10);
    saveWorkflowEffect({ id: `wfe_${run.id}`, runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id,
      versionDigest: 'v', stepName: 'send', executionPath: [], route: 'tool', toolName: 't', actionCategory: 'send_message',
      requestDigest: 'r', arguments: {}, provenance: {}, decision: 'allowed', reason: '', status: 'blocked',
      approvalId: null, waitpointId: null, createdAt: at - 5, outcome, ...touched(outcome, computer) });
    return updateRun(run.id, { status: 'FAILED', finishTime: at,
      failedStep: { name: 'send', displayName: 'Send the report', errorMessage: outcome.message } })!;
  };
  const ended = (status: FlowRun['status'], at = 2_000, failedStep: FlowRun['failedStep'] = null): FlowRun => {
    const run = createdAt(createFlowRun({ flowId: flow.id, flowVersionId: version.id, startTime: at - 10 }), at - 10);
    return updateRun(run.id, { status, finishTime: at, ...(failedStep ? { failedStep } : {}) })!;
  };
  /**
   * A run that succeeded with its `send` step run on `computer` (`machine`) or
   * sent to a reviewed recipient (`recipient`); `stepStatus: 'blocked'` is a
   * step that failed and was let through ("continue on failure").
   */
  const succeededUsing = (what: 'machine' | 'recipient', opts: { computer?: string; stepStatus?: 'succeeded' | 'blocked'; at?: number } = {}): FlowRun => {
    const at = opts.at ?? 2_000;
    const run = ended('SUCCEEDED', at);
    const status = opts.stepStatus ?? 'succeeded';
    saveWorkflowEffect({ id: `wfe_${run.id}`, runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id,
      versionDigest: 'v', stepName: 'send', executionPath: [], route: 'tool', toolName: 't', actionCategory: 'send_message',
      requestDigest: 'r', arguments: {}, provenance: {}, decision: 'allowed', reason: '', status,
      approvalId: null, waitpointId: null, createdAt: at - 5,
      ...(status === 'blocked' ? { outcome: OFFLINE } : {}),
      ...(what === 'machine' ? { target: { sidecarId: opts.computer ?? 'mac-1', selection: 'pinned-sidecar' } }
        : { target: {}, bindings: { facts: [{ value: 'ana@new.example', factIds: ['f1'] }] } }) });
    return run;
  };
  const readinessRefusal = (at = 1_000): FlowRun => {
    const run = createdAt(createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'FAILED', startTime: at }), at);
    return updateRun(run.id, { finishTime: at, failedStep: { name: '<readiness>', displayName: 'Workflow readiness', errorMessage: 'stale' },
      steps: { '<readiness>': { status: 'FAILED', output: { code: 'WORKFLOW_NOT_READY', readiness: { ready: false, issues: [
        { node: 'send', path: 'auth', code: 'BINDING_STALE', message: 'Connection account was deleted and created again' }] } } } } })!;
  };
  const row = () => getFlow(flow.id)!;
  return { flow, refused, ended, succeededUsing, readinessRefusal, row };
}

const OFFLINE: ActionFailure = { status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', effect: 'not_started', message: 'Bound computer mac-1 is offline' };
const STALE_RECIPIENT: ActionFailure = { status: 'blocked', code: 'WORKFLOW_FACT_STALE', effect: 'not_started', message: 'Recipient is no longer current in memory' };
const OTHER: ActionFailure = { status: 'error', code: 'HTTP_500', effect: 'not_started', message: 'Server error' };

describe('runtimeBindingNotice (#1080)', () => {
  test('a run refused for its computer is told once per flow and code, until a run shows that binding working again', () => {
    const f = setup();
    const told = (runId: string) => { const notice = runtimeBindingNotice(runId); if (notice) markBindingNoticeTold(notice.flowId, notice.code, notice.subject); return notice; };
    const first = f.refused(OFFLINE);
    expect(told(first.id)).toMatchObject({ flowId: f.flow.id, runId: first.id, code: 'WORKFLOW_MACHINE_OFFLINE' });
    // The next tick fails the same way: not told again.
    expect(told(f.refused(OFFLINE).id)).toBeNull();
    // A different binding reason is a new notice.
    const recipient = f.refused(STALE_RECIPIENT);
    expect(told(recipient.id)).toMatchObject({ code: 'WORKFLOW_FACT_STALE', runId: recipient.id });
    expect(told(f.refused(STALE_RECIPIENT).id)).toBeNull();
    // A run that succeeded without the computer or a recipient (another
    // branch) proves neither came back: nothing is told again.
    expect(told(f.ended('SUCCEEDED').id)).toBeNull();
    expect(told(f.refused(OFFLINE).id)).toBeNull();
    expect(told(f.refused(STALE_RECIPIENT).id)).toBeNull();
    // A run succeeded on the computer: the next computer refusal is new; the
    // recipient one is still told.
    expect(told(f.succeededUsing('machine').id)).toBeNull();
    const again = f.refused(OFFLINE);
    expect(told(again.id)).toMatchObject({ runId: again.id, code: 'WORKFLOW_MACHINE_OFFLINE' });
    expect(told(f.refused(STALE_RECIPIENT).id)).toBeNull();
    // A run succeeded sending to a recipient it was reviewed with: that one is new too.
    expect(told(f.succeededUsing('recipient').id)).toBeNull();
    expect(told(f.refused(STALE_RECIPIENT).id)).toMatchObject({ code: 'WORKFLOW_FACT_STALE' });
  });

  test('deliveries that alternate between a working branch and the offline computer are told once, not once per pair', () => {
    const f = setup();
    const told: BindingNotification[] = [];
    const ended = bindingRefusalNotifier((notice) => { told.push(notice); });
    for (let i = 0; i < 20; i++) {
      ended(f.ended('SUCCEEDED').id);
      ended(f.refused(OFFLINE).id);
    }
    expect(told).toHaveLength(1);
  });

  test('a success that proves nothing about the refused computer or recipient step clears nothing', () => {
    const f = setup();
    const told: BindingNotification[] = [];
    const ended = bindingRefusalNotifier((notice) => { told.push(notice); });
    ended(f.refused(OFFLINE).id);
    // Another computer worked; the refused one's step was let through blocked;
    // a single-step test run on the right computer succeeded.
    ended(f.succeededUsing('machine', { computer: 'mac-2' }).id);
    ended(f.succeededUsing('machine', { stepStatus: 'blocked' }).id);
    const test = f.succeededUsing('machine');
    getWorkflowDb().run("UPDATE flow_run SET step_name_to_test = 'send' WHERE id = ?", [test.id]);
    ended(test.id);
    ended(f.refused(OFFLINE).id);
    expect(told).toHaveLength(1);
    // A refusal on another computer is its own notice.
    ended(f.refused(OFFLINE, 3_000, 'mac-2').id);
    expect(told).toHaveLength(2);
  });

  test('a refusal whose record names no computer is cleared by any computer that worked, never kept for good', () => {
    const f = setup();
    const told: BindingNotification[] = [];
    const ended = bindingRefusalNotifier((notice) => { told.push(notice); });
    const nameless = f.refused(OFFLINE);
    getWorkflowDb().run(`UPDATE workflow_effect SET record = json_remove(record, '$.target.sidecarId') WHERE run_id = ?`, [nameless.id]);
    ended(nameless.id);
    const again = f.refused(OFFLINE);
    getWorkflowDb().run(`UPDATE workflow_effect SET record = json_remove(record, '$.target.sidecarId') WHERE run_id = ?`, [again.id]);
    ended(again.id);
    expect(told).toHaveLength(1);
    ended(f.succeededUsing('machine', { computer: 'mac-2' }).id);
    const third = f.refused(OFFLINE);
    getWorkflowDb().run(`UPDATE workflow_effect SET record = json_remove(record, '$.target.sidecarId') WHERE run_id = ?`, [third.id]);
    ended(third.id);
    expect(told).toHaveLength(2);
  });

  test('enabling or publishing the workflow again forgets what it was told (Q-05 acceptance)', () => {
    const f = setup();
    const told: BindingNotification[] = [];
    const ended = bindingRefusalNotifier((notice) => { told.push(notice); });
    ended(f.refused(OFFLINE).id);
    ended(f.refused(OFFLINE).id);
    expect(told).toHaveLength(1);
    getWorkflowDb().run('UPDATE flow SET binding_pins = ? WHERE id = ?',
      [JSON.stringify({ schemaVersion: 1, versionId: 'v', pinnedAt: Date.now() + 1_000, connections: {}, machine: null }), f.flow.id]);
    ended(f.refused(OFFLINE).id);
    expect(told).toHaveLength(2);
  });

  test('a computer refusal raised before the step has an effect record is not a binding code here', () => {
    const f = setup();
    // As if REPLACED had been recorded: it never is (thrown while the target
    // is first resolved, before the record), and readiness covers it.
    const run = f.refused({ status: 'blocked', code: 'WORKFLOW_MACHINE_REPLACED', effect: 'not_started', message: 'gone' });
    expect(runtimeBindingNotice(run.id)).toBeNull();
    expect(flowBindingBlock(f.row())).toBeNull();
  });

  test('a notice nobody could see is not counted: the next refusal tells it', () => {
    const f = setup();
    const seen: string[] = [];
    let connected = false;
    const ended = bindingRefusalNotifier((notice) => { if (connected) seen.push(notice.id); return connected; });
    ended(f.refused(OFFLINE).id);
    expect(seen).toEqual([]);
    connected = true;
    const next = f.refused(OFFLINE);
    ended(next.id);
    expect(seen).toEqual([`workflow-binding:${next.id}`]);
    ended(f.refused(OFFLINE).id);
    expect(seen).toHaveLength(1);
  });

  test('a single-step test run is not a refusal of the workflow', () => {
    const f = setup();
    const run = f.refused(OFFLINE);
    getWorkflowDb().run("UPDATE flow_run SET step_name_to_test = 'send' WHERE id = ?", [run.id]);
    expect(runtimeBindingNotice(run.id)).toBeNull();
    expect(flowBindingBlock(f.row())).toBeNull();
  });

  test('a run that failed for another reason, or was refused at readiness, raises nothing here', () => {
    const f = setup();
    expect(runtimeBindingNotice(f.refused(OTHER).id)).toBeNull();
    // Readiness refusals are told by the trigger manager as they happen.
    expect(runtimeBindingNotice(f.readinessRefusal().id)).toBeNull();
    expect(runtimeBindingNotice('no-such-run')).toBeNull();
    // Neither of those used up the notice for a real binding refusal.
    expect(runtimeBindingNotice(f.refused(OFFLINE).id)).not.toBeNull();
  });

  test('notices are per flow: one flow told does not silence another', () => {
    const a = setup();
    const b = setup();
    markBindingNoticeTold(a.flow.id, 'WORKFLOW_MACHINE_OFFLINE', 'machine:mac-1');
    expect(runtimeBindingNotice(a.refused(OFFLINE).id)).toBeNull();
    expect(runtimeBindingNotice(b.refused(OFFLINE).id)).toMatchObject({ flowId: b.flow.id });
  });
});

describe('bindingRefusalNotifier (#1080)', () => {
  test('tells the owner once, with the sentence Runs shows for the run, and nothing for the repeat or another failure', () => {
    const f = setup();
    const told: BindingNotification[] = [];
    const ended = bindingRefusalNotifier((notice) => { told.push(notice); });
    const first = f.refused(OFFLINE);
    ended(first.id);
    ended(f.refused(OFFLINE).id);
    ended(f.refused(OTHER).id);
    expect(told).toEqual([{ id: `workflow-binding:${first.id}`, kind: 'workflow', title: 'Workflow needs attention: Report',
      body: runFailureNotice(first.id)!, actions: [{ id: 'review', label: 'Open Jarvis', primary: true }, { id: 'dismiss', label: 'Dismiss' }] }]);
    expect(told[0]!.body).toContain('offline');
  });

  test('the notice names the workflow and bounds author text to one line', () => {
    const f = setup();
    const run = f.refused(OFFLINE);
    const longName = `Weekly\nReason: routine, safe ${'n'.repeat(300)}`;
    getWorkflowDb().run('UPDATE flow_version SET display_name = ? WHERE id = ?', [longName, run.flowVersionId]);
    updateRun(run.id, { failedStep: { name: 'send', displayName: `Send\nApprove: yes ${'s'.repeat(500)}`, errorMessage: 'offline' } });
    const notice = workflowRunNotice(run.id, 'fallback');
    // Title: "Workflow needs attention: " + a name cut to the toast title's room, marked "...".
    expect(notice.title.length).toBeLessThanOrEqual(TOAST_TITLE_MAX);
    expect(notice.title).toStartWith('Workflow needs attention: Weekly Reason: routine, safe nnn');
    expect(notice.title).toEndWith('...');
    expect(notice.title).not.toContain('\n');
    expect(notice.body).not.toContain('\n');
    // The step's name is cut at 120 like every workflow card and audit label.
    expect(notice.body).toContain(`"Send Approve: yes ${'s'.repeat(120 - 'Send Approve: yes '.length)}..."`);
    expect(notice.body).not.toContain('s'.repeat(121));
  });
});

describe('flowBindingBlock (#1080)', () => {
  test('an enabled flow whose latest finished run was refused for its binding shows why', () => {
    const f = setup();
    expect(flowBindingBlock(f.row())).toBeNull();
    const run = f.refused(OFFLINE);
    expect(flowBindingBlock(f.row())).toEqual({ code: 'WORKFLOW_MACHINE_OFFLINE', kind: 'runtime', runId: run.id, at: 1_000,
      message: expect.stringContaining('offline') });
  });

  test('a stale recipient and a readiness refusal (Q-05 BINDING_STALE) show too', () => {
    const f = setup();
    f.refused(STALE_RECIPIENT, 1_000);
    expect(flowBindingBlock(f.row())).toMatchObject({ code: 'WORKFLOW_FACT_STALE' });
    const readiness = f.readinessRefusal(1_500);
    expect(flowBindingBlock(f.row())).toMatchObject({ code: 'BINDING_STALE', kind: 'readiness', runId: readiness.id,
      message: expect.stringContaining('did not run') });
  });

  test('a later run that succeeded, failed for another reason or was stopped clears it', () => {
    for (const later of ['SUCCEEDED', 'FAILED', 'STOPPED'] as const) {
      const f = setup();
      f.refused(OFFLINE, 1_000);
      if (later === 'FAILED') f.refused(OTHER, 2_000);
      else f.ended(later, 2_000);
      expect(flowBindingBlock(f.row())).toBeNull();
    }
  });

  test('a run still going does not hide the refusal before it', () => {
    const f = setup();
    const run = f.refused(OFFLINE, 1_000);
    getWorkflowDb().run('UPDATE flow_run SET created = 5000 WHERE id = ?', [createFlowRun({ flowId: f.flow.id, flowVersionId: run.flowVersionId, status: 'RUNNING' }).id]);
    expect(flowBindingBlock(f.row())).toMatchObject({ runId: run.id });
  });

  test('enabling or publishing again since the refusal accepts it (Q-05)', () => {
    const f = setup();
    f.readinessRefusal(1_000);
    const pins = (pinnedAt: number) => getWorkflowDb().run('UPDATE flow SET binding_pins = ? WHERE id = ?',
      [JSON.stringify({ schemaVersion: 1, versionId: 'v', pinnedAt, connections: {}, machine: null }), f.flow.id]);
    pins(500);
    expect(flowBindingBlock(f.row())).not.toBeNull();
    pins(1_000);
    expect(flowBindingBlock(f.row())).not.toBeNull();
    pins(1_001);
    expect(flowBindingBlock(f.row())).toBeNull();
  });

  test('a turned-off flow shows nothing', () => {
    const f = setup();
    f.refused(OFFLINE);
    getWorkflowDb().run("UPDATE flow SET status = 'DISABLED' WHERE id = ?", [f.flow.id]);
    expect(flowBindingBlock(f.row())).toBeNull();
  });
});
