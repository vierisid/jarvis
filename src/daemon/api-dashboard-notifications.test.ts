/** The unread list a dashboard loads on open, and the mark-as-read that clears one. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { recordDashboardNotification } from '../vault/dashboard-notifications.ts';

type Handler = (req: Request & { params?: { id: string } }) => Response | Promise<Response>;
const routes = () => createApiRoutes({ daemonStartedAt: Date.now(), healthMonitor: {}, config: {}, agentService: {} } as unknown as ApiContext) as Record<string, { GET?: Handler; POST?: Handler }>;

beforeEach(() => { closeDb(); initDatabase(':memory:'); });
afterEach(() => closeDb());

test('the list returns unread notifications and mark-as-read removes one', async () => {
  const kept = recordDashboardNotification({ message: 'keep', priority: 'normal', now: 1 });
  const read = recordDashboardNotification({ message: 'read me', priority: 'low', now: 2 });
  const r = routes();
  const list = async () => ((await (await r['/api/dashboard-notifications']!.GET!(new Request('http://x/api/dashboard-notifications'))).json()) as { notifications: Array<{ id: string }> }).notifications.map(n => n.id);
  expect(await list()).toEqual([read.id, kept.id]);
  const mark = (id: string) => r['/api/dashboard-notifications/:id/read']!.POST!(Object.assign(new Request('http://x', { method: 'POST' }), { params: { id } }));
  expect((await mark(read.id)).status).toBe(200);
  expect(await list()).toEqual([kept.id]);
  expect((await mark('nope')).status).toBe(404);
});
