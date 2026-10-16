import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { browser, browserEvaluateTool } from '../actions/tools/builtin';
import { ToolRegistry } from '../actions/tools/registry';
import { getSidecarManager, setSidecarManagerRef } from '../actions/tools/sidecar-route';
import type { SidecarManager } from '../sidecar/manager';
import { collectActionVerification } from '../actions/action-verification';
import { ActionOutcomeError } from '../actions/action-outcome';
import { WorkflowCancellationError } from '../workflows/runtime/cancellation-error';
import { closeDb, initDatabase } from '../vault/schema';
import { ApprovalManager } from './approval';
import { AuditTrail } from './audit';
import { DeferredExecutor, RECEIPT_MAX_CHARS } from './deferred-executor';

const originalManager = getSidecarManager();
let evaluate: ReturnType<typeof spyOn<typeof browser, 'evaluate'>>;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  setSidecarManagerRef(null as unknown as SidecarManager);
  evaluate = spyOn(browser, 'evaluate');
});
afterEach(() => {
  evaluate.mockRestore();
  setSidecarManagerRef(originalManager as SidecarManager);
  closeDb();
});

const args = { expression: 'pageFunction()' };
const pageMessage = 'page-error:' + 'x'.repeat(2_100_000) + 'oversized-tail';
const MAX_BOUNDED_REPLY = 20_100; // 20 KB payload plus the truncation/error labels.

for (const error of [new Error(pageMessage), pageMessage]) {
  test(`approved evaluation bounds a page-controlled ${typeof error} failure before publishing it`, async () => {
    evaluate.mockRejectedValue(error);
    const registry = new ToolRegistry(); registry.register(browserEvaluateTool);
    const manager = new ApprovalManager();
    const executor = new DeferredExecutor(manager, new AuditTrail()); executor.setToolRegistry(registry);
    const notifications: string[] = [];
    executor.setResultCallback((_id, _request, result) => { notifications.push(result); });
    const request = manager.createRequest({ agentId: 'fixture', agentName: 'Fixture',
      toolName: browserEvaluateTool.name, toolArguments: args, actionCategory: 'control_app',
      urgency: 'normal', reason: 'fixture', toolRegistry: registry,
      context: JSON.stringify({ confirm: 'always', intent: 'Fixture browser evaluation' }) });
    manager.approve(request.id, 'dashboard'); // click-only: decided on the dashboard (Q-08)

    const receipt = await executor.executeApprovedWithReceipt(request.id);
    expect(receipt.failed).toBe(true);
    expect(receipt.result.length).toBeLessThanOrEqual(MAX_BOUNDED_REPLY);
    expect(receipt.result).toContain('page-error:');
    expect(receipt.result).toContain('truncated');
    expect(receipt.result).not.toContain('oversized-tail');
    expect(notifications).toEqual([receipt.result]);
    const stored = manager.getRequest(request.id)!;
    // A page error may have happened: kept unknown, never re-run (Q-08).
    expect(stored.execution_outcome).toBe('unknown');
    expect(stored.execution_result!.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS);
    await executor.executeApprovedWithReceipt(request.id);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
}

test('bounded evaluation errors retain uncertainty and the ordinary text format', async () => {
  evaluate.mockRejectedValue(new Error(pageMessage));
  const ordinary = await browserEvaluateTool.execute(args) as string;
  expect(ordinary).toStartWith('Error: page-error:');
  expect(ordinary).toContain('truncated');
  expect(ordinary.length).toBeLessThanOrEqual(MAX_BOUNDED_REPLY);
  await expect(collectActionVerification('browser_evaluate', 'browser', () => browserEvaluateTool.execute(args)))
    .rejects.toMatchObject({ outcome: { status: 'unknown', code: 'BROWSER_ACTION_UNCERTAIN',
      effect: 'may_have_occurred', message: ordinary } });
});

for (const error of [
  new ActionOutcomeError({ status: 'blocked', code: 'FIXTURE_REFUSAL', message: 'Refused before dispatch', effect: 'not_started' }),
  new WorkflowCancellationError('fixture-run'),
]) test(`${error.name} remains the original typed verdict`, async () => {
  evaluate.mockRejectedValue(error);
  await expect(collectActionVerification('browser_evaluate', 'browser', () => browserEvaluateTool.execute(args)))
    .rejects.toBe(error);
});
