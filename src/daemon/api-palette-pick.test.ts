import { afterEach, describe, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { setPaletteHandler } from './palette-controller.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function pickRoute(): Handler {
  const routes = createApiRoutes({ daemonStartedAt: Date.now(), healthMonitor: {}, config: {} } as unknown as ApiContext);
  return (routes['/api/palette/pick'] as { POST: Handler }).POST;
}

const post = (body: unknown) => new Request('http://x/api/palette/pick', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /api/palette/pick', () => {
  afterEach(() => setPaletteHandler(null));

  test('a key that is not a non-empty string is a 400 and never reaches the handler', async () => {
    const picks: unknown[] = [];
    setPaletteHandler({ pick: (req) => { picks.push(req); }, close: () => {} });
    const handler = pickRoute();
    for (const key of [123, { room: 'chat' }, ['chat'], true, '', null]) {
      const res = await handler(post({ kind: 'room', key }));
      expect({ key, status: res.status }).toEqual({ key, status: 400 });
    }
    expect(picks).toEqual([]);
  });

  test('a malformed pick is a 400 even before a handler is registered', async () => {
    setPaletteHandler(null);
    expect((await pickRoute()(post({ kind: 'room', key: 7 }))).status).toBe(400);
    expect((await pickRoute()(post({ kind: 'room', key: 'k'.repeat(257) }))).status).toBe(400);
    expect((await pickRoute()(post({ kind: 'room', key: 'chat' }))).status).toBe(503);
  });

  test('a string key is passed through', async () => {
    const picks: unknown[] = [];
    setPaletteHandler({ pick: (req) => { picks.push(req); }, close: () => {} });
    const res = await pickRoute()(post({ kind: 'room', key: 'chat', openInRoom: true }));
    expect(res.status).toBe(204);
    expect(picks).toEqual([{ kind: 'room', key: 'chat', openInRoom: true }]);
  });
});
