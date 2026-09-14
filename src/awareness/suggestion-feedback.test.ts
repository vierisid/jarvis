import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb } from '../workflows/db/index.ts';
import { closeDb, getDb } from '../vault/schema.ts';
import { createSuggestion, markSuggestionDismissed } from '../vault/awareness.ts';
import { createGoal } from '../vault/goals.ts';
import { getFlow, deleteFlow, listFlows } from '../workflows/db/repos/flow.ts';
import { getFlowVersion } from '../workflows/db/repos/flow-version.ts';
import { acceptSuggestion, canonicalSuggestion, getSuggestionLearning, retrySuggestionComposition,
  recordSuggestionDecision, getCompositionRow, listSuggestionCompositions, listSuggestionRoutines } from './suggestion-feedback.ts';
import { SuggestionComposer, attachSuggestionDraft, claimSuggestionComposition, failSuggestionComposition,
  recoverExpiredCompositions } from './suggestion-composer.ts';
import { createSuggestionFeedbackRoutes } from './suggestion-feedback-routes.ts';
import type { ComposeResult } from '../actions/tools/workflow-composer.ts';

let directory: string;
let path: string;
let worker: SuggestionComposer | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-feedback-'));
  path = join(directory, 'test.db');
  initWorkflowDb(path);
});
afterEach(async () => {
  worker?.stop(); await worker?.idle(); worker = undefined;
  closeDb(); rmSync(directory, { recursive: true, force: true });
});
const proposal = () => createSuggestion({ type: 'automation', title: 'Review invoices', body: 'Invoice review repeats.',
  triggerCaptureId: 'capture-retained-reference', context: { opportunity: {
    patternKey: 'job-v1:invoice_review',
    evidence: [{ captureId: 'observed-1', observedAt: 100, app: 'Mail', cue: 'invoice' }],
    goalCandidates: [{ goalId: 'unsupported-inference' }],
  } } });
const acceptance = { requestId: 'accept-1', reason: 'Useful recurring work', name: 'Invoice check',
  description: 'Collect invoices and prepare a review summary.', expectedOutcome: 'A list of invoices needing review' };
const result: Extract<ComposeResult, { ok: true }> = { ok: true, rawResponse: '',
  flow: { displayName: 'Invoice check', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('durable suggestion feedback', () => {
  test('dismissal, reasons and C6 identity survive database reopen', () => {
    const suggestion = proposal();
    recordSuggestionDecision(suggestion.id, 'dismiss', { requestId: 'dismiss-1', reason: 'This is already automated' });
    closeDb(); initWorkflowDb(path);
    const again = proposal();
    expect(again.id).toBe(suggestion.id);
    expect(again.dismissed).toBe(1);
    const learning = getSuggestionLearning(again.id);
    expect(learning.feedback[0]?.reason).toBe('This is already automated');
    expect(learning.observations[0]?.captureId).toBe('observed-1');
    expect(() => acceptSuggestion(again.id, acceptance)).toThrow('dismissed');
  });

  test('legacy duplicate aliases share feedback and one composition identity after upgrade', () => {
    const first = createSuggestion({ type: 'automation', title: 'A', body: '3 switches',
      context: { pattern: 'app_switch', fromApp: 'Mail', toApp: 'Sheets' } });
    getDb().run(`INSERT INTO awareness_suggestions (id, type, title, body, context, created_at)
      VALUES ('older-client-alias', 'automation', 'B', '4 switches', ?, ?)`,
      [JSON.stringify({ pattern: 'app_switch', fromApp: 'Sheets', toApp: 'mail' }), Date.now() + 100]);
    closeDb(); initWorkflowDb(path);
    expect(canonicalSuggestion('older-client-alias').id).toBe(first.id);
    expect(listSuggestionRoutines().map(item => item.opportunityId)).toEqual([first.id]);
    const one = acceptSuggestion(first.id, acceptance);
    const two = acceptSuggestion('older-client-alias', { ...acceptance, requestId: 'accept-2' });
    expect(two.composition?.id).toBe(one.composition?.id);
    expect(getDb().query('SELECT * FROM suggestion_composition_jobs').all()).toHaveLength(1);
  });

  test('legacy dismissal flag on a later alias still suppresses acceptance', () => {
    const first = proposal();
    getDb().run(`INSERT INTO awareness_suggestions (id, type, title, body, context, dismissed, created_at)
      SELECT 'alias', type, title, body, context, 1, created_at + 1 FROM awareness_suggestions WHERE id = ?`, [first.id]);
    closeDb(); initWorkflowDb(path);
    expect(getSuggestionLearning(first.id).status).toBe('dismissed');
    expect(() => acceptSuggestion(first.id, acceptance)).toThrow('dismissed');
  });

  test('acceptance preserves evidence and only explicit active goal links', () => {
    const suggestion = proposal();
    expect(() => acceptSuggestion(suggestion.id, { ...acceptance, goalId: 'missing', goalReason: 'Maybe' })).toThrow('active');
    expect(getSuggestionLearning(suggestion.id).feedback).toHaveLength(0);
    const goal = createGoal('Reduce accounting time', 'objective', { status: 'active' });
    const input = { ...acceptance, goalId: goal.id, goalReason: 'Invoice review currently takes an hour' };
    const accepted = acceptSuggestion(suggestion.id, input);
    expect(accepted.goalLink?.basis).toBe('user_confirmed');
    expect(accepted.composition?.request.observations[0]?.captureId).toBe('observed-1');
    getDb().run("UPDATE goals SET status = 'paused' WHERE id = ?", [goal.id]);
    expect(getSuggestionLearning(suggestion.id).goalLink).toBeNull();
    expect(acceptSuggestion(suggestion.id, input).composition?.id).toBe(accepted.composition?.id);
    expect(getSuggestionLearning(suggestion.id).composition?.request.goalLink?.goalId).toBe(goal.id);
  });

  test('acceptance is immutable and request IDs cannot change feedback', () => {
    const suggestion = proposal();
    const accepted = acceptSuggestion(suggestion.id, acceptance);
    expect(accepted.goalLink).toBeNull();
    expect(accepted.composition?.request.goalLink).toBeNull();
    expect(() => acceptSuggestion(suggestion.id, { ...acceptance, description: 'Send money' })).toThrow('different');
    expect(() => recordSuggestionDecision(suggestion.id, 'interest', { requestId: 'accept-1', reason: 'Changed' })).toThrow('requestId');
    expect(() => recordSuggestionDecision(suggestion.id, 'dismiss', { requestId: 'dismiss-1', reason: 'Ignore' })).toThrow('composition request');
  });

  test('interest stays separate from acceptance and non-automation rhythms still work', () => {
    const suggestion = proposal();
    recordSuggestionDecision(suggestion.id, 'interest', { requestId: 'interest-1', reason: 'Explain first' });
    expect(getCompositionRow(suggestion.id)).toBeNull();
    acceptSuggestion(suggestion.id, acceptance);
    const error = createSuggestion({ type: 'error', title: 'Error', body: 'Fix' });
    markSuggestionDismissed(error.id);
    expect(() => acceptSuggestion(error.id, acceptance)).toThrow('Only automation');
    expect(createSuggestion({ type: 'error', title: 'Error', body: 'Fix' }).id).not.toBe(error.id);
  });
});

describe('composition job and draft recovery', () => {
  test('concurrent accepts and workers create exactly one disabled draft, outside the LLM transaction', async () => {
    const suggestion = proposal();
    const gate = deferred<ComposeResult>();
    let calls = 0;
    worker = new SuggestionComposer(async () => {
      calls++;
      expect(getDb().inTransaction).toBe(false);
      createGoal('Unrelated write while composition awaits', 'task');
      return gate.promise;
    });
    const routes = createSuggestionFeedbackRoutes(() => worker);
    worker.start(); await worker.idle();
    const send = (requestId: string) => routes['/api/awareness/suggestions/:id/accept'].POST(Object.assign(
      new Request('http://localhost/accept', { method: 'POST', body: JSON.stringify({ ...acceptance, requestId }) }),
      { params: { id: suggestion.id } }));
    const responses = await Promise.all([send('accept-1'), send('accept-2')]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(calls).toBe(1);
    expect(claimSuggestionComposition()).toBeNull();
    gate.resolve(result); await worker.idle();
    expect(listFlows()).toHaveLength(1);
    const learning = getSuggestionLearning(suggestion.id);
    expect(learning.composition?.state).toBe('draft_ready');
    const flow = getFlow(learning.composition!.workflowId!)!;
    expect(flow.status).toBe('DISABLED'); expect(flow.published_version_id).toBeNull();
    expect(JSON.parse(flow.metadata!).opportunityId).toBe(suggestion.id);
    expect(getFlowVersion(learning.composition!.workflowVersionId!)?.state).toBe('DRAFT');
    worker.stop(); await worker.idle(); closeDb(); initWorkflowDb(path);
    expect(acceptSuggestion(suggestion.id, acceptance).composition?.workflowId).toBe(flow.id);
  });

  test('draft insert failure rolls back the flow and attachment; retry completes the same job', () => {
    const suggestion = proposal(); acceptSuggestion(suggestion.id, acceptance);
    const claimed = claimSuggestionComposition()!;
    getDb().run(`CREATE TRIGGER fail_draft BEFORE INSERT ON flow_version BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END`);
    expect(() => attachSuggestionDraft(claimed, result)).toThrow('disk failure');
    expect(listFlows()).toHaveLength(0);
    expect(getCompositionRow(suggestion.id)?.flow_id).toBeNull();
    getDb().run('DROP TRIGGER fail_draft');
    expect(attachSuggestionDraft(claimed, result)).toBe(true);
    expect(attachSuggestionDraft(claimed, result)).toBe(false);
    expect(listFlows()).toHaveLength(1);
  });

  test('queued acceptance survives restart, failed composition remains discoverable and retry is idempotent', async () => {
    const suggestion = proposal(); const accepted = acceptSuggestion(suggestion.id, acceptance);
    closeDb(); initWorkflowDb(path);
    worker = new SuggestionComposer(async () => ({ ok: false, errors: ['Connect the invoice service first'], rawResponse: null }));
    worker.start(); await worker.idle(); worker.stop();
    closeDb(); initWorkflowDb(path);
    expect(listSuggestionCompositions()[0]?.composition?.state).toBe('failed');
    expect(getSuggestionLearning(suggestion.id).composition?.error).toContain('Connect');
    expect(acceptSuggestion(suggestion.id, acceptance).composition?.state).toBe('failed');
    const retry = { requestId: 'retry-1', reason: 'Connection is now configured' };
    expect(retrySuggestionComposition(suggestion.id, retry).composition?.id).toBe(accepted.composition?.id);
    retrySuggestionComposition(suggestion.id, retry);
    worker = new SuggestionComposer(async () => result); worker.start(); await worker.idle();
    expect(getSuggestionLearning(suggestion.id).composition?.attempts).toBe(2);
    retrySuggestionComposition(suggestion.id, retry);
    expect(listFlows()).toHaveLength(1);
  });

  test('expired claims fail explicitly and late completion cannot attach a duplicate draft', () => {
    const suggestion = proposal(); acceptSuggestion(suggestion.id, acceptance);
    const old = claimSuggestionComposition()!;
    getDb().run('UPDATE suggestion_composition_jobs SET lease_until = 0');
    closeDb(); initWorkflowDb(path); recoverExpiredCompositions();
    expect(getSuggestionLearning(suggestion.id).composition?.error).toContain('interrupted');
    retrySuggestionComposition(suggestion.id, { requestId: 'retry-1', reason: 'Recover interrupted request' });
    const next = claimSuggestionComposition()!;
    expect(next.lease_token).not.toBe(old.lease_token);
    expect(attachSuggestionDraft(old, result)).toBe(false);
    failSuggestionComposition(old, 'stale worker failure');
    expect(attachSuggestionDraft(next, result)).toBe(true);
    expect(listFlows()).toHaveLength(1);
  });

  test('shutdown fences late LLM completion across a database reopen', async () => {
    const suggestion = proposal(); acceptSuggestion(suggestion.id, acceptance);
    const gate = deferred<ComposeResult>();
    let signal: AbortSignal | undefined;
    worker = new SuggestionComposer(request => { signal = request.signal; return gate.promise; });
    worker.start(); worker.stop(); await worker.idle();
    expect(signal?.aborted).toBe(true);
    closeDb(); initWorkflowDb(path); gate.resolve(result); await Promise.resolve();
    expect(listFlows()).toHaveLength(0);
    expect(getSuggestionLearning(suggestion.id).composition?.state).toBe('failed');
  });

  test('timeout releases the queue and retains an actionable failure', async () => {
    const suggestion = proposal(); acceptSuggestion(suggestion.id, acceptance);
    let signal: AbortSignal | undefined;
    worker = new SuggestionComposer(request => { signal = request.signal; return new Promise(() => {}); }, 20);
    worker.start(); await worker.idle();
    expect(signal?.aborted).toBe(true);
    expect(getSuggestionLearning(suggestion.id).composition?.error).toContain('timed out');
    expect(listFlows()).toHaveLength(0);
  });

  test('deleting a composed flow preserves its historical IDs and never silently creates a second draft', () => {
    const suggestion = proposal(); acceptSuggestion(suggestion.id, acceptance);
    attachSuggestionDraft(claimSuggestionComposition()!, result);
    const before = getSuggestionLearning(suggestion.id).composition!;
    deleteFlow(before.workflowId!);
    expect(getSuggestionLearning(suggestion.id).composition?.draftAvailable).toBe(false);
    expect(acceptSuggestion(suggestion.id, acceptance).composition?.workflowId).toBe(before.workflowId);
    expect(claimSuggestionComposition()).toBeNull();
  });
});

test('routes validate JSON, IDs, reason, conflicts and operate without an awareness service', async () => {
  const suggestion = proposal(); const routes = createSuggestionFeedbackRoutes(() => null);
  const req = (id: string, input: string) => Object.assign(new Request('http://localhost', { method: 'POST', body: input }), { params: { id } });
  const post = routes['/api/awareness/suggestions/:id/accept'].POST;
  expect((await post(req('missing', JSON.stringify(acceptance)))).status).toBe(404);
  expect((await post(req(suggestion.id, '{'))).status).toBe(400);
  expect((await post(req(suggestion.id, JSON.stringify({ ...acceptance, reason: '' })))).status).toBe(400);
  expect((await post(req(suggestion.id, JSON.stringify({ ...acceptance, observationIds: ['invented'] })))).status).toBe(400);
  expect((await post(req(suggestion.id, JSON.stringify(acceptance)))).status).toBe(200);
  expect((await post(req(suggestion.id, JSON.stringify({ ...acceptance, name: 'Changed' })))).status).toBe(409);
  expect((await routes['/api/awareness/compositions'].GET()).status).toBe(200);
});

test('routine discovery pages canonical proposals and decisions without a notification-age cutoff', async () => {
  const old = proposal();
  getDb().run('UPDATE awareness_suggestions SET created_at = 1, delivered = 1 WHERE id = ?', [old.id]);
  markSuggestionDismissed(old.id, 'Already handled');
  getDb().transaction(() => {
    for (let i = 0; i < 104; i++) createSuggestion({ type: 'automation', title: `Routine ${i}`, body: 'Recurring work',
      context: { opportunity: { patternKey: `test-job-${i}` } } });
    createSuggestion({ type: 'break', title: 'Take a break', body: 'Independent rhythm' });
  })();
  closeDb(); initWorkflowDb(path);
  const routes = createSuggestionFeedbackRoutes(() => null);
  const list = (offset: number) => routes['/api/awareness/routines'].GET(new Request(`http://localhost/api/awareness/routines?offset=${offset}`));
  const first = await (await list(0)).json(); const second = await (await list(first.nextOffset)).json();
  expect(first.suggestions).toHaveLength(100); expect(second.suggestions).toHaveLength(5);
  expect(second.nextOffset).toBeNull();
  const all = [...first.suggestions, ...second.suggestions];
  expect(new Set(all.map(row => row.opportunityId)).size).toBe(105);
  expect(all.find(row => row.opportunityId === old.id).status).toBe('dismissed');
  expect((await list(-1)).status).toBe(400);
});
