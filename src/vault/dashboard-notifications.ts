import { getDb } from './schema.ts';

export type DashboardNotificationPriority = 'urgent' | 'normal' | 'low';

export interface DashboardNotificationRow {
  id: string;
  message: string;
  priority: DashboardNotificationPriority;
  workflow_id: string | null;
  run_id: string | null;
  created_at: number;
  read_at: number | null;
}

/** Newest rows kept. Older ones are dropped on every insert, read or not. */
export const DASHBOARD_NOTIFICATION_CAP = 200;
/** Rows older than this are dropped on every insert, read or not. */
export const DASHBOARD_NOTIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Longest message kept, in characters. Above the 24,000-character meeting
 * brief limit, so a brief is kept whole; a longer message is shortened, never
 * dropped. With the row cap it bounds the table and the unread list.
 */
export const DASHBOARD_NOTIFICATION_MAX_CHARS = 32_000;
const SHORTENED = '\n\n[Shortened: the full message was longer than the dashboard keeps.]';

function boundedMessage(message: string): string {
  return message.length <= DASHBOARD_NOTIFICATION_MAX_CHARS ? message
    // Not ending on half of a surrogate pair.
    : message.slice(0, DASHBOARD_NOTIFICATION_MAX_CHARS - SHORTENED.length).replace(/[\uD800-\uDBFF]$/, '') + SHORTENED;
}

/**
 * Store one notification a workflow sent to the dashboard, so it is still
 * there when nobody had a dashboard open at the time. The id is also the id
 * of the live broadcast, so an open tab never shows it twice.
 */
export function recordDashboardNotification(input: {
  message: string;
  priority: DashboardNotificationPriority;
  workflowId?: string | null;
  runId?: string | null;
  now?: number;
}): DashboardNotificationRow {
  const db = getDb();
  const now = input.now ?? Date.now();
  const row: DashboardNotificationRow = {
    id: crypto.randomUUID(), message: boundedMessage(input.message), priority: input.priority,
    workflow_id: input.workflowId ?? null, run_id: input.runId ?? null, created_at: now, read_at: null,
  };
  // One transaction: a trim that fails must not leave a row saved behind a
  // throw, which the caller would report as not saved.
  db.transaction(() => {
    db.run(
      `INSERT INTO dashboard_notifications (id, message, priority, workflow_id, run_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [row.id, row.message, row.priority, row.workflow_id, row.run_id, row.created_at],
    );
    db.run(`DELETE FROM dashboard_notifications WHERE created_at < ?`, [now - DASHBOARD_NOTIFICATION_MAX_AGE_MS]);
    db.run(
      `DELETE FROM dashboard_notifications WHERE id NOT IN (SELECT id FROM dashboard_notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      [DASHBOARD_NOTIFICATION_CAP],
    );
  })();
  return row;
}

/** Unread notifications, newest first. */
export function listUnreadDashboardNotifications(): DashboardNotificationRow[] {
  return getDb().query(
    `SELECT * FROM dashboard_notifications WHERE read_at IS NULL ORDER BY created_at DESC, rowid DESC`,
  ).all() as DashboardNotificationRow[];
}

/** Returns false when there is no such notification. Marking a read one again is fine. */
export function markDashboardNotificationRead(id: string, now = Date.now()): boolean {
  const db = getDb();
  db.run(`UPDATE dashboard_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`, [now, id]);
  return !!db.query(`SELECT 1 FROM dashboard_notifications WHERE id = ?`).get(id);
}
