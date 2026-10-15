import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb } from '../workflows/db';
import { closeDb, getDb } from '../vault/schema';
import { createSuggestion } from '../vault/awareness';
import { acceptSuggestion, retrySuggestionComposition } from './suggestion-feedback';
import { claimSuggestionComposition, failSuggestionComposition, SuggestionComposer } from './suggestion-composer';
import { COMPOSITION_LIMITS, compositionQueueStatus } from './composition-budget';
import { createSuggestionFeedbackRoutes } from './suggestion-feedback-routes';
import { currentOrigin } from '../llm/origin';
let dir: string, path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'q20-')); path = join(dir, 'test.db'); initWorkflowDb(path); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
const input = { requestId: 'accept', reason: 'fixture', name: 'fixture', description: 'fixture job', expectedOutcome: 'fixture result' };
function enqueue(n: number) { const s = createSuggestion({ type: 'automation', title: `Fixture ${n}`, body: `Work ${n}` }); acceptSuggestion(s.id, input); return s.id; }

test('queue admission is bounded, idempotent at capacity, and refuses atomically', () => {
  let first = '';
  for (let i = 0; i < COMPOSITION_LIMITS.queued; i++) { const id = enqueue(i); if (!i) first = id; }
  expect(acceptSuggestion(first, input).composition?.state).toBe('queued');
  expect(() => enqueue(100)).toThrow('queue is full');
  expect(getDb().query('SELECT * FROM suggestion_feedback').all()).toHaveLength(COMPOSITION_LIMITS.queued);
});

test('two workers cannot claim concurrently; rolling allowance and attempt caps survive restart', () => {
  const id = enqueue(0); enqueue(1);
  const job = claimSuggestionComposition()!;
  expect(claimSuggestionComposition()).toBeNull();
  failSuggestionComposition(job, 'fixture');
  getDb().run('UPDATE suggestion_composition_jobs SET attempts = 3 WHERE suggestion_id = ?', [id]);
  expect(() => retrySuggestionComposition(id, { requestId: 'retry', reason: 'fixture' })).toThrow('attempt limit');
  for (let i = 1; i < COMPOSITION_LIMITS.dailyAttempts; i++) getDb().run('INSERT INTO suggestion_composition_attempts(job_id,started_at) VALUES (?,?)', [job.id, Date.now()]);
  closeDb(); initWorkflowDb(path);
  expect(claimSuggestionComposition()).toBeNull(); expect(compositionQueueStatus().reason).toBe('daily_budget');
  getDb().run('UPDATE suggestion_composition_attempts SET started_at = 0');
  expect(claimSuggestionComposition()).not.toBeNull();
});

test('budget/target admission leaves work queued without attempts; later admission runs as background', async () => {
  enqueue(1); let ready = false, calls = 0;
  const worker = new SuggestionComposer(async () => { expect(currentOrigin()).toBe('background'); calls++; return { ok: false, errors: ['fixture'], rawResponse: null }; }, 100, () => ready);
  try {
    worker.start(); await worker.idle(); expect(calls).toBe(0); expect(compositionQueueStatus().attempts).toBe(0);
    ready = true; worker.kick(); await worker.idle(); expect(calls).toBe(1);
  } finally { worker.stop(); await worker.idle(); }
  const response = await createSuggestionFeedbackRoutes(() => null)['/api/awareness/background'].GET();
  const status = await response.json(); expect(status.composition.workerAvailable).toBe(false); expect(status.composition.queued).toBe(0);
});
