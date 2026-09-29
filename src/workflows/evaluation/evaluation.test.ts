import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { LLMManager } from '../../llm/manager';
import type { LLMMessage, LLMOptions, LLMResponse } from '../../llm/provider';
import { LLMProviderError } from '../../llm/provider';
import { PieceCatalog } from '../runtime/piece-catalog';
import { sampleCatalog } from '../runtime/test-fixtures';
import { fingerprint, planningPrompt, snapshotComposition } from '../../actions/tools/composition-provenance';
import { loadTasks, evaluateTask, summarize } from './runner';
import { checkScenario, inspectGraph, staticChecks } from './checks';
import { report, applyReviews } from './report';
import { estimatedCost, MeasuredHostedProvider, validateProfile } from './hosted';
import { SmokeProvider } from './smoke';
import type { EffectExecutor, EvaluationRow, TransportAttempt } from './types';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
const dev = loadTasks('development').tasks;
const manual = dev[0]!;
const blocked = dev.find(t => t.expectation.blocked)!;
const providerProfile = { id: 'test-plan', version: '1', baseUrl: 'https://example.invalid',
  apiKeyEnv: 'EVAL_TEST_KEY', intendedModel: 'terra-test', routingEvidence: 'Synthetic test only',
  rates: { source: 'fixture', asOf: '2026-09-29', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } };
const receipt = { kind: 'notification' as const, input: { message: 'Review pipeline', channels: ['dashboard'] }, runId: 'r', stepName: 'notify' };
const engine: EffectExecutor = { catalog: new PieceCatalog(sampleCatalog().list().map(entry => ({
  ...entry, name: '@jarvispieces/piece-' + entry.name,
}))), bundleHash: 'test',
  async execute(_graph, scenarios) { return scenarios.map(s => ({ id: s.id, runId: 'r', status: 'SUCCEEDED',
    receipts: [receipt], elapsedMs: 1, checks: checkScenario(s, 'SUCCEEDED', [receipt]) })); } };
function manager(provider = new SmokeProvider()) {
  const m = new LLMManager(); m.registerProvider(provider); m.setTierAssignment('high', { provider: provider.name, model: 'controlled-fixture' }); return m;
}
async function row() {
  // Only evaluator accounting is under test here. Real engine coverage is the CLI smoke suite.
  return evaluateTask(manual, { manager: manager(), engine, kind: 'harness-smoke', policy: 'baseline-v1' });
}

test('canonical fingerprints change with contracts, not object key order', () => {
  expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  const catalog = sampleCatalog();
  const snapshot = snapshotComposition({ pieceRegistry: catalog, llm: { async chat() { return { text: '' }; } } });
  catalog.list()[0]!.description = 'Changed during a model call';
  expect(snapshot.deps.pieceRegistry.list()[0]!.description).not.toBe(catalog.list()[0]!.description);
  expect(snapshot.provenance.catalogSha256).toBe(fingerprint(snapshot.deps.pieceRegistry.list()));
});
test('baseline prompt stays exact, default policy requires deterministic work and preserves constraints', () => {
  expect(planningPrompt('old', 'baseline-v1')).toBe('old');
  expect(planningPrompt('old')).toContain('Do not add an LLM');
  expect(planningPrompt('old')).toContain('negative constraints');
});
test('task splits are frozen, disjoint and include boundaries and abstention', () => {
  const held = loadTasks('heldout');
  expect(new Set([...dev, ...held.tasks].map(t => t.id)).size).toBe(dev.length + held.tasks.length);
  expect(held.tasks).toHaveLength(12);
  expect(held.tasks.some(t => t.scenarios.some(s => s.id === 'boundary'))).toBe(true);
  expect(held.tasks.filter(t => t.expectation.blocked)).toHaveLength(2);
});
test('wrong destination, duplicates, missing delivery and unexpected AI fail effect checks', () => {
  const scenario = manual.scenarios[0]!;
  expect(checkScenario(scenario, 'SUCCEEDED', [receipt]).every(c => c.pass)).toBe(true);
  for (const receipts of [[], [receipt, receipt], [{ ...receipt, input: { ...receipt.input, channels: ['desktop'] } }],
    [receipt, { ...receipt, kind: 'ai' as const }]]) {
    expect(checkScenario(scenario, 'SUCCEEDED', receipts).every(c => c.pass)).toBe(false);
  }
  expect(checkScenario(scenario, 'FAILED', [receipt]).every(c => c.pass)).toBe(false);
  expect(checkScenario(scenario, 'SUCCEEDED', [{ ...receipt, input: { message: 'Review pipeline' } }]).every(c => c.pass)).toBe(false);
});
test('effect envelope rejects code, unknown native effects, credentials, malformed branches and cycles', () => {
  for (const action of [
    { type: 'CODE' }, { type: 'PIECE', settings: { pieceName: '@unknown', actionName: 'send' } },
    { type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-notify', actionName: 'notify', input: { auth: 'secret' } } },
    { type: 'ROUTER', children: {} },
  ]) expect(inspectGraph({ type: 'EMPTY', nextAction: action } as any).issues.length).toBeGreaterThan(0);
  const graph: any = { type: 'EMPTY' }; graph.nextAction = graph;
  expect(inspectGraph(graph).issues.length).toBeGreaterThan(0);
});
test('only an explicit blocker can satisfy abstention, never a provider or validation failure', () => {
  expect(staticChecks(blocked, { ok: false, errors: ['unsupported'], rawResponse: null }, false).checks[0]!.pass).toBe(false);
  expect(staticChecks(blocked, { ok: false, blocked: true, errorCode: 'composition_timeout', errors: [], rawResponse: null }, true).checks[0]!.pass).toBe(false);
  expect(staticChecks(blocked, { ok: false, blocked: true, errors: ['No fax'], rawResponse: null }, true).checks[0]!.pass).toBe(true);
});
test('provider failure stays in the denominator and cannot acquire intent correctness', async () => {
  class Failing extends SmokeProvider { override async chat(): Promise<never> { throw new LLMProviderError('Unauthorized fixture', 'auth'); } }
  const result = await evaluateTask(manual, { manager: manager(new Failing()), engine, kind: 'hosted', policy: 'baseline-v1' });
  expect(result.intentChecksPassed).toBe(false);
  expect(summarize([result])).toMatchObject({ completed: 1, intentChecksPassed: 0,
    humanIntentCorrect: { reviewed: 0, correct: 0 }, cost: { estimatedUsd: null }, supervision: { reviewed: 0 } });
});
test('raw requests omit hidden scenarios, automatic success stays separate from human review', async () => {
  const result = await row();
  expect(result.calls.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.calls[0]!.request)).not.toContain('negativeConstraints');
  expect(JSON.stringify(result.calls[0]!.request)).not.toContain('"notifications"');
  expect(result.humanIntentCorrect).toBeNull();
  expect(result.estimatedCostUsd).toBeNull();
  expect(result.supervision).toBeNull();
});
test('report keeps policy, condition and measurement kinds separate', async () => {
  const a = await row();
  const b: EvaluationRow = { ...a, id: 'b', condition: 'malformed-first' };
  const c: EvaluationRow = { ...a, id: 'c', kind: 'hosted' };
  expect(Object.keys(report([a,b,c]))).toHaveLength(3);
});
test('human reviews are tied to exact raw results and cannot overwrite them', async () => {
  const original = await row();
  const review = { rowId: original.id, rowSha256: fingerprint(original), reviewer: 'Owner', intentCorrect: false, elapsedMs: 45000, edits: 3, notes: 'Needs a different output' };
  const reviewed = applyReviews([original], [review]);
  expect(original.humanIntentCorrect).toBeNull();
  expect(reviewed[0]!.humanIntentCorrect).toBe(false);
  expect(reviewed[0]!.supervision?.edits).toBe(3);
  for (const bad of [[review, review], [{ ...review, rowSha256: 'changed' }], [{ ...review, elapsedMs: -1 }],
    [{ ...review, intentCorrect: null }], [{ ...review, rowId: 'unknown' }]])
    expect(() => applyReviews([original], bad)).toThrow();
});
test('unknown usage, failed requests and opaque routing cannot become zero cost', () => {
  const attempt: TransportAttempt = { index: 1, elapsedMs: 3, status: 200, requestedModel: 'uj-high', reportedModel: 'terra-test',
    usage: { input: 100, cachedInput: 50, output: 10 } };
  expect(estimatedCost([attempt], providerProfile).usd).toBeCloseTo(0.000125);
  expect(estimatedCost([attempt]).usd).toBeNull();
  expect(estimatedCost([{ ...attempt, reportedModel: 'uj-high' }], providerProfile).usd).toBeNull();
  expect(estimatedCost([{ ...attempt, reportedModel: 'uj-high' }], { ...providerProfile, intendedModel: 'uj-high' }).usd).toBeNull();
  expect(estimatedCost([attempt, { ...attempt, usage: null }], providerProfile)).toEqual({ complete: false, usd: null });
  expect(estimatedCost([], providerProfile).usd).toBeNull();
});
test('profile requires explicit routing and credential-free URL', () => {
  expect(validateProfile(providerProfile)).toEqual(providerProfile);
  for (const bad of [{ ...providerProfile, baseUrl: 'https://host/?key=secret' }, { ...providerProfile, routingEvidence: '' },
    { ...providerProfile, rates: { ...providerProfile.rates, outputUsdPerMillion: -1 } }])
    expect(() => validateProfile(bad)).toThrow();
});
test('hosted transport counts actual HTTP calls, captures requested/reported models and enforces cap', async () => {
  const saved = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({ model: 'terra-test', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 120, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } });
  }) as unknown as typeof fetch;
  try {
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 1);
    await provider.chat([{ role: 'user', content: 'hello' }], { model: 'uj-high' });
    expect(provider.attempts[0]).toMatchObject({ requestedModel: 'uj-high', reportedModel: 'terra-test',
      usage: { input: 100, cachedInput: 20, output: 10 }, status: 200 });
    await expect(provider.chat([{ role: 'user', content: 'again' }])).rejects.toThrow('budget exhausted');
    expect(requests).toBe(1);
  } finally { globalThis.fetch = saved; }
});
test('missing usage remains unknown and network error tracing redacts the supplied key', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ model: 'terra-test', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })) as unknown as typeof fetch;
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 2);
    await expect(provider.chat([{ role: 'user', content: 'hello' }])).rejects.toThrow();
    expect(provider.attempts[0]!.usage).toBeNull();
    globalThis.fetch = (async () => { throw new Error('network synthetic-secret'); }) as unknown as typeof fetch;
    await expect(provider.chat([{ role: 'user', content: 'again' }])).rejects.toThrow();
    expect(provider.attempts[1]!.error).not.toContain('synthetic-secret');
  } finally { globalThis.fetch = saved; }
});


test('provider-internal recovery is counted as two HTTP attempts with uncertain total cost', async () => {
  const saved = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => ++count === 1
    ? new Response('max_tokens must exceed thinking.budget_tokens', { status: 400 })
    : Response.json({ model: 'terra-test', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } })) as unknown as typeof fetch;
  try {
    const events: any[] = [];
    const provider = new MeasuredHostedProvider('https://example.invalid', 'synthetic-secret', 2, e => events.push(structuredClone(e)));
    await provider.chat([{ role: 'user', content: 'hello' }], { model: 'uj-high', max_tokens: 100 });
    expect(provider.attempts.map(a => a.status)).toEqual([400, 200]);
    expect(events.map(e => e.type)).toEqual(['transport_started', 'transport_finished', 'transport_started', 'transport_finished']);
    expect(estimatedCost(provider.attempts, providerProfile).usd).toBeNull();
    expect(count).toBe(2);
  } finally { globalThis.fetch = saved; }
});


test('legacy executable registries snapshot metadata without serializing handlers', () => {
  const catalog = sampleCatalog();
  const original = catalog.list()[0]!;
  const a = Object.values(original.actions)[0]! as any;
  a.requireAuth = true;
  a.run = async () => 'side effect'; a.parseInput = (v: unknown) => v;
  const snapshot = snapshotComposition({ pieceRegistry: catalog, llm: { async chat() { return { text: '' }; } } });
  const saved = Object.values(snapshot.deps.pieceRegistry.list()[0]!.actions)[0]! as any;
  expect(saved.name).toBe(a.name);
  expect(saved.requireAuth).toBe(true);
  expect(saved.inputSchema).toEqual(a.inputSchema);
  expect(saved.run).toBeUndefined();
  expect(saved.parseInput).toBeUndefined();
});

class SequenceProvider extends SmokeProvider {
  constructor(private replies: Array<LLMResponse | Error>) { super(); }
  override async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? super.chat(messages, options);
  }
}
const truncated: LLMResponse = { content: '{malformed', tool_calls: [], finish_reason: 'length',
  model: 'controlled-fixture', usage: { input_tokens: 0, output_tokens: 0 } };
const discovery: LLMResponse = { ...truncated, content: '', finish_reason: 'tool_use',
  tool_calls: [{ id: 'discover', name: 'list_pieces', arguments: {} }] };

test('truncation records a failed candidate without counting a repair, including after discovery', async () => {
  for (const replies of [[truncated], [discovery, truncated]]) {
    const result = await evaluateTask(manual, { manager: manager(new SequenceProvider([...replies])),
      engine, kind: 'harness-smoke', policy: 'baseline-v1' });
    expect(result.result?.ok).toBe(false);
    expect(result.calls).toHaveLength(replies.length);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.errors.length).toBeGreaterThan(0);
    expect(summarize([result]).repairs).toMatchObject({ needed: 1, attempted: 0, unmeasured: 0,
      structurallySucceeded: 0, intentChecksPassed: 0 });
    expect(result.calls.every(c => c.repairOfCandidate === null)).toBe(true);
  }
});

test('a malformed response followed by a successful fallback counts one repaired task', async () => {
  const result = await evaluateTask(manual, { manager: manager(), engine, kind: 'harness-smoke',
    policy: 'baseline-v1', condition: 'malformed-first' });
  expect(result.result?.ok).toBe(true);
  expect(result.calls.map(c => [c.path, c.repairOfCandidate])).toEqual([['tools', null], ['text', 0]]);
  expect(summarize([result]).repairs).toEqual({ needed: 1, attempted: 1, unmeasured: 0,
    structurallySucceeded: 1, intentChecksPassed: 1 });

  const legacy = structuredClone(result);
  for (const call of legacy.calls) delete call.repairOfCandidate;
  expect(summarize([legacy]).repairs).toEqual({ needed: 1, attempted: null, unmeasured: 1,
    structurallySucceeded: null, intentChecksPassed: null });
});

test('a repair call that fails at the provider counts as attempted, not successful', async () => {
  const invalid = { ...discovery, tool_calls: [{ id: 'invalid', name: 'submit_flow', arguments: {} }] };
  const result = await evaluateTask(manual, { manager: manager(new SequenceProvider([
    invalid, new LLMProviderError('Unauthorized fixture', 'auth'),
  ])), engine, kind: 'harness-smoke', policy: 'baseline-v1' });
  expect(result.result?.ok).toBe(false);
  expect(result.calls.map(c => c.repairOfCandidate)).toEqual([null, 0]);
  expect(summarize([result]).repairs).toEqual({ needed: 1, attempted: 1, unmeasured: 0,
    structurallySucceeded: 0, intentChecksPassed: 0 });
});

test('multiple submissions in one reply do not imply a repair call', async () => {
  const valid = await new SmokeProvider().chat([], { tools: [{ name: 'submit_flow', description: '', parameters: {} }] });
  valid.tool_calls!.unshift({ id: 'invalid', name: 'submit_flow', arguments: {} });
  const result = await evaluateTask(manual, { manager: manager(new SequenceProvider([valid])),
    engine, kind: 'harness-smoke', policy: 'baseline-v1' });
  expect(result.result?.ok).toBe(true);
  expect(result.calls).toHaveLength(1);
  expect(result.candidates).toHaveLength(2);
  expect(summarize([result]).repairs).toMatchObject({ needed: 1, attempted: 0, unmeasured: 0,
    structurallySucceeded: 0, intentChecksPassed: 0 });
});
