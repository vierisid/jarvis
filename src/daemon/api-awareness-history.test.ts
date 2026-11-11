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
  // What is derived from captures (#1314 review): suggestions, routines, compositions, opportunities.
  ['/api/awareness/suggestions', '/api/awareness/suggestions'],
  ['/api/awareness/routines', '/api/awareness/routines'],
  ['/api/awareness/compositions', '/api/awareness/compositions'],
  ['/api/awareness/suggestions/:id/learning', '/api/awareness/suggestions/ID/learning', { id: 'ID' }],
  ['/api/opportunities', '/api/opportunities'],
  ['/api/opportunities/metrics', '/api/opportunities/metrics'],
  ['/api/opportunities/:id', '/api/opportunities/ID', { id: 'ID' }],
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


test('recorded screen observations are left out of every observation read while awareness is off (#1314 review)', async () => {
  const { createObservation, getRecentObservations } = await import('../vault/observations');
  // The screen row is the newest, so a filter applied after the limit would come back empty.
  createObservation('file_change', { path: '/tmp/a' });
  createObservation('screen_capture', { appName: 'Outlook', windowTitle: 'Inbox - ana@x', ocrPreview: 'secret' });
  const routes = createApiRoutes({ awarenessService } as ApiContext) as Record<string, any>;
  const read = async (url: string) => (await call(routes, '/api/vault/observations', url)).json();
  setScreenCaptureEnabledSource(() => false);
  // The Logs room's route, the palette search and the agents' prompts all read through getRecentObservations.
  expect(getRecentObservations(undefined, 1).map(o => o.type)).toEqual(['file_change']);
  expect(getRecentObservations('screen_capture')).toEqual([]);
  expect(JSON.stringify(await read('/api/vault/observations'))).not.toContain('Outlook');
  expect(JSON.stringify(await read('/api/vault/observations?type=screen_capture'))).not.toContain('Outlook');
  setScreenCaptureEnabledSource(null);
  expect(getRecentObservations('screen_capture')).toHaveLength(1);
});

test('the awareness service itself holds recorded history back while awareness is off (#1314 review)', async () => {
  const { AwarenessService } = await import('../awareness/service');
  const fake = { analytics: { getSessionHistory: () => [{ id: 's1' }], getBehavioralInsights: () => [{ insight: 'x' }],
    generateDailyReport: async () => ({ date: 'd' }), generateWeeklyReport: async () => ({ week: 'w' }) } };
  const proto = AwarenessService.prototype as any;
  const { createSuggestion } = await import('../vault/awareness');
  createSuggestion({ type: 'error', title: 'Error detected in Outlook', body: 'Outlook crashed' });
  expect(proto.getRecentSuggestionsList.call(fake)).toHaveLength(1);
  setScreenCaptureEnabledSource(() => false);
  expect(proto.getSessionHistory.call(fake)).toEqual([]);
  expect(proto.getBehavioralInsights.call(fake)).toEqual([]);
  expect(proto.getRecentSuggestionsList.call(fake)).toEqual([]);
  await expect(proto.generateReport.call(fake)).rejects.toThrow('Screen awareness is off');
  await expect(proto.generateWeeklyReport.call(fake)).rejects.toThrow('Screen awareness is off');
  setScreenCaptureEnabledSource(null);
  expect(proto.getSessionHistory.call(fake)).toEqual([{ id: 's1' }]);
});

test('prepared opportunities answer that awareness is off (#1314 review)', async () => {
  const { createPreparedOpportunityRoutes } = await import('../brief/prepared-opportunity-routes');
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const provider = { read: async () => ({ items: [{ evidence: 'Outlook' }] }), get: async () => ({ evidence: 'Outlook' }) } as any;
  const capabilities = { hasProvider: () => true, snapshot: () => ({ capabilities: { preparedOpportunities: { enabled: true } } }) } as any;
  const routes = createPreparedOpportunityRoutes(capabilities, json, provider) as Record<string, any>;
  setScreenCaptureEnabledSource(() => false);
  for (const [path, params] of [['/api/brief/prepared-opportunities', {}], ['/api/brief/prepared-opportunities/:id', { id: 'p1' }]] as const) {
    const response = await routes[path].GET(Object.assign(new Request('http://local/api/brief/prepared-opportunities'), { params }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AWARENESS_OFF');
  }
  setScreenCaptureEnabledSource(null);
  expect((await routes['/api/brief/prepared-opportunities'].GET(new Request('http://local/api/brief/prepared-opportunities'))).status).toBe(200);
});


test('writes that answer with capture-derived content are refused while awareness is off, and run nothing (#1314 review)', async () => {
  const { createSuggestionFeedbackRoutes } = await import('../awareness/suggestion-feedback-routes');
  const { createOpportunityRoutes } = await import('../awareness/opportunity-routes');
  const { createPreparedOpportunityRoutes } = await import('../brief/prepared-opportunity-routes');
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  let ran = 0;
  const provider = { ensure: async () => { ran++; return { evidence: 'Outlook' }; }, dismiss: async () => { ran++; return {}; },
    retry: async () => { ran++; return {}; } } as any;
  const capabilities = { hasProvider: () => true, snapshot: () => ({ capabilities: { preparedOpportunities: { enabled: true } } }) } as any;
  const routes = { ...createSuggestionFeedbackRoutes(() => ({ kick: () => { ran++; } })), ...createOpportunityRoutes(json),
    ...createPreparedOpportunityRoutes(capabilities, json, provider) } as Record<string, any>;
  const writes: Array<[string, 'POST' | 'PATCH']> = [
    ['/api/awareness/suggestions/:id/accept', 'POST'], ['/api/awareness/suggestions/:id/retry', 'POST'],
    ['/api/awareness/suggestions/:id/dismiss', 'PATCH'], ['/api/awareness/suggestions/:id/act', 'PATCH'],
    ['/api/opportunities/:id/feedback', 'POST'], ['/api/brief/prepared-opportunities', 'POST'],
    ['/api/brief/prepared-opportunities/:id/dismiss', 'POST'], ['/api/brief/prepared-opportunities/:id/retry', 'POST'],
  ];
  const request = () => Object.assign(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ requestId: 'r1', opportunityId: 'o1', revision: 'v' }) }), { params: { id: 'ID' } });
  setScreenCaptureEnabledSource(() => false);
  for (const [path, method] of writes) {
    const response = await routes[path][method](request());
    expect(`${path}: ${response.status} ${(await response.json()).code}`).toBe(`${path}: 409 AWARENESS_OFF`);
  }
  expect(ran).toBe(0);
  // On again, the same calls reach their handlers (no such suggestion here, so not a 409 from the switch).
  setScreenCaptureEnabledSource(null);
  for (const [path, method] of writes) expect(`${path}: ${(await routes[path][method](request())).status}`).not.toBe(`${path}: 409`);
});

test('the live screen and the background composers stay dark while awareness is off (#1314 review)', async () => {
  const { AwarenessService } = await import('../awareness/service');
  const { SuggestionComposer } = await import('../awareness/suggestion-composer');
  const proto = AwarenessService.prototype as any;
  const fake = { _status: 'running', analytics: { getLiveContext: () => ({ currentApp: 'Outlook', currentWindow: 'Inbox - ana@x' }) },
    contextTracker: { getCurrentSession: () => ({ id: 's1', topic: null, startedAt: 1 }) } };
  let composed = 0;
  const composer = new SuggestionComposer(async () => { composed++; return null as never; });
  (composer as any).running = true;
  (composer as any).drain = async () => { composed++; };
  setScreenCaptureEnabledSource(() => false);
  expect(proto.getLiveContext.call(fake)).toMatchObject({ currentApp: null, currentWindow: null, currentSession: null, recentApps: [] });
  expect(proto.getCurrentSession.call(fake)).toBeNull();
  composer.kick(); await (composer as any).pending;
  expect(composed).toBe(0);
  setScreenCaptureEnabledSource(null);
  expect(proto.getLiveContext.call(fake).currentApp).toBe('Outlook');
  composer.kick(); await (composer as any).pending;
  expect(composed).toBe(1);
});
