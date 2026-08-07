import { getDb, generateId } from './schema.ts';

export type CommitmentPriority = 'low' | 'normal' | 'high' | 'critical';
export type CommitmentStatus = 'pending' | 'active' | 'completed' | 'failed' | 'escalated';

/**
 * P0.2 — what a row MEANS, which decides whether the CommitmentExecutor may
 * act on it.
 *
 *   'task'     — something JARVIS is meant to DO. Eligible for auto-execution
 *                if it also clears the other gates.
 *   'reminder' — something a HUMAN is meant to do, or a bare "remind me at
 *                9". Announced when due; never executed.
 *
 * Defaults to 'task' so rows written before this column existed keep their
 * current behaviour. New inferred paths (LLM extraction, and later ambient
 * meeting capture) should write 'reminder'.
 */
export type CommitmentKind = 'task' | 'reminder';

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
  kind: CommitmentKind;
  /**
   * 0..1 confidence that this is a real commitment, correctly parsed. NULL
   * means unknown — treated as below any floor by the executor. Explicit
   * user-created rows write 1.0; inferred rows write what the extractor
   * reported.
   */
  confidence: number | null;
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
  kind: CommitmentKind | null;
  confidence: number | null;
};

/**
 * Parse commitment row from database, deserializing JSON fields
 */
function parseCommitment(row: CommitmentRow): Commitment {
  return {
    ...row,
    retry_policy: row.retry_policy ? JSON.parse(row.retry_policy) : null,
    // Rows written before the P0.2 migration have kind NULL rather than the
    // column default. Normalize on read so callers never see NULL.
    kind: row.kind ?? 'task',
    confidence: row.confidence ?? null,
  };
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
    /** P0.2. Defaults to 'task'. Inferred paths should pass 'reminder'. */
    kind?: CommitmentKind;
    /**
     * P0.2. 0..1. Omit when genuinely unknown — the executor treats the
     * resulting NULL as below any floor and announces instead of executing.
     */
    confidence?: number;
  }
): Commitment {
  const db = getDb();
  const id = generateId();
  const now = Date.now();
  const priority = opts?.priority ?? 'normal';
  const kind: CommitmentKind = opts?.kind ?? 'task';

  const stmt = db.prepare(
    'INSERT INTO commitments (id, what, when_due, context, priority, status, retry_policy, created_from, assigned_to, created_at, completed_at, result, kind, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    kind,
    opts?.confidence ?? null
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
    created_at: now,
    completed_at: null,
    result: null,
    sort_order: 0,
    kind,
    confidence: opts?.confidence ?? null,
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
export function getUpcoming(limit: number = 10): Commitment[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM commitments WHERE status IN ('pending', 'active') AND when_due IS NOT NULL ORDER BY when_due ASC LIMIT ?"
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
export function getDueCommitments(): Commitment[] {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    "SELECT * FROM commitments WHERE when_due IS NOT NULL AND when_due <= ? AND status IN ('pending', 'active') ORDER BY when_due ASC"
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
