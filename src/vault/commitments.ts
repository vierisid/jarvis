import type { Database } from 'bun:sqlite';
import { getDb, generateId } from './schema.ts';
import { currentTurnScopeId } from '../actions/tools/turn-scope-store.ts';
import { oneLineTaskText } from './commitment-text.ts';

export type CommitmentPriority = 'low' | 'normal' | 'high' | 'critical';
export type CommitmentStatus = 'pending' | 'active' | 'completed' | 'failed' | 'escalated';

export const COMMITMENT_PRIORITIES: readonly CommitmentPriority[] = ['low', 'normal', 'high', 'critical'];
export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ['pending', 'active', 'completed', 'failed', 'escalated'];

export type CommitmentScheduleOptions = {
  /** Linked work uses its own decision and execution contract, even when it has a due date. */
  excludeWorkItems?: boolean;
};

const EXCLUDE_WORK_ITEMS = 'AND NOT EXISTS (SELECT 1 FROM commitment_work WHERE work_id = commitments.id)';

/**
 * Result prefix of a commitment the executor parked on approval requests
 * (daemon/commitment-executor.ts). The request ids ride in the stored result
 * so a restarted daemon picks the wait back up instead of running the
 * commitment again -- which makes the result text an instruction to the
 * executor: on its next tick it waits on those ids and closes the commitment
 * from their outcome, taking an executed request's result as its own (#1115).
 */
export const PARKED_RESULT_PREFIX = 'Awaiting user approval ';
const PARKED_RESULT_RE = /^Awaiting user approval \[req:([^\]]*)\]/;

/** Request ids encoded in a parked commitment's result, or null if not parked. */
export function parseParkedRequestIds(result: string | null | undefined): string[] | null {
  if (!result) return null;
  const m = PARKED_RESULT_RE.exec(result);
  if (!m) return null;
  return m[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * A result any writer but the executor's parking may store (#1115): one the
 * executor would read as parked is labelled so it no longer does. The writers
 * that store a model's reply (the executor's completion, the chat's tracked
 * task) cannot be refused, so this is where they are held; the dashboard and
 * the commitments tool refuse such a result first, with a reason.
 */
function storableResult(result: string | undefined): string | undefined {
  return result !== undefined && parseParkedRequestIds(result) ? `Result: ${result}` : result;
}

/** A task whose text has nothing left in it once made one line (#1115). */
export class CommitmentTextError extends Error {
  override readonly name = 'CommitmentTextError';
}

export function isWorkItemCommitment(id: string): boolean {
  return !!getDb().query('SELECT 1 FROM commitment_work WHERE work_id = ?').get(id);
}

export type RetryPolicy = {
  max_retries: number;
  interval_ms: number;
  escalate_after: number;
};

export type Commitment = {
  id: string;
  what: string;
  when_due: number | null;
  context: string | null;
  priority: CommitmentPriority;
  status: CommitmentStatus;
  retry_policy: RetryPolicy | null;
  created_from: string | null;
  assigned_to: string | null;
  created_at: number;
  completed_at: number | null;
  result: string | null;
  sort_order: number;
  /**
   * Id of the tool scope the turn that created this commitment ran under
   * (#571) - e.g. `project_site_chat` for a chat bound to one site-builder
   * project. `null` for a commitment created outside any scope, and for every
   * row written before the column existed.
   *
   * Recorded but NOT yet enforced on execution; daemon/commitment-executor.ts
   * says exactly why and what closing it needs.
   */
  scope_id: string | null;
  /**
   * When the executor took this commitment to run it, or null if it never
   * has. Written only by `claimCommitmentRun`, and it is what makes a run
   * happen at most once. Cleared when someone opens the task again.
   */
  started_at: number | null;
};

type CommitmentRow = {
  id: string;
  what: string;
  when_due: number | null;
  context: string | null;
  priority: CommitmentPriority;
  status: CommitmentStatus;
  retry_policy: string | null;
  created_from: string | null;
  assigned_to: string | null;
  created_at: number;
  completed_at: number | null;
  result: string | null;
  sort_order: number;
  /** Absent on a row read from a database predating the column (#571). */
  scope_id?: string | null;
  /** Absent on a row read from a database predating the column. */
  started_at?: number | null;
};

/**
 * Parse commitment row from database, deserializing JSON fields
 */
function parseCommitment(row: CommitmentRow): Commitment {
  return {
    ...row,
    retry_policy: row.retry_policy ? JSON.parse(row.retry_policy) : null,
    scope_id: row.scope_id ?? null,
    started_at: row.started_at ?? null,
  };
}

/**
 * Whether this database's `commitments` table carries `scope_id` (#571).
 *
 * Keyed on the handle, not a module flag, so a DB re-open between hot reloads
 * is not judged by the previous database's answer -- the same reasoning, and
 * the same failure if it is got wrong, as `TaskRegistry.contextColumnPresent`.
 */
const scopeColumn = new WeakMap<Database, boolean>();
function commitmentsHaveScopeColumn(db: Database): boolean {
  const cached = scopeColumn.get(db);
  if (cached !== undefined) return cached;
  let present: boolean;
  try {
    present = db.query<{ name: string }, []>('PRAGMA table_info(commitments)')
      .all().some((c) => c.name === 'scope_id');
  } catch {
    present = false;
  }
  scopeColumn.set(db, present);
  if (!present) {
    console.warn('[Commitments] commitments.scope_id is missing; the chat scope a '
      + 'commitment was created under will not be recorded (#571)');
  }
  return present;
}

/**
 * Whether this database's `commitments` table carries `started_at`. Probed
 * for the same reason as `scope_id`: the column arrives by an ALTER that
 * swallows its error, and a statement naming a column that is not there would
 * fail every write. Without it the claim below still decides by status, but
 * it cannot tell a run that a crash interrupted from one never started.
 */
const startedColumn = new WeakMap<Database, boolean>();
function commitmentsHaveStartedColumn(db: Database): boolean {
  const cached = startedColumn.get(db);
  if (cached !== undefined) return cached;
  let present: boolean;
  try {
    present = db.query<{ name: string }, []>('PRAGMA table_info(commitments)')
      .all().some((c) => c.name === 'started_at');
  } catch {
    present = false;
  }
  startedColumn.set(db, present);
  if (!present) {
    console.warn('[Commitments] commitments.started_at is missing; a commitment interrupted by a crash cannot be told from one that never started');
  }
  return present;
}

/**
 * The same promise, said twice: the text with case, spacing and punctuation
 * taken out. Two open commitments with the same key due in the same minute
 * are one commitment (see createCommitment).
 */
export function commitmentSameKey(what: string): string {
  return what.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Create a new commitment
 */
export function createCommitment(
  what: string,
  opts?: {
    when_due?: number;
    context?: string;
    priority?: CommitmentPriority;
    retry_policy?: RetryPolicy;
    created_from?: string;
    assigned_to?: string;
    /**
     * Tool scope of the creating turn; see Commitment.scope_id (#571).
     *
     * Defaults to the ambient turn scope, which is what covers the route that
     * matters: the row the MODEL creates through the `commitments` tool inside
     * a scoped chat. An explicit value still wins, for callers that know the
     * scope but do not run inside the tool call (ws-service's auto-created
     * tracked task).
     */
    scope_id?: string;
  }
): Commitment {
  // One well-formed line, from every writer (#1115): the commitments tool
  // lists tasks one per line and the executor quotes this text into a prompt,
  // and only the dashboard's create checked it.
  const text = oneLineTaskText(what);
  if (text === null) throw new CommitmentTextError('A task needs some text to say what it is');
  what = text;
  const db = getDb();
  // The same thing, due in the same minute, and still open: it is already
  // there. A second row would be run a second time when it falls due, and a
  // promise is kept once. Only for a commitment with a due time: two undated
  // notes with the same words are not known to be the same thing.
  if (opts?.when_due != null) {
    const minute = Math.floor(opts.when_due / 60_000) * 60_000;
    const key = commitmentSameKey(what);
    const open = db.prepare(
      "SELECT * FROM commitments WHERE status IN ('pending', 'active') AND when_due >= ? AND when_due < ? ORDER BY created_at ASC"
    ).all(minute, minute + 60_000) as CommitmentRow[];
    const same = open.find((row) => commitmentSameKey(row.what) === key);
    if (same) return parseCommitment(same);
  }
  const id = generateId();
  const now = Date.now();
  const priority = opts?.priority ?? 'normal';
  const scopeId = opts?.scope_id ?? currentTurnScopeId() ?? null;

  // `scope_id` is named only when the column is really there (#571).
  //
  // The column arrives by `ALTER TABLE ... ADD COLUMN` in a swallowing
  // try/catch (vault/schema.ts). If that ALTER were ever skipped on an
  // existing database while this INSERT still named the column, EVERY
  // commitment write would throw -- and unlike `TaskRegistry.persist`, which
  // makes the same argument for the same reason, this call is NOT wrapped in
  // a catch: the throw would surface as a failed chat turn, a failed HTTP
  // create and a failed extraction. Probing costs one `PRAGMA` per process
  // and degrades to "provenance not recorded", which the commitment executor
  // already treats as an unscoped row.
  const withScope = commitmentsHaveScopeColumn(db);
  const stmt = db.prepare(
    withScope
      ? 'INSERT INTO commitments (id, what, when_due, context, priority, status, retry_policy, created_from, assigned_to, created_at, completed_at, result, scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO commitments (id, what, when_due, context, priority, status, retry_policy, created_from, assigned_to, created_at, completed_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  stmt.run(
    id,
    what,
    opts?.when_due ?? null,
    opts?.context ?? null,
    priority,
    'pending',
    opts?.retry_policy ? JSON.stringify(opts.retry_policy) : null,
    opts?.created_from ?? null,
    opts?.assigned_to ?? null,
    now,
    null,
    null,
    ...(withScope ? [scopeId] : [])
  );

  return {
    id,
    what,
    when_due: opts?.when_due ?? null,
    context: opts?.context ?? null,
    priority,
    status: 'pending',
    retry_policy: opts?.retry_policy ?? null,
    created_from: opts?.created_from ?? null,
    assigned_to: opts?.assigned_to ?? null,
    scope_id: scopeId,
    started_at: null,
    created_at: now,
    completed_at: null,
    result: null,
    sort_order: 0,
  };
}

/**
 * Get a commitment by ID
 */
export function getCommitment(id: string): Commitment | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM commitments WHERE id = ?');
  const row = stmt.get(id) as CommitmentRow | null;

  if (!row) return null;

  return parseCommitment(row);
}

/**
 * Find commitments matching query criteria
 */
export function findCommitments(query: {
  status?: CommitmentStatus;
  priority?: CommitmentPriority;
  assigned_to?: string;
  overdue?: boolean;
}): Commitment[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }

  if (query.priority) {
    conditions.push('priority = ?');
    params.push(query.priority);
  }

  if (query.assigned_to) {
    conditions.push('assigned_to = ?');
    params.push(query.assigned_to);
  }

  if (query.overdue) {
    conditions.push('when_due IS NOT NULL AND when_due <= ?');
    params.push(Date.now());
    conditions.push("status IN ('pending', 'active')");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM commitments ${where} ORDER BY sort_order ASC, created_at DESC`);
  const rows = stmt.all(...params as any[]) as CommitmentRow[];

  return rows.map(parseCommitment);
}

/**
 * Get upcoming commitments, ordered by due date
 */
export function getUpcoming(limit: number = 10, options: CommitmentScheduleOptions = {}): Commitment[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT * FROM commitments WHERE status IN ('pending', 'active') AND when_due IS NOT NULL
     ${options.excludeWorkItems ? EXCLUDE_WORK_ITEMS : ''} ORDER BY when_due ASC LIMIT ?`
  );
  const rows = stmt.all(limit) as CommitmentRow[];

  return rows.map(parseCommitment);
}

/**
 * Mark a commitment as completed
 */
export function completeCommitment(id: string, result?: string): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  const stmt = db.prepare(
    'UPDATE commitments SET status = ?, completed_at = ?, result = ? WHERE id = ?'
  );
  stmt.run('completed', Date.now(), result ?? null, id);

  return getCommitment(id);
}

/**
 * Mark a commitment as failed
 */
export function failCommitment(id: string, reason?: string): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  const stmt = db.prepare(
    'UPDATE commitments SET status = ?, completed_at = ?, result = ? WHERE id = ?'
  );
  stmt.run('failed', Date.now(), reason ?? null, id);

  return getCommitment(id);
}

/**
 * Escalate a commitment
 */
export function escalateCommitment(id: string): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  const stmt = db.prepare('UPDATE commitments SET status = ? WHERE id = ?');
  stmt.run('escalated', id);

  return getCommitment(id);
}

/**
 * Get commitments that are currently due
 */
export function getDueCommitments(options: CommitmentScheduleOptions = {}): Commitment[] {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `SELECT * FROM commitments WHERE when_due IS NOT NULL AND when_due <= ? AND status IN ('pending', 'active')
     ${options.excludeWorkItems ? EXCLUDE_WORK_ITEMS : ''} ORDER BY when_due ASC`
  );
  const rows = stmt.all(now) as CommitmentRow[];

  return rows.map(parseCommitment);
}

/**
 * Update a commitment's status to any valid status.
 * Sets completed_at for terminal states (completed, failed).
 */
export function updateCommitmentStatus(
  id: string,
  status: CommitmentStatus,
  result?: string,
  /** Only the executor's parking writes a parked result (#1115); see `storableResult`. */
  opts: { parked?: boolean } = {},
): Commitment | null {
  if (!opts.parked) result = storableResult(result);
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  const isTerminal = status === 'completed' || status === 'failed';
  const completedAt = isTerminal ? Date.now() : null;

  db.prepare(
    'UPDATE commitments SET status = ?, completed_at = ?, result = ? WHERE id = ?'
  ).run(status, completedAt, result ?? null, id);
  // Opened again by someone (the dashboard, the commitments tool): whatever
  // run it had is behind it, and it may be run again when it is due. The
  // executor's own parking keeps the mark: a parked commitment has run.
  if (!isTerminal && !opts.parked && status !== 'escalated' && commitment.started_at !== null && commitmentsHaveStartedColumn(db)) {
    db.prepare('UPDATE commitments SET started_at = NULL WHERE id = ?').run(id);
  }

  return getCommitment(id);
}

/**
 * Takes a commitment to run it. Exactly one caller can ever win this for a
 * commitment that is open and has not been started: the row is marked active
 * and started in one statement. Null means it is not to be run: it was closed,
 * cancelled or removed, it was already taken (this process, or one that
 * crashed in the middle of it), or its due time is no longer the one given.
 * The row comes back as it is now, so what runs is what it says now.
 */
export function claimCommitmentRun(id: string, expected: { whenDue?: number | null } = {}, now: number = Date.now()): Commitment | null {
  const db = getDb();
  const dueIsChecked = 'whenDue' in expected;
  const dueClause = dueIsChecked ? ' AND when_due IS ?' : '';
  const dueArgs = dueIsChecked ? [expected.whenDue ?? null] : [];
  const taken = commitmentsHaveStartedColumn(db)
    ? db.prepare(
      `UPDATE commitments SET status = 'active', started_at = ? WHERE id = ? AND status IN ('pending', 'active') AND started_at IS NULL${dueClause}`
    ).run(now, id, ...dueArgs).changes
    : db.prepare(
      `UPDATE commitments SET status = 'active' WHERE id = ? AND status IN ('pending', 'active')${dueClause}`
    ).run(id, ...dueArgs).changes;
  return taken === 1 ? getCommitment(id) : null;
}

/**
 * Gives back a commitment that was taken but not run at all (the process was
 * shutting down before the turn began). It is open again and will be run.
 */
export function releaseCommitmentRun(id: string): void {
  const db = getDb();
  if (!commitmentsHaveStartedColumn(db)) return;
  db.prepare("UPDATE commitments SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'active'").run(id);
}

/**
 * Commitments a process took to run and never closed: it stopped in the
 * middle. Parked ones (waiting on an approval) are not among them.
 */
export function getInterruptedCommitments(): Commitment[] {
  const db = getDb();
  if (!commitmentsHaveStartedColumn(db)) return [];
  const rows = db.prepare("SELECT * FROM commitments WHERE status = 'active' AND started_at IS NOT NULL").all() as CommitmentRow[];
  return rows.map(parseCommitment).filter((row) => parseParkedRequestIds(row.result) === null);
}

/** The fields a dashboard edit may change (#1020); see daemon/commitment-patch.ts. */
export type CommitmentPatch = {
  status?: CommitmentStatus;
  /** Only with `status`, as updateCommitmentStatus takes it. */
  result?: string;
  priority?: CommitmentPriority;
  /** null unassigns. */
  assigned_to?: string | null;
};

/**
 * Apply `patch` to one commitment, all of it or none of it. A status change
 * is updateCommitmentStatus's, so it sets completed_at and the result as it
 * always has. Null when there is no such commitment.
 */
export function patchCommitment(id: string, patch: CommitmentPatch): Commitment | null {
  const db = getDb();
  if (!getCommitment(id)) return null;
  db.transaction(() => {
    if (patch.status !== undefined) updateCommitmentStatus(id, patch.status, patch.result);
    if (patch.priority !== undefined) db.prepare('UPDATE commitments SET priority = ? WHERE id = ?').run(patch.priority, id);
    if (patch.assigned_to !== undefined) updateCommitmentAssignee(id, patch.assigned_to);
  })();
  return getCommitment(id);
}

/**
 * Update a commitment's assigned_to field. null unassigns.
 */
export function updateCommitmentAssignee(id: string, assignedTo: string | null): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  db.prepare('UPDATE commitments SET assigned_to = ? WHERE id = ?').run(assignedTo, id);
  return getCommitment(id);
}

/**
 * Update a commitment's due date.
 */
export function updateCommitmentDue(id: string, when_due: number | null): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  db.prepare('UPDATE commitments SET when_due = ? WHERE id = ?').run(when_due, id);
  return getCommitment(id);
}

/**
 * Bulk update sort order for commitments (used by kanban drag & drop).
 */
export function reorderCommitments(
  items: { id: string; sort_order: number }[]
): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE commitments SET sort_order = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (const item of items) {
      stmt.run(item.sort_order, item.id);
    }
  });

  transaction();
}
