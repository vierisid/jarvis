import { afterEach, describe, expect, test } from 'bun:test';
import { NOTCH_DEMO_ENV, NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH, NOTCH_SCRIPT_PATH, NOTCH_STUDY_PATH, initNotchDemoGate, notchDemoGate } from './demo-gate.ts';
import { NOTCH_PAGE_PATH, notchRoutes } from './routes.ts';
import type { NotchScriptDeps } from './script.ts';
import type { ScriptedTurn } from '../llm/scripted.ts';

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

const postFixture = (routes: ReturnType<typeof notchRoutes>, body: unknown, token?: string): Promise<Response> =>
  routes[NOTCH_FIXTURE_PATH]!.POST(new Request(`http://localhost${NOTCH_FIXTURE_PATH}`, {
    method: 'POST',
    headers: token === undefined ? {} : { [NOTCH_DEMO_HEADER]: token },
    body: JSON.stringify(body),
  }));

function fakeFixtures() {
  const made: { kind: string; in?: number }[] = [];
  return {
    made,
    fixtures: {
      kinds: () => ['approval', 'promise'],
      make: async (kind: string, options: { in?: number }) => {
        if (kind === 'promise' && options.in === 13) throw new Error('No task could be made.');
        made.push({ kind, ...options });
        return `Made one ${kind}.`;
      },
    },
  };
}

afterEach(() => { initNotchDemoGate({ hosted: false, notch: true }, {}); });

describe('the notch routes', () => {
  // Off means the route is not there at all, not there-but-refused.
  test('do not exist while the switch is off', () => {
    expect(Object.keys(notchRoutes(false, { demo: fakeDemo().demo }))).toEqual([]);
  });

  test('the page is a built file at the root, not a route', () => {
    expect(NOTCH_PAGE_PATH).toBe('/notch.html');
    expect(Object.keys(notchRoutes(true))).toEqual([NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH, NOTCH_SCRIPT_PATH, NOTCH_STUDY_PATH]);
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

// The page and the desktop app meet at ten names. If one side renames one the
// window opens and stays empty, or hears nothing, and no type check sees it.
describe('the functions the page and the desktop app share', () => {
  test('every name the page uses is one the desktop app provides, and the other way round', async () => {
    const bridge = await Bun.file(new URL('../../ui/src/notch/bridge.ts', import.meta.url)).text();
    const host = await Bun.file(new URL('../../sidecar/notch_host.go', import.meta.url)).text();
    const pipe = await Bun.file(new URL('../../sidecar/notch.go', import.meta.url)).text();
    for (const name of ['__notch_set_outline', '__notch_focus', '__notch_send', '__notch_log', '__notch_esc', '__notch_keys']) {
      expect(bridge).toContain(`host.${name}?.(`);
      expect(host).toContain(`bind("${name}"`);
    }
    expect(bridge).toContain('host.__notch_receive = ');
    expect(pipe).toContain('window.__notch_receive&&window.__notch_receive(');
    expect(bridge).toContain('host.__notch_cursor = ');
    expect(host).toContain('window.__notch_cursor&&window.__notch_cursor(');
    // The keys: what they said, and which they are on this machine.
    const keyboard = await Bun.file(new URL('../../sidecar/notch_keyboard.go', import.meta.url)).text();
    expect(bridge).toContain('host.__notch_key = ');
    expect(keyboard).toContain('window.__notch_key&&window.__notch_key(');
    expect(bridge).toContain('host.__notch_pairs = ');
    expect(keyboard).toContain('window.__notch_pairs&&window.__notch_pairs(');
  });
});

describe('the fixture route', () => {
  test('is behind the same gate: shut, or without the secret, there is nothing there and nothing is made', async () => {
    const f = fakeFixtures();
    const routes = notchRoutes(true, { fixtures: f.fixtures });
    expect((await postFixture(routes, { kind: 'approval' }, SECRET)).status).toBe(404);
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await postFixture(routes, { kind: 'approval' })).status).toBe(404);
    expect((await postFixture(routes, { kind: 'approval' }, 'not-the-secret-at-all')).status).toBe(404);
    expect((await postFixture(notchRoutes(true), { kind: 'approval' }, SECRET)).status).toBe(404);
    expect(f.made).toEqual([]);
  });

  test('with the secret it lists the kinds and makes one, passing on a due time in range only', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const f = fakeFixtures();
    const routes = notchRoutes(true, { fixtures: f.fixtures, pages: () => 1 });
    expect(await (await postFixture(routes, { kind: 'list' }, SECRET)).json()).toEqual({ kinds: ['approval', 'promise'], pages: 1 });
    expect(await (await postFixture(routes, { kind: 'approval' }, SECRET)).json()).toEqual({ made: 'Made one approval.', pages: 1 });
    await postFixture(routes, { kind: 'promise', in: 120 }, SECRET);
    await postFixture(routes, { kind: 'promise', in: 2 }, SECRET);
    await postFixture(routes, { kind: 'promise', in: '120' }, SECRET);
    expect(f.made).toEqual([{ kind: 'approval' }, { kind: 'promise', in: 120 }, { kind: 'promise' }, { kind: 'promise' }]);
  });

  test('an unknown kind is refused, and a fixture that cannot be made says why', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const routes = notchRoutes(true, { fixtures: fakeFixtures().fixtures });
    const unknown = await postFixture(routes, { kind: 'constructor' }, SECRET);
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { kinds: string[] }).kinds).toEqual(['approval', 'promise']);
    const failed = await postFixture(routes, { kind: 'promise', in: 13 }, SECRET);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'No task could be made.' });
  });
});

describe('the script route', () => {
  function fakeScript(bound = true) {
    const seen: string[] = [];
    let turns: ScriptedTurn[] = [];
    const script: NotchScriptDeps = {
      load: (next) => { turns = next; seen.push(`load ${next.length}`); return next.length === 0 ? 'no-script' : bound ? 'bound' : 'real-model'; },
      turns: () => turns,
      calls: () => [],
      bound: () => bound && turns.length > 0,
      type: (text) => { seen.push(`type ${text}`); },
      say: (text) => { seen.push(`say ${text}`); },
    };
    return { script, seen };
  }
  const post = (routes: ReturnType<typeof notchRoutes>, body: unknown, token?: string): Promise<Response> =>
    routes[NOTCH_SCRIPT_PATH]!.POST(new Request(`http://localhost${NOTCH_SCRIPT_PATH}`, {
      method: 'POST', body: JSON.stringify(body), headers: token ? { [NOTCH_DEMO_HEADER]: token } : {},
    }));
  const HELLO = [{ match: 'hello', steps: [{ text: 'Hi.' }] }];

  test('is behind the same gate: shut, or without the secret, there is nothing there', async () => {
    const f = fakeScript();
    const routes = notchRoutes(true, { script: f.script });
    expect((await post(routes, { op: 'set', turns: HELLO }, SECRET)).status).toBe(404);
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await post(routes, { op: 'set', turns: HELLO })).status).toBe(404);
    expect((await post(notchRoutes(true), { op: 'list' }, SECRET)).status).toBe(404);
    expect(f.seen).toEqual([]);
  });

  test('loads a script, and then takes words as if typed or spoken', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const f = fakeScript();
    const routes = notchRoutes(true, { script: f.script, pages: () => 1 });
    // Before a script is loaded the stand-in does not answer, so no words are taken.
    expect((await post(routes, { op: 'type', text: 'hello' }, SECRET)).status).toBe(409);
    expect(await (await post(routes, { op: 'set', turns: HELLO }, SECRET)).json()).toEqual({ turns: 1, bound: true, pages: 1 });
    expect(await (await post(routes, { op: 'type', text: ' hello ' }, SECRET)).json()).toEqual({ typed: 'hello', pages: 1 });
    expect(await (await post(routes, { op: 'say', text: 'hello there' }, SECRET)).json()).toEqual({ said: 'hello there', pages: 1 });
    expect(await (await post(routes, { op: 'say' }, SECRET)).json()).toEqual({ said: null, pages: 1 });
    expect(f.seen).toEqual(['load 1', 'type hello', 'say hello there', 'say null']);
    expect((await post(routes, { op: 'type', text: '' }, SECRET)).status).toBe(400);
    expect((await post(routes, { op: 'nonsense' }, SECRET)).status).toBe(400);
  });

  test('on a brain with a real model nothing is loaded and no words are taken', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const f = fakeScript(false);
    const routes = notchRoutes(true, { script: f.script });
    const refused = await post(routes, { op: 'set', turns: HELLO }, SECRET);
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toContain('real model');
    expect((await post(routes, { op: 'say', text: 'delete everything' }, SECRET)).status).toBe(409);
    expect(f.seen).toEqual(['load 1']);
  });

  test('a script may call three fixed tools, with their fixed arguments, and nothing else', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const routes = notchRoutes(true, { script: fakeScript().script });
    const withCall = (name: string, args?: unknown) => [{ match: 'go', steps: [{ tool_calls: [{ name, ...(args === undefined ? {} : { arguments: args }) }] }] }];
    const status = async (turns: unknown): Promise<number> => (await post(routes, { op: 'set', turns }, SECRET)).status;
    expect(await status(withCall('get_system_info'))).toBe(200);
    expect(await status(withCall('run_command', { command: 'echo notch test' }))).toBe(200);
    expect(await status(withCall('request_approval', { action_category: 'execute_command', intent: 'Run the notch test command' }))).toBe(200);
    expect(await status(withCall('run_command', { command: 'rm -rf ~' }))).toBe(400);
    expect(await status(withCall('run_command', { command: 'echo notch test', cwd: '/' }))).toBe(400);
    expect(await status(withCall('get_system_info', { verbose: true }))).toBe(400);
    expect(await status(withCall('write_file', { path: 'x', content: 'y' }))).toBe(400);
    expect(await status(withCall('constructor'))).toBe(400);
    expect(await status(withCall('request_approval', { action_category: 'execute_command', intent: 'two\nlines' }))).toBe(400);
    // And a script that is not one.
    expect(await status([])).toBe(400);
    expect(await status([{ match: 'x', steps: [{ text: 'ok' }] }])).toBe(400);
    expect(await status([{ match: 'go', steps: [{ text: 'ok', surprise: true }] }])).toBe(400);
    expect(await status([{ match: 'go', steps: [{ error: { code: 'rate_limit', message: 'retried three times' } }] }])).toBe(400);
  });
});
