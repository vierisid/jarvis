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

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
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
        _fi: fi,
        tag,
        text,
        attrs,
        x: Math.round(frame.ox + rect.x + rect.width / 2),
        y: Math.round(frame.oy + rect.y + rect.height / 2)
      });
    });
  }

  // Assign sequential IDs and store DOM refs for later direct focus.
  //
  // This script runs in an ISOLATED WORLD (#592). It used to run in the page's
  // own main world, where this array was window.__jarvis_elements -- a global
  // the PAGE can write, so a page that overwrote it had approved text typed
  // into an element of its own choosing while the snapshot, the approval card
  // and the narration all still named the reviewed one.
  //
  // The isolation is the contextId on the evaluate, NOT this spelling: inside a
  // world "window" is that world's own global proxy and expandos are
  // per-context. globalThis is here to tell a reader the script is not meant
  // for the page's world.
  globalThis.__jarvis_elements = els.map(e => e._el);

  // WHAT WAS TRUE WHEN THESE IDS WERE HANDED OUT, so a use-time guard can tell
  // that the thing an id names has changed while every field the frame tree
  // reports stayed put (#603).
  //
  // Three parts, each answering something no other check can see:
  //
  //   __jarvis_points   where each element WAS, in the same top-page viewport
  //                     space and the same rounding the click dispatches at.
  //                     Comparing the element's live centre to this is the
  //                     exact question -- "is the coordinate still where the
  //                     element is" -- where comparing the window's scroll
  //                     offset is only a proxy for it, and a bad one in both
  //                     directions: a position: fixed consent banner or a
  //                     sticky header does not move when the window scrolls
  //                     (so the proxy refuses a click that would have been
  //                     perfectly good), while an overflow: auto list
  //                     scrolling its own contents -- Gmail's message list,
  //                     Linear's issue list, a virtualised table, a chat log
  //                     -- moves every element inside it without touching
  //                     window.scrollY at all (so the proxy misses the
  //                     commonest staleness there is). Reflow from a
  //                     late-loading banner, a settling lazy image, a window
  //                     resize and a zoom change are all missed by the proxy
  //                     and caught by this.
  //   __jarvis_frames   which frame each element came from, so a frame that
  //                     rewrites itself invalidates only ITS OWN elements. The
  //                     app's own same-origin iframes churn constantly (a
  //                     Google Docs or Gmail compose editor lives in one), and
  //                     a cross-origin ad frame is never collected here at all,
  //                     so "some frame changed" would refuse typing into the
  //                     editor because a sibling frame reloaded.
  //   __jarvis_dom      each frame's documentElement, body and scroll offset.
  //                     The first two are how a REPLACED document is detected:
  //                     document.open()/write() replaces both while the
  //                     loaderId and the URL both hold (measured), and a
  //                     Turbo-style whole-body swap replaces the body alone
  //                     (measured), while pushState and an innerHTML re-render
  //                     anywhere in the tree touch neither (measured) -- which
  //                     is what makes this safe on every ordinary SPA click.
  //                     The scroll offset stays as the FALLBACK for an element
  //                     whose own node the page has since replaced, where
  //                     there is no live rect to compare.
  globalThis.__jarvis_points = els.map(e => [e.x, e.y]);
  globalThis.__jarvis_frames = els.map(e => e._fi);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; delete el._fi; });

  globalThis.__jarvis_dom = frames.map(f => {
    const w = f.doc.defaultView;
    return [
      f.doc.documentElement,
      f.doc.body,
      w ? Math.round(w.scrollX || 0) : 0,
      w ? Math.round(w.scrollY || 0) : 0
    ];
  });

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

/**
 * Asks the isolated world what has changed for ONE element since the snapshot
 * handed out its id (#603).
 *
 * PER ELEMENT, not per page, because the answer differs per element and the
 * coarse version was wrong in both directions: a page-wide scroll comparison
 * refuses a click on a `position: fixed` consent banner that has not moved, and
 * misses an `overflow: auto` list that has scrolled every element inside it
 * without touching `window.scrollY`. See the arming block in SNAPSHOT_SCRIPT.
 *
 * TWO VERDICTS, because they invalidate different things and the callers use
 * different things: 'dom' (this element's own document, or the top document,
 * was REPLACED - every ref and coordinate in it is stale, so every caller
 * refuses, `type()` included) and 'moved' (the element is still there and is no
 * longer where the id says - only a caller that DISPATCHES AT the coordinate
 * cares, and `type()` reaches its element through the ref). 'ok' is "nothing
 * that matters to this id changed"; 'gone' is "the world holds no reading for
 * this id".
 *
 * Mirrors `domGenerationScriptFor` in sidecar/browser_snapshot.go; change both.
 */
const domGenerationScript = (index: number) => `(() => {
  const dom = globalThis.__jarvis_dom;
  const pts = globalThis.__jarvis_points;
  const fis = globalThis.__jarvis_frames;
  const i = ${index};
  if (!dom || !dom.length || !pts || !fis) return 'gone';
  const frameIntact = (k) => {
    const entry = dom[k];
    if (!entry) return false;
    const root = entry[0];
    // A frame with no documentElement was never bindable: it contributed no
    // element and no coordinate, so it cannot invalidate one.
    if (!root) return true;
    const doc = root.ownerDocument;
    const win = doc && doc.defaultView;
    if (!doc || !win) return false;
    if (doc.documentElement !== root) return false;
    if (doc.body !== entry[1]) return false;
    return true;
  };
  // The top document always matters: an element in a frame is positioned by it.
  if (!frameIntact(0)) return 'dom';
  const fi = fis[i];
  if (typeof fi !== 'number' || !dom[fi] || !pts[i]) return 'gone';
  if (fi !== 0 && !frameIntact(fi)) return 'dom';
  const el = globalThis.__jarvis_elements && globalThis.__jarvis_elements[i];
  if (el && el.isConnected) {
    // The element's centre in TOP-PAGE viewport space: the same quantity the
    // snapshot stored, walked back up through the same frame offsets.
    let w = el.ownerDocument.defaultView, ox = 0, oy = 0, hops = 0;
    while (w && w.frameElement && hops++ < 10) {
      const fr = w.frameElement.getBoundingClientRect();
      ox += fr.x; oy += fr.y;
      w = w.frameElement.ownerDocument.defaultView;
    }
    if (w && !w.frameElement) {
      const r = el.getBoundingClientRect();
      const x = Math.round(ox + r.x + r.width / 2);
      const y = Math.round(oy + r.y + r.height / 2);
      // One pixel of tolerance for sub-pixel layout, which is also the most a
      // click can be off by and still land on the same place.
      return (Math.abs(x - pts[i][0]) <= 1 && Math.abs(y - pts[i][1]) <= 1) ? 'ok' : 'moved';
    }
  }
  // The node the snapshot held is gone or cannot be placed. That does NOT by
  // itself make the coordinate wrong -- an ordinary SPA re-render replaces
  // nodes constantly while the thing on screen stays put -- so fall back to
  // the frame's scroll offset, which is what the coarse check used to be.
  const entry = dom[fi];
  const root = entry[0];
  const win = root && root.ownerDocument && root.ownerDocument.defaultView;
  if (!win) return 'gone';
  return (Math.round(win.scrollX || 0) === entry[2] && Math.round(win.scrollY || 0) === entry[3]) ? 'ok' : 'moved';
})()`;

/**
 * What the sentinel says about one id: nothing that matters changed ('ok'), the
 * document it came from was replaced ('dom'), it is no longer where the id says
 * ('moved'), the world holds no reading for it ('gone'), or the renderer did
 * not answer in time ('busy', which is RETRYABLE).
 */
type DomGeneration = 'ok' | 'dom' | 'moved' | 'gone' | 'busy';

/**
 * How long the sentinel's own read may take. It is the only renderer-served
 * term on the click and hover paths, which before #603 could not be held up by
 * the page's main thread at all, so it does not inherit the 30-second default:
 * a janked page or a modal dialog is reported as busy instead of parking a
 * click for half a minute. Mirrors `domSentinelTimeout` in the sidecar.
 */
const DOM_SENTINEL_TIMEOUT_MS = 4000;

/**
 * Whether a key moves the viewport when the page has not taken it for something
 * else (#603). Keep in step with `scrollsThePage` in sidecar/browser_input.go.
 *
 * The key NAME alone, which over-refuses: End and Home move the caret rather
 * than the viewport when a text field has focus, and then the ids were retired
 * for nothing. Accepted in that direction only -- it costs a snapshot the
 * templates already take, where the other direction costs a click at a
 * coordinate that has moved.
 */
/**
 * What every tool that drops the coordinate map tells the model (#603). One
 * string, so `scroll()` and `pressKey()` cannot word it differently;
 * `retiredIDsNotice` in sidecar/browser_input.go is the same sentence.
 */
const RETIRED_IDS_NOTICE = 'Element ids from the previous snapshot no longer apply '
  + '-- take a browser_snapshot before acting on one.';

function scrollsThePage(key: string): boolean {
  return key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End';
}

/**
 * A digest of every frame's loaderId in a `Page.getFrameTree` reply (#592).
 *
 * One string rather than a set, because the only question asked of it is "did
 * ANY document in this page change", which a string answers in one comparison.
 * Frame ids are included so a frame appearing or disappearing counts as a
 * change too -- an iframe replaced by a new one with a coincidentally equal
 * loaderId is not the same page. Sorted, so sibling order cannot make two
 * readings of one tree differ.
 *
 * The twin of `collectFrameStamp` in sidecar/browser_snapshot.go. Same format,
 * but the two never compare digests with each other -- each guards its own
 * browser -- so this is parity of behaviour, not a wire contract.
 */
function frameTreeStamp(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    const f = n as { frame?: { id?: unknown; loaderId?: unknown }; childFrames?: unknown[] } | null;
    if (!f || typeof f !== 'object') return;
    parts.push(`${String(f.frame?.id ?? '')}:${String(f.frame?.loaderId ?? '')}`);
    for (const child of f.childFrames ?? []) walk(child);
  };
  walk(node);
  parts.sort();
  return parts.join('|');
}

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

  /**
   * Which DOCUMENT the coordinates and element refs above were minted in, and
   * what every frame in the page was showing at the time (#592).
   *
   * Nothing used to record this, so nothing could notice a PAGE-INITIATED
   * navigation: `elementCoords` was dropped on the next snapshot, on disconnect
   * and on a stale-CDP reconnect, and nowhere else. A click after a meta
   * refresh therefore dispatched a trusted mouse event at the previous
   * document's geometry, while `captureApprovalGuard` — which binds the
   * connection and the approval epoch, not the document — still held.
   *
   * `loaderId` alone is the document check, deliberately without the URL:
   * `history.pushState` rewrites `frameTree.frame.url` while the loaderId holds
   * (measured), and that is how every SPA navigates, so comparing the URL would
   * refuse an ordinary click on Gmail, Linear and the cell-to-cell moves
   * `webapp-templates/gsheets.yaml` tells the model to reuse an id across.
   * `readTopFrame`'s own docblock already says this, and `snapshot()`'s
   * `sameDocument` already compares the loaderId alone.
   *
   * `frameStamp` is the whole tree's digest, because a same-origin SUBFRAME can
   * commit a document of its own while the main frame's loaderId never moves
   * (measured) — and the snapshot walks subframes, so an in-frame coordinate
   * would then point into a destroyed document. Only ids the snapshot marked as
   * coming from a subframe are held to it: an unrelated advertising iframe
   * reloading must not refuse a click on a main-document element.
   *
   * Empty `loaderId` means "no usable snapshot", and every reader refuses.
   */
  private elementDoc: { loaderId: string; frameStamp: string } = { loaderId: '', frameStamp: '' };
  /** The ids the snapshot took from a same-origin subframe. */
  private elementInFrame = new Set<number>();
  /**
   * Bumped every time the element map is filled or dropped (#602). The mirror
   * of the sidecar's `elemGen`, and it answers the question a loaderId cannot:
   * a snapshot of the SAME document re-numbers every id while the document
   * identity never moves, so "the ids I reviewed" and "the ids that exist now"
   * can differ with every document check still passing.
   *
   * Read by `captureApprovalGuard`, which is synchronous and so can compare a
   * counter but cannot ask the browser anything.
   */
  private snapshotGen = 0;

  /**
   * The isolated world the snapshot's element refs live in, retired with its
   * document (#592).
   *
   * One world per document, keyed on the loaderId: `Page.createIsolatedWorld`
   * mints a fresh world and a fresh V8 context on every call however the name
   * is reused, and nothing disposes them, so keying on the loaderId is what
   * stops a context leaking per snapshot. The contextId is a PROMISE so two
   * callers racing on a cache miss share one world rather than orphaning one.
   *
   * A dead contextId is a REFUSAL, never a re-mint-and-retry. That is the
   * ergonomic "fix" to avoid: re-minting inside one action would silently
   * re-target whatever document is there now, which is the whole bug. Only a
   * fresh `snapshot()` may mint a world for a new document.
   */
  private elementWorld: { loaderId: string; contextId: Promise<number | null> } | null = null;

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

    // Make the page behave as though its window had focus (#592).
    //
    // This is a SECURITY control here, not a convenience. Chromium DEFERS a
    // page's `focus` event while the document itself is unfocused -- the normal
    // state for an automated browser -- so a page's own focus listener fires
    // late: after `type()` has focused the reviewed element and verified that
    // focus, and during the `Input.insertText` that finally gives the document
    // focus. Measured: without this, a page that steals focus in its listener
    // received the approved text and `type()`'s pre-insert check saw nothing
    // wrong; with it, the steal is visible immediately and the type refuses
    // before a character is sent.
    //
    // Best-effort on purpose. It is one layer of three -- the pre-insert check
    // and the post-insert check (which turns a slip into an honest error rather
    // than silent success) do not depend on it -- so a browser that does not
    // support it degrades to detection rather than failing to connect.
    try {
      await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      console.warn('[BrowserController] focus emulation unavailable; a focus steal will be '
        + 'reported after the fact rather than refused:', err);
    }

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
   * The main frame's identity AND a digest of every frame's loaderId, from ONE
   * `Page.getFrameTree` (#592).
   *
   * Both halves out of one round trip because the callers need both and reading
   * them a beat apart would let the identity and the digest describe different
   * moments -- which is the class of bug this whole change is about. Frame ids
   * are in the digest too, so a frame appearing or disappearing counts: an
   * iframe replaced by a new one with a coincidentally equal loaderId is not
   * the same page.
   *
   * Mirrors `frameTreeState` in sidecar/browser_snapshot.go; the two guard the
   * same contract on the two browsers.
   */
  private async readFrameState(): Promise<{ url: string; loaderId: string; frameStamp: string }> {
    const tree = await this.cdp.send('Page.getFrameTree');
    const url = String(tree?.frameTree?.frame?.url ?? '');
    const loaderId = String(tree?.frameTree?.frame?.loaderId ?? '');
    if (url) this.lastReportedUrl = url;
    return { url, loaderId, frameStamp: frameTreeStamp(tree?.frameTree) };
  }

  /**
   * Refuse when the element an action names was minted in a document the
   * browser has since left (#592).
   *
   * Returns an error message for the caller to hand back, or null to proceed.
   * Called by every method that reads `elementCoords` -- `click`, `hover` and
   * `type` -- before it dispatches anything. `uploadFile` is not in that list
   * and needs no change: it resolves a CSS selector and already gates on the
   * reviewed origin and a loaderId of its own, which is the model these three
   * now follow.
   *
   * CHECKED AT USE TIME rather than invalidated on a navigation event. The CDP
   * client does support events and `Page.enable` is already armed, so a
   * `Page.frameNavigated` subscription was possible -- and rejected: it is racy
   * by construction (the event need not have arrived when the click fires, so a
   * check would still be needed here), and the sidecar's half cannot have one
   * at all, because its event waiters are one-shot and params-less and its
   * `Page.enable` is best-effort, so an event guard there could silently never
   * fire. One mechanism that fails closed beats two that disagree.
   *
   * Fails closed on a read that throws: an action whose document cannot be
   * confirmed does not happen.
   */
  private async refuseIfDocumentMoved(elementId: number, usesCoordinates: boolean): Promise<string | null> {
    if (!this.elementDoc.loaderId) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }
    let now: { url: string; loaderId: string; frameStamp: string };
    try {
      now = await this.readFrameState();
    } catch {
      return `Error: Could not confirm the browser is still on the page element [${elementId}] came from, so nothing was done. Take a browser_snapshot and try again.`;
    }
    const moved = this.documentMovedReason(elementId, now);
    if (moved) {
      // Drop the map on the way out for the two terms that mean the ids are
      // dead, so the next call fails the same way without another round trip
      // and nothing stale is left clickable. A FRAME that moved leaves the
      // main document's ids usable, so that one does not clear.
      if (moved.fatal) this.forgetSnapshotElements();
      return `Error: ${moved.reason}`;
    }
    // AND THE DOCUMENT MAY HAVE BEEN REPLACED WITHOUT A NEW loaderId, or the
    // page may have scrolled (#603). Neither moves anything the frame tree
    // reports, so none of the terms above can see them, and both leave every
    // coordinate describing where an element used to be.
    //
    // Asked LAST, because it is the only renderer-served term here: everything
    // above comes from the browser process and cannot be blocked by a busy or
    // modal page, so the cheap terms refuse first.
    const generation = await this.domGeneration(elementId);
    if (generation === 'gone') {
      this.forgetSnapshotElements();
      return `Error: Element [${elementId}] cannot be addressed any more. Take a browser_snapshot first.`;
    }
    if (generation === 'busy') {
      // Retryable, and said so: telling the model to take a snapshot would send
      // it at a renderer that will not serve that either.
      return `Error: The page was too busy to confirm where element [${elementId}] is, so nothing was done. Try again.`;
    }
    if (generation === 'dom') {
      this.forgetSnapshotElements();
      return `Error: The page replaced the document element [${elementId}] came from, so it no longer exists. Take a browser_snapshot first.`;
    }
    // 'moved' concerns only a caller that DISPATCHES AT the coordinate: see
    // `usesCoordinates` and the sentinel's own docblock.
    if (generation === 'moved' && usesCoordinates) {
      return `Error: Element [${elementId}] has moved since the snapshot, so its position can no longer be trusted. Take a browser_snapshot first.`;
    }
    return null;
  }

  /**
   * THE DOCUMENT-IDENTITY DECISION, in one place (#603), for the terms that
   * come out of a frame-tree reading.
   *
   * Pure: it decides, it does not act. That is deliberate and not tidiness --
   * `refuseIfDocumentMoved` both clears the coordinate map and (through
   * `readFrameState`) writes `lastReportedUrl`, which is the value
   * `browser_upload_file`'s card and its use-time origin check compare. The
   * pebble narration shares this decision and must do neither: it runs on the
   * `tool_call` event, BEFORE the action it previews, and a cosmetic read that
   * cleared the map would turn the real click's accurate "the page navigated"
   * into "element not found".
   *
   * The rule itself, and why each term is the shape it is:
   *   - the loaderId must be non-empty and unchanged. The URL is deliberately
   *     NOT compared: `history.pushState` rewrites `frameTree.frame.url` while
   *     the loaderId holds (measured), and that is how every SPA navigates, so
   *     comparing it would refuse an ordinary click on Gmail, Linear and the
   *     cell-to-cell moves `webapp-templates/gsheets.yaml` tells the model to
   *     reuse an id across;
   *   - local content is never acted on (#526), decided on the reading just
   *     taken so it costs no extra round trip;
   *   - an id taken from a same-origin SUBFRAME is held to the whole tree's
   *     digest, because a child can commit a document while the main frame's
   *     loaderId never moves (measured). Scoped to in-frame ids: an unrelated
   *     advertising iframe reloading must not refuse a main-document click.
   *
   * `fatal` says whether the ids are dead (so the caller may drop them) or
   * merely untrustworthy for this one id.
   */
  private documentMovedReason(
    elementId: number,
    now: { url: string; loaderId: string; frameStamp: string },
  ): { reason: string; fatal: boolean } | null {
    if (isLocalContentUrl(now.url)) {
      return {
        reason: `Refusing to act on ${now.url.slice(0, 200)}: the browser does not drive local files.`,
        fatal: true,
      };
    }
    if (!this.elementDoc.loaderId || !now.loaderId || now.loaderId !== this.elementDoc.loaderId) {
      return {
        reason: `The page navigated to a new document, so element [${elementId}] from the previous snapshot no longer exists. Take a browser_snapshot first.`,
        fatal: true,
      };
    }
    if (this.elementInFrame.has(elementId) && now.frameStamp !== this.elementDoc.frameStamp) {
      return {
        reason: `Element [${elementId}] came from a frame, and a frame in this page has since navigated, so its position can no longer be trusted. Take a browser_snapshot first.`,
        fatal: false,
      };
    }
    return null;
  }

  /**
   * What has changed for one element since the snapshot handed out its id
   * (#603). Asked in the isolated world the element refs live in.
   *
   * Fails CLOSED in two distinguishable ways: 'gone' (no reading for this id)
   * and 'busy' (the renderer did not answer inside the sentinel's own budget),
   * which is RETRYABLE and must not tell the model to take a snapshot the same
   * renderer will not serve either.
   *
   * Never mints a world: a world is minted by `snapshot()` alone, so a missing
   * one means there is no snapshot to trust. Mirrors `domGeneration` in
   * sidecar/browser_snapshot.go.
   */
  private async domGeneration(elementId: number): Promise<DomGeneration> {
    const world = this.elementWorld;
    if (!world || world.loaderId !== this.elementDoc.loaderId) return 'gone';
    try {
      const contextId = await world.contextId;
      if (contextId === null) return 'gone';
      // Raced against its own budget rather than the CDP client's 30 seconds:
      // a blocked renderer must cost a retry, not half a minute.
      const read = this.cdp.send('Runtime.evaluate', {
        contextId,
        expression: domGenerationScript(elementId - 1),
        returnByValue: true,
      });
      const timeout = new Promise<'busy'>((resolve) => {
        setTimeout(() => resolve('busy'), DOM_SENTINEL_TIMEOUT_MS).unref?.();
      });
      const result = await Promise.race([read, timeout]);
      if (result === 'busy') return 'busy';
      const value = (result as { result?: { value?: unknown } })?.result?.value;
      return value === 'ok' || value === 'dom' || value === 'moved' ? value : 'gone';
    } catch {
      return 'gone';
    }
  }

  /**
   * Whether the element the snapshot called `elementId` holds focus right now,
   * asked in the isolated world (#592).
   *
   * Resolves the id through the same stored ref the focus used, so this cannot
   * become a second opinion about WHICH element -- it asks only about focus.
   *
   * EXACT equality, and a shadow root that has taken focus is not focus on the
   * element: `activeElement` is the host when focus is inside its shadow tree.
   * Same predicate as the focus script, and for the same measured reasons.
   *
   * Fails closed: a read that throws, or a world that has gone, is not 'ok'.
   */
  private async verifyFocus(elementId: number, contextId: number): Promise<'ok' | 'no'> {
    try {
      const result = await this.cdp.send('Runtime.evaluate', {
        contextId,
        expression: `(() => {
          const el = globalThis.__jarvis_elements && globalThis.__jarvis_elements[${elementId - 1}];
          if (!el || !el.isConnected) return 'no';
          const ownerDoc = el.ownerDocument || document;
          if (ownerDoc.activeElement !== el) return 'no';
          if (el.shadowRoot && el.shadowRoot.activeElement) return 'no';
          return 'ok';
        })()`,
        returnByValue: true,
      });
      return result?.result?.value === 'ok' ? 'ok' : 'no';
    } catch {
      return 'no';
    }
  }

  /**
   * Forget the last snapshot's elements, coordinates, document and ELEMENT
   * world.
   *
   * Not the narration world: that one holds a geometry read and no element ref,
   * it is keyed on its own loaderId and replaced on the next read, and it is
   * not a snapshot artifact -- `forgetNarrationWorld` is its counterpart.
   */
  private forgetSnapshotElements(): void {
    this.elementCoords.clear();
    this.elementInFrame.clear();
    this.elementDoc = { loaderId: '', frameStamp: '' };
    this.elementWorld = null;
    // Dropping the ids is as much a change of surface as minting new ones, so
    // an approval reviewed against the old ones must not execute (#602).
    this.snapshotGen++;
  }

  /**
   * The execution context of the isolated world holding this document's element
   * refs, or null when there is none (#592).
   *
   * Never falls back to the main world. Re-adding a main-world read as a
   * fallback would make the vulnerability reachable by any page that can make
   * `createIsolatedWorld` fail, which is the design's own argument for the
   * snapshot refusing rather than degrading.
   */
  private async elementWorldContext(loaderId: string, frameId: string): Promise<number | null> {
    if (this.elementWorld?.loaderId !== loaderId) {
      this.elementWorld = {
        loaderId,
        contextId: this.cdp.send('Page.createIsolatedWorld', {
          frameId,
          worldName: 'jarvis-elements',
          grantUniveralAccess: false,
        }).then((world) => {
          const id = world?.executionContextId;
          return typeof id === 'number' ? id : null;
        }).catch(() => null),
      };
    }
    const contextId = await this.elementWorld.contextId;
    if (contextId === null) this.elementWorld = null;
    return contextId;
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
    // The loaderId comes with it, for the re-check after the evaluate below,
    // and the frame digest for #592's subframe check. The frame id comes with
    // it too, because the isolated world is minted per frame.
    const beforeTree = await this.cdp.send('Page.getFrameTree').catch(() => null);
    const beforeFrameId = String(beforeTree?.frameTree?.frame?.id ?? '');
    const before = beforeTree
      ? (() => {
        const url = String(beforeTree?.frameTree?.frame?.url ?? '');
        if (url) this.lastReportedUrl = url;
        return { url, loaderId: String(beforeTree?.frameTree?.frame?.loaderId ?? '') };
      })()
      : null;
    const beforeStamp = beforeTree ? frameTreeStamp(beforeTree.frameTree) : '';

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

    // The document has to be NAMED before its coordinates are worth keeping,
    // and before the isolated world can be keyed on it (#592). An unnamed frame
    // tree would fill the map with coordinates every reader must then refuse,
    // while the model can see the snapshot text and reasonably expects its ids
    // to work -- not fail-closed to the model, and not usable either. Even
    // `about:blank` reports a non-empty loaderId once it has committed
    // (measured), so a nameless main frame is genuinely anomalous.
    if (!before?.loaderId || !beforeFrameId) {
      throw new Error('Refusing to read the page: the browser did not name the document it is showing.');
    }

    // The element refs go in an ISOLATED WORLD, so the page cannot reach them
    // (#592). REFUSED rather than degraded when no world can be minted: falling
    // back to a main-world evaluate would put the page-writable global straight
    // back, reachable by any page that can make createIsolatedWorld fail.
    const contextId = await this.elementWorldContext(before.loaderId, beforeFrameId);
    if (contextId === null) {
      throw new Error('Snapshot failed: could not create the isolated world the element references live in.');
    }

    // From here on the world may already hold a fresh set of refs -- the
    // snapshot script arms it as its last statement -- so ANY failure below
    // must forget BOTH halves rather than leave the world and the coordinate
    // map describing different readings. A `finally` rather than a clear at
    // each throw site, so a throw added later cannot skip it.
    let committed = false;
    try {
      return await this.completeSnapshot(contextId, before, beforeStamp, () => { committed = true; });
    } finally {
      if (!committed) this.forgetSnapshotElements();
    }
  }

  /**
   * The rest of `snapshot()`, split out only so the caller can wrap it in the
   * one `finally` that keeps the isolated world and the coordinate map from
   * describing different readings (#592). `commit` is called once both halves
   * agree.
   */
  private async completeSnapshot(
    contextId: number,
    before: { url: string; loaderId: string },
    beforeStamp: string,
    commit: () => void,
  ): Promise<PageSnapshot> {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
      contextId,
    });

    if (result.exceptionDetails) {
      throw new Error(`Snapshot failed: ${JSON.stringify(result.exceptionDetails)}`);
    }

    // The page's answer, and only that: SNAPSHOT_SCRIPT reads the page's DOM.
    // The isolated world keeps the page from tampering with the element REFS
    // and, because a world has its own builtins, with the DOM prototypes the
    // script reads through -- but the values below still describe a page, and
    // are typed as their own shape rather than as PageSnapshot so nothing can
    // read a `browserUrl` off them. That field is ours to fill, not the page's.
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
    this.elementInFrame.clear();
    const cleanElements: PageElement[] = [];

    for (const el of data.elements) {
      this.elementCoords.set(el.id, { x: el.x, y: el.y });
      // Which frame the element came from, from the marker the snapshot script
      // already sets. Not forgeable by the page: `iframe` is not in the
      // script's attribute allowlist, and the marker is written after that loop
      // (see SNAPSHOT_SCRIPT), so a page can neither suppress it on a framed
      // element nor add it to a main-document one.
      if (el.attrs?.iframe === 'true') this.elementInFrame.add(el.id);
      cleanElements.push({
        id: el.id,
        tag: el.tag,
        text: el.text,
        attrs: el.attrs,
      });
    }
    // The document these belong to, so click/hover/type can refuse an id minted
    // under a document the browser has since left (#592). Recorded from the
    // PRE-read tree: a subframe that commits while the script is running leaves
    // the stored digest describing the older tree, so a later action compares
    // unequal and refuses -- the safe direction.
    this.elementDoc = { loaderId: before.loaderId, frameStamp: beforeStamp };
    // A new set of ids, so anything reviewed against the previous set is no
    // longer reviewed against what exists (#602).
    this.snapshotGen++;
    // Both halves now describe this same reading, so the caller's cleanup must
    // not undo it.
    commit();

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
   * NOT A COMPLETE ANSWER ON ITS OWN, and that changed under this PR: #592 put
   * `refuseIfDocumentMoved` in front of `click`, `hover` and `type`, so those
   * now refuse outright once the browser has left the document the ids were
   * minted under, and `forgetSnapshotElements` drops the map on that path and
   * on a failed snapshot. The map is still populated while a narration runs,
   * because a narration resolves on the `tool_call` stream event and the tool
   * runs after the stream finishes -- so reading this alone would fly the
   * pebble confidently to a stale coordinate for an action that is about to
   * refuse. `viewportScreenOrigin` is what closes that: it compares the
   * document these ids belong to against the one on screen, in the frame-tree
   * read it already performs, and answers 'moved' instead of an origin. The
   * pair is the honest answer; this half is the coordinate only.
   *
   * `type()` reads this map too, but only as a MEMBERSHIP test -- the
   * coordinate itself is unused there and the element's identity comes from the
   * isolated-world ref the same snapshot stashed (`__jarvis_elements[id - 1]`).
   * The coordinate-click fallback that used to make `type` a second reader of
   * these numbers was deleted by #592, so a `browser_type` pointer marks where
   * the reviewed element was while the typing reaches it through its ref; after
   * a reflow within the same document those differ, which is the same trade the
   * click makes and no worse than it.
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
   * Drop the cached narration world, so the next read mints one.
   *
   * A counterpart to `forgetSnapshotElements` rather than a line inside it: the
   * narration world is not a snapshot artifact, and the two are cleared
   * together only where the CDP session itself goes away. Named so that the two
   * cleanup sites call a pair of methods instead of repeating a pair of
   * statements -- that duplication is what made this file conflict on the
   * merge that landed #592.
   */
  private forgetNarrationWorld(): void {
    this.narrationWorld = null;
  }

  /**
   * The screen coordinate of the viewport's top-left corner. Null when nothing
   * is connected or the read fails, and `'moved'` when the browser has left the
   * document the last snapshot's ids were minted under.
   *
   * Only `snapshotElementPoint` says WHICH element; this says where the
   * viewport is on the screen. It takes an `elementId` for ONE purpose -- to
   * ask whether that id was minted inside a frame -- and `elementInFrame` is a
   * membership test over the ids this controller already minted, exactly as
   * `type()` uses the coordinate map. So nothing here can pick an element, pick
   * a different one, or answer anything but yes or no; the geometry it returns
   * is still the window's and never an element's.
   *
   * WHY THE DOCUMENT CHECK LIVES HERE. #592 made `click`, `hover` and `type`
   * refuse once the document an id was minted under is no longer the one on
   * screen, so a narration that only read the coordinate map would preview an
   * action that is about to refuse -- the pebble flying confidently to a stale
   * point under an unamended label. The sidecar's half already refuses the same
   * cases (`BROWSER_SNAPSHOT_STALE`, sidecar/browser_element_point.go), so
   * without this the local and remote narrations would disagree about the same
   * page, which is #585's own complaint one level down.
   *
   * ALL THREE of `refuseIfDocumentMoved`'s document terms are mirrored, not
   * just the main-frame one: an empty map, a main-frame loaderId change, a
   * `file:` page, and -- the one most easily missed -- a FRAME digest change
   * for an id that came from a subframe. A child document can commit while the
   * main frame's loaderId never moves, so without that term a framed element
   * after its frame reloaded would still get a confident pointer for a click
   * that refuses. The fourth term, a frame-tree read that throws, is covered by
   * this function's own catch returning null.
   *
   * Checked in THIS read rather than in a second one, because the read is
   * already being made for the isolated world's frameId, and
   * `refuseIfDocumentMoved`'s own rule applies: one mechanism that fails closed
   * beats two that can disagree. The residual window between this read and the
   * click is the one #592 already accepts, and its error direction is
   * over-refusal.
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
  async viewportScreenOrigin(elementId: number): Promise<{ x: number; y: number } | 'moved' | null> {
    if (!this._connected) return null;
    try {
      const tree = await this.cdp.send('Page.getFrameTree');
      const frameId = tree?.frameTree?.frame?.id;
      const loaderId = String(tree?.frameTree?.frame?.loaderId ?? '');
      if (typeof frameId !== 'string' || !frameId || !loaderId) return null;
      // Read off the SAME tree, so the three checks below cannot disagree with
      // each other. `readFrameState` is not reused here on purpose: it writes
      // `lastReportedUrl`, and a cosmetic narration must not move state the
      // action path reads.
      const url = String(tree?.frameTree?.frame?.url ?? '');
      const frameStamp = frameTreeStamp(tree?.frameTree);
      // THE SAME DECISION THE ACTION MAKES, from this one reading: empty or
      // changed loaderId, local content, and -- for an in-frame id -- a moved
      // frame digest (#603 moved these three into `documentMovedReason` so the
      // two halves cannot drift apart).
      //
      // The DECISION only. This path must not clear the coordinate map or
      // write `lastReportedUrl`, which is why it does not call
      // `refuseIfDocumentMoved` itself: a cosmetic narration that cleared the
      // map would turn the real click's accurate "the page navigated" into
      // "element not found", and `lastReportedUrl` is what the upload card and
      // its use-time origin check compare.
      //
      // It also does NOT ask the renderer for the DOM generation the action
      // asks for. A narration is abandoned upstream after 1200 ms and a
      // renderer-served read is exactly what a modal `alert()` blocks, so the
      // pointer would be lost to a page being busy. The gap that leaves -- a
      // pebble pointing confidently at a position a `document.write` has
      // invalidated -- is closed from the other side for the common case:
      // `scroll()` drops the ids outright.
      if (this.documentMovedReason(elementId, { url, loaderId, frameStamp })) return 'moved';
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
    // The coordinates are only the click's input while the document they were
    // measured in is still the one on screen (#592) and the page has not
    // scrolled under them (#603) -- hence `usesCoordinates`.
    const moved = await this.refuseIfDocumentMoved(elementId, true);
    if (moved) return moved;

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
    // Hover dispatches at the stored coordinate too.
    const moved = await this.refuseIfDocumentMoved(elementId, true);
    if (moved) return moved;

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

    // A PAGING KEY SCROLLS when nothing has swallowed it, which moves every
    // coordinate the snapshot handed out with nothing any document check able
    // to see it (#603). The action paths notice at use time; the pebble's
    // coordinate readers deliberately do not run that sentinel, so the map is
    // dropped here rather than leaving them pointing at a pre-scroll position.
    //
    // Only the paging keys: Enter, Tab and the arrows are what a model presses
    // while working through a list it has already snapshotted, and clearing on
    // those would break "press Enter, then click [5]" for a cosmetic pointer.
    const retiredIDs = scrollsThePage(parsed.key);
    if (retiredIDs) this.forgetSnapshotElements();

    // Let the app react (menu open, mode switch, etc.)
    await Bun.sleep(300);
    await this.noteCurrentPage();

    // SAID, not just done, exactly as scroll() says it: the model is the one
    // that has to take a fresh snapshot, and "Element [5] not found" on the
    // next call reads as "that id was never valid".
    return retiredIDs ? `Pressed ${parsed.display}. ${RETIRED_IDS_NOTICE}` : `Pressed ${parsed.display}`;
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
    // That lookup is the MEMBERSHIP test and is load-bearing even though the
    // coordinate itself is unused here: `refuseIfDocumentMoved` never consults
    // `elementCoords`, so without it `type(9999)` would fall through to the
    // focus script. Only the element's IDENTITY comes from the ref below, not
    // from any coordinate.
    void coords;
    // NOT a coordinate user, which is what `false` says: the typing reaches the
    // element through its ref, so a scroll since the snapshot does not make
    // this call wrong -- and typing itself scrolls the caret into view (#603).
    const moved = await this.refuseIfDocumentMoved(elementId, false);
    if (moved) return moved;

    // The world the refs live in, and it must be THIS document's world. No
    // world, no typing -- never a main-world read (#592).
    //
    // The loaderId comparison is not redundant with the guard above: the world
    // and the coordinate map are armed at different moments (the snapshot
    // script arms the world as its last statement, the map is committed after
    // the re-check), so a snapshot that failed in between could otherwise leave
    // a world for document B while `elementDoc` still names A.
    const world = this.elementWorld;
    const contextId = world && world.loaderId === this.elementDoc.loaderId
      ? await world.contextId
      : null;
    if (contextId === null) {
      return `Error: Element [${elementId}] cannot be addressed any more. Take a browser_snapshot first.`;
    }

    // Focus the element via the DOM ref the snapshot stored, in the isolated
    // world, and VERIFY where focus actually landed before touching the value.
    //
    // The verification is the part that closes #592, and an isolated world
    // alone does not: worlds have their own globals and prototypes but share
    // the DOM *and its events*, so a page's own `focus` listener still fires
    // when this calls `el.focus()` and can move focus wherever it likes. That
    // was measured -- the script returned 'ok', `Input.insertText` landed in the
    // page's chosen input, and `el.value = ''` had meanwhile emptied the
    // reviewed one. Hence:
    //
    //   - `isConnected` first: focusing a node the page has detached is a no-op
    //     and the text would follow whatever still had focus (also measured);
    //   - `activeElement` in the element's OWN document, because for anything
    //     inside an iframe the top document's activeElement is the iframe;
    //   - EXACT equality, not `el.contains(active)`. An earlier version allowed
    //     a descendant "since focusing a contenteditable can land on a child",
    //     which is measured FALSE -- `activeElement` is the focusable ELEMENT,
    //     not the caret's node, and it equals `el` for a plain input, a select,
    //     an anchor, a contenteditable, and a contenteditable WITH element
    //     children. The allowance bought nothing and was an attack: a page that
    //     appends its own input inside the reviewed element and focuses it from
    //     that element's own focus listener received the approved text while
    //     `type()` reported success (measured);
    //   - a shadow root that has taken focus is refused, because
    //     `activeElement` is the HOST when focus is inside its shadow tree, so
    //     exact equality alone cannot tell "the reviewed element" from "an
    //     input the page put in its shadow root" (also measured);
    //   - a frame is never typed "into" at all. An `iframe` can enter the
    //     snapshot on `[data-testid]`, `[tabindex="0"]` or a role, and focusing
    //     it sends the text into a document the snapshot never described -- in
    //     the measured case, one on an opaque origin the top page cannot even
    //     read;
    //   - checked BEFORE the clear, so a refused focus cannot empty the field
    //     the user reviewed either.
    //
    // Measured not to cost the legitimate cases: a plain input, a select, a
    // top-level contenteditable, an input in a same-origin iframe, and a
    // contenteditable in a 1x1 clipped iframe -- the Google Docs pattern this
    // suite and sidecar/browser_parity_test.go both assert on -- all pass, and
    // typing still reaches that editor.
    const focusResult = await this.cdp.send('Runtime.evaluate', {
      contextId,
      expression: `(() => {
        const el = globalThis.__jarvis_elements && globalThis.__jarvis_elements[${elementId - 1}];
        if (!el) return 'not_found';
        if (!el.isConnected) return 'gone';
        const tag = el.tagName;
        if (tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED') return 'not_typable';
        el.focus();
        const ownerDoc = el.ownerDocument || document;
        if (ownerDoc.activeElement !== el) return 'not_focused';
        if (el.shadowRoot && el.shadowRoot.activeElement) return 'not_focused';
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

    // Anything but 'ok' REFUSES. The coordinate-click fallback that used to sit
    // here is gone, and removing it is the fix rather than a casualty of it
    // (#592).
    //
    // Ask when `not_found` was reachable before: overwhelmingly when a
    // navigation had replaced the document and wiped the page-global the refs
    // lived in -- so the fallback then coordinate-clicked and typed inside a
    // document nobody had reviewed, which IS the sibling bug this change is
    // about, not a recovery from it. With the document guard above, a
    // navigation refuses before this script runs at all, and with the world
    // keyed on the loaderId a same-document world is never re-minted, so
    // `not_found` is very nearly unreachable now.
    //
    // `gone` -- a re-render replacing the node -- used to succeed silently and
    // deliver the approved text to whatever still held focus (measured), so
    // refusing is strictly better than that, not a regression from working
    // behaviour. And a coordinate fallback after `gone` would re-open exactly
    // that leak: the click lands where an element no longer is, focus stays
    // where it was, and the text follows it.
    //
    // The cost is that the model re-snapshots after a re-render, which is what
    // 83 of the 100 webapp templates already instruct.
    const focusStatus = focusResult?.result?.value;
    if (focusStatus !== 'ok') {
      switch (focusStatus) {
        case 'gone':
          return `Error: Element [${elementId}] has been removed from the page, so nothing was typed. Take a browser_snapshot first.`;
        case 'not_typable':
          return `Error: Element [${elementId}] is a frame, not a field, so nothing was typed. Take a browser_snapshot and name an element inside it instead.`;
        case 'not_focused':
          return `Error: Element [${elementId}] did not take focus -- the page moved focus elsewhere -- so nothing was typed. Take a browser_snapshot and check the page.`;
        default:
          return `Error: Element [${elementId}] is no longer addressable, so nothing was typed. Take a browser_snapshot first.`;
      }
    }
    await Bun.sleep(200);

    // RE-VERIFY focus immediately before the insert, and again after it.
    //
    // The check inside the focus script is necessary but NOT sufficient, and
    // this is the part that was measured rather than reasoned about: Chromium
    // DEFERS the focus event when the document itself is not focused -- which
    // is the normal state for an automated browser -- so a page's `focus`
    // listener can fire after `el.focus()` has returned. With only the
    // in-script check, the reviewed element was still `activeElement` at check
    // time, the script said 'ok', the steal landed during the settle, and the
    // approved text went to the page's chosen input while `type()` reported
    // success. That is #592's own sentence, so the window has to be closed
    // where it actually is: around the insert.
    //
    // Bracketing NARROWS the window to a single local CDP round trip; it does
    // not eliminate it, and it should not be read as doing so. The bracket
    // samples two instants, so a page that steals focus and restores it only
    // has to be absent at those two samples -- and it has a usable clock (the
    // focus event it received, then this fixed settle) and a completion signal
    // (the `input` event on its own element). That race is narrow and needs
    // precise timing; what it is NOT is impossible.
    //
    // The checks that do not depend on timing are the ones in the focus script:
    // exact `activeElement` equality, no shadow tree holding focus, and no
    // frame. Those refuse a page-chosen destination without any race at all,
    // which is why they matter more than this bracket.
    const stillFocused = await this.verifyFocus(elementId, contextId);
    if (stillFocused !== 'ok') {
      return `Error: Element [${elementId}] lost focus before anything was typed -- the page moved focus elsewhere -- so nothing was typed. Take a browser_snapshot and check the page.`;
    }

    // Insert text (like paste — much more reliable than char-by-char).
    // Reached only with focus verified on the reviewed element, in the reviewed
    // document, immediately beforehand.
    await this.cdp.send('Input.insertText', { text });

    const heldFocus = await this.verifyFocus(elementId, contextId);
    if (heldFocus !== 'ok') {
      // The text has already gone somewhere. Nothing can un-type it, so the one
      // thing that must not happen is reporting success: a silent wrong
      // delivery is exactly what #592 is about.
      return `Error: Element [${elementId}] lost focus while the text was being typed, so the text may have gone to another element. Take a browser_snapshot and check the page before retrying.`;
    }

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

    // EVERY COORDINATE THE SNAPSHOT HANDED OUT NOW DESCRIBES WHERE AN ELEMENT
    // USED TO BE (#603).
    //
    // Scrolling moves every element and changes nothing the frame tree
    // reports, so no document check could see it: the map stayed live and
    // clickable, and a click after a scroll dispatched a trusted mouse event
    // at the previous viewport's geometry. Reachable with no page involvement
    // at all -- just two tool calls in the order the templates recommend.
    //
    // Dropped here as well as covered by the use-time sentinel, because the two
    // reach different readers. The sentinel compares each element's LIVE
    // position and so covers every geometry change for the paths that ask it
    // (click, hover), including the ones no tool announces. This drop reaches
    // the readers that deliberately do not run it -- `snapshotElementPoint` and
    // `viewportScreenOrigin`, which answer the pebble's position under a
    // latency budget. It covers THIS scroll only: a paging key drops the map
    // itself for the same reason, and a page scrolling itself reaches neither,
    // so the pebble can still be a scroll behind on a page that moves on a
    // timer.
    //
    // The model is already told to re-snapshot after scrolling, by this tool's
    // own description and by all 100 webapp templates.
    this.forgetSnapshotElements();

    await Bun.sleep(500); // Wait for lazy-loaded content

    return `Scrolled ${direction} by ${scrollAmount}px. ${RETIRED_IDS_NOTICE}`;
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
      this.forgetSnapshotElements();
      this.forgetNarrationWorld();
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

  /**
   * A reviewed call cannot reconnect to a different CDP page/session.
   * Initial navigation may connect lazily, provided nothing changed meanwhile.
   *
   * `bindDocument` adds the SURFACE to what is bound (#602). Without it the
   * guard binds the connection and the approval epoch and nothing else, so an
   * approval reviewed against one snapshot could execute against another: the
   * ids in `element_id` are per-snapshot, and a new snapshot of the same
   * document re-numbers them while the loaderId never moves. So an
   * element-addressed tool binds both the document the ids were minted in and
   * the GENERATION of the map they came from.
   *
   * This is the synchronous half, and it has to be: `authorityGate` and this
   * guard must not act, while reading the live document is a CDP round trip.
   * The live half stays at use time in `refuseIfDocumentMoved`, which runs
   * inside the tool and can be async. Two halves of one question, neither
   * sufficient alone -- this one catches "a different surface was reviewed",
   * that one catches "the page moved since".
   *
   * KNOWN CONSEQUENCE, stated because it is user-visible: anything that
   * re-snapshots OR DROPS the ids between the review and the execution blocks
   * the approval, with "its original UI session or reviewed subject is no
   * longer available" rather than a retryable error. Three shapes reach it --
   * a DEFERRED approval left pending while the same turn carries on with
   * another `browser_snapshot` or a `browser_navigate` (which snapshots
   * internally); the same turn carrying on with a `browser_scroll` or a paging
   * key, which drop the ids outright (#603); and a second agent acting through
   * the same module-level controller. NOT the parallel-tool shape: this
   * orchestrator awaits each tool call in turn, so a snapshot and a click in
   * one message always complete in order.
   *
   * It is the same trade the sidecar's `elemGen` check already makes, the
   * message names something the user can act on, and the alternative is
   * executing a click whose id now means a different element.
   */
  captureApprovalGuard(
    allowInitialConnection = false,
    opts: { bindDocument?: boolean } = {},
  ): () => boolean {
    const epoch = this.approvalEpoch;
    const connected = this._connected;
    const surface = opts.bindDocument
      ? { loaderId: this.elementDoc.loaderId, gen: this.snapshotGen }
      : null;
    // AN EMPTY SURFACE IS NOT A SURFACE, and the same rule this change puts in
    // `assertSamePage` and `documentMovedReason` applies to the thing that
    // CAPTURES one. Reachable in two ordinary calls: snapshot, then
    // `browser_scroll` (which drops the ids), then a `browser_click` card --
    // which would otherwise capture an empty loaderId, match it against itself
    // at execution, pass, and spend the user's click on "Element [5] not
    // found". Nothing was reviewed, so there is nothing to approve.
    if (surface && !surface.loaderId) return () => false;
    return () => {
      if (this.approvalEpoch !== epoch) return false;
      const live = connected
        ? this._connected && this.cdp.isOpen && !!this.requestGuard?.isOpen
        : allowInitialConnection && !this._connected;
      if (!live) return false;
      if (surface && (surface.loaderId !== this.elementDoc.loaderId || surface.gen !== this.snapshotGen)) {
        return false;
      }
      return true;
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this._connected && (!this.cdp.isOpen || !this.requestGuard?.isOpen)) {
      // Connection went stale — reset and reconnect. A closed request guard
      // counts: Chrome stops intercepting the moment its socket closes.
      console.warn('[BrowserController] CDP connection stale, reconnecting...');
      await this.cdp.close();
      this._connected = false;
      this.forgetSnapshotElements();
      this.forgetNarrationWorld();
    }

    if (!this._connected) {
      await this.connect();
    }
  }
}
