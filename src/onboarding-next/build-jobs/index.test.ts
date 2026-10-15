import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } from './index';
import { fixture, gate, input, scope } from './fixtures';
import { digest, scopeId } from './input';
import type { DraftControl, Result, Scope } from './types';

let directory: string, dbPath: string, now: number, owner: Scope | null;
let f: ReturnType<typeof fixture>, provider: ReturnType<typeof createBuildJobsProvider<null>>;
const status = (result: Result) => { if (result.availability !== 'ready') throw new Error(JSON.stringify(result)); return result.status; };
const ref = (jobId: string) => ({ schemaVersion: 1, jobId });
function bind(options: { timeoutMs?: number; leaseMs?: number; maxAttempts?: number } = {}) {
  return createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => f.services, ...options });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'on-b08-')); dbPath = join(directory, 'vault.db');
  initWorkflowDb(dbPath); initializeBuildJobStore(getWorkflowDb()); now = Date.now(); owner = scope;
  f = fixture(createSqliteBuildStore(getWorkflowDb(), { now: () => now })); provider = bind();
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

test('default-off factory and store do no work', async () => {
  const db = new Database(':memory:'); createSqliteBuildStore(db);
  const off = createBuildJobsProvider({ authorize() { throw new Error(); }, servicesFor: () => null });
  expect(await off.submit(null, input())).toEqual({ availability: 'unsupported', reason: 'disabled' });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]); db.close();
});
test('reserve journey before durable acceptance; worker starts separately and saves one identity', async () => {
  const queued = status(await provider.submit(null, input()));
  expect(queued).toMatchObject({ outcome: 'queued', journeySync: 'started', resolution: 'pending' });
  expect(f.calls()).toBe(0); expect(f.acknowledgements.map(x => x.type)).toEqual(['reserve_build', 'build_started']);
  const complete = await provider.run(null, ref(queued.jobId));
  expect(status(complete)).toMatchObject({ outcome: 'succeeded', resolution: 'saved', journeySync: 'settled', artifact: f.artifact() });
  expect(f.snapshot().draft).toEqual({ flowId: 'flow-1', versionId: 'version-1' });
  expect(f.calls()).toBe(1);
  expect(complete.availability === 'ready' && complete.events.every((s, i, events) => !i || s.revision > events[i - 1]!.revision)).toBe(true);
});
test('concurrent double clicks and another tab get the same job and one model call', async () => {
  const peer = bind();
  const submitted = await Promise.all([provider.submit(null, input()), peer.submit(null, input())]);
  expect(status(submitted[0]!).jobId).toBe(status(submitted[1]!).jobId);
  const jobId = status(submitted[0]!).jobId;
  await Promise.all([provider.run(null, ref(jobId)), peer.run(null, ref(jobId))]);
  expect(status(await provider.read(null, ref(jobId))).outcome).toBe('succeeded'); expect(f.calls()).toBe(1);
});
test('reused request key rejects changed text, answers, references or journey', async () => {
  await provider.submit(null, input());
  for (const field of ['prompt', 'answers', 'refs', 'journey']) {
    const value = input();
    if (field === 'prompt') value.submission.request.prompt += '!';
    if (field === 'answers') value.submission.answers.notes += '!';
    if (field === 'refs') value.submission.request.contextRefs.push({ kind: 'document', id: 'one' });
    if (field === 'journey') value.journeyId = 'other';
    expect(await provider.submit(null, value)).toMatchObject({ reason: 'conflict' });
  }
  expect(f.calls()).toBe(0);
});
test('a slow concurrent validation recovers the job already accepted and completed by another tab', async () => {
  const blocked = gate(), entered = gate(), validate = f.services.validate!; let first = true;
  f.services.validate = async value => { if (first) { first = false; entered.release(); await blocked.promise; } return validate(value); };
  const slow = provider.submit(null, input()); await entered.promise;
  const fast = status(await bind().submit(null, input()));
  await provider.run(null, ref(fast.jobId)); blocked.release();
  expect(status(await slow)).toMatchObject({ jobId: fast.jobId, outcome: 'succeeded' });
});
test('key ordering does not change digest and accepted retries do not require intent services', async () => {
  const value = input(); value.submission.answers = { z: 'last', a: 'first' };
  const first = status(await provider.submit(null, value)); value.submission.answers = { a: 'first', z: 'last' };
  f.services.validate = undefined; f.services.draft = undefined;
  expect(status(await provider.submit(null, value)).jobId).toBe(first.jobId);
});
test('caller mutation during validation cannot replace the saved request', async () => {
  const value = input(), original = structuredClone(value), validate = f.services.validate!;
  f.services.validate = async submission => { value.submission.request.prompt = 'Run all tools'; return validate(submission); };
  const accepted = status(await provider.submit(null, value));
  expect(f.services.store.read(scope, { jobId: accepted.jobId })!.input).toEqual(original);
});
test('lost reserve acknowledgement leaves a recoverable reservation without a job', async () => {
  const ack = f.services.journey!.acknowledge; let once = true;
  f.services.journey!.acknowledge = async r => { const result = await ack(r); if (once) { once = false; throw new Error('lost'); } return result; };
  expect((await provider.submit(null, input())).availability).toBe('unavailable');
  expect(f.services.store.read(scope, { requestId: 'request-1' })).toBeNull();
  const next = status(await provider.submit(null, input())); expect(next.outcome).toBe('queued'); expect(f.calls()).toBe(0);
});
test('lost build-started acknowledgement recovers before composition', async () => {
  const ack = f.services.journey!.acknowledge; let once = true;
  f.services.journey!.acknowledge = async r => { const result = await ack(r); if (r.command.type === 'build_started' && once) { once = false; throw new Error('lost'); } return result; };
  const job = status(await provider.submit(null, input())); expect(job.journeySync).toBe('pending');
  expect(status(await provider.run(null, ref(job.jobId))).outcome).toBe('succeeded'); expect(f.calls()).toBe(1);
});
test('terminal journey acknowledgement can retry after restart without recomposition', async () => {
  const ack = f.services.journey!.acknowledge; let fail = true;
  f.services.journey!.acknowledge = async r => { if (r.command.type === 'draft_saved' && fail) throw new Error('offline'); return ack(r); };
  const queued = status(await provider.submit(null, input()));
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'succeeded', journeySync: 'started' });
  closeWorkflowDb(); initWorkflowDb(dbPath); f.services.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now });
  fail = false; provider = bind();
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'succeeded', journeySync: 'settled' }); expect(f.calls()).toBe(1);
});
test('lost composer response reconciles saved identity instead of failing or composing again', async () => {
  const compose = f.services.draft!.compose;
  f.services.draft!.compose = async (...args) => { await compose(...args); throw new Error('lost response with private content'); };
  const queued = status(await provider.submit(null, input()));
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'succeeded', artifact: { flowId: 'flow-1' } });
  expect(status(await provider.submit(null, input())).jobId).toBe(queued.jobId); expect(f.calls()).toBe(1);
});
test('public status/events exclude the preserved request and raw provider errors', async () => {
  const value = input(); value.submission.request.prompt = 'PRIVATE_REQUEST prepare a report'; value.submission.answers.notes = 'PRIVATE_ANSWERS';
  f.services.draft!.compose = async () => { throw new Error('PRIVATE_PROVIDER_ERROR token=secret'); };
  const queued = status(await provider.submit(null, value));
  const result = await provider.run(null, ref(queued.jobId));
  expect(status(result)).toMatchObject({ outcome: 'failed', resolution: 'none' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(f.services.store.read(scope, { jobId: queued.jobId })!.input).toEqual(value);
});
test('a claimed worker crash is resumed only after lease expiry', async () => {
  const queued = status(await provider.submit(null, input())), store = f.services.store;
  const crashed = store.claim(scope, queued.jobId, 1000, 120000)!;
  expect(status(await provider.run(null, ref(queued.jobId))).outcome).toBe('working'); expect(f.calls()).toBe(0);
  closeWorkflowDb(); initWorkflowDb(dbPath); now += 1001;
  f.services.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now }); provider = bind();
  expect(f.services.store.mayCommit(scope, queued.jobId, crashed.token!)).toBe(false);
  expect(status(await provider.run(null, ref(queued.jobId))).outcome).toBe('succeeded'); expect(f.calls()).toBe(1);
});
test('separate processes atomically claim only one worker lease', async () => {
  const queued = status(await provider.submit(null, input()));
  const children = [];
  // Schema startup uses existing vault migrations. Race claims, not unrelated initialization DDL.
  for (let i = 0; i < 2; i++) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'claim-worker.ts'), dbPath, queued.jobId,
      scope.actorId, scope.projectId, String(now)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    let initialized!: () => void;
    const ready = new Promise<void>(resolve => { initialized = resolve; });
    const output = (async () => {
      let text = '';
      const reader = child.stdout.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
          if (text.includes('READY\n')) initialized();
        }
      } finally { reader.releaseLock(); }
      return text;
    })();
    children.push({ child, output, error: new Response(child.stderr).text() });
    await Promise.race([ready, child.exited.then(code => { throw new Error(`worker exited before ready: ${code}`); })]);
  }
  for (const { child } of children) { child.stdin.write('claim\n'); child.stdin.end(); }
  const tokens = await Promise.all(children.map(async ({ child, output, error }) => {
    const [out, err, code] = await Promise.all([output, error, child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.split('\n').find(line => line.startsWith('CLAIM:'))!.slice(6));
  }));
  expect(tokens.filter(Boolean)).toHaveLength(1);
  expect(status(await provider.run(null, ref(queued.jobId))).outcome).toBe('working'); expect(f.calls()).toBe(0);
});
test('lease takeover rejects late results and phase events from the former worker', async () => {
  const entered = gate(), release = gate(), compose = f.services.draft!.compose;
  let first = true, old!: DraftControl;
  f.services.draft!.compose = async (value, control) => {
    if (first) { first = false; old = control; entered.release(); await release.promise; }
    return compose(value, control);
  };
  const queued = status(await provider.submit(null, input())), running = provider.run(null, ref(queued.jobId));
  await entered.promise; now += 30001;
  expect(status(await bind().run(null, ref(queued.jobId))).outcome).toBe('succeeded');
  const before = status(await provider.read(null, ref(queued.jobId)));
  expect(old.mayCommit()).toBe(false); old.onPhase('saving', 99); release.release(); await running;
  expect(status(await provider.read(null, ref(queued.jobId)))).toEqual(before);
});
test('queued cancellation is requested first, then confirmed after fencing and recovery', async () => {
  const queued = status(await provider.submit(null, input()));
  expect(status(await provider.cancel(null, ref(queued.jobId)))).toMatchObject({ outcome: 'queued', cancellation: 'requested', resolution: 'unknown' });
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'cancelled', cancellation: 'acknowledged', resolution: 'none', journeySync: 'settled' });
  expect(f.calls()).toBe(0);
  expect(f.snapshot().buildHistory).toEqual([{ buildRequestId: 'request-1', jobId: queued.jobId, outcome: 'cancelled' }]);
  expect(status(await provider.submit(null, input())).outcome).toBe('cancelled');
});
test('cancellation fences an uncooperative composer before acknowledging no draft', async () => {
  const entered = gate(), release = gate(), compose = f.services.draft!.compose; let control!: DraftControl;
  f.services.draft!.compose = async (value, c) => { control = c; entered.release(); await release.promise; return compose(value, c); };
  const queued = status(await provider.submit(null, input())), running = provider.run(null, ref(queued.jobId)); await entered.promise;
  await provider.cancel(null, ref(queued.jobId)); expect(control.mayCommit()).toBe(false);
  expect(status(await bind().run(null, ref(queued.jobId))).outcome).toBe('cancelled');
  release.release(); await running; expect(f.artifact()).toBeNull();
  expect(status(await provider.read(null, ref(queued.jobId))).outcome).toBe('cancelled');
});
test('a durable save wins a cancellation race and remains recoverable', async () => {
  const entered = gate(), release = gate(), compose = f.services.draft!.compose;
  f.services.draft!.compose = async (...args) => { const r = await compose(...args); entered.release(); await release.promise; return r; };
  const queued = status(await provider.submit(null, input())), running = provider.run(null, ref(queued.jobId)); await entered.promise;
  await provider.cancel(null, ref(queued.jobId));
  expect(status(await bind().run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'succeeded', resolution: 'saved', artifact: { flowId: 'flow-1' } });
  release.release(); await running; expect(f.calls()).toBe(1);
});
test('unavailable reconciliation never claims cancellation or absence', async () => {
  const queued = status(await provider.submit(null, input()));
  f.services.draft!.reconcile = async () => ({ availability: 'unavailable', reason: 'storage_unavailable' });
  await provider.cancel(null, ref(queued.jobId));
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ cancellation: 'requested', outcome: 'working', resolution: 'unknown' });
  expect(f.snapshot().jobId).toBe(queued.jobId);
});
test('timeout revokes commit permission before reconciling an uncooperative provider', async () => {
  provider = bind({ timeoutMs: 30 }); let c!: DraftControl;
  f.services.draft!.compose = async (_, control) => { c = control; return new Promise(() => {}); };
  const queued = status(await provider.submit(null, input()));
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'failed', resolution: 'none', safeError: expect.stringContaining('timed out') });
  expect(c.mayCommit()).toBe(false); expect(c.signal.aborted).toBe(true);
});
test('host shutdown releases a fenced unknown job for restart, never reports user cancellation', async () => {
  const entered = gate(), release = gate(), compose = f.services.draft!.compose;
  let first = true;
  f.services.draft!.compose = async (...args) => { if (first) { first = false; entered.release(); await release.promise; } return compose(...args); };
  const queued = status(await provider.submit(null, input())), abort = new AbortController();
  const running = provider.run(null, ref(queued.jobId), abort.signal); await entered.promise; abort.abort();
  expect(status(await running)).toMatchObject({ outcome: 'working', resolution: 'unknown', cancellation: 'not_requested' });
  now += 1001;
  expect(status(await bind().run(null, ref(queued.jobId))).outcome).toBe('succeeded'); release.release();
});
test('changed intent at worker time yields needs_input and releases the journey only after reconciliation', async () => {
  const queued = status(await provider.submit(null, input()));
  f.services.validate = async () => ({ availability: 'ready', state: 'needs_input', issues: [{ message: 'PRIVATE UNTRUSTED TEXT' }] });
  const result = status(await provider.run(null, ref(queued.jobId)));
  expect(result).toMatchObject({ outcome: 'needs_input', resolution: 'none' });
  expect(result.missingInputs).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(f.calls()).toBe(0);
});
test('provider success without a durable association cannot manufacture success', async () => {
  f.services.draft!.compose = async () => ({ availability: 'ready', state: 'saved', artifact: {
    scopeId: scopeId(scope), requestId: 'request-1', requestDigest: digest(input().submission), flowId: 'fake', versionId: 'fake', compositionRecordId: 'fake' } });
  const queued = status(await provider.submit(null, input()));
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'failed', resolution: 'none', artifact: null });
});
for (const mismatch of ['scopeId', 'requestId', 'requestDigest'] as const) test(`reconciliation refuses mismatched ${mismatch}`, async () => {
  const queued = status(await provider.submit(null, input()));
  f.setArtifact({ scopeId: scopeId(scope), requestId: 'request-1', requestDigest: digest(input().submission),
    flowId: 'flow', versionId: 'version', compositionRecordId: 'composition', [mismatch]: 'other' });
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'working', resolution: 'unknown', artifact: null }); expect(f.calls()).toBe(0);
});
for (const missing of ['validate', 'draft', 'journey'] as const) test(`missing ${missing} service cannot accept new work`, async () => {
  f.services[missing] = undefined;
  expect((await provider.submit(null, input())).availability).not.toBe('ready');
  expect(f.services.store.read(scope, { requestId: 'request-1' })).toBeNull(); expect(f.calls()).toBe(0);
});
test('authorization changes during validation prevent reservation and acceptance', async () => {
  const validate = f.services.validate!;
  f.services.validate = async value => { const result = await validate(value); owner = { ...scope, actorId: 'other' }; return result; };
  expect(await provider.submit(null, input())).toMatchObject({ reason: 'unauthorized' }); expect(f.acknowledgements).toEqual([]);
});
test('different actors and projects cannot read or cancel a known job', async () => {
  const queued = status(await provider.submit(null, input()));
  for (const changed of [{ ...scope, actorId: 'other' }, { ...scope, projectId: 'other' }]) {
    owner = changed;
    expect(await provider.read(null, ref(queued.jobId))).toMatchObject({ reason: 'not_found' });
    expect(await provider.cancel(null, ref(queued.jobId))).toMatchObject({ reason: 'not_found' });
  }
});
test('replacement service generation fences an in-flight worker', async () => {
  const compose = f.services.draft!.compose;
  f.services.draft!.compose = async (value, control) => { f.services = { ...f.services, id: 'replacement' }; expect(control.mayCommit()).toBe(false); return compose(value, control); };
  const queued = status(await provider.submit(null, input()));
  expect((await provider.run(null, ref(queued.jobId))).availability).not.toBe('ready'); expect(f.artifact()).toBeNull();
});
test('replacement workflow database cannot receive an old worker write', async () => {
  f.services.draft!.compose = async (_, control) => {
    closeWorkflowDb(); initWorkflowDb(join(directory, 'replacement.db')); initializeBuildJobStore(getWorkflowDb());
    expect(control.mayCommit()).toBe(false); return { availability: 'unavailable', reason: 'binding_missing' };
  };
  const queued = status(await provider.submit(null, input()));
  expect((await provider.run(null, ref(queued.jobId))).availability).not.toBe('ready');
  expect(getWorkflowDb().query('SELECT * FROM onboarding_build_job').all()).toEqual([]);
});
test('job and initial event roll back together when storage fails', async () => {
  getWorkflowDb().exec("CREATE TRIGGER fail_event BEFORE INSERT ON onboarding_build_event BEGIN SELECT RAISE(ABORT, 'private SQL'); END;");
  expect(await provider.submit(null, input())).toEqual({ availability: 'unavailable', reason: 'storage_unavailable' });
  expect(getWorkflowDb().query('SELECT * FROM onboarding_build_job').all()).toEqual([]);
  getWorkflowDb().exec('DROP TRIGGER fail_event');
  expect(status(await provider.submit(null, input())).outcome).toBe('queued');
});
test('event history is bounded and stale phase callbacks cannot overwrite progress or terminal status', async () => {
  const queued = status(await provider.submit(null, input())), store = f.services.store;
  const claimed = store.claim(scope, queued.jobId, 30000, 120000)!;
  for (let sequence = 0; sequence < 100; sequence++) store.phase(scope, queued.jobId, claimed.token!, 'building', sequence);
  expect(store.phase(scope, queued.jobId, claimed.token!, 'saving', 1)).toBe(false);
  expect(store.phase(scope, queued.jobId, claimed.token!, 'understanding', 200)).toBe(false);
  const result = await provider.read(null, ref(queued.jobId));
  expect(result.availability === 'ready' && result.events.length).toBe(64);
  expect(result.availability === 'ready' && result.truncated).toBe(true);
  const latest = status(result);
  const tail = await provider.read(null, { ...ref(queued.jobId), after: latest.revision - 1 });
  expect(tail.availability === 'ready' && tail.events.map(e => e.revision)).toEqual([latest.revision]);
  store.stop(scope, queued.jobId, claimed.token!, 'composition_failed'); store.finish(scope, queued.jobId, claimed.token!, null);
  expect(store.phase(scope, queued.jobId, claimed.token!, 'saving', 300)).toBe(false);
});
test('retry attempt limit prevents repeated model work after crashes', async () => {
  provider = bind({ maxAttempts: 1 });
  const queued = status(await provider.submit(null, input())), store = f.services.store;
  const crashed = store.claim(scope, queued.jobId, 1000, 120000)!;
  store.attempt(scope, queued.jobId, crashed.token!, 1); now += 1001;
  expect(status(await provider.run(null, ref(queued.jobId)))).toMatchObject({ outcome: 'failed', resolution: 'none' }); expect(f.calls()).toBe(0);
});
test('a backoff job does not starve an eligible job in another journey', async () => {
  const first = f.services.store.accept(scope, input()), secondInput = input('request-2'); secondInput.journeyId = 'journey-2';
  const second = f.services.store.accept(scope, secondInput), claim = f.services.store.claim(scope, first.id, 1000, 10000)!;
  f.services.store.defer(scope, first.id, claim.token!, 'provider_unavailable');
  expect(f.services.store.pending(scope, 1)).toEqual([second.id]);
  now += 1001; // An expired backoff must not repeatedly jump ahead of untouched work.
  expect(f.services.store.pending(scope, 1)).toEqual([second.id]);
});
for (const malformed of [null, { ...input(), actorId: 'forged' }, { ...input(), schemaVersion: 2 },
  { ...input(), submission: { ...input().submission, action: 'run' } },
  { ...input(), submission: { ...input().submission, answers: { notes: 'x'.repeat(2001) } } }]) test('malformed submission does not reserve or compose', async () => {
  expect(await provider.submit(null, malformed)).toMatchObject({ reason: 'invalid_request' }); expect(f.acknowledgements).toEqual([]); expect(f.calls()).toBe(0);
});
