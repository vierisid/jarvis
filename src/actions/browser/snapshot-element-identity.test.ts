/**
 * #585 -- a snapshot id must mean the same element for the life of the
 * snapshot, to everything that reads it.
 *
 * The pebble narration used to re-resolve the id by running a fresh
 * `querySelectorAll` in the page with a narrower selector than the snapshot's
 * and 0-based indexing against the snapshot's 1-based ids, so it pointed at a
 * different control than the click would take -- while being the thing the
 * user reads before approving. These tests hold the accessors the narration
 * now uses to the only property that makes them reviewable: for a page whose
 * DOM shifts under us, they answer with the element the snapshot named, or
 * they answer with nothing.
 *
 * Driven against a fake Chrome over real CDP, in the shape
 * session-guards.test.ts established, so the page script and the coordinate
 * bookkeeping are the real ones.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { BrowserController } from './session.ts';

type SockData = { path: string; n: number };
type Sock = ServerWebSocket<SockData>;
type Sent = { method: string; params: Record<string, any> };

/** One interactive element as the in-page snapshot script would report it. */
type FakeElement = { id: number; tag: string; text: string; x: number; y: number };

type FakeOptions = {
  /**
   * The element list the snapshot script returns, per call. Element 0 of this
   * array answers the first snapshot, element 1 the second, and so on; the
   * last entry answers every later call. That is how a DOM shift between the
   * snapshot and the narration is expressed.
   */
  snapshots: FakeElement[][];
  /**
   * The window the isolated-world origin expression is EVALUATED against, so
   * the formula itself is under test and not just its text. Null makes the
   * read fail.
   */
  window?: { screenX: number; screenY: number; outerHeight: number; innerHeight: number } | null;
  /** Refuse Page.createIsolatedWorld, as a page with no committed frame would. */
  noIsolatedWorld?: boolean;
};

type Fake = {
  port: number;
  pageSent: Sent[];
  /** How many times the in-page snapshot script has been evaluated. */
  snapshotEvals: number;
  /** Runtime.evaluate calls that carried an isolated-world contextId. */
  isolatedEvals: Sent[];
  stop(): void;
};

function fakeChrome(opts: FakeOptions): Fake {
  let snapshotsTaken = 0;
  const fake: Fake = {
    port: 0,
    pageSent: [],
    snapshotEvals: 0,
    isolatedEvals: [],
    stop: () => server.stop(true),
  };

  const elementsFor = (n: number): FakeElement[] =>
    opts.snapshots[Math.min(n, opts.snapshots.length - 1)] ?? [];

  const pageResult = async (method: string, params: Record<string, any>): Promise<Record<string, unknown>> => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'FRAME-1', url: 'https://bank.example/confirm', loaderId: 'LOADER-1' } } };
    }
    if (method === 'Page.createIsolatedWorld') {
      if (opts.noIsolatedWorld) throw new Error('No frame for given id found');
      return { executionContextId: 77 };
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      // The settle probe that runs before the snapshot script.
      if (expr.includes('readyState')) return { result: { value: 'complete:3' } };
      // The origin read: the only evaluate that carries a contextId.
      if (typeof params.contextId === 'number') {
        fake.isolatedEvals.push({ method, params });
        if (opts.window === null) return { result: { value: null } };
        const win = opts.window ?? { screenX: 100, screenY: 150, outerHeight: 900, innerHeight: 850 };
        // Run the real expression against that window, the way Chrome would.
        const value = new Function('window', `return (${expr})`)(win);
        return { result: { value } };
      }
      // The snapshot script itself.
      if (expr.includes('__jarvis_elements')) {
        const elements = elementsFor(fake.snapshotEvals);
        fake.snapshotEvals++;
        snapshotsTaken++;
        return {
          result: {
            value: {
              title: 'Confirm transfer',
              url: 'https://bank.example/confirm',
              text: 'Confirm transfer',
              elements: elements.map((e) => ({ id: e.id, tag: e.tag, text: e.text, attrs: {}, x: e.x, y: e.y })),
            },
          },
        };
      }
      return { result: { value: null } };
    }
    return {};
  };

  const opened = { '/browser': 0, '/page': 0 } as Record<string, number>;
  const server = Bun.serve<SockData>({
    port: 0,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === '/browser' || pathname === '/page') {
        if (srv.upgrade(req, { data: { path: pathname, n: ++opened[pathname]! } })) return;
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
      open() { /* nothing to track */ },
      close() { /* nothing to track */ },
      async message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, any> };
        if (ws.data.path === '/browser') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        fake.pageSent.push({ method: msg.method, params: msg.params ?? {} });
        try {
          const result = await pageResult(msg.method, msg.params ?? {});
          ws.send(JSON.stringify({ id: msg.id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: { message: String(err) } }));
        }
      },
    },
  });
  fake.port = server.port!;
  void snapshotsTaken;
  return fake;
}

/**
 * The fixture from the #585 proof, as the snapshot script would report it: a
 * confirm dialog whose ids 1..6 are a <summary>, a [data-testid] div, a link,
 * Cancel, the destructive button, and a note field. The old narration resolved
 * every one of these to a different element (a `summary` and a `[data-testid]`
 * div are invisible to its selector, and its index was 0-based).
 */
const PAGE_A: FakeElement[] = [
  { id: 1, tag: 'summary', text: 'More options', x: 70, y: 52 },
  { id: 2, tag: 'div', text: 'LC', x: 70, y: 82 },
  { id: 3, tag: 'a', text: 'Home', x: 70, y: 112 },
  { id: 4, tag: 'button', text: 'Cancel', x: 70, y: 142 },
  { id: 5, tag: 'button', text: 'Send $5,000', x: 70, y: 172 },
  { id: 6, tag: 'input', text: '', x: 70, y: 232 },
];

/**
 * The same page after it shifts: the banner and the avatar are gone and a
 * cookie bar has appeared, so every id now names something else. A narration
 * that looked at this DOM would point at the wrong control.
 */
const PAGE_B: FakeElement[] = [
  { id: 1, tag: 'button', text: 'Accept cookies', x: 400, y: 600 },
  { id: 2, tag: 'button', text: 'Send $5,000', x: 70, y: 90 },
  { id: 3, tag: 'input', text: '', x: 70, y: 150 },
];

describe('#585 a snapshot id names one element for the life of the snapshot', () => {
  let fake: Fake | null = null;
  let ctrl: BrowserController | null = null;

  afterEach(async () => {
    await ctrl?.disconnect();
    fake?.stop();
    ctrl = null;
    fake = null;
  });

  test('a DOM shift between the snapshot and the narration cannot move the narrated element', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A, PAGE_B] });
    ctrl = new BrowserController(fake.port);
    const snap = await ctrl.snapshot();
    expect(snap.elements.map((e) => e.text)).toEqual(
      ['More options', 'LC', 'Home', 'Cancel', 'Send $5,000', ''],
    );

    // The page shifts to PAGE_B. Nothing re-snapshots, which is exactly the
    // window the narration runs in.
    const evalsBefore = fake.snapshotEvals;

    // Every id still resolves to the point the reviewed snapshot recorded,
    // element for element -- not to PAGE_B's geometry.
    for (const el of PAGE_A) {
      expect(ctrl.snapshotElementPoint(el.id)).toEqual({ x: el.x, y: el.y });
    }
    // In particular, the id the proof showed being mis-narrated: id 4 is
    // Cancel at y=142, and it must not come back as PAGE_B's id-4-ish
    // geometry or as PAGE_A's id 5 ("Send $5,000") one row down.
    expect(ctrl.snapshotElementPoint(4)).toEqual({ x: 70, y: 142 });
    expect(ctrl.snapshotElementPoint(4)).not.toEqual({ x: 70, y: 172 });

    // And it answered without looking at the page at all.
    expect(fake.snapshotEvals).toBe(evalsBefore);
  });

  test('the point the narration shows is the point the click dispatches', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A, PAGE_B] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    const narrated = ctrl.snapshotElementPoint(5);
    expect(narrated).toEqual({ x: 70, y: 172 });

    await ctrl.click(5);
    const presses = fake.pageSent.filter(
      (s) => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mousePressed',
    );
    expect(presses).toHaveLength(1);
    expect({ x: presses[0]!.params.x, y: presses[0]!.params.y }).toEqual(narrated!);
  });

  test('an id no live snapshot minted resolves to nothing, not to whatever is there now', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    // PAGE_A minted 1..6. The old resolver would have handed back element
    // [7]'s live position for any of these; there is no element 7.
    expect(ctrl.snapshotElementPoint(7)).toBeNull();
    expect(ctrl.snapshotElementPoint(0)).toBeNull();
    expect(ctrl.snapshotElementPoint(-1)).toBeNull();
    expect(ctrl.snapshotElementPoint(1.5)).toBeNull();
  });

  test('a fresh snapshot replaces the ids wholesale rather than merging them', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A, PAGE_B] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    await ctrl.snapshot();

    // PAGE_B has three elements; ids 4-6 belonged to the previous page and
    // must not survive into the new one.
    expect(ctrl.snapshotElementPoint(2)).toEqual({ x: 70, y: 90 });
    expect(ctrl.snapshotElementPoint(4)).toBeNull();
    expect(ctrl.snapshotElementPoint(6)).toBeNull();
  });

  test('nothing resolves once the session is gone', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(ctrl.snapshotElementPoint(4)).not.toBeNull();

    await ctrl.disconnect();
    expect(ctrl.snapshotElementPoint(4)).toBeNull();
  });
});

describe('#585 the viewport origin is read out of the page\'s reach', () => {
  let fake: Fake | null = null;
  let ctrl: BrowserController | null = null;

  afterEach(async () => {
    await ctrl?.disconnect();
    fake?.stop();
    ctrl = null;
    fake = null;
  });

  test('the read happens in an isolated world, so a page-installed getter cannot reach it', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    const origin = await ctrl.viewportScreenOrigin();
    // screenX, and screenY plus the 50px of chrome (900 outer - 850 inner).
    expect(origin).toEqual({ x: 100, y: 200 });

    // One isolated world created, and the evaluate ran inside it.
    const worlds = fake.pageSent.filter((s) => s.method === 'Page.createIsolatedWorld');
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.params.frameId).toBe('FRAME-1');
    expect(fake.isolatedEvals).toHaveLength(1);
    expect(fake.isolatedEvals[0]!.params.contextId).toBe(77);

    // And it asked about the window, not about any element.
    const expr = String(fake.isolatedEvals[0]!.params.expression);
    expect(expr).toContain('screenX');
    expect(expr).toContain('outerHeight');
    // Deliberately NOT scaled: see viewportScreenOrigin on why the pebble's
    // coordinate space is not device pixels on macOS or Linux.
    expect(expr).not.toContain('devicePixelRatio');
    expect(expr).not.toContain('querySelector');
    expect(expr).not.toContain('__jarvis_elements');
  });

  test('one isolated world per document, not one per narration', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    // createIsolatedWorld mints a fresh world (and V8 context) on every call
    // however the name is reused, and nothing disposes them, so a page driven
    // through many narrations would accumulate contexts.
    for (let i = 0; i < 4; i++) expect(await ctrl.viewportScreenOrigin()).toEqual({ x: 100, y: 200 });
    expect(fake.pageSent.filter((s) => s.method === 'Page.createIsolatedWorld')).toHaveLength(1);
    expect(fake.isolatedEvals).toHaveLength(4);
  });

  test('the origin clears the browser chrome instead of starting at the title bar', async () => {
    // The formula is evaluated, not matched: `screenY` alone put every pointer
    // a toolbar height above its element, and a sign flip or a Math.min would
    // read as "contains outerHeight" just as happily.
    fake = fakeChrome({
      snapshots: [PAGE_A],
      window: { screenX: 40, screenY: 60, outerHeight: 1000, innerHeight: 880 },
    });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin()).toEqual({ x: 40, y: 180 });

    // A window reporting an inner taller than its outer (devtools undocking
    // mid-read, a stale value) must not drag the pointer above the screen.
    fake.stop();
    await ctrl.disconnect();
    fake = fakeChrome({
      snapshots: [PAGE_A],
      window: { screenX: 40, screenY: 60, outerHeight: 800, innerHeight: 900 },
    });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin()).toEqual({ x: 40, y: 60 });
  });

  test('narrations racing on a cache miss share one isolated world', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    // One message emitting two element-addressed tool calls is the ordinary
    // parallel-tool shape, and each narration is a detached task. Both miss the
    // cache at once; only one world may be minted, or the loser is orphaned for
    // the life of the document.
    const all = await Promise.all([
      ctrl.viewportScreenOrigin(), ctrl.viewportScreenOrigin(),
      ctrl.viewportScreenOrigin(), ctrl.viewportScreenOrigin(),
    ]);
    for (const o of all) expect(o).toEqual({ x: 100, y: 200 });
    expect(fake.pageSent.filter((s) => s.method === 'Page.createIsolatedWorld')).toHaveLength(1);
  });

  test('an unreadable origin is null, never a partial coordinate', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A], noIsolatedWorld: true });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin()).toBeNull();

    fake.stop();
    fake = fakeChrome({ snapshots: [PAGE_A], window: null });
    await ctrl.disconnect();
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin()).toBeNull();
  });

  test('it never connects a browser to answer', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    // Nothing connected yet: a narration must not be what launches Chrome,
    // since it runs before the action it previews has even executed.
    expect(await ctrl.viewportScreenOrigin()).toBeNull();
    expect(fake.pageSent).toHaveLength(0);
    expect(ctrl.connected).toBe(false);
  });
});
