/**
 * #603 - "the document identity says unchanged when the thing it identifies has
 * changed", in the three ways that were reachable:
 *
 *   - `document.open()`/`document.write()` replaces the DOM without changing
 *     the loaderId (measured on Chromium 153: neither the loaderId nor
 *     `frame.url` moves, every element ref is detached, and
 *     `documentElement`/`body` identity changes);
 *   - `scroll()` invalidated every coordinate without clearing the map, so a
 *     coordinate handed out afterwards described where an element used to be -
 *     reachable with no page involvement at all;
 *   - an empty loaderId compared equal to another empty one.
 *
 * The constraint that makes this subtle, and the reason the fix is a sentinel
 * rather than a URL comparison: `history.pushState` changes `frame.url` WITHOUT
 * changing the loaderId (measured), and that is how every SPA navigates - so
 * comparing both fields would refuse an ordinary click on Gmail, Linear and the
 * cell-to-cell moves webapp-templates/gsheets.yaml tells the model to reuse an
 * id across. The first test here is that case, and it must keep passing.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { BrowserController } from './session.ts';

type SockData = { path: string };
const ELEMENTS_CONTEXT = 91;

type Fake = {
  port: number;
  /** Change `frame.url` without committing a document, as pushState does. */
  pushState(url: string): void;
  /**
   * What the per-element sentinel reports: 'ok', 'dom' (this element's document
   * was replaced), 'moved' (it is no longer where the id says), or 'gone'.
   */
  setGeneration(value: string): void;
  /** Mouse presses the controller dispatched. */
  presses(): Array<{ x: number; y: number }>;
  /** Did the in-page scroll actually run? */
  scrolled(): boolean;
  /** Never answer the sentinel, as a blocked renderer would not. */
  stallSentinel(): void;
  stop(): void;
};

function fakeChrome(): Fake {
  let frameUrl = 'https://app.example/inbox';
  let generation = 'ok';
  let didScroll = false;
  let stalled = false;
  const presses: Array<{ x: number; y: number }> = [];

  const pageResult = async (method: string, params: Record<string, any>): Promise<Record<string, unknown>> => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'FRAME-1', url: frameUrl, loaderId: 'LOADER-1' } } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ELEMENTS_CONTEXT };
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') presses.push({ x: params.x, y: params.y });
      return {};
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      if (expr.includes('readyState')) return { result: { value: 'complete:3' } };
      if (expr.includes('globalThis.__jarvis_dom;')) {
        if (stalled) await new Promise<void>(() => { /* never resolves */ });
        return { result: { value: generation } };
      }
      if (expr.includes('window.innerHeight')) return { result: { value: 800 } };
      if (expr.includes('window.scrollBy')) { didScroll = true; return { result: { value: null } }; }
      if (expr.includes('__jarvis_elements =')) {
        return {
          result: {
            value: {
              title: 'Inbox',
              url: frameUrl,
              text: 'Inbox',
              elements: [
                { id: 1, tag: 'button', text: 'Archive', attrs: {}, x: 10, y: 20 },
                { id: 2, tag: 'button', text: 'Delete', attrs: {}, x: 10, y: 60 },
              ],
            },
          },
        };
      }
      // The focus script and the focus verification, for the type path.
      return { result: { value: 'ok' } };
    }
    if (method === 'Input.insertText') return {};
    return {};
  };

  const server = Bun.serve<SockData>({
    port: 0,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === '/browser' || pathname === '/page') {
        if (srv.upgrade(req, { data: { path: pathname } })) return;
        return new Response('upgrade failed', { status: 400 });
      }
      if (pathname === '/json/version') {
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/browser` });
      }
      if (pathname === '/json/list') {
        return Response.json([{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/page` }]);
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      async message(ws: ServerWebSocket<SockData>, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, any> };
        if (ws.data.path === '/browser') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        try {
          ws.send(JSON.stringify({ id: msg.id, result: await pageResult(msg.method, msg.params ?? {}) }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: { message: String(err) } }));
        }
      },
    },
  });

  return {
    port: server.port!,
    pushState: (url) => { frameUrl = url; },
    setGeneration: (value) => { generation = value; },
    presses: () => presses,
    scrolled: () => didScroll,
    stallSentinel: () => { stalled = true; },
    stop: () => server.stop(true),
  };
}

describe('#603 what the document identity has to mean', () => {
  let fake: Fake | null = null;
  let ctrl: BrowserController | null = null;

  afterEach(async () => {
    await ctrl?.disconnect();
    fake?.stop();
    ctrl = null;
    fake = null;
  });

  const connected = async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port, undefined, { autoLaunch: false });
    await ctrl.connect();
    await ctrl.snapshot();
    return { fake: fake!, ctrl: ctrl! };
  };

  test('a pushState does not cost an ordinary SPA click', async () => {
    const { fake, ctrl } = await connected();

    // The URL changes, the loaderId holds, the DOM is untouched. This is Gmail
    // opening a message, Linear opening an issue, a gsheets cell move.
    fake.pushState('https://app.example/inbox/message/42');
    fake.setGeneration('ok');

    expect(await ctrl.click(2)).toBe('Clicked element [2]');
    expect(fake.presses()).toEqual([{ x: 10, y: 60 }]);
  });

  test('a document.write refuses the click it has invalidated', async () => {
    const { fake, ctrl } = await connected();

    // Measured: document.open()/write() leaves the loaderId AND the URL
    // unchanged, so nothing the frame tree reports moves - the sentinel in the
    // isolated world is the only thing that can see it.
    fake.setGeneration('dom');

    const result = await ctrl.click(2);
    expect(result).toContain('replaced the document');
    expect(result).toContain('browser_snapshot');
    expect(fake.presses()).toEqual([]);
  });

  // NOT TESTED HERE: that a frame rewriting itself retires only its own ids.
  // That property lives inside the in-page sentinel, which this fake replaces
  // wholesale, so a test here could only assert the canned answer it was just
  // given. It is proved against real Chromium in
  // sidecar/browser_document_identity_test.go, and the TypeScript sentinel
  // inherits it by being byte-identical to the Go one (checked by extracting
  // and diffing both scripts).

  test('a renderer that will not answer is reported as retryable', async () => {
    const { fake, ctrl } = await connected();

    // A long task, or a modal dialog nothing has dismissed: the sentinel's own
    // read never comes back. The click must refuse -- a coordinate nobody
    // could confirm is not dispatched -- but it must say TRY AGAIN, because
    // telling the model to take a snapshot sends it at a renderer that will
    // not serve that either. This is also why the sentinel does not inherit
    // the CDP client's 30-second budget.
    fake.stallSentinel();

    const started = Date.now();
    const result = await ctrl.click(2);
    expect(result).toContain('too busy');
    expect(result).toContain('Try again');
    expect(fake.presses()).toEqual([]);
    // It gave up on its own budget rather than the client's 30 seconds.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test('a scroll refuses a click but not a type', async () => {
    const { fake, ctrl } = await connected();

    // The page scrolled itself, an inner list scrolled, a late banner reflowed
    // the page, or the window was resized: nothing announced it and no
    // loaderId moved, but this element is no longer where its id says.
    fake.setGeneration('moved');

    const clicked = await ctrl.click(2);
    expect(clicked).toContain('has moved since the snapshot');
    expect(fake.presses()).toEqual([]);

    // Typing reaches its element through the ref, not the coordinate, and
    // typing itself scrolls the caret into view -- so refusing it here would
    // make the second type into one contenteditable refuse itself.
    const typed = await ctrl.type(2, 'hello');
    expect(typed).not.toContain('moved');
  });

  test('scroll() drops the ids it has invalidated', async () => {
    const { fake, ctrl } = await connected();

    const message = await ctrl.scroll('down');
    expect(fake.scrolled()).toBe(true);
    // Said in the reply, because the model is the one that has to re-snapshot.
    expect(message).toContain('no longer apply');

    // The coordinate map is gone, so nothing can dispatch at a pre-scroll
    // point -- including the readers that do not run the use-time sentinel,
    // like the pebble narration's position.
    expect(ctrl.snapshotElementPoint(2)).toBeNull();
    expect(await ctrl.viewportScreenOrigin(2)).toBe('moved');
    expect(await ctrl.click(2)).toContain('not found');
    expect(fake.presses()).toEqual([]);
  });

  test('a paging key retires the ids it moved, and says so', async () => {
    const { fake, ctrl } = await connected();

    // PageDown scrolls, which moves every coordinate with nothing any
    // document check can see. Unlike browser_scroll it was silent, so the
    // model's next error read as "that id was never valid".
    const pressed = await ctrl.pressKey('PageDown');
    expect(pressed).toContain('no longer apply');
    expect(ctrl.snapshotElementPoint(2)).toBeNull();

    // Enter is not a paging key: a model works through a list it has already
    // snapshotted with Enter and the arrows, and retiring the ids there would
    // break "press Enter, then click [5]" for a cosmetic pointer.
    await ctrl.snapshot();
    const enter = await ctrl.pressKey('Enter');
    expect(enter).not.toContain('no longer apply');
    expect(ctrl.snapshotElementPoint(2)).toEqual({ x: 10, y: 60 });
  });

  test('a sentinel that cannot be read refuses rather than guessing', async () => {
    const { fake, ctrl } = await connected();

    // A world that has gone, a reply that makes no sense.
    fake.setGeneration('nonsense');

    const result = await ctrl.click(2);
    expect(result).toContain('cannot be addressed any more');
    expect(fake.presses()).toEqual([]);
  });
});
