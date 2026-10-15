import { afterEach, expect, test } from 'bun:test';
import { BackgroundAgentService } from './background-agent-service.ts';
import { BackgroundThrottled } from '../llm/background-budget.ts';
import { CommitmentExecutor } from './commitment-executor.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createCommitment, getCommitment } from '../vault/commitments.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';

afterEach(() => closeDb());

function service(processMessage: () => Promise<string>) {
  const svc = new BackgroundAgentService({} as JarvisConfig, {} as LLMManager);
  (svc as unknown as { orchestrator: { processMessage: () => Promise<string> } }).orchestrator = { processMessage };
  return svc;
}

test('a refused background admission rejects instead of reading as an answer', async () => {
  const svc = service(async () => { throw new BackgroundThrottled('daily_budget', null); });
  await expect(svc.handleMessage('fixture', 'awareness')).rejects.toMatchObject({ code: 'background_throttled' });
  // The chain stays usable for the next turn.
  (svc as unknown as { orchestrator: { processMessage: () => Promise<string> } }).orchestrator = { processMessage: async () => 'done' };
  expect(await svc.handleMessage('fixture', 'awareness')).toBe('done');
});

test('other errors keep their existing text result', async () => {
  const svc = service(async () => { throw new Error('boom'); });
  expect(await svc.handleMessage('fixture')).toBe('Error: boom');
});

test('a throttled commitment execution is recorded as failed, not completed', async () => {
  initDatabase(':memory:', { quiet: true });
  const commitment = createCommitment('fixture task', { when_due: Date.now() - 1000 });
  const executor = new CommitmentExecutor('aggressive');
  executor.setAgentService(service(async () => { throw new BackgroundThrottled('foreground_busy', null); }));
  const internals = executor as unknown as {
    pending: Map<string, unknown>;
    fireExecution(id: string): Promise<void>;
  };
  internals.pending.set(commitment.id, { commitmentId: commitment.id, what: commitment.what, announcedAt: 0, cancelDeadline: 0, cancelled: false, executed: false });
  await internals.fireExecution(commitment.id);
  const after = getCommitment(commitment.id)!;
  expect(after.status).toBe('failed');
  expect(after.result).toContain('Background work paused: foreground_busy');
});
