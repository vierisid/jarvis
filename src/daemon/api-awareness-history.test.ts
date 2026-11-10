/**
 * Owner decision on #1314: with screen awareness off, its recorded history is
 * hidden from every reader -- the dashboard routes and the workflow context --
 * and nothing is deleted: it shows again once awareness is back on.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes';
import { initDatabase, closeDb } from '../vault/schema';
import { createCapture } from '../vault/awareness';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard';
import { JarvisContextProviderAdapter } from '../workflows/adapters/context-provider';

beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => { setScreenCaptureEnabledSource(null); closeDb(); });

const awarenessService = {
  status: () => 'running', isEnabled: () => false, getUsageEstimate: () => ({}),
  getLiveContext: () => ({ currentApp: 'Outlook', currentWindow: 'Inbox - ana@x' }),
  getSessionHistory: () => [{ id: 's1', apps: ['Outlook'] }],
  generateReport: async () => ({ date: 'today', apps: ['Outlook'] }),
  generateWeeklyReport: async () => ({ week: 'w', apps: ['Outlook'] }),
  getBehavioralInsights: () => [{ insight: 'Outlook' }],
} as unknown as ApiContext['awarenessService'];

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
const call = async (routes: Record<string, any>, path: string, url: string, params: Record<string, string> = {}) =>
  (routes[path].GET as Handler)(Object.assign(new Request(`http://local${url}`), { params }));

const HISTORY: Array<[string, string, Record<string, string>?]> = [
  ['/api/awareness/context', '/api/awareness/context'],
  ['/api/awareness/captures', '/api/awareness/captures'],
  ['/api/awareness/captures/:id', '/api/awareness/captures/ID', { id: 'ID' }],
  ['/api/awareness/captures/:id/image', '/api/awareness/captures/ID/image', { id: 'ID' }],
  ['/api/awareness/sessions', '/api/awareness/sessions'],
  ['/api/awareness/report', '/api/awareness/report'],
  ['/api/awareness/stats', '/api/awareness/stats'],
  ['/api/awareness/report/weekly', '/api/awareness/report/weekly'],
  ['/api/awareness/insights', '/api/awareness/insights'],
];

test('every awareness history route answers that awareness is off, with no data, and shows it again when it is on', async () => {
  const capture = createCapture({ timestamp: Date.now(), pixelChangePct: 10, appName: 'Outlook', windowTitle: 'Inbox - ana@x' });
  const routes = createApiRoutes({ awarenessService } as ApiContext) as Record<string, any>;
  setScreenCaptureEnabledSource(() => false);
  for (const [path, url, params] of HISTORY) {
    const response = await call(routes, path, url.replace('ID', capture.id), params ? { id: capture.id } : {});
    const body = await response.json();
    expect(`${path}: ${response.status} ${body.code}`).toBe(`${path}: 409 AWARENESS_OFF`);
    expect(JSON.stringify(body)).not.toContain('Outlook');
  }
  const status = await (await call(routes, '/api/awareness/status', '/api/awareness/status')).json();
  expect(status.liveContext).toBeNull();
  // Nothing was deleted: turned back on, the history is there.
  setScreenCaptureEnabledSource(null);
  const captures = await (await call(routes, '/api/awareness/captures', '/api/awareness/captures')).json();
  expect(captures.map((c: { id: string }) => c.id)).toEqual([capture.id]);
  expect((await call(routes, '/api/awareness/captures/:id', `/api/awareness/captures/${capture.id}`, { id: capture.id })).status).toBe(200);
});

test('a workflow reading recent activity gets none while awareness is off, and it comes back when on', async () => {
  createCapture({ timestamp: Date.now(), pixelChangePct: 10, appName: 'Outlook', windowTitle: 'Inbox - ana@x' });
  const adapter = new JarvisContextProviderAdapter();
  setScreenCaptureEnabledSource(() => false);
  expect(await adapter.awarenessRecent({})).toEqual([]);
  setScreenCaptureEnabledSource(null);
  expect(await adapter.awarenessRecent({})).toHaveLength(1);
});
