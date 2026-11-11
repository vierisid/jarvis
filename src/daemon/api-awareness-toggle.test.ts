/**
 * POST /api/awareness/toggle starts a service that watches the screen, so it
 * takes only a real boolean. "false" as a string used to start it.
 */
import { expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes';

type Handler = (req: Request) => Response | Promise<Response>;

function setup() {
  const calls: boolean[] = [];
  const awarenessService = { toggle: (v: boolean) => { calls.push(v); } } as unknown as ApiContext['awarenessService'];
  const routes = createApiRoutes({ awarenessService } as ApiContext) as Record<string, any>;
  const post = (raw: string) => (routes['/api/awareness/toggle'].POST as Handler)(
    new Request('http://local/api/awareness/toggle', { method: 'POST', body: raw }));
  return { calls, post };
}

test('a non-boolean enabled is refused with 400 and does not change anything', async () => {
  const { calls, post } = setup();
  for (const raw of ['{"enabled":"false"}', '{"enabled":"true"}', '{"enabled":1}', '{"enabled":0}',
    '{"enabled":null}', '{"enabled":[]}', '{"enabled":{}}', '{}', 'null']) {
    const res = await post(raw);
    expect(`${raw}: ${res.status}`).toBe(`${raw}: 400`);
  }
  expect(calls).toEqual([]);
});

test('a real boolean still turns it on and off', async () => {
  const { calls, post } = setup();
  expect((await post('{"enabled":true}')).status).toBe(200);
  const off = await post('{"enabled":false}');
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({ ok: true, enabled: false });
  expect(calls).toEqual([true, false]);
});
