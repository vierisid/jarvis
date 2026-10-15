import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../../vault/schema.ts';
import { getUserProfile } from '../../vault/user-profile.ts';
import { createCanonicalInterviewProfileStore, createInterviewProfileProvider, createStagedInterviewer } from './index.ts';
import type { LLMManager } from '../../llm/manager.ts';
import type { LLMResponse, LLMToolCall } from '../../llm/provider.ts';
import type { CommitInput, Store } from './types.ts';

// This fixture exercises the real optional consumer when present. Keep module
// removal compilable too: these imports do not belong to the production provider.
const sessionPath = '../interview-session/index.ts';
const hasSession = existsSync(join(import.meta.dir, sessionPath));
const owner = { actorId: 'owner', projectId: 'project' };
const fact = { theme: 'work', summary: 'Builds a product' };
const response = (content: string, calls: LLMToolCall[] = []): LLMResponse => ({ content, tool_calls: calls, model: 'scripted',
  usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop' });
const record: LLMToolCall = { id: 'f', name: 'record_profile_facts', arguments: { facts: [fact, fact] } };
const wrap: LLMToolCall = { id: 'w', name: 'wrap_interview', arguments: { farewell: 'Thanks. A workflow can be drafted after setup.' } };
let dir: string, path: string, calls: number, answers: (() => Promise<LLMResponse>)[], store: Store;
let createSession: any, createSessionStore: any;
function provider(commit?: (input: CommitInput) => Promise<{ confirmedFactIds: string[] }>) {
  const profile = createInterviewProfileProvider({ enabled: true, store });
  return createSession({ enabled: true, authorize: () => owner, store: createSessionStore(() => getDb()),
    interviewer: createStagedInterviewer({ llmForScope: () => ({ hasConversationTier: () => false,
      chatTier: async () => { calls++; const next = answers.shift(); if (!next) throw Error('unexpected inference'); return next(); },
    }) as unknown as LLMManager }), profile: commit ? { capability: 'interview-profile.v1', commit } : profile });
}
async function start(p: ReturnType<typeof provider>) {
  const result = await p.request(null, { type: 'start' }); expect(result.kind).toBe('ok'); expect(result.snapshot.phase).toBe('ready'); return result.snapshot;
}
function answer(snapshot: any) {
  return { type: 'answer', sessionId: snapshot.sessionId, turnId: snapshot.turnId, clientRequestId: 'answer-1', text: 'I build a product. Please wrap up.' };
}

describe.skipIf(!hasSession)('B04 + staged interviewer + real canonical SQLite writer', () => {
  beforeEach(async () => {
    ({ createInterviewSessionProvider: createSession, createSettingsInterviewStore: createSessionStore } = await import(sessionPath));
    dir = mkdtempSync(join(tmpdir(), 'on-b-05-session-')); path = join(dir, 'vault.db'); initDatabase(path, { quiet: true });
    calls = 0; answers = [async () => response('What are you building?'), async () => response('', [record, wrap])];
    store = createCanonicalInterviewProfileStore({ owner, database: getDb });
  });
  afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  test('quick check: failed final save stays recoverable; retry commits one fact and one completion', async () => {
    const real = store; let fail = true;
    store = { transaction(scope, work) { return real.transaction(scope, tx => work({ ...tx, append(f) {
      tx.append(f); if (fail) throw Error('disk full');
    } })); } };
    const p = provider(), snapshot = await start(p), command = answer(snapshot);
    const failed = await p.request(null, command);
    expect(failed.snapshot.phase).toBe('error'); expect(failed.snapshot.error).toBe('save_failed');
    expect(failed.snapshot.confirmedFactIds).toEqual([]); expect(failed.snapshot.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
    expect(getUserProfile()).toBeNull(); expect(calls).toBe(2);
    fail = false;
    closeDb(); initDatabase(path, { quiet: true });
    const restarted = provider();
    const result = await restarted.request(null, { type: 'retry', sessionId: snapshot.sessionId });
    expect(result.snapshot.phase).toBe('done'); expect(result.snapshot.confirmedFactIds).toHaveLength(1);
    expect(getUserProfile()?.interview_facts).toHaveLength(1); expect(getUserProfile()?.completed_at).toBeNumber(); expect(calls).toBe(2);
    expect((await restarted.request(null, command)).snapshot).toEqual(result.snapshot);
  });
  test('lost commit acknowledgement retries the durable receipt without rewriting profile', async () => {
    const canonical = createInterviewProfileProvider({ enabled: true, store }); let lose = true;
    const p = provider(async input => { const result = await canonical.commit(input); if (input.wrap && lose) { lose = false; throw Error('lost acknowledgement'); } return result; });
    const snapshot = await start(p); const failed = await p.request(null, answer(snapshot));
    expect(failed.snapshot.phase).toBe('error'); expect(getUserProfile()?.completed_at).toBeNumber();
    const previous = getUserProfile();
    const result = await provider().request(null, { type: 'retry', sessionId: snapshot.sessionId });
    expect(result.snapshot.phase).toBe('done'); expect(result.snapshot.confirmedFactIds).toHaveLength(1);
    expect(getUserProfile()).toEqual(previous); expect(calls).toBe(2);
  });
  test('skip during model work fences late facts and completion', async () => {
    let resolve!: (r: LLMResponse) => void; let entered!: () => void;
    const pending = new Promise<void>(r => { entered = r; });
    answers[1] = () => { entered(); return new Promise(r => { resolve = r; }); };
    const p = provider(), snapshot = await start(p);
    const work = p.request(null, answer(snapshot)); await pending;
    expect((await p.request(null, { type: 'skip', sessionId: snapshot.sessionId })).snapshot.phase).toBe('skipped');
    resolve(response('', [record, wrap]));
    expect((await work).snapshot.phase).toBe('skipped');
    expect(getUserProfile()).toBeNull();
    expect((await p.request(null, { type: 'start' })).snapshot.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
  });
  test('skip before opening does not infer or mark completion', async () => {
    const p = provider();
    expect((await p.request(null, { type: 'skip', sessionId: null })).snapshot.phase).toBe('skipped');
    expect((await p.request(null, { type: 'start' })).snapshot.phase).toBe('skipped');
    expect(getUserProfile()).toBeNull(); expect(calls).toBe(0);
  });
  test('nonterminal fact save remains incomplete and repeated/corrected input counts canonical entries', async () => {
    answers[1] = async () => response('Which tool?', [record]);
    answers.push(async () => response('Thanks for clarifying.', [record, { id: 'correction', name: 'record_profile_facts',
      arguments: { facts: [{ theme: 'tools', summary: 'Uses Calendar, not Gmail' }] } }, wrap]));
    const p = provider(), first = await start(p);
    const partial = await p.request(null, { ...answer(first), text: 'I build a product' });
    expect(partial.snapshot.phase).toBe('ready'); expect(partial.snapshot.confirmedFactIds).toHaveLength(1);
    expect(getUserProfile()?.completed_at).toBeNull();
    const final = await p.request(null, { ...answer(partial.snapshot), clientRequestId: 'answer-2', text: 'Correction: Calendar, not Gmail.' });
    expect(final.snapshot.phase).toBe('done'); expect(final.snapshot.confirmedFactIds).toHaveLength(2);
    expect(getUserProfile()?.interview_facts).toHaveLength(2);
    expect(getUserProfile()?.interview_facts?.[1]?.summary).toBe('Uses Calendar, not Gmail');
  });
  test.skipIf(!existsSync(join(import.meta.dir, '../runtime/runtime.ts')))('real B05/B04 bind through runtime; removing B05 closes the dependency', async () => {
    const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts', catalogPath = '../runtime/generated/catalog.ts';
    const { createOnboardingRuntime } = await import(runtimePath);
    const { fixtureOptions, request, omit } = await import(fixturePath);
    const { runtimeModules } = await import(catalogPath);
    const options = fixtureOptions();
    options.modules = options.modules.map((m: any) => ['ON-B-04', 'ON-B-05'].includes(m.manifest.id)
      ? runtimeModules.find((actual: any) => actual.manifest.id === m.manifest.id) : m);
    options.bindings['interview-profile.v1'] = (module: any) => ({
      probe: () => ({ ready: true, reason: 'ready' }), operations: {},
      profile: module.createInterviewProfileProvider({ enabled: true, store }),
      interviewer: module.createStagedInterviewer({ llmForScope: () => ({ hasConversationTier: () => false,
        chatTier: async () => { calls++; return answers.shift()!(); },
      }) }),
    });
    options.bindings['interview-session.v1'] = (module: any, dependencies: any) => {
      const p = module.createInterviewSessionProvider({ enabled: true, authorize: () => owner,
        store: module.createSettingsInterviewStore(() => getDb()), ...dependencies['interview-profile.v1'] });
      return { probe: () => ({ ready: true, reason: 'ready' }), operations: {
        'interview.command': (command: unknown, context: unknown) => p.request(context, command),
      } };
    };
    const without = createOnboardingRuntime(omit(options, 'interview-profile.v1'));
    expect((await without.status(request())).capabilities['interview-session.v1'].reason).toBe('dependency_unavailable');
    await expect(without.execute(request(), 'interview.command', { type: 'start' })).rejects.toThrow();
    expect(calls).toBe(0); expect(getUserProfile()).toBeNull();
    const runtime = createOnboardingRuntime(options);
    const opened = await runtime.execute(request(), 'interview.command', { type: 'start' });
    const done = await runtime.execute(request(), 'interview.command', answer(opened.snapshot));
    expect(done.snapshot.phase).toBe('done'); expect(done.snapshot.confirmedFactIds).toHaveLength(1);
    expect(getUserProfile()?.interview_facts).toHaveLength(1); expect(calls).toBe(2);
  });

});
