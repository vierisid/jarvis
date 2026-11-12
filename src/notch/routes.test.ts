import { afterEach, describe, expect, test } from 'bun:test';
import { NOTCH_DEMO_ENV, NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, initNotchDemoGate, notchDemoGate } from './demo-gate.ts';
import { NOTCH_PAGE_PATH, notchRoutes } from './routes.ts';

const SECRET = 'a-secret-of-sixteen-or-more';

function fakeDemo() {
  const played: string[] = [];
  let stopped = 0;
  return {
    played,
    stops: () => stopped,
    demo: {
      names: () => ['morning', 'mail'],
      play: (name: string) => { if (name !== 'morning' && name !== 'mail') return false; played.push(name); return true; },
      stop: () => { stopped++; },
      running: () => played.at(-1) ?? null,
    },
  };
}

const post = (routes: ReturnType<typeof notchRoutes>, body: unknown, token?: string): Promise<Response> =>
  routes[NOTCH_DEMO_PATH]!.POST(new Request(`http://localhost${NOTCH_DEMO_PATH}`, {
    method: 'POST',
    headers: token === undefined ? {} : { [NOTCH_DEMO_HEADER]: token },
    body: JSON.stringify(body),
  }));

afterEach(() => { initNotchDemoGate({ hosted: false, notch: true }, {}); });

describe('the notch routes', () => {
  // Off means the route is not there at all, not there-but-refused.
  test('do not exist while the switch is off', () => {
    expect(Object.keys(notchRoutes(false, { demo: fakeDemo().demo }))).toEqual([]);
  });

  test('the page is a built file at the root, not a route', () => {
    expect(NOTCH_PAGE_PATH).toBe('/notch.html');
    expect(Object.keys(notchRoutes(true))).toEqual([NOTCH_DEMO_PATH]);
  });
});

describe('the demo gate', () => {
  test('is shut without a secret, with a short one, on a hosted install, and with the notch off', () => {
    expect(initNotchDemoGate({ hosted: false, notch: true }, {})).toBe('off');
    expect(initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: 'short' })).toBe('too-short');
    expect(initNotchDemoGate({ hosted: true, notch: true }, { [NOTCH_DEMO_ENV]: SECRET })).toBe('refused-hosted');
    expect(initNotchDemoGate({ hosted: false, notch: false }, { [NOTCH_DEMO_ENV]: SECRET })).toBe('notch-off');
    expect(notchDemoGate()).toBeNull();
  });

  test('takes the secret out of the environment whatever the outcome', () => {
    for (const opts of [{ hosted: false, notch: true }, { hosted: true, notch: true }, { hosted: false, notch: false }]) {
      const env: Record<string, string | undefined> = { [NOTCH_DEMO_ENV]: SECRET };
      initNotchDemoGate(opts, env);
      expect(NOTCH_DEMO_ENV in env).toBe(false);
    }
  });

  test('a shut gate, a missing token and a wrong token all answer 404 and play nothing', async () => {
    const f = fakeDemo();
    const routes = notchRoutes(true, { demo: f.demo });
    expect((await post(routes, { moment: 'morning' }, SECRET)).status).toBe(404);
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await post(routes, { moment: 'morning' })).status).toBe(404);
    expect((await post(routes, { moment: 'morning' }, 'a-secret-of-sixteen-or-morf')).status).toBe(404);
    expect((await post(routes, { moment: 'morning' }, SECRET.slice(0, -1))).status).toBe(404);
    expect(f.played).toEqual([]);
  });

  test('with the right token it plays, lists and stops', async () => {
    const f = fakeDemo();
    const routes = notchRoutes(true, { demo: f.demo, pages: () => 1 });
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const played = await post(routes, { moment: 'mail' }, SECRET);
    expect(played.status).toBe(200);
    expect(await played.json()).toEqual({ playing: 'mail', pages: 1 });
    expect(await (await post(routes, { moment: 'list' }, SECRET)).json()).toEqual({ moments: ['morning', 'mail'], running: 'mail', pages: 1 });
    expect(await (await post(routes, { moment: 'stop' }, SECRET)).json()).toEqual({ stopped: true, pages: 1 });
    expect(f.played).toEqual(['mail']);
    expect(f.stops()).toBe(1);
  });

  test('an unknown moment, or a body that is not what it should be, is a plain refusal', async () => {
    const f = fakeDemo();
    const routes = notchRoutes(true, { demo: f.demo });
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    for (const body of [{ moment: 'nothing' }, { moment: 7 }, {}, 'morning', null]) {
      const res = await post(routes, body, SECRET);
      expect(res.status).toBe(400);
      expect((await res.json() as { moments: string[] }).moments).toEqual(['morning', 'mail']);
    }
    expect(f.played).toEqual([]);
  });
});

// The page and the desktop app meet at six names. If one side renames one the
// window opens and stays empty, or hears nothing, and no type check sees it.
describe('the functions the page and the desktop app share', () => {
  test('every name the page uses is one the desktop app provides, and the other way round', async () => {
    const bridge = await Bun.file(new URL('../../ui/src/notch/bridge.ts', import.meta.url)).text();
    const host = await Bun.file(new URL('../../sidecar/notch_host.go', import.meta.url)).text();
    const pipe = await Bun.file(new URL('../../sidecar/notch.go', import.meta.url)).text();
    for (const name of ['__notch_set_outline', '__notch_focus', '__notch_send', '__notch_log']) {
      expect(bridge).toContain(`host.${name}?.(`);
      expect(host).toContain(`bind("${name}"`);
    }
    expect(bridge).toContain('host.__notch_receive = ');
    expect(pipe).toContain('window.__notch_receive&&window.__notch_receive(');
    expect(bridge).toContain('host.__notch_cursor = ');
    expect(host).toContain('window.__notch_cursor&&window.__notch_cursor(');
  });
});
