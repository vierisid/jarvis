import { getDb, generateId } from '../vault/schema.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion } from '../workflows/db/repos/flow-version.ts';
import type { ComposeResult, ComposeRequest } from '../actions/tools/workflow-composer.ts';
import { canonicalSuggestion, type CompositionRequest, type CompositionRow } from './suggestion-feedback.ts';

const COMPOSITION_TIMEOUT_MS = 5 * 60_000;
export type ComposeSuggestion = (request: ComposeRequest) => Promise<ComposeResult>;

export function recoverExpiredCompositions(now = Date.now()): void {
  getDb().run(`UPDATE suggestion_composition_jobs SET state = 'failed', lease_token = NULL, lease_until = 0,
    error = 'Composition was interrupted or timed out. Review the saved request and retry.', updated_at = ?
    WHERE state = 'running' AND lease_until <= ?`, [now, now]);
}

export function claimSuggestionComposition(timeoutMs = COMPOSITION_TIMEOUT_MS): CompositionRow | null {
  return getDb().transaction(() => {
    const now = Date.now();
    recoverExpiredCompositions(now);
    const row = getDb().query<CompositionRow, []>(`SELECT * FROM suggestion_composition_jobs
      WHERE state = 'queued' ORDER BY created_at, id LIMIT 1`).get();
    if (!row) return null;
    const token = generateId();
    getDb().run(`UPDATE suggestion_composition_jobs SET state = 'running', attempts = attempts + 1,
      lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?`, [token, now + timeoutMs, now, row.id]);
    return { ...row, state: 'running' as const, attempts: row.attempts + 1, lease_token: token, lease_until: now + timeoutMs };
  }).immediate();
}

export function failSuggestionComposition(job: CompositionRow, message: string): void {
  getDb().run(`UPDATE suggestion_composition_jobs SET state = 'failed', error = ?,
    lease_token = NULL, lease_until = 0, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?`,
    [message.slice(0, 4000), Date.now(), job.id, job.lease_token]);
}

/** The LLM has already finished. Flow, draft and attachment are ONE local commit. */
export function attachSuggestionDraft(job: CompositionRow, result: Extract<ComposeResult, { ok: true }>): boolean {
  return getDb().transaction(() => {
    const current = getDb().query<CompositionRow, [string]>('SELECT * FROM suggestion_composition_jobs WHERE id = ?').get(job.id);
    if (!current || current.state !== 'running' || current.lease_token !== job.lease_token || current.lease_until <= Date.now()) return false;
    if (canonicalSuggestion(job.suggestion_id).dismissed) {
      failSuggestionComposition(job, 'Suggestion was dismissed during composition. No draft was created.');
      return false;
    }
    const request = JSON.parse(job.request) as CompositionRequest;
    const flow = createFlow({ metadata: { opportunityId: job.suggestion_id, compositionId: job.id, feedbackId: job.feedback_id,
      ...(result.compositionRecordId ? { compositionRecordId: result.compositionRecordId } : {}) } });
    const version = createDraftVersion({ flowId: flow.id, displayName: result.flow.displayName.trim() || request.name,
      trigger: result.flow.trigger });
    getDb().run(`UPDATE suggestion_composition_jobs SET state = 'draft_ready', flow_id = ?, version_id = ?,
      error = NULL, lease_token = NULL, lease_until = 0, updated_at = ? WHERE id = ?`,
      [flow.id, version.id, Date.now(), job.id]);
    return true;
  }).immediate();
}

/** Independent of capture/awareness enablement. No transaction spans compose(). */
export class SuggestionComposer {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: { job: CompositionRow; abort: AbortController } | null = null;
  private pending: Promise<void> | null = null;

  constructor(private compose: ComposeSuggestion, private timeoutMs = COMPOSITION_TIMEOUT_MS) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    recoverExpiredCompositions();
    this.timer = setInterval(() => this.kick(), 5_000);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active) {
      failSuggestionComposition(this.active.job, 'Composition interrupted by shutdown. Review the saved request and retry.');
      this.active.abort.abort();
      this.active = null;
    }
  }

  kick(): void {
    if (!this.running || this.pending) return;
    this.pending = this.drain().catch(error => console.error('[SuggestionComposer]', error)).finally(() => { this.pending = null; });
  }

  /** Also provides a deterministic idle boundary for tests. */
  async idle(): Promise<void> { await this.pending; }

  private async drain(): Promise<void> {
    while (this.running) {
      const job = claimSuggestionComposition(this.timeoutMs);
      if (!job) return;
      const active = { job, abort: new AbortController() };
      this.active = active;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (canonicalSuggestion(job.suggestion_id).dismissed) throw new Error('Suggestion was dismissed. No draft was created.');
        const request = JSON.parse(job.request) as CompositionRequest;
        const result = await Promise.race([
          this.compose({ name: request.name, description: `${request.description}\n\nExpected result: ${request.expectedOutcome}`,
            signal: active.abort.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => active.abort.abort(new Error('Composition timed out. Review the request and retry.')), this.timeoutMs);
            active.abort.signal.addEventListener('abort', () => reject(active.abort.signal.reason), { once: true });
          }),
        ]);
        // A stopped/replaced worker must never write into a reopened database.
        if (!this.running || this.active !== active) return;
        if (result.ok) {
          if (!attachSuggestionDraft(job, result)) failSuggestionComposition(job, 'Composition lease expired. Review the request and retry.');
        } else {
          const installs = result.suggestedInstalls?.map(p => p.displayName ?? p.id).join(', ');
          failSuggestionComposition(job, result.errors.join('\n') + (installs ? `\nRequired pieces: ${installs}` : ''));
        }
      } catch (error) {
        if (this.running && this.active === active) failSuggestionComposition(job, error instanceof Error ? error.message : String(error));
      } finally {
        if (timer) clearTimeout(timer);
        // Also cancel transport work orphaned by a provider/router's own timeout.
        active.abort.abort();
        if (this.active === active) this.active = null;
      }
    }
  }
}
