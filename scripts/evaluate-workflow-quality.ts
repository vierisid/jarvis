#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { EvaluationRow } from '../src/workflows/evaluation/types';
import type { PlanningPolicy } from '../src/actions/tools/composition-provenance';

// Set isolation before importing any Jarvis runtime module.
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'plan' }, out: { type: 'string' },
  split: { type: 'string', default: 'heldout' }, policy: { type: 'string', default: 'both' },
  condition: { type: 'string', default: 'natural' }, repeats: { type: 'string', default: '1' },
  profile: { type: 'string' }, 'max-requests': { type: 'string', default: '100' },
  results: { type: 'string' }, reviews: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Workflow quality: --mode plan|smoke|hosted|review --out NEW_DIRECTORY\n'
    + '--split development|heldout --policy both|baseline-v1|deterministic-first-v1\n'
    + '--condition natural|malformed-first --repeats 1..20\n'
    + 'Hosted: --profile PROFILE.json --max-requests 1..1000\n'
    + 'Review: --results RUN/rows.jsonl --reviews REVIEWS.json\n'
    + 'Plan is the default and makes no provider requests. Smoke requires development.');
  process.exit(0);
}
function integer(value: string, max: number, name: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(name + ' must be 1..' + max);
  return n;
}
if (!['plan', 'smoke', 'hosted', 'review'].includes(values.mode!)) throw new Error('Invalid mode');
if (!['development', 'heldout'].includes(values.split!)) throw new Error('Invalid split');
if (!['natural', 'malformed-first'].includes(values.condition!)) throw new Error('Invalid condition');
const policies: PlanningPolicy[] = values.policy === 'both' ? ['baseline-v1', 'deterministic-first-v1']
  : ['baseline-v1', 'deterministic-first-v1'].includes(values.policy!) ? [values.policy as PlanningPolicy]
  : (() => { throw new Error('Invalid policy'); })();
const repeats = integer(values.repeats!, 20, 'repeats');
const maxRequests = integer(values['max-requests']!, 1000, 'max-requests');
if (values.mode === 'smoke' && values.split !== 'development') throw new Error('Smoke fixtures are development-only');
if (!values.out) throw new Error('--out must be a new directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: false });
process.env.JARVIS_WORKFLOW_DATA_DIR = join(out, 'runtime');

const { fingerprint } = await import('../src/actions/tools/composition-provenance');
const { fingerprintSource } = await import('../src/workflows/evaluation/source');
const { sanitizedEnv } = await import('../src/util/subprocess-env');
const { loadTasks, evaluateTask } = await import('../src/workflows/evaluation/runner');
const { report, applyReviews } = await import('../src/workflows/evaluation/report');
const { validateProfile, MeasuredHostedProvider } = await import('../src/workflows/evaluation/hosted');
const profile = values.profile ? validateProfile(JSON.parse(readFileSync(values.profile, 'utf8'))) : undefined;
const key = profile ? process.env[profile.apiKeyEnv] : undefined;
const json = (value: unknown) => {
  return JSON.stringify(value, (_name, item) =>
    key && typeof item === 'string' ? item.replaceAll(key, '[REDACTED]') : item);
};
const write = (name: string, value: unknown) => writeFileSync(join(out, name), json(value) + '\n', { flag: 'wx', mode: 0o600 });
const append = (name: string, value: unknown) => {
  const serialized = json(value);
  appendFileSync(join(out, name), serialized + '\n', { mode: 0o600 });
  return serialized;
};

if (values.mode === 'review') {
  if (!values.results || !values.reviews) throw new Error('Review needs --results and --reviews');
  const rows: EvaluationRow[] = readFileSync(values.results, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const reviewed = applyReviews(rows, JSON.parse(readFileSync(values.reviews, 'utf8')));
  write('reviewed-rows.json', reviewed);
  write('report.json', report(reviewed));
  console.log('Review report: ' + out);
  process.exit(0);
}
const taskset = loadTasks(values.split as 'development' | 'heldout');
const scheduled = policies.flatMap(policy => Array.from({ length: repeats }, (_, index) =>
  taskset.tasks.filter(task => values.condition !== 'malformed-first' || !task.expectation.blocked).map(task => ({ taskId: task.id, policy, repeat: index + 1, condition: values.condition })))).flat();
const root = resolve(import.meta.dir, '..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: sanitizedEnv(), encoding: 'utf8' }).trim();
const source = fingerprintSource(root, [
  'src/actions/tools', 'src/workflows', 'src/llm', 'scripts/evaluate-workflow-quality.ts', 'package.json', 'bun.lock', 'bun.lockb',
]);
const manifest = {
  schemaVersion: 1, startedAt: new Date().toISOString(), mode: values.mode,
  head, ...source,
  taskset: { version: taskset.version, sha256: taskset.sha256, split: values.split },
  profile: profile ?? null, requestedAlias: values.mode === 'smoke' ? 'controlled-fixture' : 'uj-high', maxRequests, scheduled,
  limitations: ['Synthetic tasks and simulated effects only; no live integration certification.',
    'Schedule encoding and event subscriptions are inspected, not clock/event-bus delivery.',
    'Ask responses are simulated; this tests wiring, not summarization quality.',
    'Automatic checks do not establish human intent correctness; review is initially unmeasured.',
    'Opaque aliases do not verify the intended backend model. Unknown usage or prices mean unknown cost.'],
};
write('manifest.json', manifest);
write('taskset.json', taskset);
if (values.mode === 'plan' || (values.mode === 'hosted' && (!profile || !key))) {
  write('report.json', { status: 'not_run', scheduled: scheduled.length, completed: 0, results: {},
    reason: values.mode === 'plan' ? 'Plan only; no model calls requested.' : 'Hosted profile or its credential is unavailable.',
    liveModelQuality: 'unmeasured', supervision: 'unmeasured' });
  console.log('Evaluation not run. Manifest: ' + out);
  if (values.mode === 'hosted') process.exitCode = 2;
} else {
  const { initWorkflowDb, closeWorkflowDb } = await import('../src/workflows/db');
  const { setUsageDatabase } = await import('../src/llm/usage');
  const { LLMManager } = await import('../src/llm/manager');
  const { createEvaluationEngine } = await import('../src/workflows/evaluation/engine');
  const { SmokeProvider } = await import('../src/workflows/evaluation/smoke');
  const db = initWorkflowDb(join(out, 'evaluation.sqlite'));
  setUsageDatabase(db);
  const manager = new LLMManager();
  const provider = values.mode === 'smoke' ? new SmokeProvider() : new MeasuredHostedProvider(profile!.baseUrl, key!, maxRequests,
    event => append('events.jsonl', event));
  manager.registerProvider(provider);
  manager.setTierAssignment('high', { provider: provider.name, model: values.mode === 'smoke' ? 'controlled-fixture' : 'uj-high' });
  const rows: EvaluationRow[] = [];
  let engine: Awaited<ReturnType<typeof createEvaluationEngine>> | undefined;
  let failure: string | null = null;
  try {
    engine = await createEvaluationEngine();
    write('catalog.json', { entries: engine.catalog.list(), sha256: fingerprint(engine.catalog.list()),
      bundleHash: engine.bundleHash, readinessValidator: engine.readiness });
    for (const item of scheduled) {
      if (provider instanceof MeasuredHostedProvider && provider.attempts.length >= maxRequests) {
        failure = 'Request budget exhausted; remaining tasks were not run'; break;
      }
      if (provider instanceof SmokeProvider) provider.taskId = item.taskId;
      const task = taskset.tasks.find(t => t.id === item.taskId)!;
      const row = await evaluateTask(task, { manager, engine, kind: values.mode === 'smoke' ? 'harness-smoke' : 'hosted',
        policy: item.policy, condition: values.condition as EvaluationRow['condition'], repeat: item.repeat,
        profile, transport: provider instanceof MeasuredHostedProvider ? provider.attempts : undefined,
        onEvent: event => append('events.jsonl', event) });
      // Reports and review hashes must use exactly the redacted row persisted
      // to disk, not the original object that may still contain a provider secret.
      const savedRow: EvaluationRow = JSON.parse(append('rows.jsonl', row));
      rows.push(savedRow);
      console.log(item.policy + '/' + item.taskId + ': ' + (row.intentChecksPassed ? 'checks passed' : 'checks failed'));
    }
  } catch (error) { failure = String(error); process.exitCode = 1; }
  finally {
    try { await engine?.close(); } catch (error) { failure ??= String(error); process.exitCode = 1; }
    setUsageDatabase(() => null); closeWorkflowDb();
    write('report.json', { status: failure ? 'incomplete' : 'completed', finishedAt: new Date().toISOString(),
      scheduled: scheduled.length, completed: rows.length, notRun: scheduled.slice(rows.length), failure,
      liveModelQuality: values.mode === 'smoke' ? 'unmeasured' : 'automatic checks only; human review required',
      results: report(rows), modelRouting: provider instanceof MeasuredHostedProvider ? provider.attempts.map(a => ({
        request: a.index, requested: a.requestedModel, reported: a.reportedModel,
        intendedModelVerified: a.reportedModel && !a.reportedModel.startsWith('uj-') ? a.reportedModel === profile!.intendedModel : null,
      })) : [] });
    write('review-template.json', rows.map(row => ({ rowId: row.id, rowSha256: fingerprint(row), reviewer: '',
      intentCorrect: null, elapsedMs: null, edits: null, notes: '' })));
    if (failure || rows.some(r => !r.intentChecksPassed)) process.exitCode = 1;
  }
  console.log('Raw results and report: ' + out);
}
