/**
 * Browser Controller — High-level browser automation
 *
 * Wraps CDPClient with user-friendly operations:
 * navigate, snapshot (interactive elements with IDs), click, type, screenshot.
 *
 * The snapshot approach: each interactive element gets a numeric [id].
 * The LLM sees these IDs and references them in click/type commands.
 */

import { CDPClient } from './cdp.ts';
import { STEALTH_SCRIPT } from './stealth.ts';
import { launchChrome, stopChrome, type RunningBrowser } from './chrome-launcher.ts';
import { parseKeyCombo, SUPPORTED_KEYS_HINT } from './keys.ts';
import { checkNavigationUrl, isDrivableUrl, isLocalContentUrl, knownDevtoolsPorts, registerDevtoolsPort } from './url-policy.ts';
import { BrowserRequestGuard } from './browser-request-guard.ts';
import { checkUploadPath, pageOrigin, uploadTargetRefusal } from './upload-policy.ts';

export type PageElement = {
  id: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
};

export type PageSnapshot = {
  /** The page's own `document.title`. Display only -- it can contain newlines. */
  title: string;
  /**
   * The page's own `location.href`. DISPLAY ONLY: this is what the page says it
   * is, it is rendered into the snapshot text the model reads, and no decision
   * may be made from it. Use `browserUrl`.
   */
  url: string;
  /**
   * What Chrome reports for the top frame (`Page.getFrameTree`), or null when
   * that read failed or the document changed under the snapshot. THE ONLY URL
   * CODE MAY BRANCH ON (#572).
   *
   * The distinction is the same one `readTopFrameUrl` already documents for the
   * upload gate: the frame tree is the browser's answer, `location.href` is the
   * page's. Outside content either way -- a page still picks its own path with
   * `history.pushState`, and the document can be a `data:` or `blob:` URL -- so
   * "structural" here means unforgeable across origins, not trusted.
   *
   * Null rather than a stale fallback on purpose. A caller that gets null does
   * less (no site playbook); one handed the PREVIOUS page's URL would act on
   * the wrong site's instructions while believing it had the current one.
   */
  browserUrl: string | null;
  /** Page text, truncated by the formatter. Outside content. */
  text: string;
  elements: PageElement[];
};

// JS function injected into the page to extract interactive elements.
// Traverses same-origin iframes (Google Docs, Gmail compose, embedded
// editors) with click coordinates offset to top-page space. Cross-origin
// frames are skipped (contentDocument is inaccessible). Mirrored in the Go
// sidecar (sidecar/browser_snapshot.go) — change both together.
const SNAPSHOT_SCRIPT = `(() => {
  const els = [];
  const seen = new WeakSet();
  const sel = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="textbox"]',
    '[role="combobox"]', '[role="menuitem"]', '[role="option"]',
    '[role="row"]', '[role="gridcell"]',
    '[onclick]', '[contenteditable="true"]', '[tabindex="0"]',
    '[data-testid]'
  ].join(', ');

  // Collect same-origin documents: the top document plus nested iframes,
  // each with the cumulative offset of its viewport in top-page coordinates.
  const frames = [];
  const collectFrames = (doc, ox, oy, depth) => {
    frames.push({ doc, ox, oy });
    if (depth >= 3 || frames.length >= 10) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let child = null;
      try { child = f.contentDocument; } catch { continue; }
      if (!child) continue;
      const r = f.getBoundingClientRect();
      collectFrames(child, ox + r.x, oy + r.y, depth + 1);
    }
  };
  collectFrames(document, 0, 0, 0);

  for (const frame of frames) {
    const doc = frame.doc;
    const win = doc.defaultView || window;
    const inFrame = doc !== document;
    doc.querySelectorAll(sel).forEach((el) => {
      // Skip duplicates (child of already-captured parent)
      if (seen.has(el)) return;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      const isTypingTarget = el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
      const style = win.getComputedStyle(el);
      if (style.display === 'none') return;
      if (isTypingTarget) {
        // Keep typing targets even when tiny, clipped, or transparent —
        // editors (Google Docs) hide their real input in an offscreen iframe.
      } else {
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width < 5 || rect.height < 5) return;
        if (style.visibility === 'hidden') return;
        if (style.opacity === '0') return;
      }

      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      const attrs = {};
      for (const a of ['href', 'name', 'placeholder', 'type', 'aria-label', 'title', 'id', 'role', 'data-testid', 'contenteditable']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.slice(0, 200);
      }
      // Live element values (el.value) are deliberately NOT collected.
      // Nothing formats or reads them, and an input's value can be a typed
      // password, so collecting it only creates something to leak later.
      if (inFrame) attrs.iframe = 'true';
      els.push({
        _el: el,
        tag,
        text,
        attrs,
        x: Math.round(frame.ox + rect.x + rect.width / 2),
        y: Math.round(frame.oy + rect.y + rect.height / 2)
      });
    });
  }

  // Assign sequential IDs and store DOM refs for later direct focus
  window.__jarvis_elements = els.map(e => e._el);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; });

  // Get visible text (top document first, then same-origin frames), clean up whitespace.
  // document.body can be null on challenge/error pages (WAF "checking your browser"
  // interstitials) — guard so the snapshot returns empty text instead of throwing,
  // which lets callers detect the bot-wall rather than seeing an opaque error.
  let bodyText = (document.body && document.body.innerText) || '';
  for (const frame of frames) {
    if (frame.doc === document) continue;
    const t = frame.doc.body && frame.doc.body.innerText;
    if (t && t.trim()) bodyText += '\\n' + t;
  }
  bodyText = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);

  return {
    title: document.title,
    url: location.href,
    text: bodyText,
    elements: els
  };
})()`;

export class BrowserController {
  private cdp: CDPClient;
  // Fails file: and DevTools-endpoint requests inside Chrome (#521). Armed
  // before the page connection on every connect; never driven without it.
  private requestGuard: BrowserRequestGuard | null = null;
  // Keeps this.port on url-policy's DevTools-port list while connected.
  private releasePort: (() => void) | null = null;
  private port: number;
  private profileDir: string | undefined;
  private _connected = false;
  private approvalEpoch = 0;
  /**
   * The URL Chrome last reported for the TOP frame -- from the frame tree or the
   * target list, never from script the page controls. It exists because an
   * approval gate is synchronous (`authorityGate` must be cheap and must not
   * act) while every route to the current URL is an async CDP round trip, and
   * `browser_upload_file`'s card has to name the origin that will receive the
   * file. Advisory by design: the authoritative check happens at upload time,
   * which refuses when the origin has moved since the card was built.
   */
  private lastReportedUrl: string | null = null;
  private runningBrowser: RunningBrowser | null = null;
  // Coordinates stored from last snapshot — not sent to LLM
  private elementCoords = new Map<number, { x: number; y: number }>();

  private autoLaunch: boolean;

  /**
   * `autoLaunch: false` makes connect() fail instead of starting a browser
   * when nothing answers on the port. Tests that bring their own headless
   * Chromium pass it: a browser that died mid-suite must fail the test, not be
   * replaced by a headed Chrome on the developer's desktop and real profile.
   */
  constructor(port: number = 9222, profileDir?: string, opts: { autoLaunch?: boolean } = {}) {
    this.cdp = new CDPClient();
    this.port = port;
    this.profileDir = profileDir;
    this.autoLaunch = opts.autoLaunch ?? true;
  }

  /**
   * Check if Chrome CDP is already reachable on the debug port.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Connect to Chrome. If Chrome isn't running, auto-launches it
   * with CDP enabled and an isolated profile. No user setup required.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    this.approvalEpoch++;

    // browser.local: false is enforced HERE, not only in launchChrome:
    // connect() first probes the CDP port and attaches to whatever is
    // already listening, so on a shared host a guard on launch alone would
    // let the agent adopt ANY process bound to 127.0.0.1:<port> - including
    // another tenant's. No local CDP connection at all when disabled.
    const { isLocalBrowserDisabled } = await import('../tools/local-tools-guard.ts');
    if (isLocalBrowserDisabled()) {
      throw new Error('The local browser is disabled on this machine (browser.local: false). Use a sidecar browser instead.');
    }

    // If Chrome isn't running, launch it automatically
    if (!(await this.isAvailable())) {
      if (!this.autoLaunch) {
        throw new Error(`Chrome CDP not reachable on port ${this.port} and auto-launch is disabled`);
      }
      console.log('[BrowserController] Chrome not detected, launching automatically...');
      this.runningBrowser = await launchChrome(this.port, this.profileDir);
    }

    // Arm the in-browser local-file guard BEFORE anything can navigate. Fail
    // closed: without it a redirect-free path to file: is one CDP call away.
    // The new one is armed before the old one is dropped, so a reconnect has
    // no window without interception.
    this.releasePort ??= registerDevtoolsPort(this.port);
    const guard = new BrowserRequestGuard();
    try {
      await guard.install(this.port, knownDevtoolsPorts());
    } catch (err) {
      throw new Error(
        `Could not install the browser's local-file guard, so the browser will not be driven: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const previousGuard = this.requestGuard;
    this.requestGuard = guard;
    await previousGuard?.close();

    // Discover page targets
    const listRes = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!listRes.ok) {
      throw new Error('Chrome CDP not reachable after launch');
    }

    const targets = await listRes.json() as Array<{
      type: string;
      url?: string;
      webSocketDebuggerUrl: string;
    }>;

    // Prefer a tab showing something the model may be sent to. A tab opened
    // before the guard existed (by hand, or in a Chrome that outlived an
    // earlier daemon) can be sitting on a file: page or chrome://settings; if
    // that is all there is, it is adopted and blanked below rather than read.
    const pages = targets.filter(t => t.type === 'page');
    let pageTarget = pages.find(t => isDrivableUrl(t.url ?? '')) ?? pages[0];
    const blankAdopted = !!pageTarget && !isDrivableUrl(pageTarget.url ?? '');

    if (!pageTarget) {
      // Create a new tab. PUT: Chrome 111+ refuses /json/new over GET.
      const newRes = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
      pageTarget = await newRes.json() as any;
    }

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('No page target found and could not create one');
    }

    // Connect CDP to the page
    await this.cdp.connect(pageTarget.webSocketDebuggerUrl);

    // Enable required CDP domains
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('DOM.enable');

    // Inject stealth scripts for all future navigations
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: STEALTH_SCRIPT,
    });

    if (blankAdopted) {
      await this.cdp.send('Page.navigate', { url: 'about:blank' });
    }

    this._connected = true;
    // The tab that was adopted, so a gate has something to name before the
    // first navigate. `blankAdopted` means it was just blanked.
    this.lastReportedUrl = blankAdopted ? 'about:blank' : (pageTarget.url ?? null);
    console.log('[BrowserController] Connected to Chrome');
  }

  /**
   * Navigate to a URL and wait for the page to load.
   */
  async navigate(url: string): Promise<PageSnapshot> {
    // Before connecting: a refused URL should not launch a browser.
    const target = checkNavigationUrl(url);
    await this.ensureConnected();

    const loadPromise = this.cdp.waitForEvent('Page.loadEventFired', 30000);
    const navigatedAt = Date.now();

    let result: { errorText?: string };
    try {
      result = await this.cdp.send('Page.navigate', { url: target });
    } catch (err) {
      // If navigate fails, suppress the dangling loadPromise timeout
      loadPromise.catch(() => {});
      throw err;
    }

    // The guard failed this navigation (a redirect into a blocked URL, say).
    // Say so, instead of snapshotting Chrome's generic "blocked" error page.
    const blocked = this.requestGuard?.lastBlocked;
    if (
      result?.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
      && blocked && blocked.at >= navigatedAt && blocked.resourceType === 'Document'
    ) {
      loadPromise.catch(() => {});
      throw new Error(`Navigation to ${url} was blocked: it led to ${blocked.url.slice(0, 200)}, and ${blocked.reason}.`);
    }

    try {
      await loadPromise;
    } catch {
      // Page.loadEventFired timeout — page may still be usable (SPAs, slow loads)
      console.warn(`[BrowserController] Page load timeout for ${url}, continuing anyway`);
    }

    await this.waitForSettled();

    return this.snapshot();
  }

  /**
   * Wait for the document to stop changing, bounded.
   *
   * This replaces a flat `Bun.sleep(800)`. That sleep was wrong in both
   * directions: on a static page it burned 800ms doing nothing, and on a loaded
   * machine — or when the load-event wait above timed out and we continued
   * anyway — 800ms wasn't enough, so callers got a snapshot of a page whose
   * scripts hadn't run yet (missing elements, unattached listeners).
   *
   * Polls readyState plus the element count and returns as soon as two
   * consecutive samples agree, so the common case is FASTER than the old sleep
   * while a slow page gets up to `maxMs`.
   *
   * A failed sample is RETRIED rather than treated as terminal. Chrome rejects
   * Runtime.evaluate with "Cannot find context with specified id" while the
   * execution context is being swapped — i.e. exactly during the navigation we
   * are waiting on. Bailing on the first such error would end the wait after a
   * single tick and hand back a page whose scripts have not run, which is worse
   * than the flat sleep this replaced. Only a sustained run of failures (a
   * crashed tab, a closed target) ends the wait early.
   */
  private async waitForSettled(maxMs = 3000, intervalMs = 150, minSettleMs = 800): Promise<void> {
    const start = Date.now();
    const deadline = start + maxMs;
    const maxConsecutiveFailures = 5;
    let lastCount = -1;
    let failures = 0;

    while (Date.now() < deadline) {
      await Bun.sleep(intervalMs);

      let sample: string | null = null;
      try {
        const result = await this.cdp.send('Runtime.evaluate', {
          expression: `(() => {
            try { return document.readyState + ':' + document.getElementsByTagName('*').length; }
            catch { return 'error:-1'; }
          })()`,
          returnByValue: true,
        });
        if (!result.exceptionDetails && result.result?.value !== undefined) {
          sample = String(result.result.value);
        }
      } catch {
        // Transient during a context swap — fall through to the retry counter.
      }

      const count = sample === null ? Number.NaN : Number.parseInt(sample.split(':')[1] ?? '', 10);
      if (sample === null || Number.isNaN(count)) {
        if (++failures >= maxConsecutiveFailures) return;
        continue;
      }
      failures = 0;

      // A stable element count is the settle signal, floored at minSettleMs for
      // EVERY page — `readyState === 'complete'` is not a licence to return
      // early. Plenty of pages build their DOM from a load handler or a short
      // setTimeout, which run AFTER 'complete'; returning at ~300ms would
      // snapshot them empty, a regression against the flat 800ms sleep this
      // replaced. The floor keeps the old guarantee; the stability check is
      // what lets a slow page take longer, up to maxMs.
      const stable = count === lastCount;
      if (stable && Date.now() - start >= minSettleMs) return;
      lastCount = count;
    }
  }

  /**
   * Refuse to hand the model anything from a page showing local content
   * (#521). The guards keep file: from loading; this covers what they cannot
   * see -- a tab restored from the back/forward cache (no request is made), or
   * a load let through because the guard's socket died while it was paused
   * (Chrome then continues the request, verified). The URL comes from the
   * browser's frame tree, not from script the page controls.
   */
  private async assertNotLocalContent(): Promise<void> {
    const url = await this.readTopFrameUrl();
    if (isLocalContentUrl(url)) {
      throw new Error(`Refusing to read ${url.slice(0, 200)}: the browser does not show local files to the model.`);
    }
  }

  /**
   * Ask Chrome what the top frame's URL is, and remember it. The frame tree is
   * the browser's own answer; `location.href` is the page's, and a page that
   * wants a file attached to it is exactly the party that would lie.
   */
  private async readTopFrameUrl(): Promise<string> {
    return (await this.readTopFrame()).url;
  }

  /**
   * Record where the browser is now, best effort. Called after the actions that
   * can leave a page -- a click, a key press, a submit -- so a later approval
   * card names the page the model is actually on. A failure here must not fail
   * the action that succeeded: a stale record costs a refusal at upload time,
   * which is the safe direction.
   */
  private async noteCurrentPage(): Promise<void> {
    try {
      await this.readTopFrameUrl();
    } catch { /* keep the previous record */ }
  }

  /**
   * The top frame's URL and loaderId. The loaderId changes on every document
   * commit, so it is how a caller can tell that the page it checked is still the
   * page it is acting on -- a URL can be rewritten same-origin by
   * `history.pushState` without a new document, and a new document can arrive at
   * the same URL.
   */
  private async readTopFrame(): Promise<{ url: string; loaderId: string }> {
    const tree = await this.cdp.send('Page.getFrameTree');
    const url = String(tree?.frameTree?.frame?.url ?? '');
    const loaderId = String(tree?.frameTree?.frame?.loaderId ?? '');
    // Only ever REPLACE the record, never clear it. A frame that has not
    // committed a document reports an empty URL, and writing that as null would
    // put the upload path back into its "nothing reviewed" branch while the
    // connection still looks healthy -- turning a missing answer into a skipped
    // check.
    if (url) this.lastReportedUrl = url;
    return { url, loaderId };
  }

  /**
   * The last URL Chrome reported, for a synchronous approval gate. Null when
   * nothing has been reported yet. May be stale: a page that navigated itself
   * since the last navigate or snapshot is not reflected, which is why the
   * upload path re-reads it and refuses a mismatch rather than trusting this.
   */
  lastKnownPageUrl(): string | null {
    return this.lastReportedUrl;
  }

  /**
   * Get a snapshot of the current page: text content + numbered interactive elements.
   */
  async snapshot(): Promise<PageSnapshot> {
    await this.ensureConnected();
    // Refresh the browser-reported URL while we are here: a snapshot is what the
    // model takes after clicking through a site, so this is where an approval
    // card's idea of the current origin comes from -- and, since #572, where the
    // site-playbook lookup gets the URL it resolves. Kept non-fatal: a snapshot
    // whose frame-tree read failed still shows the model the page, it just
    // reports no browserUrl and so buys no decision.
    //
    // The loaderId comes with it, for the re-check after the evaluate below.
    const before = await this.readTopFrame().catch(() => null);

    // A refusal ADDED here, ahead of the page's own claim, not moved: until #572
    // `snapshot()` refused on `data.url` alone, i.e. on what the page said it
    // was. The frame-tree URL is now in hand anyway, and the Go port states the
    // order outright (sidecar/browser_snapshot.go) -- there is no reason to run a
    // local document's script and refuse afterwards.
    //
    // Belt and braces rather than the primary control: `location.href` is
    // [LegacyUnforgeable], so a page cannot actually lie about it, and the
    // loading guards are what keep `file:` out in the first place (#521). This
    // catches the case where the page's claim is honest and the guards never saw
    // the load.
    const frameUrl = before?.url ?? '';
    if (isLocalContentUrl(frameUrl)) {
      throw new Error(`Refusing to read ${frameUrl.slice(0, 200)}: the browser does not show local files to the model.`);
    }

    const result = await this.cdp.send('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Snapshot failed: ${JSON.stringify(result.exceptionDetails)}`);
    }

    // The page's answer, and only that: SNAPSHOT_SCRIPT runs in the page's own
    // world. Typed as its own shape rather than as PageSnapshot so nothing can
    // read a `browserUrl` off it -- that field is ours to fill, not the page's.
    const data = result.result.value as {
      title: string;
      url: string;
      text: string;
      elements: Array<PageElement & { x: number; y: number }>;
    };

    // Backstop for the guards (#521): whatever got the tab here, local
    // content is not handed to the model. Both answers are checked -- this one
    // is the page's claim, and the browser's was checked above, before the
    // script ran. A page that wants its file: document read has to lie in the
    // one Chrome does not let it touch.
    if (isLocalContentUrl(data.url ?? '')) {
      throw new Error(`Refusing to read ${String(data.url).slice(0, 200)}: the browser does not show local files to the model.`);
    }

    // CHECK, READ, CHECK AGAIN, as browser_read_guard.go puts it. A document can
    // commit between the frame-tree read and the evaluate -- a timer, a meta
    // refresh -- and then the URL names one document while the text came from
    // another, which is exactly the mismatch `browserUrl` promises not to be. The
    // loaderId changes on every commit, so comparing it is what closes the
    // window; `uploadFile` already gates on it the same way.
    const after = await this.readTopFrame().catch(() => null);
    const sameDocument = before !== null && after !== null
      && before.loaderId !== '' && before.loaderId === after.loaderId;

    // Store coordinates locally, strip from LLM-facing data
    this.elementCoords.clear();
    const cleanElements: PageElement[] = [];

    for (const el of data.elements) {
      this.elementCoords.set(el.id, { x: el.x, y: el.y });
      cleanElements.push({
        id: el.id,
        tag: el.tag,
        text: el.text,
        attrs: el.attrs,
      });
    }

    return {
      title: data.title,
      url: data.url,
      // Null unless the document that answered is the one that was checked. A
      // caller handed the PREVIOUS document's URL is the failure this field's
      // docblock rules out, so a lost race costs a site playbook, not a wrong one.
      browserUrl: sameDocument && before.url ? before.url : null,
      text: data.text,
      elements: cleanElements,
    };
  }

  /**
   * Where the element the last snapshot called `elementId` sits in the
   * viewport, or null when this controller never minted that id.
   *
   * This is the map `click()` dispatches from, and that is the whole point.
   * The pebble narration has to preview the element the click will hit, and
   * the only way to be sure of that is to read the click's own input. It used
   * to re-run a `querySelectorAll` inside the page instead, with a narrower
   * selector and 0-based indexing against these 1-based ids, so the pebble
   * pointed at one control while the click took another -- and the narration
   * is what the user reads before approving (#585). Two resolutions of one
   * integer is the bug; there is now one.
   *
   * Null rather than a guess, for the reason `getCachedElementBounds` in
   * actions/tools/desktop.ts already gives on the desktop half of the same
   * narration: an id we did not mint names nothing, and whatever happens to
   * sit at that index now is not it.
   *
   * A centre point, not a rect. Callers that want to draw something at the
   * element get the same single point the mouse event goes to, so there is no
   * second centre to compute and disagree over.
   *
   * These coordinates go stale exactly the way the click's do: nothing clears
   * them when the PAGE navigates itself (they are dropped on the next
   * snapshot, on disconnect, and on a stale-CDP reconnect, and nowhere else).
   * That is deliberate here -- a narration drawn from the same stale numbers
   * still previews where the click will land, which is the invariant this
   * accessor exists to hold. Refusing a click on a document nobody reviewed is
   * a click-path change and belongs in its own issue.
   *
   * `type()` is the one reader that goes further: it focuses through the DOM
   * ref the same snapshot stashed (`__jarvis_elements[id - 1]`) and only falls
   * back to these coordinates when that ref is gone. Both were minted from the
   * same kept list in the same pass, so they are the SAME element and the
   * identity #585 is about holds -- but after a reflow the typing reaches that
   * element wherever it now is while this point marks where it was. So a
   * `browser_type` pointer is exact on identity and stale on position, which
   * is the same trade the click makes and no worse than it.
   */
  snapshotElementPoint(elementId: number): { x: number; y: number } | null {
    const coords = this.elementCoords.get(elementId);
    return coords ? { x: coords.x, y: coords.y } : null;
  }

  /**
   * The isolated world `viewportScreenOrigin` evaluates in, retired with its
   * document. Only ever holds a geometry read, never an element lookup.
   *
   * The contextId is a PROMISE so that two narrations racing on a cache miss
   * share one world. One message emitting two element-addressed tool calls is
   * the ordinary parallel-tool shape, and each narration is a detached task;
   * without this, both would mint a world and only the last would be kept,
   * orphaning a V8 context for the life of the document every time.
   */
  private narrationWorld: { loaderId: string; contextId: Promise<number | null> } | null = null;

  /**
   * The screen coordinate of the viewport's top-left corner. Null when nothing
   * is connected or the read fails.
   *
   * Only `snapshotElementPoint` says WHICH element; this says where the
   * viewport is on the screen, and it is deliberately element-independent so
   * that no part of choosing the element can come back through it.
   *
   * Read in an ISOLATED WORLD. The values are the browser's, but a page can
   * install its own `screenX` getter on its main-world `window`, and this
   * offset is added to narration coordinates ONLY -- the click never reads it.
   * A page able to forge it could slide the pointer off the point the click
   * takes, which is the same decoupling #585 is about, reintroduced one term
   * later. An isolated world gets its own global proxy, so accessors the page
   * installed do not apply.
   *
   * Never connects. A narration runs on the tool_call event, before the action
   * it previews has executed, so it must not be the thing that launches a
   * browser.
   *
   * `screenY + (outerHeight - innerHeight)` is the viewport origin. The old
   * narration added `screenY` alone, which is the top of the title bar, so
   * every pointer landed roughly a toolbar height above the element. The
   * subtraction is the chrome height at 100% page zoom: Chromium reports
   * `outerHeight` and `screenY` in device-independent pixels while
   * `innerHeight` follows the page zoom, so a zoomed page over-reports it --
   * as does devtools docked at the bottom of the window, for the same reason.
   * Verified at zoom 1 only; `Page.getLayoutMetrics` would give the ratio
   * outright and is the way to remove the guess.
   *
   * NOT scaled to device pixels, deliberately. The pebble is positioned in
   * whatever space its platform reads the cursor in, and that is not one
   * space: Cocoa points on macOS (sidecar/panels_darwin.go, `[NSEvent
   * mouseLocation]`), GDK logical pixels on Linux (panels_linux.go,
   * `gdk_device_get_position`), physical pixels on Windows (panels_windows.go,
   * `GetCursorPos` under PerMonitorV2). A `devicePixelRatio` multiply is right
   * only on the third, and on the other two it would scale an absolute screen
   * coordinate -- throwing the pebble most of a screen away rather than a
   * toolbar. So this returns the CSS-pixel position unscaled, which is what
   * the code it replaces effectively did, and the CSS-to-platform conversion
   * stays an open, measurable question rather than an unverified multiply.
   */
  async viewportScreenOrigin(): Promise<{ x: number; y: number } | null> {
    if (!this._connected) return null;
    try {
      const tree = await this.cdp.send('Page.getFrameTree');
      const frameId = tree?.frameTree?.frame?.id;
      const loaderId = String(tree?.frameTree?.frame?.loaderId ?? '');
      if (typeof frameId !== 'string' || !frameId || !loaderId) return null;
      // One isolated world per document, not per narration: createIsolatedWorld
      // mints a fresh world (and a fresh V8 context) on every call however the
      // name is reused, and nothing disposes them. The loaderId changes on
      // every commit, so keying on it retires the world with its document.
      if (this.narrationWorld?.loaderId !== loaderId) {
        this.narrationWorld = {
          loaderId,
          contextId: this.cdp.send('Page.createIsolatedWorld', {
            frameId,
            worldName: 'jarvis-narration',
          }).then((world) => {
            const id = world?.executionContextId;
            return typeof id === 'number' ? id : null;
          }).catch(() => null),
        };
      }
      const contextId = await this.narrationWorld.contextId;
      if (contextId === null) {
        this.narrationWorld = null;
        return null;
      }
      const result = await this.cdp.send('Runtime.evaluate', {
        expression: `({
          x: window.screenX || 0,
          y: (window.screenY || 0) + Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0)),
        })`,
        contextId,
        returnByValue: true,
      });
      if (result?.exceptionDetails) {
        this.narrationWorld = null;
        return null;
      }
      const value = result?.result?.value as { x?: unknown; y?: unknown } | undefined;
      const x = Number(value?.x);
      const y = Number(value?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch {
      // A narration that cannot be placed says so (the caller amends the
      // bubble); it does not fall back to a coordinate it cannot stand behind.
      // Drop the cached world too -- a context that just failed is the most
      // likely thing to have gone away.
      this.narrationWorld = null;
      return null;
    }
  }

  /**
   * Click an element by its snapshot ID.
   * options.button: 'left' (default) or 'right' (context menu).
   * options.double: double-click instead of single click.
   */
  async click(
    elementId: number,
    options: { button?: 'left' | 'right'; double?: boolean } = {},
  ): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    const button = options.button === 'right' ? 'right' : 'left';

    // Move the pointer onto the element first — hover-sensitive UIs
    // (menus, message toolbars) expect mouseover before the press.
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
    });

    const clicks = options.double ? 2 : 1;
    for (let count = 1; count <= clicks; count++) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: count,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: count,
      });
    }

    // Wait for navigation/changes
    await Bun.sleep(1000);
    // A click is the ordinary way to leave a page, so re-read where the browser
    // now is: an approval card built after this must name the page the click
    // landed on, not the one it left (see lastReportedUrl).
    await this.noteCurrentPage();

    const kind = options.double ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked';
    return `${kind} element [${elementId}]`;
  }

  /**
   * Hover the pointer over an element by its snapshot ID (trusted CDP mouse
   * move). Reveals hover-only UI like message action toolbars. The revealed
   * elements only show up in a NEW snapshot taken after this call.
   */
  async hover(elementId: number): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    // Approach from a nearby point so mouseenter/mouseover always fire,
    // even if the pointer already sat on the target coordinates.
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.max(0, coords.x - 10),
      y: Math.max(0, coords.y - 10),
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
    });

    // Give the app time to render hover-triggered UI
    await Bun.sleep(600);

    return `Hovering over element [${elementId}]. Take a browser_snapshot to see any hover-revealed elements, then act before moving the mouse elsewhere.`;
  }

  /**
   * Press a key or key combination (trusted CDP key events), e.g. "Enter",
   * "Escape", "Tab", "ArrowDown", "Ctrl+K", "Shift+Enter". Keys go to the
   * currently focused element.
   */
  async pressKey(combo: string): Promise<string> {
    await this.ensureConnected();

    const parsed = parseKeyCombo(combo);
    if (!parsed) {
      return `Error: Unsupported key "${combo}". Supported: ${SUPPORTED_KEYS_HINT}.`;
    }

    const base = {
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.keyCode,
      nativeVirtualKeyCode: parsed.keyCode,
      modifiers: parsed.modifiers,
    };

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: parsed.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(parsed.text ? { text: parsed.text } : {}),
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });

    // Let the app react (menu open, mode switch, etc.)
    await Bun.sleep(300);
    await this.noteCurrentPage();

    return `Pressed ${parsed.display}`;
  }

  /**
   * Type text into an input element by its snapshot ID.
   * Optionally press Enter after typing.
   *
   * By default the element's existing content is CLEARED first (replace
   * semantics). Pass append=true to keep it and insert at the end instead.
   *
   * Uses DOM focus + targeted value clearing instead of coordinate-click + Ctrl+A.
   * This prevents misclicks from wiping the wrong field (e.g., typing subject
   * text into the To field in Gmail's compact compose window).
   */
  async type(
    elementId: number,
    text: string,
    submit: boolean = false,
    append: boolean = false,
  ): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    // Focus the element via DOM (more reliable than coordinate click for typing)
    const focusResult = await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = window.__jarvis_elements && window.__jarvis_elements[${elementId - 1}];
        if (!el) return 'not_found';
        el.focus();
        const append = ${append};
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          if (append) {
            // Move the caret to the end so the insert lands after existing text
            try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
          } else {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
          // Use the element's OWN document/window — the element may live
          // inside a same-origin iframe (Google Docs, Gmail compose), where
          // the top document's selection can't reach it.
          const doc = el.ownerDocument || document;
          const win = doc.defaultView || window;
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = win.getSelection();
          sel.removeAllRanges();
          if (append) {
            // Collapse to the end of the element's content — insert appends
            range.collapse(false);
            sel.addRange(range);
          } else {
            // Select all within this element only, then delete the selection
            sel.addRange(range);
            doc.execCommand('delete', false, null);
          }
        }
        return 'ok';
      })()`,
      returnByValue: true,
    });

    const focusStatus = focusResult?.result?.value;
    if (focusStatus === 'not_found') {
      // Fallback: coordinate-based click (element refs may have been lost on navigation)
      const clickResult = await this.click(elementId);
      if (clickResult.startsWith('Error:')) return clickResult;
      await Bun.sleep(200);
      if (!append) {
        // Use Ctrl+A as fallback clearing (old behavior)
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
        });
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
        });
      }
    } else {
      await Bun.sleep(200);
    }

    // Insert text (like paste — much more reliable than char-by-char)
    await this.cdp.send('Input.insertText', { text });

    let result = `${append ? 'Appended' : 'Typed'} "${text}" into element [${elementId}]`;

    if (submit) {
      await Bun.sleep(100);
      await this.pressEnter();
      // Wait for page load after submit
      await Bun.sleep(2000);
      await this.noteCurrentPage();
      result += ' and pressed Enter';
    }

    return result;
  }

  /**
   * Press Enter key.
   */
  async pressEnter(): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }

  /**
   * Scroll the page up or down.
   * direction: 'down' or 'up'
   * amount: pixels to scroll (default: one viewport height)
   */
  async scroll(direction: 'up' | 'down' = 'down', amount?: number): Promise<string> {
    await this.ensureConnected();

    const viewportHeight = (await this.evaluate('window.innerHeight') as number) || 600;
    const scrollAmount = amount ?? viewportHeight;

    const pixels = direction === 'down' ? scrollAmount : -scrollAmount;

    await this.evaluate(`window.scrollBy(0, ${pixels})`);
    await Bun.sleep(500); // Wait for lazy-loaded content

    return `Scrolled ${direction} by ${scrollAmount}px`;
  }

  /**
   * Upload a file to a <input type="file"> element on the page.
   * Uses CDP DOM.setFileInputFiles to bypass the native file picker.
   * If no selector is provided, finds the first visible file input.
   */
  async uploadFile(filePath: string, selector?: string): Promise<string> {
    // Throws for sensitive locations (upload-policy.ts). Chrome is handed the
    // symlink-resolved path the rule was applied to, not the name the model
    // passed.
    const realPath = checkUploadPath(filePath);
    // The origin the approval card named, BEFORE ensureConnected can refresh it:
    // a reconnect adopts `pages.find(isDrivableUrl) ?? pages[0]`, a tab the
    // reviewed page can influence, so comparing the authoritative URL against a
    // cache that the reconnect just rewrote would compare it with itself.
    const reviewed = this.lastReportedUrl;
    await this.ensureConnected();

    // Authoritative, from the browser's frame tree. Three refusals:
    const before = await this.readTopFrame();
    // (1) a page that cannot legitimately receive a file at all.
    const opaque = uploadTargetRefusal(before.url);
    if (opaque) return `Error: Refusing to upload to this page: ${opaque}`;
    // (2) nothing reviewed. Allowing it would skip the origin check altogether,
    // and it is reachable: after a daemon restart against a Chrome that outlived
    // it, `connect()` adopts whatever tab was left open.
    if (reviewed === null) {
      return 'Error: Refusing to upload: no page has been reported by the browser yet, so the approval could not name '
        + 'the page that would receive the file. Take a browser_snapshot first, then ask again.';
    }
    // (3) a page that is not the one the click was given for. Compared by
    // ORIGIN, not by URL: the sites people upload to (Gmail, Drive, GitHub)
    // rewrite the path constantly with history.pushState, and refusing on that
    // would refuse every real upload. A cross-origin move is what invalidates a
    // review.
    const reviewedOrigin = pageOrigin(reviewed);
    if (reviewedOrigin !== pageOrigin(before.url)) {
      return `Error: Refusing to upload: the page moved from ${reviewedOrigin} to ${pageOrigin(before.url) ?? 'an unknown origin'} `
        + 'since this upload was reviewed. Take a browser_snapshot and ask again, so the approval names the page that '
        + 'will actually receive the file.';
    }

    // Resolve the file input element
    const query = selector || 'input[type="file"]';
    const doc = await this.cdp.send('DOM.getDocument');
    const node = await this.cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: query,
    });

    if (!node.nodeId) {
      return `Error: No file input found matching "${query}". Click the upload/attach button first to trigger the file input.`;
    }

    // The origin check above and the handoff below are separate round trips, so a
    // page that navigates in between would receive a file approved for the
    // previous document. The loaderId changes on every commit, so comparing it
    // closes that window -- and it catches a same-URL reload, which a URL
    // comparison cannot.
    const after = await this.readTopFrame();
    if (after.loaderId !== before.loaderId || pageOrigin(after.url) !== reviewedOrigin) {
      return 'Error: Refusing to upload: the page loaded a new document while the upload was being set up. '
        + 'Take a browser_snapshot and ask again.';
    }

    // Set the file on the input element via CDP
    try {
      await this.cdp.send('DOM.setFileInputFiles', {
        files: [realPath],
        nodeId: node.nodeId,
      });
    } catch (err) {
      return `Error setting file: ${err instanceof Error ? err.message : String(err)}`;
    }

    await Bun.sleep(1000); // Wait for the app to process the file

    return `Uploaded file "${filePath}" to file input`;
  }

  /**
   * Take a screenshot and save to a file.
   */
  async screenshot(filePath: string = '/tmp/jarvis-screenshot.png'): Promise<string> {
    await this.ensureConnected();
    await this.assertNotLocalContent();

    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(result.data, 'base64');

    await Bun.write(filePath, buffer);
    return filePath;
  }

  /**
   * Take a screenshot and return raw base64 data (for vision/LLM).
   */
  async screenshotBuffer(): Promise<{ base64: string; mimeType: string }> {
    await this.ensureConnected();
    await this.assertNotLocalContent();
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    return { base64: result.data, mimeType: 'image/png' };
  }

  /**
   * Evaluate arbitrary JavaScript in the page context.
   */
  async evaluate(expression: string): Promise<unknown> {
    await this.ensureConnected();
    await this.assertNotLocalContent();

    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`JS error: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result.result.value;
  }

  /**
   * Disconnect from Chrome. If we auto-launched Chrome, stop it too.
   */
  async disconnect(): Promise<void> {
    this.approvalEpoch++;
    if (this.requestGuard) {
      await this.requestGuard.close();
      this.requestGuard = null;
    }
    this.releasePort?.();
    this.releasePort = null;
    if (this._connected) {
      await this.cdp.close();
      this._connected = false;
      this.elementCoords.clear();
      this.narrationWorld = null;
      console.log('[BrowserController] Disconnected');
    }

    // Stop the Chrome process we launched (if any)
    if (this.runningBrowser) {
      await stopChrome(this.runningBrowser);
      this.runningBrowser = null;
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  /** A reviewed call cannot reconnect to a different CDP page/session.
   * Initial navigation may connect lazily, provided nothing changed meanwhile. */
  captureApprovalGuard(allowInitialConnection = false): () => boolean {
    const epoch = this.approvalEpoch;
    const connected = this._connected;
    return () => this.approvalEpoch === epoch && (connected
      ? this._connected && this.cdp.isOpen && !!this.requestGuard?.isOpen
      : allowInitialConnection && !this._connected);
  }

  private async ensureConnected(): Promise<void> {
    if (this._connected && (!this.cdp.isOpen || !this.requestGuard?.isOpen)) {
      // Connection went stale — reset and reconnect. A closed request guard
      // counts: Chrome stops intercepting the moment its socket closes.
      console.warn('[BrowserController] CDP connection stale, reconnecting...');
      await this.cdp.close();
      this._connected = false;
      this.elementCoords.clear();
      this.narrationWorld = null;
    }

    if (!this._connected) {
      await this.connect();
    }
  }
}
