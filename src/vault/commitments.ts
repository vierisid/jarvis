import type { Database } from 'bun:sqlite';
import { getDb, generateId } from './schema.ts';
import { currentTurnScopeId } from '../actions/tools/turn-scope-store.ts';

export type CommitmentPriority = 'low' | 'normal' | 'high' | 'critical';
export type CommitmentStatus = 'pending' | 'active' | 'completed' | 'failed' | 'escalated';

export type CommitmentScheduleOptions = {
  /** Linked work uses its own decision and execution contract, even when it has a due date. */
  excludeWorkItems?: boolean;
};

const EXCLUDE_WORK_ITEMS = 'AND NOT EXISTS (SELECT 1 FROM commitment_work WHERE work_id = commitments.id)';

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
};

/**
 * Parse commitment row from database, deserializing JSON fields
 */
function parseCommitment(row: CommitmentRow): Commitment {
  return {
    ...row,
    retry_policy: row.retry_policy ? JSON.parse(row.retry_policy) : null,
    scope_id: row.scope_id ?? null,
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
  const db = getDb();
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
  result?: string
): Commitment | null {
  const db = getDb();
  const commitment = getCommitment(id);
  if (!commitment) return null;

  const isTerminal = status === 'completed' || status === 'failed';
  const completedAt = isTerminal ? Date.now() : null;

  db.prepare(
    'UPDATE commitments SET status = ?, completed_at = ?, result = ? WHERE id = ?'
  ).run(status, completedAt, result ?? null, id);

  return getCommitment(id);
}

/**
 * Update a commitment's assigned_to field.
 */
export function updateCommitmentAssignee(id: string, assignedTo: string): Commitment | null {
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
