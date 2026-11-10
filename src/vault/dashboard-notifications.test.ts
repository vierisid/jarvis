import { test, expect, beforeEach, describe } from 'bun:test';
import { initDatabase } from './schema.ts';
import {
  DASHBOARD_NOTIFICATION_CAP, DASHBOARD_NOTIFICATION_MAX_AGE_MS,
  listUnreadDashboardNotifications, markDashboardNotificationRead, recordDashboardNotification,
} from './dashboard-notifications.ts';

describe('dashboard notifications', () => {
  beforeEach(() => { initDatabase(':memory:'); });

  test('a stored notification is unread, with its workflow, run, priority and time', () => {
    const row = recordDashboardNotification({ message: 'Stand-up at 9', priority: 'urgent', workflowId: 'flow1', runId: 'run1', now: 5000 });
    expect(listUnreadDashboardNotifications()).toEqual([
      { id: row.id, message: 'Stand-up at 9', priority: 'urgent', workflow_id: 'flow1', run_id: 'run1', created_at: 5000, read_at: null },
    ]);
  });

  test('unread comes back newest first, and mark-as-read removes only that one', () => {
    const a = recordDashboardNotification({ message: 'a', priority: 'normal', now: 1000 });
    const b = recordDashboardNotification({ message: 'b', priority: 'normal', now: 2000 });
    expect(listUnreadDashboardNotifications().map(r => r.id)).toEqual([b.id, a.id]);
    expect(markDashboardNotificationRead(b.id, 3000)).toBe(true);
    expect(listUnreadDashboardNotifications().map(r => r.id)).toEqual([a.id]);
    expect(markDashboardNotificationRead(b.id)).toBe(true);
    expect(markDashboardNotificationRead('missing')).toBe(false);
  });

  test('keeps only the newest rows', () => {
    const now = Date.now();
    for (let i = 0; i < DASHBOARD_NOTIFICATION_CAP + 5; i++) recordDashboardNotification({ message: `n${i}`, priority: 'low', now: now + i });
    const rows = listUnreadDashboardNotifications();
    expect(rows).toHaveLength(DASHBOARD_NOTIFICATION_CAP);
    expect(rows[0]!.message).toBe(`n${DASHBOARD_NOTIFICATION_CAP + 4}`);
    expect(rows.some(r => r.message === 'n0')).toBe(false);
  });

  test('drops rows older than 30 days, read or not', () => {
    const now = Date.now();
    recordDashboardNotification({ message: 'old', priority: 'low', now: now - DASHBOARD_NOTIFICATION_MAX_AGE_MS - 1000 });
    recordDashboardNotification({ message: 'new', priority: 'low', now });
    expect(listUnreadDashboardNotifications().map(r => r.message)).toEqual(['new']);
  });
});
