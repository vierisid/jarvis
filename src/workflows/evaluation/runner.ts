import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LLMManager } from '../../llm/manager';
import { createComposerLlmClient } from '../../actions/tools/composer-llm';
import { composePersistedFlow } from '../../actions/tools/persisted-workflow-composer';
import { fingerprint, snapshotComposition, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import type { ComposerLlmClient } from '../../actions/tools/workflow-composer';
import { estimatedCost, type HostedProfile } from './hosted';
import { staticChecks, passed } from './checks';
import { environmentFor } from './environment';
import type { EvaluationRow, EffectExecutor, QualityTask, TransportAttempt, TransportStop, CallTrace } from './types';

/** Named task sets. W8 keeps its original files; later sets name their environment. */
export const TASK_SETS: Record<string, Record<QualityTask['split'], string>> = {
  w8: { development: 'development.json', heldout: 'heldout.json' },
  founder: { development: 'founder-development-1.json', heldout: 'founder-heldout-1.json' },
};
export interface TaskSet { name: string; version: string; sha256: string; environment: string; tasks: QualityTask[] }

/** Rejects a fixture that could not be graded fairly: unknown tools, pieces or
 * machines, graph-only tasks with scenarios, or duplicate ids. */
export function validateTaskSet(data: any, split: QualityTask['split'], name: string): TaskSet {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('Invalid task set');
  const environment = environmentFor(data.environment);
  const tools = new Set(environment.tools.map(t => t.name)), targets = new Set(environment.targets.map(t => t.name));
  const external = new Map(environment.external.map(e => [e.name, new Set(Object.keys(e.actions))]));
  const ids = new Set<string>();
  for (const t of data.tasks) {
    const fail = (why: string): never => { throw new Error('Invalid task fixture ' + (t?.id ?? '?') + ': ' + why); };
    if (t.split !== split || !t.id || ids.has(t.id) || !t.specification?.description
      || !t.expectation || !Array.isArray(t.scenarios)) fail('identity, split, specification or scenarios');
    ids.add(t.id);
    const graphOnly = (t.expectation.external ?? []).length > 0;
    if ((graphOnly || t.expectation.blocked) && t.scenarios.length) fail('graph-only and abstention tasks have no scenarios');
    if (!graphOnly && !t.expectation.blocked && !t.scenarios.length) fail('an executable task needs scenarios');
    for (const step of t.expectation.external ?? [])
      if (!external.get(step.piece)?.has(step.action) || !step.connection || typeof step.input !== 'object') fail('unknown external step');
    for (const s of t.scenarios) {
      if (!s.id || typeof s.payload !== 'object' || !Array.isArray(s.notifications)) fail('scenario shape');
      for (const call of s.tools ?? []) {
        if (!tools.has(call.toolName)) fail('tool ' + call.toolName + ' is not in environment ' + environment.id);
        if (call.params?.target !== undefined && !targets.has(call.params.target)) fail('unknown target ' + call.params.target);
      }
      for (const target of s.sandbox?.offlineTargets ?? []) if (!targets.has(target)) fail('unknown offline target ' + target);
    }
  }
  return { name, version: data.version, sha256: fingerprint(data), environment: environment.id, tasks: data.tasks };
}

export function loadTasks(split: QualityTask['split'], name = 'w8'): TaskSet {
  if (!['development', 'heldout'].includes(split)) throw new Error('Unknown task split');
  const file = TASK_SETS[name]?.[split];
  if (!file) throw new Error('Unknown task set ' + name);
  return validateTaskSet(JSON.parse(readFileSync(new URL('./tasks/' + file, import.meta.url), 'utf8')), split, name);
}

/** The sealed replacement holdout lives outside the repository; only its hash
 * is committed, so a reserve that was edited or swapped is refused. */
export function loadReserve(path: string, commitmentPath: string | URL = new URL('./tasks/founder-reserve-1.commitment.json', import.meta.url)): TaskSet {
  const commitment = JSON.parse(readFileSync(commitmentPath, 'utf8'));
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (fingerprint(data) !== commitment.sha256 || data.version !== commitment.version) throw new Error('Reserve does not match its committed hash');
  return validateTaskSet(data, 'heldout', 'founder-reserve');
}
export interface EvaluationOptions {
  manager: LLMManager; engine: EffectExecutor; kind: EvaluationRow['kind']; policy: PlanningPolicy;
  condition?: EvaluationRow['condition']; repeat?: number;
  transport?: TransportAttempt[]; profile?: HostedProfile;
  /** The provider's refusal log; each row keeps the refusals made during its task. */
  stops?: TransportStop[];
  profileIdentity?: EvaluationRow['profile'];
  onEvent?: (event: unknown) => void;
}
/** What the model was told apart from the job itself: the system prompt and,
 * on the tool path, the tool definitions. Repair feedback lives in user turns. */
function promptFingerprint(call: CallTrace): string {
  const request = call.request as any;
  return call.path === 'text' ? fingerprint({ path: 'text', system: request?.system ?? null })
    : fingerprint({ path: 'tools', tools: request?.tools ?? null,
      system: (request?.messages ?? []).filter((m: any) => m?.role === 'system').map((m: any) => m.content) });
}
export async function evaluateTask(task: QualityTask, opts: EvaluationOptions): Promise<EvaluationRow> {
  const id = randomUUID(), calls: CallTrace[] = [];
  const candidates: EvaluationRow['candidates'] = [];
  const transportStart = opts.transport?.length ?? 0, stopsStart = opts.stops?.length ?? 0;
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
  // The composer sees exactly the environment the task set names: tools and machines included.
  const environment = opts.engine.environment ?? environmentFor('w8');
  const deps = { llm, pieceRegistry: opts.engine.catalog, planningPolicy: opts.policy,
    ...(environment.tools.length ? { tools: environment.tools } : {}),
    ...(environment.targets.length ? { executionTargets: environment.targets } : {}),
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
    profile: opts.profileIdentity ?? null, interruptions: [], promptSha256s: [],
  };
  const start = performance.now();
  opts.onEvent?.({ type: 'task_started', id, taskId: task.id, policy: opts.policy, condition });
  try { row.result = await composePersistedFlow(deps, task.specification); }
  catch (error) { row.error = String(error); }
  row.compositionMs = performance.now() - start;
  row.transport = structuredClone(opts.transport?.slice(transportStart) ?? []);
  row.interruptions = structuredClone(opts.stops?.slice(stopsStart) ?? []);
  row.promptSha256s = [...new Set(calls.map(promptFingerprint))].sort();
  const cost = estimatedCost(row.transport, opts.profile);
  row.estimatedCostUsd = cost.usd; row.costComplete = cost.complete && cost.usd !== null;
  const checks = staticChecks(task, row.result, row.result?.ok === false && row.result.blocked === true, environment);
  row.staticChecks = checks.checks; row.aiSteps = checks.aiSteps;
  // A step on a connection-bound integration cannot run here; such tasks are graded on the graph.
  if (row.result?.ok && !task.expectation.blocked && !(task.expectation.external ?? []).length) {
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
