import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LLMManager } from '../../llm/manager';
import { createComposerLlmClient } from '../../actions/tools/composer-llm';
import { composePersistedFlow } from '../../actions/tools/persisted-workflow-composer';
import { fingerprint, snapshotComposition, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import type { ComposerLlmClient } from '../../actions/tools/workflow-composer';
import { estimatedCost, type HostedProfile } from './hosted';
import { staticChecks, passed } from './checks';
import type { EvaluationRow, EffectExecutor, QualityTask, TransportAttempt, CallTrace } from './types';

export function loadTasks(split: QualityTask['split']): { version: string; sha256: string; tasks: QualityTask[] } {
  if (!['development', 'heldout'].includes(split)) throw new Error('Unknown task split');
  const text = readFileSync(new URL('./tasks/' + split + '.json', import.meta.url), 'utf8');
  const data = JSON.parse(text);
  if (data.schemaVersion !== 1 || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('Invalid task set');
  const ids = new Set<string>();
  for (const t of data.tasks) {
    if (t.split !== split || !t.id || ids.has(t.id) || !t.specification?.description
      || !t.expectation || !Array.isArray(t.scenarios)) throw new Error('Invalid task fixture');
    ids.add(t.id);
  }
  return { version: data.version, sha256: fingerprint(data), tasks: data.tasks };
}
export interface EvaluationOptions {
  manager: LLMManager; engine: EffectExecutor; kind: EvaluationRow['kind']; policy: PlanningPolicy;
  condition?: EvaluationRow['condition']; repeat?: number;
  transport?: TransportAttempt[]; profile?: HostedProfile;
  onEvent?: (event: unknown) => void;
}
export async function evaluateTask(task: QualityTask, opts: EvaluationOptions): Promise<EvaluationRow> {
  const id = randomUUID(), calls: CallTrace[] = [];
  const candidates: EvaluationRow['candidates'] = [];
  const transportStart = opts.transport?.length ?? 0;
  const base = createComposerLlmClient(opts.manager);
  let injected = false;
  const condition = opts.condition ?? 'natural';
  async function trace<T>(path: 'text' | 'tools', request: unknown, invoke: () => Promise<T>): Promise<T> {
    // Capture this BEFORE invocation: a rejected response is only a repair
    // opportunity until the composer actually starts another call with its errors.
    const previous = candidates.at(-1);
    const row: CallTrace = { path, request: structuredClone(request), requestSha256: fingerprint(request), elapsedMs: 0,
      repairOfCandidate: previous?.errors.length ? candidates.length - 1 : null };
    calls.push(row);
    opts.onEvent?.({ type: 'call_started', id, call: calls.length, ...row });
    const start = performance.now();
    try {
      const real = await invoke();
      // A separate controlled repair condition, never mixed into natural quality.
      const value = condition === 'malformed-first' && !injected
        ? (injected = true, row.injectedFault = 'malformed-first',
          path === 'text' ? { text: '{malformed' } : { content: '{malformed', tool_calls: [], finish_reason: 'stop' })
        : real;
      row.response = structuredClone(real);
      if (row.injectedFault) row.injectedResponse = structuredClone(value);
      return value as T;
    } catch (error) { row.error = String(error); throw error; }
    finally {
      row.elapsedMs = performance.now() - start;
      opts.onEvent?.({ type: 'call_finished', id, call: calls.length, ...row });
    }
  }
  const llm: ComposerLlmClient = {
    chat: input => trace('text', { prompt: input.prompt, system: input.system }, () => base.chat(input)),
    chatTools: (messages, tools, signal, checkDeadline) => trace('tools', { messages, tools },
      () => base.chatTools!(messages, tools, signal, checkDeadline)),
  };
  const deps = { llm, pieceRegistry: opts.engine.catalog, planningPolicy: opts.policy,
    onCandidate(candidate: EvaluationRow['candidates'][number]) {
      candidates.push(structuredClone(candidate));
      opts.onEvent?.({ type: 'candidate', id, candidate });
    } };
  const row: EvaluationRow = {
    schemaVersion: 1, id, taskId: task.id, split: task.split, repeat: opts.repeat ?? 1,
    kind: opts.kind, policy: opts.policy, condition, specification: structuredClone(task.specification),
    provenance: snapshotComposition(deps).provenance, calls, candidates, transport: [], result: null,
    compositionMs: 0, staticChecks: [], aiSteps: null, scenarios: [], intentChecksPassed: false,
    humanIntentCorrect: null, supervision: null, estimatedCostUsd: null, costComplete: false,
  };
  const start = performance.now();
  opts.onEvent?.({ type: 'task_started', id, taskId: task.id, policy: opts.policy, condition });
  try { row.result = await composePersistedFlow(deps, task.specification); }
  catch (error) { row.error = String(error); }
  row.compositionMs = performance.now() - start;
  row.transport = structuredClone(opts.transport?.slice(transportStart) ?? []);
  const cost = estimatedCost(row.transport, opts.profile);
  row.estimatedCostUsd = cost.usd; row.costComplete = cost.complete && cost.usd !== null;
  const checks = staticChecks(task, row.result, row.result?.ok === false && row.result.blocked === true);
  row.staticChecks = checks.checks; row.aiSteps = checks.aiSteps;
  if (row.result?.ok && !task.expectation.blocked) {
    try { row.scenarios = await opts.engine.execute(row.result.flow.trigger, task.scenarios); }
    catch (error) { row.error = String(error); }
  }
  row.intentChecksPassed = passed(row.staticChecks, row.scenarios, task) && !row.error;
  opts.onEvent?.({ type: 'task_finished', row });
  return row;
}
export function summarize(rows: EvaluationRow[]) {
  const count = (f: (r: EvaluationRow) => boolean) => rows.filter(f).length;
  const needed = rows.filter(r => r.candidates.some(c => c.errors.length > 0) || r.calls.some(c => c.injectedFault));
  const repaired = rows.filter(r => r.calls.some(c => typeof c.repairOfCandidate === 'number'));
  // Older raw artifacts have no call/candidate ordering. Do not infer attempts
  // from errors or from total calls (which may include pre-failure discovery).
  const unmeasured = needed.filter(r => !repaired.includes(r)
    && r.calls.some(c => c.repairOfCandidate === undefined)).length;
  return {
    completed: rows.length,
    compositionSucceeded: count(r => r.result?.ok === true),
    intentChecksPassed: count(r => r.intentChecksPassed),
    humanIntentCorrect: { reviewed: count(r => r.humanIntentCorrect !== null), correct: count(r => r.humanIntentCorrect === true) },
    repairs: { needed: needed.length, unmeasured, attempted: unmeasured ? null : repaired.length,
      structurallySucceeded: unmeasured ? null : repaired.filter(r => r.result?.ok).length,
      intentChecksPassed: unmeasured ? null : repaired.filter(r => r.intentChecksPassed).length },
    effects: { scenarios: rows.reduce((n,r) => n + r.scenarios.length, 0),
      passed: rows.reduce((n,r) => n + r.scenarios.filter(s => s.checks.every(c => c.pass)).length, 0), mode: 'simulated-providers' },
    aiAllowanceViolations: count(r => r.staticChecks.some(c => c.name === 'AI steps within task allowance' && !c.pass)),
    compositionLatencyMs: rows.map(r => r.compositionMs),
    transportAttempts: rows.reduce((n,r) => n + r.transport.length, 0),
    cost: { estimatedUsd: rows.length && rows.every(r => r.costComplete)
      ? rows.reduce((n,r) => n + r.estimatedCostUsd!, 0) : null, rowsWithCompleteCost: count(r => r.costComplete) },
    supervision: { reviewed: count(r => r.supervision !== null), records: rows.flatMap(r => r.supervision ? [r.supervision] : []) },
  };
}
