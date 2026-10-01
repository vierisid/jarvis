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

/**
 * One interactive element as the in-page snapshot script would report it.
 *
 * `inFrame` sets the `iframe` marker the snapshot script writes, which is what
 * fills the controller's `elementInFrame` set.
 */
type FakeElement = {
  id: number; tag: string; text: string; x: number; y: number; inFrame?: boolean;
};

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
  /**
   * A loaderId the main frame reports once `navigate()` is called on the fake,
   * standing in for a page that replaced its own document between the snapshot
   * and the narration.
   */
  loaderIdAfterNavigation?: string;
  /**
   * A loaderId the CHILD frame reports once `navigateChildFrame()` is called.
   * A subframe can commit a new document while the main frame's loaderId never
   * moves, which is the case a main-frame-only check misses.
   */
  childLoaderIdAfterNavigation?: string;
  /** The main frame's URL, for the local-content refusal. */
  url?: string;
  /**
   * What the per-element sentinel reports (#603): 'ok', 'dom' (the element's
   * document was replaced), 'moved' (it is no longer where its id says) or
   * 'gone'. Default: nothing that matters to the id has changed.
   */
  domGeneration?: () => string;
  /**
   * Refuse the NARRATION world only, as a page with no committed frame would.
   * Scoped to that world because #592 made the snapshot mint one of its own and
   * refuse outright when it cannot, so refusing both would leave nothing
   * snapshotted to narrate about.
   */
  noIsolatedWorld?: boolean;
};

/**
 * The two isolated worlds this controller mints, kept apart so the fake can
 * tell a narration read from a snapshot read.
 *
 * #592 put the snapshot's element refs in `jarvis-elements`, so BOTH worlds
 * exist on a snapshotted page and both evaluate with a contextId. A fake that
 * routed on "has a contextId" alone would hand the origin formula the snapshot
 * script, which is how this file failed when #592 landed.
 */
const NARRATION_CONTEXT = 77;
const ELEMENTS_CONTEXT = 78;
const NARRATION_WORLD = 'jarvis-narration';

type Fake = {
  port: number;
  pageSent: Sent[];
  /** Commit `loaderIdAfterNavigation`, the way a page-initiated load would. */
  navigate(): void;
  /** Commit `childLoaderIdAfterNavigation` on the subframe only. */
  navigateChildFrame(): void;
  /** Change the main frame's reported URL without changing its loaderId. */
  setUrl(url: string): void;
  /** How many times the in-page snapshot script has been evaluated. */
  snapshotEvals: number;
  /** Runtime.evaluate calls that ran in the NARRATION isolated world. */
  isolatedEvals: Sent[];
  stop(): void;
};

function fakeChrome(opts: FakeOptions): Fake {
  let navigated = false;
  let childNavigated = false;
  let currentUrl = opts.url ?? 'https://bank.example/confirm';
  const fake: Fake = {
    port: 0,
    pageSent: [],
    snapshotEvals: 0,
    isolatedEvals: [],
    navigate: () => { navigated = true; },
    navigateChildFrame: () => { childNavigated = true; },
    setUrl: (u: string) => { currentUrl = u; },
    stop: () => server.stop(true),
  };

  const elementsFor = (n: number): FakeElement[] =>
    opts.snapshots[Math.min(n, opts.snapshots.length - 1)] ?? [];

  const pageResult = async (method: string, params: Record<string, any>): Promise<Record<string, unknown>> => {
    if (method === 'Page.getFrameTree') {
      const loaderId = navigated ? (opts.loaderIdAfterNavigation ?? 'LOADER-2') : 'LOADER-1';
      const childLoaderId = childNavigated
        ? (opts.childLoaderIdAfterNavigation ?? 'CHILD-LOADER-2')
        : 'CHILD-LOADER-1';
      return {
        frameTree: {
          frame: { id: 'FRAME-1', url: currentUrl, loaderId },
          // A same-origin subframe, so the tree digest has something to move.
          childFrames: [{ frame: { id: 'FRAME-2', url: 'https://bank.example/widget', loaderId: childLoaderId } }],
        },
      };
    }
    if (method === 'Page.createIsolatedWorld') {
      const narration = params.worldName === NARRATION_WORLD;
      if (narration && opts.noIsolatedWorld) throw new Error('No frame for given id found');
      return { executionContextId: narration ? NARRATION_CONTEXT : ELEMENTS_CONTEXT };
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      // The settle probe that runs before the snapshot script.
      if (expr.includes('readyState')) return { result: { value: 'complete:3' } };
      // The origin read: the evaluate in the NARRATION world. Routed on the
      // world it ran in rather than on "carries a contextId", because #592's
      // snapshot carries one too.
      if (params.contextId === NARRATION_CONTEXT) {
        fake.isolatedEvals.push({ method, params });
        if (opts.window === null) return { result: { value: null } };
        const win = opts.window ?? { screenX: 100, screenY: 150, outerHeight: 900, innerHeight: 850 };
        // Run the real expression against that window, the way Chrome would.
        const value = new Function('window', `return (${expr})`)(win);
        return { result: { value } };
      }
      // The document-generation sentinel (#603). Routed before the snapshot
      // script, which also mentions `__jarvis_dom` (it arms it).
      if (expr.includes('globalThis.__jarvis_dom;')) {
        return { result: { value: opts.domGeneration ? opts.domGeneration() : 'ok' } };
      }
      // The snapshot script itself -- it ASSIGNS the ref array, where the focus
      // and focus-verification reads only index it.
      if (expr.includes('__jarvis_elements =')) {
        const elements = elementsFor(fake.snapshotEvals);
        fake.snapshotEvals++;
        return {
          result: {
            value: {
              title: 'Confirm transfer',
              url: 'https://bank.example/confirm',
              text: 'Confirm transfer',
              elements: elements.map((e) => ({
              id: e.id, tag: e.tag, text: e.text,
              attrs: e.inFrame ? { iframe: 'true' } : {},
              x: e.x, y: e.y,
            })),
            },
          },
        };
      }
      // Nothing routed it. Naming itself rather than answering null: an
      // unrouted evaluate used to surface ten files away as
      // `TypeError: null is not an object (evaluating 'data.url')` inside
      // production code, when the actual cause is a reworded marker here.
      throw new Error(
        "fake: unrouted Runtime.evaluate -- did SNAPSHOT_SCRIPT's '__jarvis_elements =' "
        + `assignment get reworded? expr: ${expr.slice(0, 120)}`,
      );
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
  // Minted inside a same-origin subframe. The old narration could not resolve
  // a framed id at all, and its document identity needs the frame digest
  // rather than the main frame's loaderId.
  { id: 7, tag: 'button', text: 'Pay now', x: 300, y: 400, inFrame: true },
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
      ['More options', 'LC', 'Home', 'Cancel', 'Send $5,000', '', 'Pay now'],
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

    // PAGE_A minted 1..7. The old resolver would have handed back element
    // [8]'s live position for any of these; there is no element 8.
    expect(ctrl.snapshotElementPoint(8)).toBeNull();
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

    const origin = await ctrl.viewportScreenOrigin(4);
    // screenX, and screenY plus the 50px of chrome (900 outer - 850 inner).
    expect(origin).toEqual({ x: 100, y: 200 });

    // One narration world created, and the evaluate ran inside it. Scoped to
    // that world by name: the snapshot mints `jarvis-elements` of its own
    // (#592), which is not this read's and must not be counted as it.
    const worlds = fake.pageSent.filter(
      (s) => s.method === 'Page.createIsolatedWorld' && s.params.worldName === NARRATION_WORLD,
    );
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.params.frameId).toBe('FRAME-1');
    expect(fake.isolatedEvals).toHaveLength(1);
    expect(fake.isolatedEvals[0]!.params.contextId).toBe(NARRATION_CONTEXT);

    // And it asked about the window, not about any element.
    const expr = String(fake.isolatedEvals[0]!.params.expression);
    expect(expr).toContain('screenX');
    expect(expr).toContain('outerHeight');
    // Deliberately NOT scaled: see viewportScreenOrigin on why the pebble's
    // coordinate space is not device pixels on macOS or Linux.
    expect(expr).not.toContain('devicePixelRatio');
    expect(expr).not.toContain('querySelector');
    expect(expr).not.toContain('__jarvis_elements');

    // And it asked in ITS world only. Routing `isolatedEvals` by world name
    // means an evaluate the narration sent into the ELEMENTS world would not
    // appear above, so it is constrained here instead: the snapshot's own
    // script is the only thing that may ever run in there.
    const elementsEvals = fake.pageSent.filter(
      (s) => s.method === 'Runtime.evaluate' && s.params.contextId === ELEMENTS_CONTEXT,
    );
    expect(elementsEvals).toHaveLength(1);
    expect(String(elementsEvals[0]!.params.expression)).toContain('__jarvis_elements =');
  });

  test('one isolated world per document, not one per narration', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();

    // createIsolatedWorld mints a fresh world (and V8 context) on every call
    // however the name is reused, and nothing disposes them, so a page driven
    // through many narrations would accumulate contexts.
    for (let i = 0; i < 4; i++) expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 100, y: 200 });
    expect(fake.pageSent.filter(
      (s) => s.method === 'Page.createIsolatedWorld' && s.params.worldName === NARRATION_WORLD,
    )).toHaveLength(1);
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
    expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 40, y: 180 });

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
    expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 40, y: 60 });
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
      ctrl.viewportScreenOrigin(4), ctrl.viewportScreenOrigin(4),
      ctrl.viewportScreenOrigin(4), ctrl.viewportScreenOrigin(4),
    ]);
    for (const o of all) expect(o).toEqual({ x: 100, y: 200 });
    expect(fake.pageSent.filter(
      (s) => s.method === 'Page.createIsolatedWorld' && s.params.worldName === NARRATION_WORLD,
    )).toHaveLength(1);
  });

  test('an unreadable origin is null, never a partial coordinate', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A], noIsolatedWorld: true });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin(4)).toBeNull();

    fake.stop();
    fake = fakeChrome({ snapshots: [PAGE_A], window: null });
    await ctrl.disconnect();
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin(4)).toBeNull();
  });

  test('a page that replaced its own document gets no origin, and the click agrees', async () => {
    // #592 made click/hover/type refuse once the main frame's loaderId has
    // moved on. The narration resolves on the tool_call event, BEFORE the tool
    // runs, so the coordinate map is still populated at that moment -- and
    // without the document check the pebble would fly confidently to a stale
    // point for an action that is about to refuse. The two halves have to reach
    // the same verdict about the same page, which is #585's whole subject.
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    // Still the reviewed document: a real origin.
    expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 100, y: 200 });

    fake.navigate();

    // The narration declines, and says so in a way distinguishable from a
    // geometry read that merely failed.
    expect(await ctrl.viewportScreenOrigin(4)).toBe('moved');

    // And the action it was previewing really does refuse, dispatching nothing
    // -- so this is the honest verdict and not an over-refusal.
    const before = fake.pageSent.filter((s) => s.method === 'Input.dispatchMouseEvent').length;
    const result = await ctrl.click(5);
    expect(result).toContain('navigated to a new document');
    expect(fake.pageSent.filter((s) => s.method === 'Input.dispatchMouseEvent')).toHaveLength(before);
  });

  test('a dropped element map is "moved", not a confident origin', async () => {
    // Nothing reviewed is on screen, so there is no point to preview. Reached
    // by a narration racing a `forgetSnapshotElements()` -- a refused click or a
    // failed snapshot drops the map (#592) while the pebble task is in flight.
    //
    // Both clauses of the document check hold here at once (the map is empty
    // AND the frame reports a new loaderId), so this pins the OUTCOME rather
    // than isolating the empty-map clause; the clause itself is what makes the
    // answer 'moved' instead of a crash once `elementDoc` is blank.
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    fake.navigate();
    // The refused click is what clears `elementDoc`.
    await ctrl.click(5);
    expect(ctrl.snapshotElementPoint(5)).toBeNull();
    expect(await ctrl.viewportScreenOrigin(4)).toBe('moved');
  });

  test('a FRAMED element loses its pointer when its frame navigates, main frame or not', async () => {
    // The term a main-frame-only check misses, and the reason it matters: a
    // child document can commit on its own while the main frame's loaderId
    // never moves, so an in-frame coordinate describes a document that is gone.
    // #592's `refuseIfDocumentMoved` refuses the click for exactly this, so a
    // narration without the term would fly the pebble confidently to a stale
    // point for an action about to refuse.
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    // Id 7 came from the subframe; id 4 is main-document.
    expect(await ctrl.viewportScreenOrigin(7)).toEqual({ x: 100, y: 200 });

    fake.navigateChildFrame();

    // The framed id is refused...
    expect(await ctrl.viewportScreenOrigin(7)).toBe('moved');
    // ...and the main-document id is NOT, because an unrelated iframe
    // reloading must not cost every element its pointer.
    expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 100, y: 200 });

    // And the action really does refuse the framed id, so this is the honest
    // verdict rather than an over-refusal.
    const before = fake.pageSent.filter((s) => s.method === 'Input.dispatchMouseEvent').length;
    expect(await ctrl.click(7)).toContain('came from a frame');
    expect(fake.pageSent.filter((s) => s.method === 'Input.dispatchMouseEvent')).toHaveLength(before);
  });

  test('a page showing local content gets no origin, like the action gets no click', async () => {
    // The browser does not drive local files (#521/#526), so the action refuses
    // here too. Mirrored so the narration cannot preview it -- and the URL is
    // never returned or logged from this path (#594).
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    await ctrl.snapshot();
    expect(await ctrl.viewportScreenOrigin(4)).toEqual({ x: 100, y: 200 });

    // The tab is now on a file: document, same loaderId.
    fake.setUrl('file:///home/someone/secret-plans.html');
    expect(await ctrl.viewportScreenOrigin(4)).toBe('moved');
  });

  test('it never connects a browser to answer', async () => {
    fake = fakeChrome({ snapshots: [PAGE_A] });
    ctrl = new BrowserController(fake.port);
    // Nothing connected yet: a narration must not be what launches Chrome,
    // since it runs before the action it previews has even executed.
    expect(await ctrl.viewportScreenOrigin(4)).toBeNull();
    expect(fake.pageSent).toHaveLength(0);
    expect(ctrl.connected).toBe(false);
  });
});
