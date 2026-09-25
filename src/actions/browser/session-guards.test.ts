/**
 * BrowserController's #521 guards against a scripted fake of Chrome's
 * DevTools endpoints, for the paths a real browser will not reproduce on
 * demand: a guard that cannot be armed, a tab already sitting on a local
 * file, a page that is on file: when the model asks to read it, and a
 * navigation the in-browser guard fails. The real-browser counterparts are in
 * browser-local-files.test.ts.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { BrowserController } from './session.ts';

type Sent = { method: string; params?: Record<string, any> };
type Sock = ServerWebSocket<{ path: string }>;

type FakeOptions = {
  /** /json/version body. Default: a browser websocket. */
  version?: (port: number) => unknown;
  /** Page targets in /json/list. */
  pages?: Array<{ url: string }>;
  /** Error to return for Fetch.enable on the browser socket. */
  fetchEnableError?: string;
  /** URL of the main frame, as Page.getFrameTree reports it. */
  frameUrl?: () => string;
  /** Page.navigate handler; may talk to the browser socket first. */
  onNavigate?: (url: string, fake: Fake) => Promise<Record<string, unknown>>;
};

type Fake = {
  port: number;
  browserSent: Sent[];
  pageSent: Sent[];
  created: string[];
  /** Push an event on the browser socket (the request guard's). */
  browserEvent(method: string, params: Record<string, unknown>): void;
  /** Push an event on the page socket. */
  pageEvent(method: string, params: Record<string, unknown>): void;
  stop(): void;
};

function fakeChrome(opts: FakeOptions = {}): Fake {
  let browserSock: Sock | null = null;
  let pageSock: Sock | null = null;
  const fake: Fake = {
    port: 0,
    browserSent: [],
    pageSent: [],
    created: [],
    browserEvent: (method, params) => browserSock?.send(JSON.stringify({ method, params })),
    pageEvent: (method, params) => pageSock?.send(JSON.stringify({ method, params })),
    stop: () => server.stop(true),
  };

  const pageResult = async (method: string, params: Record<string, any>): Promise<Record<string, unknown>> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: opts.frameUrl?.() ?? 'https://example.com/' } } };
    if (method === 'Page.navigate') return opts.onNavigate ? opts.onNavigate(params.url, fake) : {};
    if (method === 'Page.captureScreenshot') return { data: 'SECRET-PIXELS' };
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      if (expr.includes('readyState')) return { result: { value: 'complete:5' } };
      if (expr.includes('__jarvis_elements')) {
        return { result: { value: { title: 'SECRET-TITLE', url: opts.frameUrl?.() ?? 'https://example.com/', text: 'SECRET-TEXT', elements: [] } } };
      }
      return { result: { value: 'SECRET-VALUE' } };
    }
    return {};
  };

  const server = Bun.serve<{ path: string }>({
    port: 0,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === '/browser' || pathname === '/page') {
        if (srv.upgrade(req, { data: { path: pathname } })) return;
        return new Response('upgrade failed', { status: 400 });
      }
      if (pathname === '/json/version') {
        return Response.json(opts.version ? opts.version(srv.port!) : { webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/browser` });
      }
      if (pathname === '/json/list') {
        return Response.json((opts.pages ?? [{ url: 'about:blank' }]).map(p => ({
          type: 'page', url: p.url, webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/page`,
        })));
      }
      if (pathname === '/json/new') {
        fake.created.push(`${req.method} ${new URL(req.url).search}`);
        return Response.json({ type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/page` });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path === '/browser') browserSock = ws;
        else pageSock = ws;
      },
      async message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, any> };
        if (ws.data.path === '/browser') {
          fake.browserSent.push({ method: msg.method, params: msg.params });
          if (msg.method === 'Fetch.enable' && opts.fetchEnableError) {
            ws.send(JSON.stringify({ id: msg.id, error: { message: opts.fetchEnableError } }));
            return;
          }
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        fake.pageSent.push({ method: msg.method, params: msg.params });
        const result = await pageResult(msg.method, msg.params ?? {});
        ws.send(JSON.stringify({ id: msg.id, result }));
        if (msg.method === 'Page.navigate') {
          ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
        }
      },
    },
  });
  fake.port = server.port!;
  return fake;
}

describe('BrowserController #521 guards (fake Chrome)', () => {
  let fake: Fake | null = null;
  let ctrl: BrowserController | null = null;

  afterEach(async () => {
    await ctrl?.disconnect();
    fake?.stop();
    ctrl = null;
    fake = null;
  });

  test('refuses to drive a browser whose request guard cannot be armed', async () => {
    fake = fakeChrome({ version: () => ({}) });
    ctrl = new BrowserController(fake.port);
    await expect(ctrl.connect()).rejects.toThrow(/Could not install the browser's local-file guard/);
    expect(ctrl.connected).toBe(false);
    expect(fake.pageSent).toHaveLength(0);

    fake.stop();
    fake = fakeChrome({ fetchEnableError: 'Fetch.enable wasn\'t found' });
    ctrl = new BrowserController(fake.port);
    await expect(ctrl.connect()).rejects.toThrow(/local-file guard.*Fetch\.enable/);
    expect(fake.pageSent).toHaveLength(0);
  });

  test('arms interception for file: and the DevTools ports before touching a page', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    const enable = fake.browserSent.find(s => s.method === 'Fetch.enable');
    const patterns = (enable?.params?.patterns ?? []).map((p: { urlPattern: string }) => p.urlPattern);
    expect(patterns).toContain('file:*');
    expect(patterns).toContain(`*://*:${fake.port}/*`);
    expect(patterns).toContain('*://*:9222/*');
    expect(patterns).toContain('*://*:9223/*');
  });

  test('fails paused local-file requests and lets textual port matches through', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    fake.browserEvent('Fetch.requestPaused', { requestId: 'r1', resourceType: 'Document', request: { url: 'file:///etc/hostname' } });
    fake.browserEvent('Fetch.requestPaused', { requestId: 'r2', resourceType: 'Document', request: { url: 'https://example.com/a:9222/' } });
    for (let i = 0; i < 100 && fake.browserSent.filter(s => s.method.startsWith('Fetch.') && s.method !== 'Fetch.enable').length < 2; i++) await Bun.sleep(5);
    expect(fake.browserSent).toContainEqual({ method: 'Fetch.failRequest', params: { requestId: 'r1', errorReason: 'BlockedByClient' } });
    expect(fake.browserSent).toContainEqual({ method: 'Fetch.continueRequest', params: { requestId: 'r2' } });
  });

  test('prefers a drivable tab, and blanks a local one it has to adopt', async () => {
    fake = fakeChrome({ pages: [{ url: 'file:///etc/hostname' }, { url: 'https://example.com/' }] });
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    expect(fake.pageSent.some(s => s.method === 'Page.navigate')).toBe(false);
    await ctrl.disconnect();
    fake.stop();

    fake = fakeChrome({ pages: [{ url: 'file:///etc/hostname' }] });
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    expect(fake.pageSent.filter(s => s.method === 'Page.navigate').map(s => s.params?.url)).toEqual(['about:blank']);
    expect(fake.created).toHaveLength(0);
  });

  test('creates a tab with PUT when there is none', async () => {
    fake = fakeChrome({ pages: [] });
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    expect(fake.created).toEqual(['PUT ?about:blank']);
  });

  test('never reads a page that shows a local file', async () => {
    let frameUrl = 'file:///home/me/.jarvis/config.yaml';
    fake = fakeChrome({ frameUrl: () => frameUrl });
    ctrl = new BrowserController(fake.port);
    await ctrl.connect();
    for (const read of [() => ctrl!.evaluate('document.body.innerText'), () => ctrl!.screenshotBuffer(), () => ctrl!.snapshot()]) {
      await expect(read()).rejects.toThrow(/Refusing to read file:\/\/\/home\/me\/\.jarvis\/config\.yaml/);
    }
    expect(fake.pageSent.some(s => s.method === 'Page.captureScreenshot')).toBe(false);

    // The same reads work on a web page.
    frameUrl = 'https://example.com/';
    expect(await ctrl.evaluate('1')).toBe('SECRET-VALUE');
    expect((await ctrl.screenshotBuffer()).base64).toBe('SECRET-PIXELS');
  });

  test('a navigation the guard failed is reported as blocked, naming where it led', async () => {
    fake = fakeChrome({
      onNavigate: async (url, f) => {
        // What a redirect into a blocked URL looks like from here: the guard
        // sees the document request, then Page.navigate reports the failure.
        f.browserEvent('Fetch.requestPaused', {
          requestId: 'nav', resourceType: 'Document',
          request: { url: 'http://127.0.0.1:9222/json/new?file:///etc/hostname' },
        });
        await Bun.sleep(50);
        return { frameId: 'f', errorText: url.includes('blocked') ? 'net::ERR_BLOCKED_BY_CLIENT' : undefined };
      },
    });
    ctrl = new BrowserController(fake.port);
    await expect(ctrl.navigate('https://example.com/blocked')).rejects.toThrow(
      /Navigation to https:\/\/example\.com\/blocked was blocked: it led to http:\/\/127\.0\.0\.1:9222\/json\/new\?file:\/\/\/etc\/hostname, and requests to a Jarvis browser's DevTools port are blocked\./,
    );
  }, 15_000);

  test('a blocked subresource does not turn a successful navigation into an error', async () => {
    fake = fakeChrome({
      onNavigate: async (_url, f) => {
        f.browserEvent('Fetch.requestPaused', { requestId: 'img', resourceType: 'Image', request: { url: 'file:///etc/hostname' } });
        await Bun.sleep(50);
        // Chrome only reports ERR_BLOCKED_BY_CLIENT for the document itself;
        // simulate the mislabel risk by reporting it anyway.
        return { frameId: 'f', errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
      },
    });
    ctrl = new BrowserController(fake.port);
    const snap = await ctrl.navigate('https://example.com/');
    expect(snap.text).toBe('SECRET-TEXT');
  }, 15_000);

  test('a refused URL never connects, launches or navigates', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port);
    await expect(ctrl.navigate('file:///etc/hostname')).rejects.toThrow(/Refusing to open/);
    expect(ctrl.connected).toBe(false);
    expect(fake.browserSent).toHaveLength(0);
  });
});
