import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { LLMManager } from '../../llm/manager';
import { SmokeProvider } from './smoke';
import { evaluateTask, loadTasks } from './runner';

test('Jarvis composer, engine and outer worker check actual effects and detect a wrong destination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-quality-engine-'));
  const previous = process.env.JARVIS_WORKFLOW_DATA_DIR;
  process.env.JARVIS_WORKFLOW_DATA_DIR = directory;
  initWorkflowDb(':memory:');
  const { createEvaluationEngine } = await import('./engine');
  let engine: Awaited<ReturnType<typeof createEvaluationEngine>> | undefined;
  try {
    engine = await createEvaluationEngine();
    const provider = new SmokeProvider(), manager = new LLMManager();
    manager.registerProvider(provider);
    manager.setTierAssignment('high', { provider: provider.name, model: 'controlled-fixture' });
    const task = loadTasks('development').tasks[0]!;
    const result = await evaluateTask(task, { manager, engine, policy: 'deterministic-first-v1', kind: 'harness-smoke', condition: 'malformed-first' });
    expect(result.intentChecksPassed).toBe(true);
    expect(result.calls.some(c => c.injectedFault)).toBe(true);
    expect(result.calls.some(c => c.path === 'text')).toBe(true);
    expect(result.scenarios[0]!.receipts[0]).toMatchObject({ kind: 'notification', stepName: 'notify' });
    expect(result.scenarios[0]!.runId).toBe(result.scenarios[0]!.receipts[0]!.runId);
    expect(result.humanIntentCorrect).toBeNull();
    if (!result.result?.ok) throw new Error('Fixture composition failed');
    const wrong = structuredClone(result.result.flow.trigger);
    (wrong.nextAction!.settings as any).input.channels = ['desktop'];
    const actual = await engine.execute(wrong, task.scenarios);
    expect(actual[0]!.status).toBe('SUCCEEDED');
    expect(actual[0]!.checks.find(c => c.name.includes('destinations'))!.pass).toBe(false);
  } finally {
    await engine?.close();
    closeWorkflowDb();
    if (previous === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR;
    else process.env.JARVIS_WORKFLOW_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
