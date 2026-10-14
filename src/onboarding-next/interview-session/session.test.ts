import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterviewSession, runInterviewTurn } from '../../daemon/onboarding-interviewer.ts';
import type { LLMManager } from '../../llm/manager.ts';
import { createInterviewSessionProvider, createSettingsInterviewStore } from './index.ts';
import { settingsKey } from './settings.ts';
import type { Answer, CommitInput, Dependencies, InterviewerPort, PreparedTurn, ProfilePort, Result, Scope } from './types.ts';

const scope = { actorId: 'actor-a', projectId: 'project-a' };
const disposers: (() => void)[] = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });
export function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export function snapshot(result: Result) { expect(result.kind).toBe('ok'); if (result.kind !== 'ok') throw new Error(result.reason); return result.snapshot; }
function fixture(overrides: Partial<Dependencies<Scope | null>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-interview-'));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.sqlite');
  const db = new Database(path);
  disposers.push(() => db.close());
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  const store = createSettingsInterviewStore(() => db);
  const prepared: (string | null)[] = [];
  const commits: CommitInput[] = [];
  const interviewer: InterviewerPort = {
    create: createInterviewSession,
    async prepare({ session, answer }) {
      prepared.push(answer);
      session.turnCount++;
      if (answer !== null) session.messages.push({ role: 'user', content: answer });
      const text = answer === null ? 'What are you working on?' : 'What repeats?';
      session.messages.push({ role: 'assistant', content: text });
      session.done = answer === 'finish';
      return { session, result: { assistantText: text, done: session.done, factsRecorded: 0 },
        facts: answer === null ? [] : [{ theme: 'work', summary: answer }] };
    },
  };
  const profile: ProfilePort = { capability: 'interview-profile.v1', async commit(input) {
    commits.push(input);
    return { confirmedFactIds: input.facts.map((_, i) => `${input.attemptId}:${i}`) };
  } };
  const deps: Dependencies<Scope | null> = { enabled: true, authorize: s => s, store, interviewer, profile, ...overrides };
  const provider = createInterviewSessionProvider(deps);
  const start = async () => snapshot(await provider.request(scope, { type: 'start' }));
  const answer = (s: Awaited<ReturnType<typeof start>>, text = 'I build software', id = 'request-1'): Answer =>
    ({ sessionId: s.sessionId, turnId: s.turnId, clientRequestId: id, text });
  return { db, path, store, deps, provider, prepared, commits, start, answer, interviewer, profile };
}

describe('durable scoped written interview', () => {
  test('is inert by default and unavailable without either injected capability', async () => {
    for (const overrides of [{ enabled: undefined }, { profile: undefined }, { interviewer: undefined }]) {
      const f = fixture(overrides);
      expect((await f.provider.request(scope, { type: 'start' })).kind).toBe('unavailable');
      expect(f.db.query('SELECT * FROM settings').all()).toEqual([]);
      expect(f.prepared).toEqual([]);
    }
  });
  test('lost acknowledgement and duplicate answer return one persisted turn', async () => {
    const f = fixture(), start = await f.start(), answer = f.answer(start, '  exact original answer  ');
    const first = snapshot(await f.provider.request(scope, { type: 'answer', ...answer }));
    const retry = snapshot(await f.provider.request(scope, { type: 'answer', ...answer }));
    expect(retry).toEqual(first);
    expect(f.prepared).toEqual([null, answer.text]);
    expect(f.commits).toHaveLength(2);
    expect(retry.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual([answer.text]);
    expect((await f.provider.request(scope, { type: 'answer', ...answer, text: 'changed' })).kind).toBe('conflict');
  });
  test('reopening the SQLite file restores the original opening and transcript', async () => {
    const f = fixture(), s = await f.start();
    const complete = snapshot(await f.provider.request(scope, { type: 'answer', ...f.answer(s) }));
    const db2 = new Database(f.path); disposers.push(() => db2.close());
    const restart = createInterviewSessionProvider({ ...f.deps, store: createSettingsInterviewStore(() => db2) });
    expect(snapshot(await restart.request(scope, { type: 'start' }))).toEqual(complete);
    expect(f.prepared).toHaveLength(2);
    expect((f.db.query('SELECT value FROM settings').get() as { value: string }).value).not.toContain('You are Jarvis interviewing');
  });
  test('two providers/connections serialize different tabs answering one prompt', async () => {
    const f = fixture(), s = await f.start();
    const wait = deferred<PreparedTurn>(), started = deferred<void>();
    f.deps.interviewer = { ...f.interviewer, async prepare(input) { started.resolve(); return wait.promise; } };
    const p1 = createInterviewSessionProvider(f.deps);
    const db2 = new Database(f.path); disposers.push(() => db2.close());
    const p2 = createInterviewSessionProvider({ ...f.deps, store: createSettingsInterviewStore(() => db2) });
    const answer = f.answer(s);
    const running = p1.request(scope, { type: 'answer', ...answer }); await started.promise;
    expect(snapshot(await p2.request(scope, { type: 'answer', ...answer })).phase).toBe('thinking');
    expect((await p2.request(scope, { type: 'answer', ...f.answer(s, 'Other tab', 'request-2') })).kind).toBe('conflict');
    const session = createInterviewSession(); session.turnCount = 1;
    wait.resolve(await f.interviewer.prepare({ scope, session, answer: answer.text, turnId: answer.turnId, signal: new AbortController().signal }));
    expect(snapshot(await running).messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(f.commits).toHaveLength(2);
  });
  test('pure interviewer failure retains answer and retries with the original identity', async () => {
    const f = fixture(), s = await f.start(), answer = f.answer(s);
    let fail = true;
    f.deps.interviewer = { ...f.interviewer, async prepare(input) { if (fail) { fail = false; throw new Error('provider secret'); } return f.interviewer.prepare(input); } };
    const p = createInterviewSessionProvider(f.deps);
    const error = snapshot(await p.request(scope, { type: 'answer', ...answer }));
    expect(error.phase).toBe('error'); expect(error.error).toBe('turn_failed'); expect(error.pendingAnswer).toEqual(answer);
    expect(JSON.stringify(error)).not.toContain('provider secret');
    expect(snapshot(await p.request(scope, { type: 'answer', ...answer })).phase).toBe('ready');
    expect(f.commits).toHaveLength(2);
  });
  test('lost fact acknowledgement reconciles the same attempt without rerunning the model', async () => {
    const f = fixture(), s = await f.start(), calls: CommitInput[] = [];
    const receipts = new Map<string, string[]>();
    f.deps.profile = { capability: 'interview-profile.v1', async commit(input) {
      calls.push(input);
      const previous = receipts.get(input.attemptId);
      if (previous) return { confirmedFactIds: previous };
      receipts.set(input.attemptId, ['confirmed-work']);
      throw new Error('ack lost after write');
    } };
    let p = createInterviewSessionProvider(f.deps);
    const first = snapshot(await p.request(scope, { type: 'answer', ...f.answer(s, 'finish') }));
    expect(first.phase).toBe('error'); expect(first.confirmedFactIds).toEqual([]);
    p = createInterviewSessionProvider(f.deps);
    const retry = snapshot(await p.request(scope, { type: 'retry', sessionId: s.sessionId }));
    expect(retry.phase).toBe('done'); expect(retry.confirmedFactIds).toEqual(['confirmed-work']);
    expect(calls).toHaveLength(2); expect(calls[0]!.attemptId).toBe(calls[1]!.attemptId);
    expect(calls.every(c => c.wrap)).toBe(true); expect(f.prepared).toHaveLength(2);
    expect(snapshot(await p.request(scope, { type: 'start' }))).toEqual(retry);
  });
  test('skip fences late model completion and preserves original answer', async () => {
    const f = fixture(), s = await f.start();
    const wait = deferred<PreparedTurn>(), started = deferred<Parameters<InterviewerPort['prepare']>[0]>();
    f.deps.interviewer = { ...f.interviewer, async prepare(input) { started.resolve(input); return wait.promise; } };
    const p = createInterviewSessionProvider(f.deps), answer = f.answer(s);
    const running = p.request(scope, { type: 'answer', ...answer }); const input = await started.promise;
    const skipped = snapshot(await p.request(scope, { type: 'skip', sessionId: s.sessionId }));
    expect(input.signal.aborted).toBe(true);
    expect(snapshot(await running)).toEqual(skipped); // Cancel waiting even if the model ignores abort.
    wait.resolve(await f.interviewer.prepare(input));
    expect(snapshot(await running)).toEqual(skipped);
    expect(skipped.pendingAnswer).toEqual(answer); expect(skipped.phase).toBe('skipped');
    expect(f.commits).toHaveLength(1);
    expect(snapshot(await p.request(scope, { type: 'retry', sessionId: s.sessionId }))).toEqual(skipped);
  });
  test('skip fences late fact receipt without an assistant bubble or done state', async () => {
    const f = fixture(), s = await f.start(), wait = deferred<{ confirmedFactIds: string[] }>(), started = deferred<CommitInput>();
    f.deps.profile = { capability: 'interview-profile.v1', async commit(input) { started.resolve(input); return wait.promise; } };
    const p = createInterviewSessionProvider(f.deps);
    const running = p.request(scope, { type: 'answer', ...f.answer(s, 'finish') }); const input = await started.promise;
    const skipped = snapshot(await p.request(scope, { type: 'skip', sessionId: s.sessionId }));
    expect(input.isCurrent()).toBe(false); expect(input.signal.aborted).toBe(true);
    wait.resolve({ confirmedFactIds: ['late'] });
    expect(snapshot(await running)).toEqual(skipped); expect(skipped.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
  });
  test('skip before opening acknowledgement uses authenticated current scope, even before start arrives', async () => {
    const f = fixture();
    const skipped = snapshot(await f.provider.request(scope, { type: 'skip', sessionId: null }));
    expect(skipped.phase).toBe('skipped'); expect(f.prepared).toEqual([]);
    expect(snapshot(await f.provider.request(scope, { type: 'start' }))).toEqual(skipped);
  });
  test('skip with no client session ID cancels an in-flight opening', async () => {
    const f = fixture(), wait = deferred<PreparedTurn>(), started = deferred<Parameters<InterviewerPort['prepare']>[0]>();
    const p = createInterviewSessionProvider({ ...f.deps, interviewer: { ...f.interviewer,
      async prepare(input) { started.resolve(input); return wait.promise; } } });
    const opening = p.request(scope, { type: 'start' }); const input = await started.promise;
    const result = await p.request(scope, { type: 'skip', sessionId: null });
    wait.resolve(await f.interviewer.prepare(input)); await opening;
    expect(snapshot(result).phase).toBe('skipped'); expect(f.commits).toHaveLength(0);
  });
  test('turn timeout is bounded and late results cannot write facts', async () => {
    const f = fixture(), s = await f.start(), wait = deferred<PreparedTurn>();
    let input!: Parameters<InterviewerPort['prepare']>[0];
    f.deps.interviewer = { ...f.interviewer, async prepare(v) { input = v; return wait.promise; } };
    const p = createInterviewSessionProvider({ ...f.deps, timeoutMs: 15 });
    const error = snapshot(await p.request(scope, { type: 'answer', ...f.answer(s) }));
    expect(error.error).toBe('turn_timeout'); expect(input.signal.aborted).toBe(true);
    wait.resolve(await f.interviewer.prepare(input)); await Promise.resolve();
    expect(f.commits).toHaveLength(1);
  });
  test('fact timeout retries only the same prepared write identity', async () => {
    const f = fixture(), s = await f.start(), inputs: CommitInput[] = [];
    const wait = deferred<{ confirmedFactIds: string[] }>();
    f.deps.profile = { capability: 'interview-profile.v1', async commit(input) {
      inputs.push(input); return inputs.length === 1 ? wait.promise : { confirmedFactIds: ['fact'] };
    } };
    const p = createInterviewSessionProvider({ ...f.deps, timeoutMs: 15 });
    const failed = snapshot(await p.request(scope, { type: 'answer', ...f.answer(s) }));
    expect(failed.error).toBe('save_timeout'); expect(failed.confirmedFactIds).toEqual([]);
    const resumed = snapshot(await p.request(scope, { type: 'retry', sessionId: s.sessionId }));
    expect(resumed.confirmedFactIds).toEqual(['fact']); expect(inputs[0]!.attemptId).toBe(inputs[1]!.attemptId);
    expect(f.prepared).toHaveLength(2); wait.resolve({ confirmedFactIds: ['late'] }); await Promise.resolve();
    expect(snapshot(await p.request(scope, { type: 'read', sessionId: s.sessionId }))).toEqual(resumed);
  });
  test('deadline expiry without a fired timer remains an explicit recoverable error', async () => {
    let time = 1;
    const f = fixture({ now: () => time }), s = await f.start();
    const p = createInterviewSessionProvider({ ...f.deps, interviewer: { ...f.interviewer, async prepare(input) {
      const value = await f.interviewer.prepare(input); time += 30_001; return value;
    } } });
    const failed = snapshot(await p.request(scope, { type: 'answer', ...f.answer(s) }));
    expect(failed.phase).toBe('error'); expect(failed.error).toBe('turn_timeout'); expect(f.commits).toHaveLength(1);
  });
  test('expired crashed worker is fenced when another process resumes its lease', async () => {
    let time = 1;
    const f = fixture({ now: () => time }), s = await f.start();
    const wait = deferred<PreparedTurn>(), started = deferred<Parameters<InterviewerPort['prepare']>[0]>();
    const p1 = createInterviewSessionProvider({ ...f.deps, interviewer: { ...f.interviewer,
      async prepare(input) { started.resolve(input); return wait.promise; } } });
    const running = p1.request(scope, { type: 'answer', ...f.answer(s) }); const input = await started.promise;
    time += 30_001;
    const restarted = createInterviewSessionProvider(f.deps);
    const recovered = snapshot(await restarted.request(scope, { type: 'start' }));
    expect(recovered.phase).toBe('ready');
    wait.resolve(await f.interviewer.prepare(input));
    expect(snapshot(await running)).toEqual(recovered);
    expect(f.commits).toHaveLength(2);
    expect(recovered.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  test('reads and all mutations require authenticated actor/project and cannot adopt client scope', async () => {
    const f = fixture(), s = await f.start();
    for (const c of [{ type: 'start' }, { type: 'read', sessionId: s.sessionId }, { type: 'skip', sessionId: s.sessionId },
      { type: 'retry', sessionId: s.sessionId }, { type: 'answer', ...f.answer(s) }]) {
      expect((await f.provider.request(null, c)).kind).toBe('unauthorized');
    }
    const other = snapshot(await f.provider.request({ ...scope, projectId: 'other' }, { type: 'start' }));
    expect(other.sessionId).not.toBe(s.sessionId);
    expect((await f.provider.request({ ...scope, actorId: 'other' }, { type: 'read', sessionId: s.sessionId })).kind).toBe('unavailable');
    expect((await f.provider.request(scope, { type: 'start', actorId: 'other' })).kind).toBe('invalid');
  });
  test('auth loss during model work cannot publish or commit a reply', async () => {
    let allowed = true;
    const f = fixture({ authorize: s => allowed ? s : null }), s = await f.start();
    const wait = deferred<PreparedTurn>(), started = deferred<Parameters<InterviewerPort['prepare']>[0]>();
    const p = createInterviewSessionProvider({ ...f.deps, interviewer: { ...f.interviewer,
      async prepare(input) { started.resolve(input); return wait.promise; } } });
    const running = p.request(scope, { type: 'answer', ...f.answer(s) }); const input = await started.promise;
    allowed = false; wait.resolve(await f.interviewer.prepare(input));
    expect((await running).kind).toBe('unauthorized'); expect(f.commits).toHaveLength(1);
  });
  test('future or corrupt records fail closed without overwriting them', async () => {
    const f = fixture();
    for (const value of ['null', '{bad', '{"schemaVersion":2}', '{"schemaVersion":1}']) {
      f.db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [settingsKey(scope), value]);
      expect((await f.provider.request(scope, { type: 'start' })).kind).toBe('unavailable');
      expect((f.db.query('SELECT value FROM settings').get() as { value: string }).value).toBe(value);
    }
  });
  test('invalid, oversized and stale commands do not call the interviewer', async () => {
    const f = fixture(), s = await f.start();
    for (const text of ['', ' ', 'x'.repeat(16_385), 17]) expect((await f.provider.request(scope,
      { type: 'answer', ...f.answer(s), text })).kind).toBe('invalid');
    expect((await f.provider.request(scope, { type: 'answer', ...f.answer(s), turnId: 'stale' })).kind).toBe('conflict');
    expect(f.prepared).toHaveLength(1);
  });
  test('reuses the real existing interviewer for text-only turns with an injected model', async () => {
    const seen: string[][] = [];
    const llm = { hasConversationTier: () => false, async chatTier(_tier: string, _use: string, messages: { content: string }[]) {
      seen.push(messages.map(m => m.content));
      return { content: 'Existing interviewer reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'fixture', finish_reason: 'stop' };
    } } as unknown as LLMManager;
    const f = fixture({ interviewer: { create: createInterviewSession, async prepare({ session, answer }) {
      // Text-only fixture: no legacy tools are invoked. Production effect-staging
      // for record_profile_facts/wrap_interview remains ON-B-05's binding.
      return { session, result: await runInterviewTurn(session, llm, answer), facts: [] };
    } } });
    const s = await f.start(); await f.provider.request(scope, { type: 'answer', ...f.answer(s, 'Original answer') });
    expect(seen).toHaveLength(2); expect(seen[1]).toContain('Original answer');
    expect(seen[1]!.filter(t => t === 'Existing interviewer reply')).toHaveLength(1);
    expect(seen[1]![0]).toContain('This is a written conversation');
  });
});
