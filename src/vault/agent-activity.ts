import { getDb } from './schema.ts';

export type AgentActivityEventType = 'text' | 'tool_call' | 'done';

export interface AgentActivityRow {
  id: string;
  agent_id: string;
  agent_name: string;
  event_type: AgentActivityEventType;
  data: unknown;
  task_id: string | null;
  timestamp: number;
  created_at: number;
}

interface DbRow {
  id: string;
  agent_id: string;
  agent_name: string;
  event_type: AgentActivityEventType;
  data: string | null;
  task_id: string | null;
  timestamp: number;
  created_at: number;
}

const PER_AGENT_CAP = 1000;

/**
 * Persist a single sub-agent event. Called from the daemon's delegation
 * progress callback alongside the WS broadcast — the broadcast and the
 * write happen in the same tick so a fresh dashboard load + a live tab
 * never see different views of the same event.
 *
 * Trims to PER_AGENT_CAP on each insert. The cap matters because some
 * agents emit dozens of `text` events per turn; without it the table grows
 * unbounded over a long-running daemon.
 */
export function recordAgentActivity(input: {
  agent_id: string;
  agent_name: string;
  event_type: AgentActivityEventType;
  data?: unknown;
  task_id?: string | null;
  timestamp?: number;
}): AgentActivityRow {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const ts = input.timestamp ?? now;
  const dataStr = input.data === undefined ? null : JSON.stringify(input.data);

  db.run(
    `INSERT INTO agent_activity (id, agent_id, agent_name, event_type, data, task_id, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.agent_id, input.agent_name, input.event_type, dataStr, input.task_id ?? null, ts, now],
  );

  // Bound per-agent history. Cheap on the indexed (agent_id, timestamp DESC)
  // path; ROWID-based delete keeps it a single statement.
  db.run(
    `DELETE FROM agent_activity
     WHERE agent_id = ?
       AND id NOT IN (
         SELECT id FROM agent_activity
         WHERE agent_id = ?
         ORDER BY timestamp DESC
         LIMIT ?
       )`,
    [input.agent_id, input.agent_id, PER_AGENT_CAP],
  );

  return {
    id,
    agent_id: input.agent_id,
    agent_name: input.agent_name,
    event_type: input.event_type,
    data: input.data ?? null,
    task_id: input.task_id ?? null,
    timestamp: ts,
    created_at: now,
  };
}

export function listAgentActivity(
  agentId: string,
  options: { limit?: number; offset?: number } = {},
): AgentActivityRow[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const db = getDb();
  const rows = db
    .query(
      `SELECT id, agent_id, agent_name, event_type, data, task_id, timestamp, created_at
       FROM agent_activity
       WHERE agent_id = ?
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
    )
    .all(agentId, limit, offset) as DbRow[];

  return rows.map(deserialize);
}

export function countAgentActivity(agentId: string): number {
  const db = getDb();
  const row = db
    .query(`SELECT COUNT(*) AS n FROM agent_activity WHERE agent_id = ?`)
    .get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

function deserialize(row: DbRow): AgentActivityRow {
  let data: unknown = null;
  if (row.data != null) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = row.data;
    }
  }
  return {
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    event_type: row.event_type,
    data,
    task_id: row.task_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
  };
}
