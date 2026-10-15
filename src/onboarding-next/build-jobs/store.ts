import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { getWorkflowDb } from '../../workflows/db';
import { digest, scopeId } from './input';
import { BuildError, type Artifact, type Outcome, type Phase, type Reason, type Result, type Scope, type Status, type SubmitInput } from './types';

const PHASES: Phase[] = ['understanding', 'building', 'validating', 'saving'];
const TERMINAL: Outcome[] = ['needs_input', 'succeeded', 'failed', 'cancelled'];
const MAX_EVENTS = 64;
const MESSAGES: Partial<Record<Reason, string>> = {
  timeout: 'The build timed out. Checking whether a draft was saved.',
  interrupted: 'The worker stopped. Check status to recover this build.',
  provider_unavailable: 'The build service is unavailable. The saved result has not been confirmed.',
  composition_failed: 'The workflow could not be composed. Review the request before starting a new build.',
  needs_input: 'Review the request and supply the missing details before starting a new build.',
  attempt_limit: 'The build reached its retry limit. Review the request before starting a new build.',
};
export interface Job {
  schemaVersion: 1; id: string; owner: Scope; digest: string; input: SubmitInput;
  revision: number; outcome: Outcome; phase?: Phase; phaseSequence: number;
  cancellation: Status['cancellation']; resolution: Status['resolution']; artifact: Artifact | null;
  journeySync: Status['journeySync']; reason?: Reason; missingInputs: string[];
  token: string | null; leaseUntil: number; deadline: number | null; attempts: number; retryAfter: number;
  stopReason: 'timeout' | 'composition_failed' | 'needs_input' | 'attempt_limit' | null;
}
export const terminal = (j: Job) => TERMINAL.includes(j.outcome);
const project = (j: Job): Status => ({ schemaVersion: 1, scopeId: scopeId(j.owner), journeyId: j.input.journeyId,
  jobId: j.id, requestId: j.input.submission.request.requestId, requestDigest: j.digest, revision: j.revision,
  outcome: j.outcome, ...(j.phase ? { phase: j.phase } : {}),
  completedPhases: j.outcome === 'succeeded' ? [...PHASES] : j.phase ? PHASES.slice(0, PHASES.indexOf(j.phase)) : [],
  cancellation: j.cancellation, resolution: j.resolution, artifact: j.artifact,
  journeySync: j.journeySync, ...(j.reason && MESSAGES[j.reason] ? { safeError: j.reason === 'timeout' && j.resolution === 'none'
    ? 'The build timed out before a draft was saved. Review the request before starting a new build.' : MESSAGES[j.reason] } : {}), missingInputs: [...j.missingInputs] });

/** Explicit provisioning on the workflow database. Factories never provision or start workers. */
export function initializeBuildJobStore(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS onboarding_build_job (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
    record TEXT NOT NULL, UNIQUE(actor_id, project_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS onboarding_build_event (
    job_id TEXT NOT NULL REFERENCES onboarding_build_job(id), revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(job_id, revision)
  );`);
}

export function createSqliteBuildStore(db: Database, options: { now?: () => number } = {}) {
  const current = () => { if (getWorkflowDb() !== db) throw new BuildError('binding_missing'); };
  const now = () => {
    const n = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(n) || n < 0) throw new BuildError('storage_unavailable');
    return n;
  };
  function read(scope: Scope, ref: { jobId?: string; requestId?: string }): Job | null {
    current();
    const row = db.query<{ record: string }, [string, string, string]>(`SELECT record FROM onboarding_build_job
      WHERE actor_id = ? AND project_id = ? AND ${ref.jobId ? 'id' : 'request_id'} = ?`).get(scope.actorId, scope.projectId, ref.jobId ?? ref.requestId!);
    if (!row) return null;
    const job = JSON.parse(row.record) as Job;
    if (job.schemaVersion !== 1 || job.owner.actorId !== scope.actorId || job.owner.projectId !== scope.projectId
      || !Number.isSafeInteger(job.revision) || job.revision < 1
      || !['queued', 'working', ...TERMINAL].includes(job.outcome)) throw new BuildError('storage_unavailable');
    return job;
  }
  function write(job: Job, event = true) {
    current();
    if (event) job.revision++;
    db.run('UPDATE onboarding_build_job SET record = ? WHERE id = ?', [JSON.stringify(job), job.id]);
    if (event) {
      db.run('INSERT INTO onboarding_build_event (job_id, revision, snapshot) VALUES (?, ?, ?)', [job.id, job.revision, JSON.stringify(project(job))]);
      db.run('DELETE FROM onboarding_build_event WHERE job_id = ? AND revision <= ?', [job.id, job.revision - MAX_EVENTS]);
    }
  }
  const transaction = <T>(fn: () => T): T => { current(); return db.transaction(fn).immediate(); };
  const owns = (j: Job, token: string) => !terminal(j) && j.token === token && j.leaseUntil > now();
  const canCommit = (j: Job, token: string) => owns(j, token) && j.cancellation === 'not_requested' && j.stopReason === null && j.deadline! > now();
  function change(scope: Scope, id: string, token: string, update: (j: Job) => boolean): boolean {
    return transaction(() => {
      const j = read(scope, { jobId: id });
      if (!j || !owns(j, token) || !update(j)) return false;
      write(j); return true;
    });
  }
  return {
    current, now, read,
    accept(scope: Scope, input: SubmitInput): Job {
      return transaction(() => {
        const existing = read(scope, { requestId: input.submission.request.requestId });
        if (existing) {
          if (existing.digest !== digest(input.submission) || existing.input.journeyId !== input.journeyId) throw new BuildError('conflict');
          return existing;
        }
        const job: Job = { schemaVersion: 1, id: randomUUID(), owner: scope, input: structuredClone(input), digest: digest(input.submission),
          revision: 0, outcome: 'queued', phaseSequence: -1, cancellation: 'not_requested', resolution: 'pending', artifact: null,
          journeySync: 'pending', missingInputs: [], token: null, leaseUntil: 0, deadline: null, attempts: 0, retryAfter: 0, stopReason: null };
        db.run('INSERT INTO onboarding_build_job (id, actor_id, project_id, request_id, record) VALUES (?, ?, ?, ?, ?)',
          [job.id, scope.actorId, scope.projectId, input.submission.request.requestId, JSON.stringify(job)]);
        write(job); return job;
      });
    },
    result(scope: Scope, jobId: string, after = 0): Result {
      return transaction(() => {
        const job = read(scope, { jobId });
        if (!job) throw new BuildError('not_found');
        const rows = db.query<{ snapshot: string }, [string, number]>(`SELECT snapshot FROM onboarding_build_event
          WHERE job_id = ? AND revision > ? ORDER BY revision LIMIT ${MAX_EVENTS}`).all(jobId, after);
        const events = rows.map(r => JSON.parse(r.snapshot) as Status);
        return { availability: 'ready', status: project(job), events, cursor: job.revision,
          truncated: events.length > 0 && events[0]!.revision > after + 1 };
      });
    },
    pending(scope: Scope, limit = 20): string[] {
      current();
      // Bounded index page is scoped. JSON expressions keep one authoritative record.
      return db.query<{ id: string }, [string, string, number, number, number]>(`SELECT id FROM onboarding_build_job
        WHERE actor_id = ? AND project_id = ? AND json_extract(record, '$.retryAfter') <= ? AND (
          (json_extract(record, '$.outcome') IN ('queued', 'working') AND json_extract(record, '$.leaseUntil') <= ?)
          OR (json_extract(record, '$.outcome') IN ('needs_input', 'succeeded', 'failed', 'cancelled')
            AND json_extract(record, '$.journeySync') != 'settled'))
        ORDER BY json_extract(record, '$.retryAfter'), rowid LIMIT ?`).all(scope.actorId, scope.projectId, now(), now(), Math.max(1, Math.min(100, limit))).map(r => r.id);
    },
    claim(scope: Scope, id: string, leaseMs: number, timeoutMs: number): Job | null {
      return transaction(() => {
        const j = read(scope, { jobId: id });
        if (!j || terminal(j) || j.leaseUntil > now() || j.retryAfter > now()) return null;
        j.token = randomUUID(); j.leaseUntil = now() + leaseMs; j.deadline ??= now() + timeoutMs;
        j.outcome = 'working'; j.phase = undefined; j.phaseSequence = -1;
        write(j); return j;
      });
    },
    mayCommit(scope: Scope, id: string, token: string): boolean {
      const j = read(scope, { jobId: id }); return !!j && canCommit(j, token);
    },
    renew(scope: Scope, id: string, token: string, leaseMs: number): boolean {
      return transaction(() => {
        const j = read(scope, { jobId: id });
        if (!j || !owns(j, token)) return false;
        j.leaseUntil = now() + leaseMs; write(j, false); return true;
      });
    },
    phase(scope: Scope, id: string, token: string, phase: Phase, sequence: number): boolean {
      return change(scope, id, token, j => {
        if (!canCommit(j, token) || !PHASES.includes(phase) || !Number.isSafeInteger(sequence) || sequence <= j.phaseSequence
          || (j.phase && PHASES.indexOf(phase) < PHASES.indexOf(j.phase))) return false;
        j.phase = phase; j.phaseSequence = sequence; return true;
      });
    },
    attempt(scope: Scope, id: string, token: string, max: number): boolean {
      return change(scope, id, token, j => {
        if (!canCommit(j, token) || j.attempts >= max) return false;
        j.attempts++; return true;
      });
    },
    stop(scope: Scope, id: string, token: string, reason: NonNullable<Job['stopReason']>, missingInputs: string[] = []) {
      return change(scope, id, token, j => {
        j.stopReason = reason; j.reason = reason; j.resolution = 'unknown'; j.phase = undefined;
        j.missingInputs = missingInputs.slice(0, 20).map(s => s.slice(0, 512)); return true;
      });
    },
    defer(scope: Scope, id: string, token: string, reason: 'provider_unavailable' | 'interrupted') {
      return change(scope, id, token, j => {
        j.token = null; j.leaseUntil = 0; j.resolution = 'unknown'; j.reason = reason; j.phase = undefined;
        j.retryAfter = now() + 1000; return true;
      });
    },
    cancel(scope: Scope, id: string) {
      return transaction(() => {
        const j = read(scope, { jobId: id });
        if (!j) throw new BuildError('not_found');
        if (terminal(j) || j.cancellation !== 'not_requested') return;
        // Fence the old worker synchronously before any cancellation acknowledgement.
        j.cancellation = 'requested'; j.token = null; j.leaseUntil = 0; j.retryAfter = 0;
        j.resolution = 'unknown'; j.phase = undefined; write(j);
      });
    },
    finish(scope: Scope, id: string, token: string, artifact: Artifact | null) {
      return change(scope, id, token, j => {
        if (!artifact && j.cancellation !== 'requested' && !j.stopReason) return false;
        j.artifact = artifact; j.resolution = artifact ? 'saved' : 'none';
        j.outcome = artifact ? 'succeeded' : j.cancellation === 'requested' ? 'cancelled' : j.stopReason === 'needs_input' ? 'needs_input' : 'failed';
        if (j.cancellation === 'requested') j.cancellation = 'acknowledged';
        if (artifact) { j.reason = undefined; j.missingInputs = []; }
        if (j.outcome === 'cancelled') j.reason = undefined;
        j.phase = undefined; j.token = null; j.leaseUntil = 0; return true;
      });
    },
    synced(scope: Scope, id: string, state: Status['journeySync']) {
      transaction(() => {
        const j = read(scope, { jobId: id });
        if (!j || j.journeySync === state || j.journeySync === 'settled' || (state === 'started' && terminal(j))) return;
        j.journeySync = state; write(j);
      });
    },
    retrySync(scope: Scope, id: string) {
      transaction(() => {
        const j = read(scope, { jobId: id });
        if (j && terminal(j) && j.journeySync !== 'settled') { j.retryAfter = now() + 1000; write(j, false); }
      });
    },
  };
}
export type BuildStore = ReturnType<typeof createSqliteBuildStore>;
