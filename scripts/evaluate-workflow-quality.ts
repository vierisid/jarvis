#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { EvaluationRow } from '../src/workflows/evaluation/types';
import type { PlanningPolicy } from '../src/actions/tools/composition-provenance';

// Set isolation before importing any Jarvis runtime module.
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'plan' }, out: { type: 'string' },
  split: { type: 'string', default: 'heldout' }, policy: { type: 'string', default: 'both' },
  condition: { type: 'string', default: 'natural' }, repeats: { type: 'string', default: '1' },
  profile: { type: 'string' }, authorization: { type: 'string' }, rubric: { type: 'string' }, 'max-requests': { type: 'string' },
  results: { type: 'string' }, reviews: { type: 'string' }, key: { type: 'string' }, runs: { type: 'string' }, rule: { type: 'string' },
  taskset: { type: 'string', default: 'w8' }, reserve: { type: 'string' }, references: { type: 'string' }, environment: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Workflow quality: --mode plan|smoke|hosted|review-packet|review|baseline|compare --out NEW_DIRECTORY\n'
    + '--taskset w8|founder|founder-reserve (the reserve also needs --reserve FILE)\n'
    + '--split development|heldout --policy both|baseline-v1|deterministic-first-v1\n'
    + '--environment ID runs the task set in an environment containing its own (founder-v2 or founder-v2-hosted: production-shaped)\n'
    + '--condition natural|malformed-first --repeats 1..20 [--rubric RUBRIC.json]\n'
    + 'Hosted: --profile PROFILE.json --authorization SPEND.json [--max-requests N, at most the authorized limit]\n'
    + 'Review packet: --results RUN/rows.jsonl (writes a blinded packet, its key and a template)\n'
    + 'Review: --results RUN/rows.jsonl --reviews REVIEWS.json [--key KEY.json for blinded reviews]\n'
    + 'Baseline: --runs RUN_OR_REVIEWED_DIRECTORY[,...]\n'
    + 'Compare: --runs RUN_OR_REVIEWED_DIRECTORY[,...] [--rule PROMOTION_RULE.json] (deterministic-first against baseline-v1;\n'
    + '  hosted runs pin the rule they start under, and compare refuses any other)\n'
    + 'Plan is the default and makes no provider requests. Smoke requires development, unless --references FILE\n'
    + 'supplies answers kept outside the repository: that proves a held-out set is satisfiable and measures nothing.');
  process.exit(0);
}
function integer(value: string, max: number, name: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(name + ' must be 1..' + max);
  return n;
}
if (!['plan', 'smoke', 'hosted', 'review-packet', 'review', 'baseline', 'compare'].includes(values.mode!)) throw new Error('Invalid mode');
if (values.taskset === 'founder-reserve' && (values.split !== 'heldout' || !values.reserve)) throw new Error('The reserve is a held-out set and needs --reserve FILE');
if (!['development', 'heldout'].includes(values.split!)) throw new Error('Invalid split');
if (!['natural', 'malformed-first'].includes(values.condition!)) throw new Error('Invalid condition');
const policies: PlanningPolicy[] = values.policy === 'both' ? ['baseline-v1', 'deterministic-first-v1']
  : ['baseline-v1', 'deterministic-first-v1'].includes(values.policy!) ? [values.policy as PlanningPolicy]
  : (() => { throw new Error('Invalid policy'); })();
const repeats = integer(values.repeats!, 20, 'repeats');
const requestedMaxRequests = values['max-requests'] === undefined ? undefined : integer(values['max-requests'], 1000, 'max-requests');
if (values.mode === 'smoke' && values.split !== 'development' && !values.references) throw new Error('Smoke fixtures are development-only');
if (values.references && values.mode !== 'smoke') throw new Error('--references only applies to smoke');
if (!values.out) throw new Error('--out must be a new directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: false });
process.env.JARVIS_WORKFLOW_DATA_DIR = join(out, 'runtime');

const { fingerprint } = await import('../src/actions/tools/composition-provenance');
const { fingerprintSource } = await import('../src/workflows/evaluation/source');
const { sanitizedEnv } = await import('../src/util/subprocess-env');
const { loadTasks, loadReserve, evaluateTask } = await import('../src/workflows/evaluation/runner');
const { environmentFor, extendsEnvironment } = await import('../src/workflows/evaluation/environment');
const { reviewPacket, unblindReviews } = await import('../src/workflows/evaluation/review-packet');
const { report, applyReviews } = await import('../src/workflows/evaluation/report');
const { validateProfile, resolveAdminEvidence, MeasuredHostedProvider, COMPOSITION_ALIAS } = await import('../src/workflows/evaluation/hosted');
const { validateAuthorization, authorizationProblems } = await import('../src/workflows/evaluation/authorization');
const { loadRubric, rubricProblems } = await import('../src/workflows/evaluation/rubric');
const { baselineReport } = await import('../src/workflows/evaluation/baseline');
const { loadPromotionRule, promotionReport } = await import('../src/workflows/evaluation/promotion');
const startedAt = new Date();
const profile = values.profile ? validateProfile(JSON.parse(readFileSync(values.profile, 'utf8'))) : undefined;
const evidence = profile?.admin ? resolveAdminEvidence(profile) : null;
const authorization = values.authorization ? validateAuthorization(JSON.parse(readFileSync(values.authorization, 'utf8'))) : null;
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
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const readRows = (path: string): EvaluationRow[] => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

if (values.mode === 'review-packet') {
  if (!values.results) throw new Error('Review packet needs --results');
  const run = dirname(resolve(values.results));
  const tasks = existsSync(join(run, 'taskset.json')) ? readJson(join(run, 'taskset.json')).tasks : [];
  const blinded = reviewPacket(readRows(values.results), tasks);
  write('packet.json', blinded.packet); write('key.json', blinded.key); write('review-template.json', blinded.template);
  console.log('Blinded review packet: ' + out + ' (give reviewers packet.json and review-template.json; keep key.json apart)');
  process.exit(0);
}
if (values.mode === 'review') {
  if (!values.results || !values.reviews) throw new Error('Review needs --results and --reviews');
  const rows = readRows(values.results);
  const reviews = values.key ? unblindReviews(readJson(values.reviews), readJson(values.key)) : readJson(values.reviews);
  const reviewed = applyReviews(rows, reviews);
  // Carry the run's own manifest and task set, so reviewed results remain a complete, comparable run.
  const run = dirname(resolve(values.results));
  const known = ['manifest.json', 'taskset.json', 'report.json'].every(name => existsSync(join(run, name)));
  write('reviewed-rows.json', reviewed);
  if (known) {
    const manifest = readJson(join(run, 'manifest.json')), taskset = readJson(join(run, 'taskset.json'));
    write('manifest.json', manifest); write('taskset.json', taskset);
    write('report.json', { ...readJson(join(run, 'report.json')), reviewedAt: new Date().toISOString(),
      results: report(reviewed, { tasks: taskset.tasks, scheduled: manifest.scheduled,
        run: { kind: manifest.mode === 'smoke' ? 'harness-smoke' : 'hosted', split: manifest.taskset.split, profileId: manifest.profile?.id ?? null } }) });
  } else write('report.json', report(reviewed));
  console.log('Review report: ' + out);
  process.exit(0);
}
const loadRuns = (list: string) => list.split(',').filter(Boolean).map(directory => {
  const at = resolve(directory);
  return { source: directory, manifest: readJson(join(at, 'manifest.json')), report: readJson(join(at, 'report.json')),
    taskset: readJson(join(at, 'taskset.json')),
    rows: existsSync(join(at, 'reviewed-rows.json')) ? readJson(join(at, 'reviewed-rows.json'))
      : existsSync(join(at, 'rows.jsonl')) ? readRows(join(at, 'rows.jsonl')) : [] };
});
if (values.mode === 'compare') {
  if (!values.runs) throw new Error('Compare needs --runs');
  const promotion = promotionReport(loadRuns(values.runs), loadPromotionRule(values.rule ? resolve(values.rule) : undefined).rule);
  write('promotion-report.json', promotion);
  console.log('Promotion comparison ' + promotion.status + ('verdict' in promotion ? ' (' + promotion.verdict + ')' : '') + ': ' + out);
  process.exit(promotion.status === 'completed' ? 0 : promotion.status === 'refused' ? 1 : 2);
}
if (values.mode === 'baseline') {
  if (!values.runs) throw new Error('Baseline needs --runs');
  const baseline = baselineReport(loadRuns(values.runs));
  write('baseline-report.json', baseline);
  console.log('Baseline ' + baseline.status + ': ' + out);
  process.exit(baseline.status === 'completed' ? 0 : baseline.status === 'refused' ? 1 : 2);
}
const rubric = loadRubric(values.rubric ? resolve(values.rubric) : undefined);
const taskset = values.taskset === 'founder-reserve' ? loadReserve(resolve(values.reserve!))
  : loadTasks(values.split as 'development' | 'heldout', values.taskset);
const declared = environmentFor(taskset.environment);
const environment = values.environment ? environmentFor(values.environment) : declared;
if (!extendsEnvironment(environment, declared)) throw new Error('--environment ' + environment.id + ' does not contain ' + declared.id + ', the environment this task set was written for');
// Both policies run each task and repeat back to back, so drift over the run and a budget stop affect them evenly.
const scheduled = Array.from({ length: repeats }, (_, index) =>
  taskset.tasks.filter(task => values.condition !== 'malformed-first' || !task.expectation.blocked)
    .flatMap(task => policies.map(policy => ({ taskId: task.id, policy, repeat: index + 1, condition: values.condition! })))).flat();
// Pinned at the start, so a comparison can only be judged by the rule the run began under.
const promotionRule = loadPromotionRule(values.rule ? resolve(values.rule) : undefined);
// A hosted run spends money and claims to measure a deployed profile, so it
// starts only when the spend is authorized and, for the held-out set, the
// profile is evidenced and the rubric was frozen first. Otherwise: not_run.
const reasons: string[] = [];
if (values.mode === 'hosted') {
  if (!profile) reasons.push('Hosted profile is missing (--profile).');
  else if (!key) reasons.push('The credential named by ' + profile.apiKeyEnv + ' is not set.');
  if (!authorization) reasons.push('Spend authorization is missing (--authorization).');
  else if (profile) reasons.push(...authorizationProblems(authorization, { profileId: profile.id, split: values.split!, now: startedAt }));
  if (values.split === 'heldout') {
    if (profile && !evidence) reasons.push('A held-out run needs admin evidence for the plan profile (profile.admin).');
    reasons.push(...rubricProblems(rubric.rubric, startedAt));
  }
}
if (authorization && requestedMaxRequests !== undefined && requestedMaxRequests > authorization.maxRequests)
  throw new Error('--max-requests exceeds the authorized request limit');
const maxRequests = values.mode === 'hosted' ? requestedMaxRequests ?? authorization?.maxRequests ?? null : null;
const maxTokens = values.mode === 'hosted' ? authorization?.maxTokens ?? null : null;
const root = resolve(import.meta.dir, '..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: sanitizedEnv(), encoding: 'utf8' }).trim();
const source = fingerprintSource(root, [
  'src/actions/tools', 'src/workflows', 'src/llm', 'scripts/evaluate-workflow-quality.ts', 'package.json', 'bun.lock', 'bun.lockb',
]);
const manifest = {
  schemaVersion: 1, startedAt: startedAt.toISOString(), mode: values.mode, argv: process.argv.slice(2), bunVersion: Bun.version,
  head, ...source,
  taskset: { name: taskset.name, version: taskset.version, sha256: taskset.sha256, split: values.split, environment: taskset.environment },
  environment: environment.id,
  rubric: { id: rubric.rubric.id, sha256: rubric.sha256, status: rubric.rubric.status, value: rubric.rubric },
  promotionRule: { id: promotionRule.rule.id, sha256: promotionRule.sha256, status: promotionRule.rule.status, value: promotionRule.rule },
  profile: profile ?? null, profileEvidence: evidence, authorization,
  requestedAlias: values.mode === 'smoke' ? 'controlled-fixture' : COMPOSITION_ALIAS, maxRequests, maxTokens, scheduled,
  limitations: ['Synthetic tasks and simulated effects only; no live integration certification.',
    'Schedule encoding and event subscriptions are inspected, not clock/event-bus delivery.',
    'Ask responses are simulated; this tests wiring, not summarization quality.',
    'Automatic checks do not establish human intent correctness; review is initially unmeasured.',
    'Opaque aliases do not verify the intended backend model. Unknown usage or prices mean unknown cost.',
    'Hosted requests are pinned to the profile alias; a fallback to another alias is refused and recorded, never measured.'],
};
write('manifest.json', manifest);
write('taskset.json', taskset);
const context = { tasks: taskset.tasks, scheduled,
  run: { kind: (values.mode === 'smoke' ? 'harness-smoke' : 'hosted') as EvaluationRow['kind'], split: values.split as 'development' | 'heldout', profileId: profile?.id ?? null } };
if (values.mode === 'plan' || reasons.length) {
  const why = values.mode === 'plan' ? ['Plan only; no model calls requested.'] : reasons;
  write('report.json', { status: 'not_run', scheduled: scheduled.length, completed: 0, results: report([], context),
    reason: why.join(' '), reasons: why, liveModelQuality: 'unmeasured', supervision: 'unmeasured' });
  console.log('Evaluation not run' + (values.mode === 'plan' ? '' : ': ' + why.join(' ')) + ' Manifest: ' + out);
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
  const provider = values.mode === 'smoke' ? new SmokeProvider(values.references ? readJson(values.references).answers : {}) : new MeasuredHostedProvider(profile!.baseUrl, key!, maxRequests!,
    event => append('events.jsonl', event), { maxTokens: maxTokens!, pinnedModel: COMPOSITION_ALIAS });
  manager.registerProvider(provider);
  manager.setTierAssignment('high', { provider: provider.name, model: values.mode === 'smoke' ? 'controlled-fixture' : COMPOSITION_ALIAS });
  const rows: EvaluationRow[] = [];
  let engine: Awaited<ReturnType<typeof createEvaluationEngine>> | undefined;
  let failure: string | null = null;
  try {
    engine = await createEvaluationEngine(environment);
    write('catalog.json', { entries: engine.catalog.list(), sha256: fingerprint(engine.catalog.list()),
      bundleHash: engine.bundleHash, readinessValidator: engine.readiness });
    for (const item of scheduled) {
      if (provider instanceof MeasuredHostedProvider && (provider.attempts.length >= provider.maxRequests || provider.stops.length)) {
        failure = provider.stops.some(s => s.reason === 'routing_fallback')
          ? 'The profile alias failed over to another alias; remaining tasks were not run'
          : 'Spend limit reached; remaining tasks were not run';
        break;
      }
      if (provider instanceof SmokeProvider) provider.taskId = item.taskId;
      const task = taskset.tasks.find(t => t.id === item.taskId)!;
      const row = await evaluateTask(task, { manager, engine, kind: values.mode === 'smoke' ? 'harness-smoke' : 'hosted',
        policy: item.policy, condition: values.condition as EvaluationRow['condition'], repeat: item.repeat,
        profile, transport: provider instanceof MeasuredHostedProvider ? provider.attempts : undefined,
        stops: provider instanceof MeasuredHostedProvider ? provider.stops : undefined,
        profileIdentity: profile ? { id: profile.id, revisionSha256: evidence?.revisionSha256 ?? null } : null,
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
      results: report(rows, context), modelRouting: provider instanceof MeasuredHostedProvider ? provider.attempts.map(a => ({
        request: a.index, requested: a.requestedModel, reported: a.reportedModel,
        intendedModelVerified: a.reportedModel && !a.reportedModel.startsWith('uj-') ? a.reportedModel === profile!.intendedModel : null,
      })) : [], refusedRequests: provider instanceof MeasuredHostedProvider ? provider.stops : [] });
    write('review-template.json', rows.map(row => ({ rowId: row.id, rowSha256: fingerprint(row), reviewer: '',
      intentCorrect: null, elapsedMs: null, edits: null, notes: '' })));
    if (failure || rows.some(r => !r.intentChecksPassed)) process.exitCode = 1;
  }
  console.log('Raw results and report: ' + out);
}
