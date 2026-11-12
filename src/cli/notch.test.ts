import { describe, expect, test } from 'bun:test';
import { cmdNotch } from './notch.ts';
import type { NotchCliDeps } from './notch.ts';

const SECRET = 'a-secret-of-sixteen-or-more';

function deps(over: Partial<NotchCliDeps> & { answer?: () => Response } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const d: NotchCliDeps = {
    env: { JARVIS_NOTCH_DEMO: SECRET },
    port: () => 3142,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return over.answer ? over.answer() : Response.json({ playing: 'mail', pages: 1 });
    },
    ...over,
  };
  return { d, out, err, calls };
}

describe('jarvis notch demo', () => {
  test('plays a moment on the running brain, with the secret in its header', async () => {
    const h = deps();
    expect(await cmdNotch(['demo', 'mail'], h.d)).toBe(0);
    expect(h.calls).toEqual([{
      url: 'http://127.0.0.1:3142/api/notch/demo',
      headers: { 'Content-Type': 'application/json', 'x-notch-demo-token': SECRET },
      body: { moment: 'mail' },
    }]);
    expect(h.out).toEqual(['Playing "mail".']);
  });

  test('with no moment it lists them', async () => {
    const h = deps({ answer: () => Response.json({ moments: ['morning', 'mail'], running: 'mail', pages: 1 }) });
    expect(await cmdNotch(['demo'], h.d)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ moment: 'list' });
    expect(h.out).toEqual(['Moments: morning, mail', 'Playing now: mail']);
  });

  test('--port names the brain to talk to', async () => {
    const h = deps({ port: () => null });
    expect(await cmdNotch(['demo', 'mail', '--port', '3143'], h.d)).toBe(0);
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:3143/api/notch/demo');
  });

  test('says so when no desktop app is showing the notch', async () => {
    const h = deps({ answer: () => Response.json({ playing: 'mail', pages: 0 }) });
    expect(await cmdNotch(['demo', 'mail'], h.d)).toBe(0);
    expect(h.out.at(-1)).toContain('No desktop app is showing the notch');
  });

  test('without the secret it calls nothing and explains', async () => {
    const h = deps({ env: {} });
    expect(await cmdNotch(['demo', 'mail'], h.d)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join(' ')).toContain('JARVIS_NOTCH_DEMO is not set');
  });

  test('a brain with no demo is told apart from a brain that is not there', async () => {
    const shut = deps({ answer: () => Response.json({ error: 'Not found' }, { status: 404 }) });
    expect(await cmdNotch(['demo', 'mail'], shut.d)).toBe(1);
    expect(shut.err.join(' ')).toContain('has no notch demo');

    const none = deps({ port: () => null });
    expect(await cmdNotch(['demo', 'mail'], none.d)).toBe(1);
    expect(none.calls).toEqual([]);
    expect(none.err.join(' ')).toContain('No running brain was found');

    const down = deps({ fetch: async () => { throw new Error('connection refused'); } });
    expect(await cmdNotch(['demo', 'mail'], down.d)).toBe(1);
    expect(down.err.join(' ')).toContain('did not answer');
  });

  test('an unknown moment lists the ones there are', async () => {
    const h = deps({ answer: () => Response.json({ error: 'No moment is called "x"', moments: ['morning', 'mail'] }, { status: 400 }) });
    expect(await cmdNotch(['demo', 'x'], h.d)).toBe(2);
    expect(h.err).toEqual(['No moment is called "x"', 'Moments: morning, mail']);
  });

  test('anything that is not "notch demo ..." is a usage error and calls nothing', async () => {
    for (const args of [[], ['show'], ['demo', 'a', 'b'], ['demo', '--loud'], ['demo', 'mail', '--port', 'x'], ['demo', '--port']]) {
      const h = deps();
      expect(await cmdNotch(args, h.d)).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.err[0]).toContain('usage: jarvis notch demo');
    }
  });
});

describe('jarvis notch fixture', () => {
  test('makes one on the running brain and says what the brain said', async () => {
    const h = deps({ answer: () => Response.json({ made: 'An approval is waiting: write a line into notch-fixture.txt.', pages: 1 }) });
    expect(await cmdNotch(['fixture', 'approval'], h.d)).toBe(0);
    expect(h.calls).toEqual([{
      url: 'http://127.0.0.1:3142/api/notch/fixture',
      headers: { 'Content-Type': 'application/json', 'x-notch-demo-token': SECRET },
      body: { kind: 'approval' },
    }]);
    expect(h.out).toEqual(['An approval is waiting: write a line into notch-fixture.txt.']);
  });

  test('with no kind it lists them, and --in gives a due time in seconds', async () => {
    const h = deps({ answer: () => Response.json({ kinds: ['approval', 'promise'], pages: 1 }) });
    expect(await cmdNotch(['fixture'], h.d)).toBe(0);
    expect(h.out).toEqual(['Fixtures: approval, promise']);
    expect(await cmdNotch(['fixture', 'promise', '--in', '120', '--port', '3143'], h.d)).toBe(0);
    expect(h.calls[1]!.url).toBe('http://127.0.0.1:3143/api/notch/fixture');
    expect(h.calls[1]!.body).toEqual({ kind: 'promise', in: 120 });
  });

  test('--in is for fixtures only, and must be a sensible number', async () => {
    const h = deps();
    expect(await cmdNotch(['demo', 'mail', '--in', '120'], h.d)).toBe(2);
    expect(await cmdNotch(['fixture', 'promise', '--in', 'soon'], h.d)).toBe(2);
    expect(await cmdNotch(['fixture', 'promise', '--in', '1'], h.d)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test('an unknown kind and a fixture that failed are told apart', async () => {
    const unknown = deps({ answer: () => Response.json({ error: 'No fixture is called "x"', kinds: ['approval'] }, { status: 400 }) });
    expect(await cmdNotch(['fixture', 'x'], unknown.d)).toBe(2);
    expect(unknown.err).toEqual(['No fixture is called "x"', 'Fixtures: approval']);
    const failed = deps({ answer: () => Response.json({ error: 'No task could be made.' }, { status: 500 }) });
    expect(await cmdNotch(['fixture', 'promise'], failed.d)).toBe(1);
    expect(failed.err).toEqual(['No task could be made.']);
  });
});
