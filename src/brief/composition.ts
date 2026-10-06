import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../workflows/db/index';
import { apId } from '../workflows/db/ids';
import { walkFlowNodes } from '../workflows/db/flow-graph';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { composePersistedFlow } from '../actions/tools/persisted-workflow-composer';
import type { ComposeDeps } from '../actions/tools/workflow-composer';
import { COMPOSITION_LIMITS as limits, type BriefCompositionJob, type BriefComposeRequest } from './composition-contracts';
import { ensureCompositionJobSchema } from './composition-schema';

export class CompositionRequestError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
interface JobRow {
  id: string; project_id: string; request_id: string; name: string; prompt: string;
  state: BriefCompositionJob['state']; checked_candidates: number;
  composition_id: string | null; flow_id: string | null; version_id: string | null;
  blocker: string | null; created_at: number; updated_at: number;
}
const terminal = (row: JobRow) => row.state !== 'queued' && row.state !== 'running';
function project(row: JobRow): BriefCompositionJob {
  return { jobId: row.id, requestId: row.request_id, specification: { name: row.name, prompt: row.prompt },
    state: row.state, progress: { checkedCandidates: row.checked_candidates }, compositionId: row.composition_id,
    workflow: row.flow_id && row.version_id ? { flowId: row.flow_id, versionId: row.version_id } : null,
    blocker: row.blocker ? JSON.parse(row.blocker) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** One worker per daemon. Never restart provider work or run a prepared draft implicitly. */
export class BriefCompositionProvider {
  private dependencies: (() => ComposeDeps) | null = null;
  private stopped = false;
  private pending: Promise<void> | null = null;
  private requested = false;
  private active: { id: string; abort: AbortController } | null = null;

  constructor(private readonly db: Database, private readonly projectId: string = DEFAULT_IDS.project, private readonly timeoutMs = 190_000) {
    ensureCompositionJobSchema(db);
    // The daemon owns this worker. On a new process, interrupted/uncertain work
    // retains its identity and prompt, and requires a new explicit request to retry.
    this.interruptPending();
  }

  configure(dependencies: () => ComposeDeps): void { this.dependencies = dependencies; }
  readiness(): 'ready' | 'unavailable' {
    return !this.stopped && this.dependencies && this.currentDatabase() ? 'ready' : 'unavailable';
  }
  private currentDatabase(): boolean {
    try { return this.db === getWorkflowDb() && !!this.db.query('SELECT 1').get(); } catch { return false; }
  }
  private row(id: string): JobRow {
    const row = this.db.query<JobRow, [string, string]>('SELECT * FROM brief_workflow_composition_jobs WHERE id = ? AND project_id = ?').get(id, this.projectId);
    if (!row) throw new CompositionRequestError('Composition job not found', 404);
    return row;
  }
  get(id: string): BriefCompositionJob { return project(this.row(id)); }
  list(requestId?: string): BriefCompositionJob[] {
    if (requestId !== undefined) {
      const row = this.db.query<JobRow, [string, string]>('SELECT * FROM brief_workflow_composition_jobs WHERE project_id = ? AND request_id = ?').get(this.projectId, requestId);
      return row ? [project(row)] : [];
    }
    return this.db.query<JobRow, [string]>('SELECT * FROM brief_workflow_composition_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(this.projectId).map(project);
  }
  submit(input: BriefComposeRequest): { job: BriefCompositionJob; created: boolean } {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['requestId', 'prompt', 'name'].includes(k))) throw new CompositionRequestError('Invalid composition fields');
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new CompositionRequestError('A stable requestId is required');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new CompositionRequestError('Describe what this workflow should do');
    if (Buffer.byteLength(input.prompt, 'utf8') > limits.promptBytes) throw new CompositionRequestError('Prompt exceeds its size limit', 413);
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > limits.nameChars)) throw new CompositionRequestError('Invalid workflow name');
    const name = input.name ?? 'New workflow';
    const result = this.db.transaction(() => {
      const old = this.db.query<JobRow, [string, string]>('SELECT * FROM brief_workflow_composition_jobs WHERE project_id = ? AND request_id = ?').get(this.projectId, input.requestId);
      if (old) {
        if (old.prompt !== input.prompt || old.name !== name) throw new CompositionRequestError('This requestId belongs to a different specification', 409);
        return { job: project(old), created: false };
      }
      if (this.readiness() !== 'ready') throw new CompositionRequestError('Workflow composer is unavailable', 503);
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM brief_workflow_composition_jobs WHERE project_id = ? AND state IN ('queued','running')").get(this.projectId)!.n;
      if (count >= limits.pendingJobs) throw new CompositionRequestError('Composition queue is full; retry this request shortly', 429);
      const id = apId(), now = Date.now();
      this.db.run(`INSERT INTO brief_workflow_composition_jobs(id, project_id, request_id, name, prompt, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`, [id, this.projectId, input.requestId, name, input.prompt, now, now]);
      return { job: this.get(id), created: true };
    }).immediate();
    this.kick();
    return result;
  }
  cancel(id: string): BriefCompositionJob {
    this.db.transaction(() => {
      const row = this.row(id);
      if (!terminal(row)) this.finish(id, 'cancelled', { code: 'cancelled', message: 'Composition cancelled. The original request is saved.', details: [] });
    }).immediate();
    if (this.active?.id === id) this.active.abort.abort();
    return this.get(id);
  }
  stop(): void {
    this.stopped = true;
    this.tryInterruptPending();
    this.active?.abort.abort();
  }
  async idle(): Promise<void> { while (this.pending) await this.pending; }

  private interruptPending(): void {
    this.db.run(`UPDATE brief_workflow_composition_jobs SET state = 'failed', blocker = ?, updated_at = ?
      WHERE project_id = ? AND state IN ('queued','running')`, [JSON.stringify({ code: 'interrupted', message: 'Composition was interrupted. Your request is saved; submit a new requestId to retry explicitly.', details: [] }), Date.now(), this.projectId]);
  }
  private tryInterruptPending(): void {
    try { if (this.currentDatabase()) this.interruptPending(); }
    catch { /* Unwritable storage retains its last checkpoint for startup recovery; still abort work. */ }
  }
  private finish(id: string, state: BriefCompositionJob['state'], blocker: NonNullable<BriefCompositionJob['blocker']>): void {
    this.db.run(`UPDATE brief_workflow_composition_jobs SET state = ?, blocker = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND state IN ('queued','running')`, [state, JSON.stringify(blocker), Date.now(), id, this.projectId]);
  }
  private kick(): void {
    this.requested = true;
    if (this.pending || this.readiness() !== 'ready') return;
    this.requested = false;
    this.pending = Promise.resolve().then(() => this.drain()).catch(() => {
      // Leave a durable interrupted outcome rather than leaking database/provider diagnostics.
      this.tryInterruptPending();
    }).finally(() => {
      this.pending = null;
      // A submission can arrive between drain returning and this microtask.
      if (this.requested) this.kick();
    });
  }
  private async drain(): Promise<void> {
    while (this.readiness() === 'ready') {
      const row = this.db.transaction(() => {
        const next = this.db.query<JobRow, [string]>("SELECT * FROM brief_workflow_composition_jobs WHERE project_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1").get(this.projectId);
        if (!next) return null;
        this.db.run("UPDATE brief_workflow_composition_jobs SET state = 'running', updated_at = ? WHERE id = ?", [Date.now(), next.id]);
        return next;
      }).immediate();
      if (!row) return;
      const active = { id: row.id, abort: new AbortController() }; this.active = active;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; active.abort.abort(); }, this.timeoutMs);
      const owns = () => !this.stopped && this.currentDatabase() && this.active === active && this.row(row.id).state === 'running' && !active.abort.signal.aborted;
      try {
        const deps = this.dependencies!();
        const compose = composePersistedFlow({ ...deps, onCandidate: candidate => {
          if (!owns()) throw new Error('Composition is no longer active');
          this.db.run('UPDATE brief_workflow_composition_jobs SET checked_candidates = checked_candidates + 1, updated_at = ? WHERE id = ?', [Date.now(), row.id]);
          deps.onCandidate?.(candidate);
        } }, { name: row.name, description: row.prompt, signal: active.abort.signal }, { projectId: this.projectId, onJournal: id => {
          if (!owns()) throw new Error('Composition is no longer active');
          this.db.run('UPDATE brief_workflow_composition_jobs SET composition_id = ?, updated_at = ? WHERE id = ?', [id, Date.now(), row.id]);
        } });
        const result = await Promise.race([compose, new Promise<never>((_, reject) => {
          if (active.abort.signal.aborted) reject(new Error('Composition stopped'));
          else active.abort.signal.addEventListener('abort', () => reject(new Error('Composition stopped')), { once: true });
        })]);
        if (!owns()) continue;
        if (!result.ok) {
          this.finish(row.id, result.blocked ? 'blocked' : 'failed', { code: result.errorCode === 'composition_timeout' ? 'timeout' : result.blocked ? 'composition_blocked' : 'composition_failed',
            message: result.blocked ? 'More information or an available capability is needed.' : 'A valid workflow could not be prepared. Review the saved request and retry explicitly.',
            // Provider diagnostics and malformed-response excerpts stay in the journal.
            details: result.blocked ? result.errors.slice(0, 6).map(message => message.slice(0, 500)) : [] });
        } else if (!walkFlowNodes(result.flow.trigger).some(node => node.type === 'PIECE')) {
          this.finish(row.id, 'blocked', { code: 'insufficient_information', message: 'No workflow actions were prepared. Describe the action, its destination and when it should run.', details: [] });
        } else {
          this.db.transaction(() => {
            if (!owns()) return;
            const flow = createFlow({ projectId: this.projectId, metadata: { compositionJobId: row.id, compositionRecordId: result.compositionRecordId } });
            const version = createDraftVersion({ flowId: flow.id, displayName: result.flow.displayName.trim() || row.name, trigger: result.flow.trigger });
            this.db.run("UPDATE brief_workflow_composition_jobs SET state = 'draft_ready', flow_id = ?, version_id = ?, updated_at = ? WHERE id = ?", [flow.id, version.id, Date.now(), row.id]);
          }).immediate();
        }
      } catch {
        if (!this.stopped && this.currentDatabase() && this.active === active) this.finish(row.id, 'failed', {
          code: timedOut ? 'timeout' : 'composition_failed', message: timedOut ? 'Composition timed out. Your request is saved; retry explicitly with a new requestId.' : 'Composition could not finish. Your request is saved; check model availability and retry explicitly.', details: [],
        });
      } finally {
        clearTimeout(timer); active.abort.abort(); if (this.active === active) this.active = null;
      }
    }
  }
}
