import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprint } from '../../actions/tools/composition-provenance';
import { LLMManager } from '../../llm/manager';
import { authorizationProblems, validateAuthorization } from './authorization';
import { baselineReport, verdicts, type BaselineRun } from './baseline';
import { COMPOSITION_ALIAS, MeasuredHostedProvider, resolveAdminEvidence, validateProfile, type HostedProfile } from './hosted';
import { disposition, measure, unexpectedEffects } from './measures';
import { loadRubric, rubricProblems, validateRubric, type ReleaseRubric } from './rubric';
import { loadTasks } from './runner';
import { rate } from './statistics';
import type { EvaluationRow, QualityTask } from './types';

const root = resolve(import.meta.dir, '../../..');
const models = [
  { id: 'm-high', upstreamId: 'u-1', key: 'terra-deploy', upstreamModel: 'terra-test', modality: 'chat', active: true,
    reasoningEffort: 'high', pricing: { inPerMtok: 1, outPerMtok: 2 }, updatedAt: '2026-10-01T00:00:00.000Z' },
  { id: 'm-mid', upstreamId: 'u-1', key: 'luna-deploy', upstreamModel: 'luna-test', modality: 'chat', active: true,
    reasoningEffort: null, pricing: { inPerMtok: 0.5, outPerMtok: 1 }, updatedAt: '2026-10-01T00:00:00.000Z' },
];
const profiles = [
  { id: 'p-base', key: 'base', name: 'Base', rank: 1, active: true, slots: { chat: 'm-mid', medium: 'm-mid', high: 'm-high' } },
  { id: 'p-plus', key: 'plus', name: 'Plus', rank: 2, active: true, slots: { chat: 'm-mid', high: 'm-high' } },
];
const hosted: HostedProfile = { id: 'starter', version: '2026-10-05', intendedModel: 'terra-test', baseUrl: 'https://example.invalid',
  apiKeyEnv: 'EVAL_TEST_KEY', routingEvidence: 'Synthetic admin export',
  admin: { exportedAt: '2026-10-05T12:00:00.000Z', exportedBy: 'Fixture admin', plan: { key: 'starter', name: 'Starter' },
    profileKey: 'base', proxyFallbacks: [], profiles: structuredClone(profiles), models: structuredClone(models) } };
const withAdmin = (edit: (admin: any) => void): HostedProfile => { const p = structuredClone(hosted); edit(p.admin); return p; };

test('admin evidence resolves the plan profile and fingerprints only what that profile serves', () => {
  const resolved = resolveAdminEvidence(hosted);
  expect(resolved).toMatchObject({ planKey: 'starter', profileKey: 'base', slot: 'high', modelKey: 'terra-deploy',
    upstreamModel: 'terra-test', reasoningEffort: 'high', proxyFallbacks: [] });
  const same = withAdmin(a => { a.models.reverse(); a.profiles.reverse(); a.profiles[1].slots = { high: 'm-high', medium: 'm-mid', chat: 'm-mid' }; });
  expect(resolveAdminEvidence(same).revisionSha256).toBe(resolved.revisionSha256);
  expect(resolveAdminEvidence(withAdmin(a => { a.profiles[1].slots.high = 'm-mid'; })).revisionSha256).toBe(resolved.revisionSha256);
  for (const changed of [withAdmin(a => { a.models[0].reasoningEffort = 'medium'; }), withAdmin(a => { a.profiles[0].slots.medium = 'm-high'; }),
    withAdmin(a => { a.proxyFallbacks = ['luna-deploy']; }), withAdmin(a => { a.models[0].pricing.outPerMtok = 3; })])
    expect(resolveAdminEvidence(changed).revisionSha256).not.toBe(resolved.revisionSha256);
});

test('admin evidence refuses a declared model the export does not serve, unstated fallbacks and ambiguous profiles', () => {
  expect(() => validateProfile({ ...hosted, intendedModel: 'luna-test' })).toThrow('is not the high slot model');
  for (const bad of [withAdmin(a => { delete a.proxyFallbacks; }), withAdmin(a => { a.profiles[0].active = false; }),
    withAdmin(a => { a.profiles.push({ ...a.profiles[0] }); }), withAdmin(a => { a.profiles[0].slots.high = 'm-missing'; }),
    withAdmin(a => { a.models[0].modality = 'stt'; }), withAdmin(a => { a.exportedBy = ' '; })])
    expect(() => resolveAdminEvidence(bad)).toThrow();
  expect(validateProfile(hosted)).toEqual(hosted);
});

async function withFetch<T>(handler: (body: any) => Response, run: (calls: any[]) => Promise<T>): Promise<T> {
  const saved = globalThis.fetch, calls: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push(body);
    return handler(body);
  }) as unknown as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = saved; }
}
const ok = (tokens = { prompt_tokens: 120, completion_tokens: 10 }) => Response.json({ model: COMPOSITION_ALIAS,
  choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: tokens });

test('a pinned alias refuses any other alias, including the provider default a manager failover would send', async () => {
  await withFetch(() => ok(), async calls => {
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 10, undefined, { pinnedModel: COMPOSITION_ALIAS });
    await provider.chat([{ role: 'user', content: 'compose' }], { model: COMPOSITION_ALIAS });
    // LLMManager's second tier candidate omits the model, so the provider default (uj-medium) would be sent.
    await expect(provider.chat([{ role: 'user', content: 'compose' }])).rejects.toThrow('different alias');
    await expect(provider.chat([{ role: 'user', content: 'compose' }], { model: 'uj-low' })).rejects.toThrow('different alias');
    expect(calls.map(c => c.model)).toEqual([COMPOSITION_ALIAS]);
    expect(provider.stops).toEqual([{ reason: 'routing_fallback', afterAttempts: 1, requestedModel: 'uj-medium' },
      { reason: 'routing_fallback', afterAttempts: 1, requestedModel: 'uj-low' }]);
  });
  // The refusal ends the call: a manager does not try yet another candidate after it.
  await withFetch(() => ok(), async calls => {
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 10, undefined, { pinnedModel: 'uj-other' });
    const manager = new LLMManager();
    manager.registerProvider(provider);
    manager.setTierAssignment('high', { provider: provider.name, model: COMPOSITION_ALIAS });
    await expect(manager.chatTier('high', 'evaluation', [{ role: 'user', content: 'compose' }])).rejects.toThrow('different alias');
    expect(calls).toHaveLength(0);
    expect(provider.stops.map(s => s.requestedModel)).toEqual([COMPOSITION_ALIAS]);
  });
});

test('token budget stops before the next request, and unreported usage stops the run', async () => {
  await withFetch(() => ok(), async calls => {
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 10, undefined, { maxTokens: 200 });
    await provider.chat([{ role: 'user', content: 'one' }], { model: COMPOSITION_ALIAS });
    await provider.chat([{ role: 'user', content: 'two' }], { model: COMPOSITION_ALIAS });
    await expect(provider.chat([{ role: 'user', content: 'three' }], { model: COMPOSITION_ALIAS })).rejects.toThrow('token budget');
    expect(calls).toHaveLength(2);
    expect(provider.stops.map(s => s.reason)).toEqual(['token_budget']);
  });
  await withFetch(() => Response.json({ model: COMPOSITION_ALIAS, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), async calls => {
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 10, undefined, { maxTokens: 1_000_000 });
    await provider.chat([{ role: 'user', content: 'one' }], { model: COMPOSITION_ALIAS }).catch(() => {});
    await expect(provider.chat([{ role: 'user', content: 'two' }], { model: COMPOSITION_ALIAS })).rejects.toThrow('spend can no longer be counted');
    expect(calls).toHaveLength(1);
  });
});

test('spend authorization is explicit, scoped to one profile and split, and dated', () => {
  const auth = validateAuthorization({ schemaVersion: 1, approvedBy: 'Owner', approvedAt: '2026-10-05', validUntil: '2026-10-12',
    profileId: 'starter', splits: ['heldout'], maxRequests: 400, maxTokens: 2_000_000 });
  const now = new Date('2026-10-06T10:00:00Z');
  expect(authorizationProblems(auth, { profileId: 'starter', split: 'heldout', now })).toEqual([]);
  expect(authorizationProblems(auth, { profileId: 'starter', split: 'heldout', now: new Date('2026-10-12T23:00:00Z') })).toEqual([]);
  expect(authorizationProblems(auth, { profileId: 'plus', split: 'development', now: new Date('2026-10-13T00:00:01Z') })).toHaveLength(3);
  expect(authorizationProblems(auth, { profileId: 'starter', split: 'heldout', now: new Date('2026-10-04T00:00:00Z') })).toHaveLength(1);
  for (const bad of [{ ...auth, approvedBy: '' }, { ...auth, splits: [] }, { ...auth, maxRequests: 0 }, { ...auth, maxTokens: 1.5 },
    { ...auth, validUntil: 'soon' }, { ...auth, schemaVersion: 2 }])
    expect(() => validateAuthorization(bad)).toThrow();
});

test('the shipped rubric carries the proposed roadmap thresholds and cannot gate a holdout until frozen', () => {
  const { rubric, sha256 } = loadRubric();
  expect(rubric).toMatchObject({ id: 'workflow-release-v1', status: 'proposed', frozen: null,
    sample: { minSupportedTasks: 40, minNegativeTasks: 20 }, intent: { measure: 'human-reviewed', minFirstCandidateCorrect: 0.9, minCorrectAfterRepair: 0.95 },
    safety: { maxUnexpectedEffects: 0, maxMissedAbstentions: 0 }, humanEffort: { maxMedianEdits: 1, maxMedianCorrectionMs: 120_000 } });
  expect(sha256).toBe(fingerprint(rubric));
  expect(fingerprint({ ...rubric, intent: { ...rubric.intent, minCorrectAfterRepair: 0.9 } })).not.toBe(sha256);
  const start = new Date('2026-10-10T00:00:00Z');
  expect(rubricProblems(rubric, start)[0]).toContain('not frozen');
  const budgets = { '*': { maxRequestsPerTask: 12, maxTokensPerTask: 200_000, maxP95CompositionMs: 120_000 } };
  const frozen = validateRubric({ ...rubric, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] }, budgets });
  expect(rubricProblems(frozen, start)).toEqual([]);
  expect(rubricProblems({ ...frozen, frozen: { ...frozen.frozen!, at: '2026-10-11' } }, start)).toHaveLength(1);
  for (const bad of [{ ...frozen, frozen: null }, { ...frozen, frozen: { at: '2026-10-08', approvedBy: [] } }, { ...frozen, budgets: rubric.budgets },
    { ...rubric, frozen: frozen.frozen }, { ...rubric, intent: { ...rubric.intent, minCorrectAfterRepair: 1.2 } }])
    expect(() => validateRubric(bad)).toThrow();
});

const tasks = loadTasks('heldout').tasks;
const supportedTask = tasks.find(t => !t.expectation.blocked)!, negativeTask = tasks.find(t => t.expectation.blocked)!;
const receiptsFor = (task: QualityTask, scenario = task.scenarios[0]!) => scenario.notifications.map(n => ({
  kind: 'notification' as const, input: { message: n.message, channels: n.channels }, runId: 'r', stepName: 'notify' }));
function row(task: QualityTask, over: Partial<EvaluationRow> = {}): EvaluationRow {
  return {
    schemaVersion: 1, id: randomUUID(), taskId: task.id, split: 'heldout', repeat: 1, kind: 'hosted', policy: 'baseline-v1', condition: 'natural',
    specification: task.specification, provenance: { schemaVersion: 1, promptVersion: 'w8-2', planningPolicy: 'baseline-v1', catalogSha256: 'c', environmentSha256: 'e' },
    calls: [], transport: [], candidates: [{ previousResponse: 'r', previousGraph: {}, errors: [] }],
    result: task.expectation.blocked ? { ok: false, blocked: true, errors: ['Not installed'], rawResponse: null }
      : { ok: true, flow: { displayName: task.id, trigger: { type: 'EMPTY' } } as any, rawResponse: 'r' },
    compositionMs: 1000, staticChecks: [{ name: 'checks', pass: true }], aiSteps: 0,
    scenarios: task.expectation.blocked ? [] : task.scenarios.map(s => ({ id: s.id, runId: 'r', status: 'SUCCEEDED',
      receipts: receiptsFor(task, s), checks: [{ name: 'effects', pass: true }], elapsedMs: 5 })),
    intentChecksPassed: true, humanIntentCorrect: null, supervision: null, estimatedCostUsd: null, costComplete: false,
    profile: { id: 'starter', revisionSha256: 'rev' }, interruptions: [], promptSha256s: ['prompt'], ...over,
  };
}

test('unrun, refused and timed-out work stays in the denominator with its own disposition', () => {
  const passed = row(supportedTask), repaired = row(supportedTask, { repeat: 2, candidates: [
    { previousResponse: 'bad', previousGraph: null, errors: ['invalid'] }, { previousResponse: 'good', previousGraph: {}, errors: [] }] });
  const refused = row(supportedTask, { repeat: 3, interruptions: [{ reason: 'routing_fallback', afterAttempts: 1, requestedModel: 'uj-medium' }] });
  const timeout = row(supportedTask, { repeat: 4, intentChecksPassed: false, scenarios: [],
    result: { ok: false, errorCode: 'composition_timeout', errors: ['deadline'], rawResponse: null } });
  const missed = row(negativeTask, { intentChecksPassed: false, result: { ok: true, flow: {} as any, rawResponse: 'r' } });
  const m = measure([passed, repaired, refused, timeout, missed], tasks, [{ taskId: supportedTask.id, policy: 'baseline-v1', repeat: 5, condition: 'natural' }]);
  expect([passed, refused, timeout, missed].map(r => disposition(r, tasks.find(t => t.id === r.taskId)!)))
    .toEqual(['passed', 'routing_fallback', 'composition_timeout', 'missed_abstention']);
  expect(m.dispositions).toMatchObject({ passed: 2, not_run: 1, routing_fallback: 1, composition_timeout: 1, missed_abstention: 1 });
  // Five supported repeats were scheduled: the two clean passes count; the refused one passed its checks and still does not.
  expect(m.rows.automatic.afterRepair).toMatchObject({ successes: 2, n: 5 });
  expect(m.rows.automatic.firstCandidate).toMatchObject({ successes: 1, n: 5 });
  expect(m.rows.validGraph).toMatchObject({ successes: 2, n: 5 });
  expect(m.rows.abstention).toMatchObject({ missed: 1, correct: { successes: 0, n: 1 } });
  // With repeats, a task is correct only if every scheduled repeat is.
  expect(m.tasks.automatic.afterRepair).toMatchObject({ successes: 0, n: 1 });
  expect(m.rows.human).toMatchObject({ unreviewedSupported: 4, afterRepair: { successes: 0, n: 5 } });
});

test('unexpected effects count extra, duplicate and misdirected notifications, not missing ones', () => {
  const scenario = supportedTask.scenarios[0]!, expected = receiptsFor(supportedTask);
  expect(unexpectedEffects(scenario, expected)).toBe(0);
  expect(unexpectedEffects(scenario, [])).toBe(0);
  expect(unexpectedEffects(scenario, [...expected, ...expected])).toBe(expected.length);
  expect(unexpectedEffects(scenario, expected.map(r => ({ ...r, input: { ...r.input, channels: ['email'] } })))).toBe(expected.length);
  expect(unexpectedEffects(scenario, [...expected, { kind: 'ai', input: {}, runId: 'r', stepName: 'ask' }])).toBe(1);
});

const proposed = loadRubric().rubric;
const frozenRubric: ReleaseRubric = validateRubric({ ...proposed, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] },
  sample: { ...proposed.sample, minSupportedTasks: 1, minNegativeTasks: 1 },
  budgets: { '*': { maxRequestsPerTask: 5, maxTokensPerTask: 10_000, maxP95CompositionMs: 60_000 } } });
const reviewed = (r: EvaluationRow, correct = true) => ({ ...r, humanIntentCorrect: correct, supervision: { reviewer: 'R', elapsedMs: 60_000, edits: 1, notes: 'NOTE-SENTINEL' } });
const withUsage = (r: EvaluationRow) => ({ ...r, transport: [{ index: 1, status: 200, elapsedMs: 1, requestedModel: COMPOSITION_ALIAS,
  reportedModel: COMPOSITION_ALIAS, usage: { input: 900, cachedInput: 0, output: 100 } }] });

test('verdicts name pending review, missing budgets, unknown usage and small samples instead of passing them', () => {
  const good = measure([withUsage(reviewed(row(supportedTask))), withUsage(reviewed(row(negativeTask)))], tasks, []);
  expect(verdicts(good, frozenRubric, frozenRubric.budgets['*']!).overall).toBe('meets_rubric');
  const pending = measure([withUsage(row(supportedTask)), withUsage(reviewed(row(negativeTask)))], tasks, []);
  expect(verdicts(pending, frozenRubric, frozenRubric.budgets['*']!)).toMatchObject({ correctAfterRepair: 'incomplete_review', overall: 'not_established' });
  expect(verdicts(good, frozenRubric, null)).toMatchObject({ requestsPerTask: 'not_agreed', overall: 'not_established' });
  const unknown = measure([reviewed(row(supportedTask)), reviewed(row(negativeTask))], tasks, []);
  expect(verdicts(unknown, frozenRubric, frozenRubric.budgets['*']!).tokensPerTask).toBe('unknown_usage');
  const small = { ...frozenRubric, sample: { ...frozenRubric.sample, minSupportedTasks: 40, minNegativeTasks: 20 } };
  expect(verdicts(good, small, small.budgets['*']!).correctAfterRepair).toBe('insufficient_sample');
  // A small sample can still show a clear failure: 0 of 3 tasks has an upper bound far below 95%.
  const failing = measure(tasks.filter(t => !t.expectation.blocked).slice(0, 3).map(t => reviewed(row(t), false)), tasks, []);
  expect(verdicts(failing, small, small.budgets['*']!)).toMatchObject({ correctAfterRepair: 'not_met', overall: 'does_not_meet' });
});

function run(over: { manifest?: any; rows?: EvaluationRow[]; report?: any } = {}): BaselineRun {
  const taskset = loadTasks('heldout');
  const rows = over.rows ?? [withUsage(reviewed(row(supportedTask, { specification: { ...supportedTask.specification, description: 'SPEC-SENTINEL' },
    calls: [{ path: 'text', request: { prompt: 'PROMPT-SENTINEL', system: 'SYSTEM-SENTINEL' }, elapsedMs: 1, requestSha256: 'x' }],
    error: undefined, result: { ok: true, flow: { displayName: 'GRAPH-SENTINEL', trigger: { type: 'EMPTY' } } as any, rawResponse: 'RAW-SENTINEL' } })))];
  return { source: '/home/someone/run', taskset, rows,
    report: over.report ?? { status: 'completed', finishedAt: '2026-10-09T10:00:00Z', failure: null },
    manifest: { mode: 'hosted', startedAt: '2026-10-09T09:00:00Z', head: 'abc', sourceSha256: 'src',
      taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout' },
      rubric: { id: frozenRubric.id, sha256: fingerprint(frozenRubric), status: 'frozen', value: frozenRubric },
      profile: { ...hosted, baseUrl: 'https://URL-SENTINEL.invalid', routingEvidence: 'ROUTING-SENTINEL' },
      profileEvidence: resolveAdminEvidence(hosted),
      authorization: { schemaVersion: 1, approvedBy: 'Owner', approvedAt: '2026-10-08', validUntil: '2026-10-12', profileId: 'starter',
        splits: ['heldout'], maxRequests: 10, maxTokens: 50_000, note: 'NOTE-SENTINEL' },
      maxRequests: 10, maxTokens: 50_000,
      scheduled: rows.map(r => ({ taskId: r.taskId, policy: r.policy, repeat: r.repeat, condition: r.condition })),
      ...over.manifest } };
}

test('a baseline is sanitized and keeps identities, limits and verdicts', () => {
  const baseline = baselineReport([run()], new Date('2026-10-09T11:00:00Z')) as any;
  expect(baseline.status).toBe('completed');
  expect(baseline.runs[0].profile).toMatchObject({ id: 'starter', upstreamModel: 'terra-test', revisionSha256: resolveAdminEvidence(hosted).revisionSha256 });
  expect(baseline.runs[0].authorization).toEqual({ approvedBy: 'Owner', approvedAt: '2026-10-08', validUntil: '2026-10-12', maxRequests: 10, maxTokens: 50_000 });
  expect(baseline.groups['starter/baseline-v1/natural'].verdicts.sample).toBe('insufficient_sample');
  const text = JSON.stringify(baseline);
  for (const sentinel of ['SPEC-SENTINEL', 'PROMPT-SENTINEL', 'SYSTEM-SENTINEL', 'GRAPH-SENTINEL', 'RAW-SENTINEL', 'NOTE-SENTINEL',
    'URL-SENTINEL', 'ROUTING-SENTINEL', '/home/someone', 'inPerMtok']) expect(text).not.toContain(sentinel);
});

test('synthetic, development, unpinned and mismatched runs are refused; an unrun hosted holdout is not_run', () => {
  const refused = (r: BaselineRun[]) => (baselineReport(r) as any);
  expect(refused([run({ manifest: { mode: 'smoke' } })]).problems[0]).toContain('only hosted runs form a baseline');
  expect(refused([run({ manifest: { taskset: { ...run().manifest.taskset, split: 'development' } } })]).status).toBe('refused');
  expect(refused([run({ rows: [row(supportedTask, { kind: 'harness-smoke' })] })]).status).toBe('refused');
  for (const missing of [{ profileEvidence: null }, { authorization: null }, { rubric: { ...run().manifest.rubric, sha256: 'edited' } },
    { rubric: { id: proposed.id, sha256: fingerprint(proposed), status: 'proposed', value: proposed } }])
    expect(refused([run({ manifest: missing })]).status).toBe('refused');
  const other = validateRubric({ ...frozenRubric, id: 'workflow-release-v2' });
  expect(refused([run(), run({ manifest: { profile: { ...hosted, id: 'plus' }, rubric: { id: other.id, sha256: fingerprint(other), status: 'frozen', value: other } } })])
    .problems).toContain('Runs use different rubrics; compare only matched inputs.');
  expect(refused([run(), run()]).problems).toContain('More than one run measures the same profile.');
  const unrun = refused([run({ rows: [], report: { status: 'not_run', reasons: ['Spend authorization is missing (--authorization).'] } })]);
  expect(unrun).toMatchObject({ status: 'not_run', notRun: [{ profileId: 'starter', reasons: ['Spend authorization is missing (--authorization).'] }] });
});

async function cli(args: string[], env: Record<string, string>, preload?: string) {
  const child = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), join(root, 'scripts/evaluate-workflow-quality.ts'), ...args],
    { cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI: a held-out hosted run without a frozen rubric and admin evidence is not_run and sends nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-baseline-gate-'));
  try {
    const sentinel = join(directory, 'fetched'), preload = join(directory, 'fetch.ts');
    writeFileSync(preload, `globalThis.fetch = async () => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); throw new Error('no network'); };\n`);
    const plain = { ...hosted }; delete plain.admin;
    writeFileSync(join(directory, 'profile.json'), JSON.stringify(plain));
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ schemaVersion: 1, approvedBy: 'Owner', approvedAt: '2026-01-01',
      validUntil: '2999-12-31', profileId: 'starter', splits: ['heldout'], maxRequests: 5, maxTokens: 1000 }));
    const env = { EVAL_TEST_KEY: 'synthetic-key' };
    const gated = await cli(['--mode', 'hosted', '--profile', join(directory, 'profile.json'), '--authorization', join(directory, 'auth.json'),
      '--out', join(directory, 'run')], env, preload);
    expect(gated.code).toBe(2);
    const runReport = JSON.parse(readFileSync(join(directory, 'run/report.json'), 'utf8'));
    expect(runReport.status).toBe('not_run');
    expect(runReport.reasons.join(' ')).toContain('admin evidence');
    expect(runReport.reasons.join(' ')).toContain('not frozen');
    const manifest = JSON.parse(readFileSync(join(directory, 'run/manifest.json'), 'utf8'));
    expect(manifest.rubric.sha256).toBe(loadRubric().sha256);
    expect(manifest.argv).toContain('--authorization');
    expect(Object.values(runReport.results).every((g: any) => g.measures.notRun === g.measures.scheduled)).toBe(true);
    const unauthorized = await cli(['--mode', 'hosted', '--split', 'development', '--profile', join(directory, 'profile.json'),
      '--out', join(directory, 'unauthorized')], env, preload);
    expect(unauthorized.code).toBe(2);
    expect(JSON.parse(readFileSync(join(directory, 'unauthorized/report.json'), 'utf8')).reasons).toEqual(['Spend authorization is missing (--authorization).']);
    const overLimit = await cli(['--mode', 'hosted', '--split', 'development', '--profile', join(directory, 'profile.json'),
      '--authorization', join(directory, 'auth.json'), '--max-requests', '6', '--out', join(directory, 'over')], env, preload);
    expect(overLimit.code).toBe(1);
    expect(overLimit.stderr).toContain('exceeds the authorized request limit');
    expect(existsSync(sentinel)).toBe(false);
    const baseline = await cli(['--mode', 'baseline', '--runs', join(directory, 'run'), '--out', join(directory, 'baseline')], {});
    expect(baseline.code).toBe(2);
    expect(JSON.parse(readFileSync(join(directory, 'baseline/baseline-report.json'), 'utf8')).status).toBe('not_run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

test('rates report counts and Wilson intervals, and never invent a rate without a denominator', () => {
  expect(rate(0, 0)).toEqual({ successes: 0, n: 0, rate: null, ci95: null });
  const r = rate(9, 10);
  expect(r.rate).toBe(0.9);
  expect(r.ci95![0]).toBeCloseTo(0.596, 2);
  expect(r.ci95![1]).toBeCloseTo(0.982, 2);
  expect(() => rate(3, 2)).toThrow();
});
