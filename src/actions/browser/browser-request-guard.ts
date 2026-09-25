/**
 * In-browser enforcement of the local-file ban (#521).
 *
 * url-policy.ts refuses a `file:` URL before we send it to Chrome. That covers
 * one door: our own `Page.navigate`. This covers the rest, by failing the
 * request inside Chrome whichever way it was started:
 *
 *   - `file:` anything. Chrome already refuses a web page's own attempts
 *     (script navigation, iframes, fetch, redirects), so what is left is every
 *     browser-initiated load that does not go through url-policy -- a tab
 *     opened through the DevTools endpoint below, a future caller that forgets
 *     the check, a parser disagreement between Bun's URL and Chrome's.
 *   - The DevTools HTTP endpoints of the browsers Jarvis drives: this one's
 *     and the other's (main 9222, background agent 9223). A page on that
 *     origin can `fetch('/json/new?file:///...', { method: 'PUT' })` as a
 *     same-origin request, and Chrome opens a new tab at that URL (verified).
 *     Blocking requests to those ports means the model never gets a page on
 *     that origin to run script in. Blocked on any host, not only loopback:
 *     `*.localhost` names reach it too, and a real site on the same port
 *     number is not worth the lookup.
 *
 * Mechanism: CDP `Fetch.enable` on the BROWSER target (the websocket in
 * /json/version), not on a page. A browser-level interception applies to every
 * tab, including tabs created after it and tabs the user opens by hand, where
 * a page-level one covers only the page it was enabled on (both verified).
 * Patterns limit it to `file:` URLs and the DevTools port, so ordinary web
 * requests are never paused and cost nothing.
 *
 * Chosen over the alternatives:
 *   - Chrome policy (`URLBlocklist`) cannot be scoped to our profile. Linux
 *     reads it from /etc (root), and macOS/Windows policies are machine- or
 *     user-wide, so they would also lock the user's own browser.
 *   - `Network.setBlockedURLs` does not stop a `file:` navigation (verified).
 *   - Watching navigations and bouncing them is after the fact: the page has
 *     loaded by then.
 * It works the same headless and headed, on every platform Chrome runs on.
 *
 * Lifetime: the interception lives exactly as long as this websocket. When it
 * closes, Chrome stops intercepting and CONTINUES any request it had paused
 * (verified), so BrowserController treats a closed guard like a dead page
 * connection and reconnects -- re-arming it -- before the next action, and
 * refuses to read a page that shows local content whatever got it there.
 */

import { CDPClient } from './cdp.ts';
import { effectivePort } from './url-policy.ts';

export type BlockedRequest = { url: string; reason: string; resourceType: string; at: number };

export class BrowserRequestGuard {
  private cdp = new CDPClient();
  private blockedPorts: ReadonlySet<number> = new Set();
  private _lastBlocked: BlockedRequest | null = null;

  /**
   * Attach to the browser target behind `devtoolsPort` and start failing
   * local-file requests and requests to any of `blockedPorts` (the DevTools
   * ports of every browser Jarvis drives, this one's included). Throws if the
   * interception cannot be installed; the caller must not drive the browser
   * then.
   */
  async install(devtoolsPort: number, blockedPorts: Iterable<number> = [devtoolsPort]): Promise<void> {
    this.blockedPorts = new Set([devtoolsPort, ...blockedPorts]);
    const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`/json/version returned HTTP ${res.status}`);
    const { webSocketDebuggerUrl } = await res.json() as { webSocketDebuggerUrl?: string };
    if (!webSocketDebuggerUrl) throw new Error('/json/version has no browser websocket');

    await this.cdp.connect(webSocketDebuggerUrl);
    this.cdp.on('Fetch.requestPaused', (params) => {
      void this.onPaused(params as { requestId: string; resourceType?: string; request: { url: string } });
    });
    try {
      await this.cdp.send('Fetch.enable', {
        patterns: [
          { urlPattern: 'file:*' },
          ...[...this.blockedPorts].map(port => ({ urlPattern: `*://*:${port}/*` })),
        ],
      });
    } catch (err) {
      await this.cdp.close();
      throw err;
    }
  }

  private async onPaused(params: { requestId: string; resourceType?: string; request: { url: string } }): Promise<void> {
    const url = params.request?.url ?? '';
    const reason = blockReason(url, this.blockedPorts);
    try {
      if (reason) {
        this._lastBlocked = { url, reason, resourceType: params.resourceType ?? '', at: Date.now() };
        console.warn(`[BrowserGuard] Blocked ${url.slice(0, 200)}: ${reason}`);
        await this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
      } else {
        // The port pattern is a wildcard on the URL text, so it can match a
        // URL whose port is something else (":9222/" in a path). Let it go.
        await this.cdp.send('Fetch.continueRequest', { requestId: params.requestId });
      }
    } catch (err) {
      // The request went away, or the connection did -- and when the socket
      // closes Chrome CONTINUES what it had paused. BrowserController treats
      // a closed guard as a dead session and reconnects, and refuses to read
      // a page showing local content, so that case is covered there.
      console.warn(`[BrowserGuard] Could not answer paused request ${url.slice(0, 200)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The last request this guard failed, for turning Chrome's generic error page into a clear message. */
  get lastBlocked(): BlockedRequest | null {
    return this._lastBlocked;
  }

  get isOpen(): boolean {
    return this.cdp.isOpen;
  }

  async close(): Promise<void> {
    await this.cdp.close();
  }
}

/**
 * Why a paused request must fail, or null to let it through. Exported for the
 * unit tests; the patterns in install() decide what reaches it.
 */
export function blockReason(url: string, blockedPorts: ReadonlySet<number>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Chrome paused it on a pattern we set, and we cannot tell which: fail.
    return 'unparseable URL matched a blocked pattern';
  }
  if (parsed.protocol === 'file:') return 'the browser does not load local files';
  if (blockedPorts.has(effectivePort(parsed))) return "requests to a Jarvis browser's DevTools port are blocked";
  return null;
}
