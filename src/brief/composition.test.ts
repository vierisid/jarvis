import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BriefCompositionProvider } from './composition';
import { COMPOSITION_LIMITS } from './composition-contracts';
import type { BriefComposeRequest } from './composition-contracts';
import { ensureCompositionJobSchema } from './composition-schema';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db/index';
import { getFlow, updateFlowStatus } from '../workflows/db/repos/flow';
import { getFlowVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { getWorkflowComposition } from '../workflows/db/repos/workflow-composition';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import type { ComposerLlmClient } from '../actions/tools/workflow-composer';

const input = { requestId: 'stable-request', name: 'Private report', prompt: '  On manual trigger, draft a report in the dashboard. Never send email or delete files.\n' };
const graph = { displayName: 'Private report', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
  name: 'report', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Draft the report without sending email or deleting files.' } },
} } };
const valid = JSON.stringify(graph);
let directory: string, path: string;
let providers: BriefCompositionProvider[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f07-')); path = join(directory, 'test.db');
  initWorkflowDb(path); configureWorkflowReadiness({ pieces: sampleCatalog() }); providers = [];
});
afterEach(async () => {
  for (const p of providers) p.stop();
  await Promise.all(providers.map(p => p.idle()));
  closeWorkflowDb(); rmSync(directory, { recursive: true, force: true });
});
function provider(llm: ComposerLlmClient = { async chat() { return { text: valid }; } }, timeout = 1000, project?: string) {
  const p = new BriefCompositionProvider(getWorkflowDb(), project, timeout);
  p.configure(() => ({ llm, pieceRegistry: sampleCatalog(), maxAttempts: 2 })); providers.push(p); return p;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function started(p: BriefCompositionProvider, id: string) {
  for (let i = 0; i < 1000 && !p.get(id).compositionId; i++) await Bun.sleep(1);
  expect(p.get(id).compositionId).not.toBeNull();
}
function count(table: 'flow' | 'flow_version' | 'workflow_composition' | 'flow_run') {
  return getWorkflowDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

test('durable receipt precedes the model; retries across every phase attach one disabled populated draft', async () => {
  let calls = 0; const reply = deferred<{ text: string }>();
  const p = provider({ async chat({ prompt }) {
    calls++; expect(prompt).toContain(JSON.stringify(input.prompt));
    const reader = new Database(path, { readonly: true });
    try {
      const row = reader.query<{ composition_id: string; prompt: string }, []>('SELECT composition_id, prompt FROM brief_workflow_composition_jobs').get()!;
      expect(row.prompt).toBe(input.prompt); expect(row.composition_id).toBeTruthy();
      expect(reader.query('SELECT id FROM workflow_composition WHERE id = ?').get(row.composition_id)).toBeTruthy();
    } finally { reader.close(); }
    return reply.promise;
  } });
  const accepted = p.submit(input);
  expect(accepted).toMatchObject({ created: true, job: { state: 'queued', specification: { name: input.name, prompt: input.prompt } } });
  expect(calls).toBe(0); expect(p.submit(input)).toMatchObject({ created: false, job: { jobId: accepted.job.jobId } });
  await started(p, accepted.job.jobId);
  expect(p.submit(input).job.state).toBe('running');
  reply.resolve({ text: valid }); await p.idle();
  const job = p.get(accepted.job.jobId);
  expect(job).toMatchObject({ state: 'draft_ready', progress: { checkedCandidates: 1 }, blocker: null });
  expect(p.cancel(job.jobId)).toEqual(job);
  expect(p.submit(input)).toEqual({ created: false, job }); await p.idle();
  expect(calls).toBe(1); expect(count('workflow_composition')).toBe(1); expect(count('flow')).toBe(1); expect(count('flow_version')).toBe(1); expect(count('flow_run')).toBe(0);
  expect(getFlow(job.workflow!.flowId)).toMatchObject({ status: 'DISABLED', published_version_id: null });
  expect(getFlowVersion(job.workflow!.versionId)).toMatchObject({ state: 'DRAFT', trigger: graph.trigger });
  expect(getWorkflowComposition(job.compositionId!)!.specification).toMatchObject({ name: input.name, description: input.prompt });
  p.stop(); closeWorkflowDb(); initWorkflowDb(path);
  const recovered = provider();
  expect(recovered.submit(input)).toEqual({ job, created: false }); await recovered.idle();
  expect(count('flow')).toBe(1);
});

test('an uncertain response can be recovered by requestId and changed specifications conflict', async () => {
  const p = provider(); const job = p.submit(input).job;
  expect(p.list(input.requestId)[0]!.jobId).toBe(job.jobId);
  for (const changed of [{ ...input, prompt: 'Another instruction' }, { ...input, name: 'Another name' }]) {
    expect(() => p.submit(changed)).toThrow('different specification');
  }
  await p.idle(); expect(count('flow')).toBe(1); expect(p.list('unknown')).toEqual([]);
});

test('repair retains the exact specification and exposes candidate count without candidate contents', async () => {
  let calls = 0; const p = provider({ async chat({ prompt }) {
    expect(prompt).toContain(JSON.stringify(input.prompt));
    return { text: ++calls === 1 ? '{PRIVATE MALFORMED RESPONSE' : valid };
  } });
  const { job } = p.submit(input); await p.idle();
  const result = p.get(job.jobId);
  expect(result).toMatchObject({ state: 'draft_ready', progress: { checkedCandidates: 2 } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE MALFORMED');
});

test('a trigger-only result is a useful blocker and cannot create an empty success', async () => {
  const p = provider({ async chat() { return { text: JSON.stringify({ displayName: 'Empty', trigger: { name: 'trigger', type: 'EMPTY' } }) }; } });
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'blocked', workflow: null, blocker: { code: 'insufficient_information', message: expect.stringContaining('destination') } });
  expect(count('flow')).toBe(0); expect(p.submit(input).created).toBe(false); await p.idle(); expect(count('workflow_composition')).toBe(1);
});

test('a populated graph with an unknown piece cannot bypass composer validation', async () => {
  const invalid = JSON.stringify(graph).replace('jarvis-ask', 'missing-piece');
  const p = provider({ async chat() { return { text: invalid }; } });
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'failed', workflow: null, progress: { checkedCandidates: 2 } });
  expect(count('flow')).toBe(0); expect(getWorkflowComposition(p.get(job.jobId).compositionId!)!.state).toBe('FAILED');
});

test('report_blocked preserves actionable reasons without attaching or running a draft', async () => {
  const p = provider({ async chat() { throw new Error('Unexpected fallback'); }, async chatTools() {
    return { content: '', tool_calls: [{ id: 'blocked', name: 'report_blocked', arguments: { reason: 'Specify which destination should receive the report.' } }] };
  } });
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'blocked', blocker: { code: 'composition_blocked', details: [expect.stringContaining('destination')] } });
  expect(count('flow')).toBe(0); expect(count('flow_run')).toBe(0);
});

test('provider errors and malformed responses stay out of the public failure receipt', async () => {
  for (const llm of [
    { async chat(): Promise<{ text: string }> { throw Error('PRIVATE PROVIDER DIAGNOSTIC'); } },
    { async chat() { return { text: '{PRIVATE MODEL RESPONSE' }; } },
  ]) {
    const p = provider(llm), { job } = p.submit({ ...input, requestId: `failure-${providers.length}` }); await p.idle();
    expect(p.get(job.jobId)).toMatchObject({ state: 'failed', workflow: null, blocker: { code: 'composition_failed', details: [] } });
    expect(JSON.stringify(p.get(job.jobId))).not.toContain('PRIVATE'); p.stop();
  }
  expect(count('flow')).toBe(0);
});

test('queued cancellation makes no model call; running cancellation aborts and rejects late results', async () => {
  const reply = deferred<{ text: string }>(); let signal: AbortSignal | undefined, calls = 0;
  const p = provider({ async chat(request) { signal = request.signal; calls++; return reply.promise; } });
  const first = p.submit(input).job, queued = p.submit({ ...input, requestId: 'queued' }).job;
  expect(p.cancel(queued.jobId).state).toBe('cancelled');
  await started(p, first.jobId); expect(p.cancel(first.jobId).state).toBe('cancelled');
  expect(signal!.aborted).toBe(true); await p.idle();
  reply.resolve({ text: valid }); await Bun.sleep(5);
  expect(p.get(first.jobId).state).toBe('cancelled'); expect(p.cancel(first.jobId).state).toBe('cancelled');
  expect(calls).toBe(1); expect(count('flow')).toBe(0); expect(count('workflow_composition')).toBe(1);
});

test('cancellation frees the queue even if the model ignores abort', async () => {
  const reply = deferred<{ text: string }>(); let calls = 0;
  const p = provider({ async chat() { return ++calls === 1 ? reply.promise : { text: valid }; } });
  const first = p.submit(input).job; await started(p, first.jobId);
  const second = p.submit({ ...input, requestId: 'second' }).job;
  p.cancel(first.jobId); await p.idle();
  expect(p.get(second.jobId).state).toBe('draft_ready');
  reply.resolve({ text: valid }); await Bun.sleep(5);
  expect(count('flow')).toBe(1); expect(p.get(first.jobId).workflow).toBeNull();
});

test('timeout releases an uncooperative model and retains a durable retryable failure', async () => {
  const reply = deferred<{ text: string }>(); const p = provider({ async chat() { return reply.promise; } }, 15);
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'failed', blocker: { code: 'timeout' }, specification: { prompt: input.prompt } });
  reply.resolve({ text: valid }); await Bun.sleep(5); expect(count('flow')).toBe(0);
  expect(p.submit(input).created).toBe(false); await p.idle(); expect(count('workflow_composition')).toBe(1);
});

test('restart records queued and running work as interrupted and never resumes it implicitly', async () => {
  const reply = deferred<{ text: string }>(); const p = provider({ async chat() { return reply.promise; } });
  const first = p.submit(input).job; await started(p, first.jobId);
  const queued = p.submit({ ...input, requestId: 'pending' }).job;
  const compositionId = p.get(first.jobId).compositionId;
  closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: sampleCatalog() });
  let calls = 0; const recovered = provider({ async chat() { calls++; return { text: valid }; } });
  for (const id of [first.jobId, queued.jobId]) expect(recovered.get(id)).toMatchObject({ state: 'failed', blocker: { code: 'interrupted' }, specification: { prompt: input.prompt } });
  expect(recovered.get(first.jobId).compositionId).toBe(compositionId);
  expect(recovered.submit(input).created).toBe(false); await recovered.idle(); expect(calls).toBe(0);
  reply.resolve({ text: valid }); await p.idle(); expect(count('flow')).toBe(0);
  const retry = recovered.submit({ ...input, requestId: 'explicit-retry' }).job; await recovered.idle();
  expect(recovered.get(retry.jobId).state).toBe('draft_ready'); expect(calls).toBe(1);
});

test('graceful shutdown persists interrupted outcomes before aborting provider work', async () => {
  const reply = deferred<{ text: string }>(); const p = provider({ async chat() { return reply.promise; } });
  const first = p.submit(input).job; await started(p, first.jobId);
  const queued = p.submit({ ...input, requestId: 'pending' }).job; p.stop(); await p.idle();
  for (const id of [first.jobId, queued.jobId]) expect(p.get(id)).toMatchObject({ state: 'failed', blocker: { code: 'interrupted' } });
  reply.resolve({ text: valid }); await Bun.sleep(5); expect(count('flow')).toBe(0); expect(p.readiness()).toBe('unavailable');
});

test('failure to save result IDs rolls back both canonical draft rows', async () => {
  const p = provider();
  getWorkflowDb().exec(`CREATE TRIGGER reject_result BEFORE UPDATE ON brief_workflow_composition_jobs WHEN NEW.state = 'draft_ready'
    BEGIN SELECT RAISE(ABORT, 'result write failed'); END`);
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'failed', workflow: null, compositionId: expect.any(String) });
  expect(count('flow')).toBe(0); expect(count('flow_version')).toBe(0);
});

test('failure to bind journal identity rolls back before any model call', async () => {
  let calls = 0; const p = provider({ async chat() { calls++; return { text: valid }; } });
  getWorkflowDb().exec(`CREATE TRIGGER reject_journal BEFORE UPDATE ON brief_workflow_composition_jobs WHEN NEW.composition_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'journal attachment failed'); END`);
  const { job } = p.submit(input); await p.idle();
  expect(p.get(job.jobId)).toMatchObject({ state: 'failed', compositionId: null }); expect(calls).toBe(0); expect(count('workflow_composition')).toBe(0);
});

test('a prepared disabled draft still faces canonical readiness checks before activation', async () => {
  const p = provider({ async chat() { configureWorkflowReadiness({}); return { text: valid }; } });
  const { job } = p.submit(input); await p.idle();
  const result = p.get(job.jobId);
  expect(result.state).toBe('draft_ready');
  expect(() => updateFlowStatus(result.workflow!.flowId, 'ENABLED')).toThrow();
  expect(getFlow(result.workflow!.flowId)!.status).toBe('DISABLED');
});

test('request validation bounds bytes and identifiers, rejects F08 fields, and preserves admitted wording', async () => {
  const p = provider();
  const invalid: unknown[] = [null, [], {}, { ...input, requestId: 'a/b' }, { ...input, requestId: 'x'.repeat(129) },
    { ...input, prompt: ' \n ' }, { ...input, prompt: 42 }, { ...input, prompt: 'é'.repeat(COMPOSITION_LIMITS.promptBytes / 2 + 1) },
    { ...input, name: '' }, { ...input, name: 'x'.repeat(161) }, { ...input, ingredients: [] }, { ...input, projectId: 'foreign' }];
  for (const value of invalid) expect(() => p.submit(value as BriefComposeRequest)).toThrow();
  expect(p.list()).toEqual([]);
  const exact = 'é'.repeat(COMPOSITION_LIMITS.promptBytes / 2);
  expect(p.submit({ ...input, prompt: exact }).job.specification.prompt).toBe(exact); await p.idle();
});

test('queue is bounded while idempotent repeats remain readable when it is full', async () => {
  const p = provider(); const ids: string[] = [];
  for (let i = 0; i < COMPOSITION_LIMITS.pendingJobs; i++) ids.push(p.submit({ ...input, requestId: `request-${i}` }).job.jobId);
  expect(() => p.submit(input)).toThrow('queue is full');
  expect(p.submit({ ...input, requestId: 'request-0' })).toMatchObject({ created: false, job: { jobId: ids[0] } });
  ids.forEach(id => p.cancel(id)); await p.idle(); expect(count('workflow_composition')).toBe(0);
});

test('project scope separates lookup, recovery, cancellation and idempotency keys', async () => {
  const a = provider(undefined, 1000, 'project-a'), b = provider(undefined, 1000, 'project-b');
  const one = a.submit(input).job, two = b.submit(input).job;
  expect(one.jobId).not.toBe(two.jobId); expect(a.list()).toHaveLength(1); expect(b.list(input.requestId)[0]!.jobId).toBe(two.jobId);
  expect(() => a.get(two.jobId)).toThrow('not found'); expect(() => a.cancel(two.jobId)).toThrow('not found');
  a.stop(); expect(b.get(two.jobId).state).toBe('queued'); b.cancel(two.jobId); await Promise.all([a.idle(), b.idle()]);
});

test('schema is additive and idempotent over saved receipts and journals', async () => {
  const p = provider(), { job } = p.submit(input); await p.idle(); const saved = p.get(job.jobId);
  ensureCompositionJobSchema(getWorkflowDb()); ensureCompositionJobSchema(getWorkflowDb());
  expect(p.get(job.jobId)).toEqual(saved); expect(count('workflow_composition')).toBe(1); expect(count('flow')).toBe(1);
});
