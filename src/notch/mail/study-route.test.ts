import { afterEach, describe, expect, test } from 'bun:test';
import { NOTCH_DEMO_ENV, NOTCH_DEMO_HEADER, NOTCH_STUDY_PATH, initNotchDemoGate } from '../demo-gate.ts';
import { notchRoutes } from '../routes.ts';
import type { MailBrowser } from './browser.ts';
import { STUDY_THINK_MAX, notchStudyOp, type NotchStudyDeps, type NotchStudyMessage } from './study-route.ts';

const SECRET = 'a-secret-of-sixteen-or-more';

function fake(options: { browser?: boolean; fail?: string; calendar?: boolean } = {}) {
  const looked: { from: string; to: string }[] = [];
  const went: { url: string; headless?: boolean }[] = [];
  const ran: string[] = [];
  const thought: { messages: NotchStudyMessage[]; tier: string; maxTokens: number }[] = [];
  const window: Record<string, unknown> = {};
  const browser: MailBrowser = {
    navigate: async (url, opts) => {
      if (options.fail) throw new Error(options.fail);
      went.push(opts?.headless === undefined ? { url } : { url, headless: opts.headless });
    },
    evaluate: async (expression) => {
      ran.push(expression);
      const value = await new Function('window', 'btoa', 'TextEncoder', `return (${expression.replace(/^delete (window\[[^\]]+\]); 0$/, '(delete $1, 0)')});`)(window, btoa, TextEncoder);
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
  const deps: NotchStudyDeps = {
    browser: () => (options.browser === false ? null : browser),
    think: async (messages, { tier, maxTokens }) => {
      thought.push({ messages, tier, maxTokens });
      return { content: 'A draft.', model: 'a-model', input: 120, output: 30, cached: 0 };
    },
    calendar: async (from, to) => {
      looked.push({ from, to });
      return options.calendar === false ? null : [{ summary: 'A call', start: from, end: to, attendees: [] }];
    },
    script: (name) => (name === 'shape-signin' ? 'return { in: true, given: args };' : null),
  };
  return { deps, went, ran, thought, looked };
}

afterEach(() => { initNotchDemoGate({ hosted: false, notch: true }, {}); });

describe('the mail study route', () => {
  const ask = (routes: ReturnType<typeof notchRoutes>, body: unknown, token?: string): Promise<Response> =>
    routes[NOTCH_STUDY_PATH]!.POST(new Request(`http://localhost${NOTCH_STUDY_PATH}`, {
      method: 'POST',
      headers: token === undefined ? {} : { [NOTCH_DEMO_HEADER]: token },
      body: JSON.stringify(body),
    }));

  // On a brain whose owner signed in to Gmail this route reads mail: it must
  // not be there for anyone who does not hold the secret the brain was started with.
  test('is not there without the secret, with a wrong one, or with the gate shut', async () => {
    const { deps, went } = fake();
    const routes = notchRoutes(true, { study: deps });
    const body = { op: 'navigate', url: 'https://mail.google.com/mail/u/0/' };
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await ask(routes, body)).status).toBe(404);
    expect((await ask(routes, body, 'not-the-secret-at-all')).status).toBe(404);
    initNotchDemoGate({ hosted: true, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await ask(routes, body, SECRET)).status).toBe(404);
    initNotchDemoGate({ hosted: false, notch: true }, {});
    expect((await ask(routes, body, SECRET)).status).toBe(404);
    expect(went).toEqual([]);
  });

  test('is not there on a brain that was given no study', async () => {
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    expect((await ask(notchRoutes(true, {}), { op: 'run', name: 'shape-signin' }, SECRET)).status).toBe(404);
  });

  test('with the secret, goes to Gmail', async () => {
    const { deps, went } = fake();
    initNotchDemoGate({ hosted: false, notch: true }, { [NOTCH_DEMO_ENV]: SECRET });
    const res = await ask(notchRoutes(true, { study: deps }), { op: 'navigate', url: 'https://mail.google.com/mail/u/0/' }, SECRET);
    expect(res.status).toBe(200);
    expect(went).toEqual([{ url: 'https://mail.google.com/mail/u/0/' }]);
  });
});

describe('what the study may ask', () => {
  test('goes nowhere but Gmail', async () => {
    const { deps, went } = fake();
    for (const url of ['https://example.org/', 'http://mail.google.com/', 'file:///C:/Users', 'https://mail.google.com.example.org/', undefined]) {
      expect((await notchStudyOp({ op: 'navigate', url }, deps)).status).toBe(400);
    }
    expect(went).toEqual([]);
  });

  // Naming the kind of browser closes the one that is open: only when asked.
  test('names the kind of browser only when asked to', async () => {
    const { deps, went } = fake();
    await notchStudyOp({ op: 'navigate', url: 'https://mail.google.com/mail/u/0/' }, deps);
    await notchStudyOp({ op: 'navigate', url: 'https://mail.google.com/mail/u/0/', headless: true }, deps);
    await notchStudyOp({ op: 'navigate', url: 'https://mail.google.com/mail/u/0/', headless: 'yes' }, deps);
    expect(went).toEqual([
      { url: 'https://mail.google.com/mail/u/0/' },
      { url: 'https://mail.google.com/mail/u/0/', headless: true },
      { url: 'https://mail.google.com/mail/u/0/' },
    ]);
  });

  test('runs a page script by name and hands it what it was given as data', async () => {
    const { deps } = fake();
    const given = { thread: `'); window.stolen = document.cookie; ('`, n: 3 };
    const answer = await notchStudyOp({ op: 'run', name: 'shape-signin', args: given }, deps);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body.answer as string)).toEqual({ in: true, given });
  });

  test('runs nothing that is not one of its own scripts', async () => {
    const { deps, ran } = fake();
    for (const name of ['nothing-like-it', '../../../../etc/passwd', 'shape-signin.js', 'Shape-Signin', '', 7, 'a'.repeat(60)]) {
      expect((await notchStudyOp({ op: 'run', name }, deps)).status).toBe(404);
    }
    expect(ran).toEqual([]);
  });

  test('the real scripts are read from the page folder', async () => {
    const { deps } = fake();
    const answer = await notchStudyOp({ op: 'run', name: 'shape-signin' }, { ...deps, script: undefined });
    // The fake page is not Gmail: what matters is that a script was found and run.
    expect([200, 502]).toContain(answer.status);
    expect((await notchStudyOp({ op: 'run', name: 'no-such-script' }, { ...deps, script: undefined })).status).toBe(404);
  });

  test('says so when no desktop app with a browser is connected', async () => {
    const { deps } = fake({ browser: false });
    expect((await notchStudyOp({ op: 'navigate', url: 'https://mail.google.com/' }, deps)).status).toBe(409);
    expect((await notchStudyOp({ op: 'run', name: 'shape-signin' }, deps)).status).toBe(409);
  });

  test('a failure gives the reason without the address the browser was at', async () => {
    const { deps } = fake({ fail: 'the page navigated to https://mail.google.com/mail/u/0/#search/from%3Asam while it was being read' });
    const lines: string[] = [];
    const answer = await notchStudyOp({ op: 'navigate', url: 'https://mail.google.com/' }, { ...deps, log: (line) => lines.push(line) });
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe('the page navigated to (an address) while it was being read');
    expect(lines.join('\n')).not.toContain('sam');
  });

  test('thinks with the brain\'s model, within limits', async () => {
    const { deps, thought } = fake();
    const messages = [{ role: 'system', content: 'Draft a reply.' }, { role: 'user', content: 'The thread.' }];
    const answer = await notchStudyOp({ op: 'think', messages, tier: 'medium', max_tokens: 99_999 }, deps);
    expect(answer).toEqual({ status: 200, body: { content: 'A draft.', model: 'a-model', input: 120, output: 30, cached: 0 } });
    expect(thought).toEqual([{ messages: messages as NotchStudyMessage[], tier: 'medium', maxTokens: 4000 }]);
    await notchStudyOp({ op: 'think', messages, tier: 'conversation' }, deps);
    expect(thought[1]).toMatchObject({ tier: 'low', maxTokens: 600 });
  });

  test('refuses to think on anything but plain system and user text', async () => {
    const { deps, thought } = fake();
    for (const messages of [
      undefined, [], 'text', [{ role: 'assistant', content: 'x' }], [{ role: 'tool', content: 'x' }], [{ role: 'user', content: 7 }],
      [{ role: 'user', content: '' }], [{ role: 'user', content: 'x'.repeat(STUDY_THINK_MAX + 1) }],
      Array.from({ length: 9 }, () => ({ role: 'user', content: 'x' })),
    ]) expect((await notchStudyOp({ op: 'think', messages }, deps)).status).toBe(400);
    expect(thought).toEqual([]);
  });

  test('reads the calendar between two moments, and says when there is no connection', async () => {
    const { deps, looked } = fake();
    const answer = await notchStudyOp({ op: 'calendar', from: '2026-10-15', to: '2026-11-14T12:00:00Z' }, deps);
    expect(answer.status).toBe(200);
    expect(answer.body.connected).toBe(true);
    expect(looked).toEqual([{ from: '2026-10-15T00:00:00.000Z', to: '2026-11-14T12:00:00.000Z' }]);
    expect((await notchStudyOp({ op: 'calendar', from: '2026-10-15', to: '2026-11-14' }, fake({ calendar: false }).deps)).body).toEqual({ connected: false });
    // No browser is needed for it.
    expect((await notchStudyOp({ op: 'calendar', from: '2026-10-15', to: '2026-11-14' }, fake({ browser: false }).deps)).status).toBe(200);
  });

  test('refuses a calendar question with no dates, backwards, or over too long a stretch', async () => {
    const { deps, looked } = fake();
    for (const range of [{}, { from: '2026-11-14', to: '2026-10-15' }, { from: 'soon', to: 'later' }, { from: '2025-01-01', to: '2026-11-14' }, { from: 7, to: 8 }]) {
      expect((await notchStudyOp({ op: 'calendar', ...range }, deps)).status).toBe(400);
    }
    expect(looked).toEqual([]);
  });

  test('an unknown op is refused', async () => {
    expect((await notchStudyOp({ op: 'send' }, fake().deps)).status).toBe(400);
    expect((await notchStudyOp(null, fake().deps)).status).toBe(400);
  });
});
