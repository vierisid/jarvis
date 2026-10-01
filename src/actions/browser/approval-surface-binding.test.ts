/**
 * #602 - an approval must bind the SURFACE it was reviewed on, not just the
 * connection and the approval epoch.
 *
 * #495 bound an approval to the reviewed snapshot so that what the user
 * approved is what happens. `captureApprovalGuard` bound the CDP connection and
 * an epoch counter, which catches a reconnect and a dropped request guard and
 * nothing else -- so an approval reviewed while the browser showed one document
 * still held after the page had become another, and an approval reviewed
 * against one snapshot's ids still held after a second snapshot had re-numbered
 * them (the loaderId does not move for that, by design: `history.pushState`
 * changes the URL on every SPA without committing a document).
 *
 * Driven against a fake Chrome over real CDP, in the shape
 * session-guards.test.ts established, so the guard is exercised through the
 * real snapshot bookkeeping rather than against a stubbed controller.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { BrowserController } from './session.ts';

type SockData = { path: string };
const ELEMENTS_CONTEXT = 88;

type Fake = {
  port: number;
  /** Commit a new document, the way a page-initiated navigation would. */
  navigate(): void;
  /**
   * Change the main frame's URL WITHOUT committing a document, which is what
   * `history.pushState` does (measured in #592) and how every SPA navigates.
   */
  pushState(url: string): void;
  /** What the in-page snapshot script will report next. */
  setElements(els: Array<{ id: number; tag: string; text: string; x: number; y: number }>): void;
  stop(): void;
};

function fakeChrome(): Fake {
  let loaderId = 'LOADER-1';
  let frameUrl = 'https://bank.example/confirm';
  let elements = [
    { id: 1, tag: 'button', text: 'Cancel', x: 10, y: 20 },
    { id: 2, tag: 'button', text: 'Send $5,000', x: 10, y: 50 },
  ];
  const fake: Fake = {
    port: 0,
    navigate: () => { loaderId = `LOADER-${Number(loaderId.split('-')[1]) + 1}`; },
    pushState: (url: string) => { frameUrl = url; },
    setElements: (els) => { elements = els; },
    stop: () => server.stop(true),
  };

  const pageResult = async (method: string, params: Record<string, any>): Promise<Record<string, unknown>> => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'FRAME-1', url: frameUrl, loaderId } } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ELEMENTS_CONTEXT };
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      if (expr.includes('readyState')) return { result: { value: 'complete:3' } };
      if (expr.includes('__jarvis_elements =')) {
        return {
          result: {
            value: {
              title: 'Confirm transfer',
              url: 'https://bank.example/confirm',
              text: 'Confirm transfer',
              elements: elements.map((e) => ({ ...e, attrs: {} })),
            },
          },
        };
      }
      // The document-generation sentinel check (#603) and anything else the
      // controller asks the elements world: answer "unchanged".
      return { result: { value: 'ok' } };
    }
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
  fake.port = server.port!;
  return fake;
}

describe('#602 an approval binds the surface it was reviewed on', () => {
  let fake: Fake | null = null;
  let ctrl: BrowserController | null = null;

  afterEach(async () => {
    await ctrl?.disconnect();
    fake?.stop();
    ctrl = null;
    fake = null;
  });

  test('cannot act after the page became a different document', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port, undefined, { autoLaunch: false });
    await ctrl.connect();
    await ctrl.snapshot();

    // Reviewed here: the user is looking at this snapshot of this document.
    const reviewed = ctrl.captureApprovalGuard(false, { bindDocument: true });
    expect(reviewed()).toBe(true);

    // The page replaces its document on its own - a meta refresh, a timer, a
    // redirect. THE SYNCHRONOUS GUARD CANNOT SEE THIS, and that is not a bug
    // to paper over: an approval gate must not act, and asking the browser
    // which document it is showing is a CDP round trip. So the guard still
    // holds here...
    fake.navigate();
    expect(reviewed()).toBe(true);

    // ...and the ACTION is what refuses, at use time, where it can read the
    // live document. Between them the approval cannot reach a document it was
    // not reviewed against.
    const result = await ctrl.click(2);
    expect(result).toContain('navigated to a new document');
    expect(result).toContain('browser_snapshot');

    // And the refusal drops the ids on its way out, so the approval is dead
    // for the synchronous guard too from here on.
    expect(reviewed()).toBe(false);
  });

  test('cannot be replayed after a new snapshot re-numbered the ids', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port, undefined, { autoLaunch: false });
    await ctrl.connect();
    await ctrl.snapshot();

    const reviewed = ctrl.captureApprovalGuard(false, { bindDocument: true });
    expect(reviewed()).toBe(true);

    // A second snapshot of the SAME document: the loaderId never moves, so no
    // document check can see this, and id 2 now names a different control.
    fake.setElements([
      { id: 1, tag: 'button', text: 'Accept cookies', x: 400, y: 600 },
      { id: 2, tag: 'button', text: 'Delete account', x: 10, y: 50 },
    ]);
    await ctrl.snapshot();
    expect(reviewed()).toBe(false);
  });

  test('holds across a pushState, which is how every SPA navigates', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port, undefined, { autoLaunch: false });
    await ctrl.connect();
    await ctrl.snapshot();

    const reviewed = ctrl.captureApprovalGuard(false, { bindDocument: true });
    expect(reviewed()).toBe(true);

    // A same-document URL change: the loaderId holds, nothing is re-numbered,
    // and the elements are the same elements. Refusing here would refuse an
    // ordinary click on Gmail, Linear, and the cell-to-cell moves
    // webapp-templates/gsheets.yaml tells the model to reuse an id across.
    fake.pushState('https://bank.example/confirm/step-2');
    expect(reviewed()).toBe(true);

    // And the action still goes through, which is the half the guard cannot
    // answer for: `refuseIfDocumentMoved` compares the loaderId alone for this
    // exact reason.
    const result = await ctrl.click(2);
    expect(result).toBe('Clicked element [2]');
  });

  test('a tool that binds no document is unaffected by a new snapshot', async () => {
    fake = fakeChrome();
    ctrl = new BrowserController(fake.port, undefined, { autoLaunch: false });
    await ctrl.connect();
    await ctrl.snapshot();

    // browser_press_key and browser_scroll address no element, so they bind
    // the connection and the epoch only.
    const reviewed = ctrl.captureApprovalGuard();
    await ctrl.snapshot();
    expect(reviewed()).toBe(true);
    // The epoch still binds them: a disconnect invalidates the approval.
    await ctrl.disconnect();
    expect(reviewed()).toBe(false);
  });
});
