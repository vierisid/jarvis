/**
 * Which URLs the model-driven browser may be sent to (#521).
 *
 * `Page.navigate` is a BROWSER-initiated navigation: Chrome applies none of the
 * checks it applies to a web page. Handed `file:///proc/<daemon pid>/environ`
 * it opens the file, and the next snapshot hands the contents to the model --
 * and to any page that talked the model into asking. Web pages themselves are
 * already fenced off from `file:` by Chrome (a `window.location`, an iframe, a
 * fetch or a redirect to `file:` is refused), so this check is the gate for
 * the path Chrome does not police: our own CDP calls.
 *
 * ALLOWLIST, NOT DENYLIST. Chrome understands many schemes that reach local or
 * privileged content -- `file:`, `filesystem:`, `view-source:file:`,
 * `chrome:`, `chrome-extension:`, `devtools:`, and `about:` aliases such as
 * `about:settings`, which Chrome rewrites to `chrome://settings`. Naming the
 * few that are safe is shorter than predicting all the others:
 *
 *   - `http:` and `https:` -- the web.
 *   - `about:blank` only -- the empty page. Not `about:` in general, because
 *     of the `chrome://` aliases above.
 *   - `data:` -- kept on purpose. A top-level `data:` document gets an opaque
 *     origin: it cannot read `file:` (Chrome refuses the navigation, the
 *     iframe and the fetch, verified), nor any site's cookies or storage. Its
 *     content is whatever the model wrote into the URL, and the model can
 *     already run arbitrary script in any page through browser_evaluate, so
 *     `data:` grants nothing new. The integration tests load their fixture
 *     pages this way.
 *
 * Refused: everything else, `javascript:` and `blob:` included (browser_evaluate
 * covers the first; a `blob:` URL is only meaningful inside the page that made
 * it).
 *
 * This is one of two layers. The other, browser-request-guard.ts, fails every
 * `file:` request inside Chrome itself, so a path that never passes through
 * here -- a redirect, script navigation, a tab opened some other way -- still
 * cannot load a local file.
 */

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'data:']);

/**
 * DevTools ports of the browsers this process drives: always the defaults of
 * the main (9222) and background-agent (9223) browsers, plus the port of every
 * BrowserController while it is connected. Each browser blocks ALL of them,
 * not only its own: the model's browser can reach the background browser's
 * endpoint over loopback just as well as its own.
 *
 * Counted, and released on disconnect, so a short-lived controller (a test's,
 * on an ephemeral port) does not leave that port blocked for whatever the
 * kernel hands it to next.
 */
const DEFAULT_DEVTOOLS_PORTS: ReadonlySet<number> = new Set([9222, 9223]);
const connectedPorts = new Map<number, number>();

/** Mark `port` as a DevTools port until the returned release is called (once). */
export function registerDevtoolsPort(port: number): () => void {
  connectedPorts.set(port, (connectedPorts.get(port) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (connectedPorts.get(port) ?? 1) - 1;
    if (n <= 0) connectedPorts.delete(port);
    else connectedPorts.set(port, n);
  };
}

export function knownDevtoolsPorts(): number[] {
  return [...new Set([...DEFAULT_DEVTOOLS_PORTS, ...connectedPorts.keys()])];
}

function isDevtoolsPort(port: number): boolean {
  return DEFAULT_DEVTOOLS_PORTS.has(port) || connectedPorts.has(port);
}

const ALLOWED_SUMMARY = 'http://, https://, data: and about:blank';

/**
 * Hostnames Chrome sends to this machine's loopback interface. Chrome resolves
 * `localhost` and every `*.localhost` name to loopback itself, and the WHATWG
 * parser canonicalises `127.1`, `0x7f.1` and friends to `127.0.0.1`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  // Unspecified addresses connect to this host.
  if (h === '0.0.0.0' || h === '[::]') return true;
  // IPv4-mapped 127.0.0.0/8, which the WHATWG parser serialises in hex:
  // [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
  if (/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Validate a URL the model asked the browser to open, and return the exact
 * string to hand to `Page.navigate`.
 *
 * The NORMALISED href is returned, not the input: the scheme check runs on the
 * WHATWG parse, and passing the re-serialised form means Chrome is handed a
 * URL whose scheme is spelled the way it was checked, instead of re-parsing
 * the raw text by its own rules.
 *
 * DevTools endpoints are refused too (see knownDevtoolsPorts). One is on
 * loopback for every browser we drive, and it serves `PUT /json/new?<url>`,
 * which opens a tab at ANY url, `file:` included: a page on that origin can
 * call it with a plain same-origin fetch. So the model is not sent there.
 *
 * Throws an Error whose message is written for the model: what was refused,
 * why, and what is allowed.
 */
export function checkNavigationUrl(raw: string): string {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) {
    throw new Error('No URL given. Pass a full URL such as https://example.com.');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      `"${truncate(input)}" is not a valid URL. Include the scheme, e.g. https://${truncate(input, 60)}.`,
    );
  }

  const protocol = parsed.protocol.toLowerCase();

  if (protocol === 'about:') {
    // `about:blank`, `about:blank#x` and `about:blank?x` are the empty page.
    if (parsed.pathname.toLowerCase() === 'blank') return parsed.href;
    throw refusal(input, protocol, 'about: pages other than about:blank map to browser-internal chrome:// pages');
  }

  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    const why = protocol === 'file:'
      ? 'the browser does not open local files'
      : `"${protocol}" is not a web address`;
    throw refusal(input, protocol, why);
  }

  if (
    (protocol === 'http:' || protocol === 'https:')
    && isLoopbackHost(parsed.hostname)
    && isDevtoolsPort(effectivePort(parsed))
  ) {
    throw new Error(
      `Refusing to open ${truncate(input)}: that is a Jarvis browser's DevTools endpoint, which can open ` +
      `local files in new tabs. Open a web page instead.`,
    );
  }

  return parsed.href;
}

/**
 * Whether a page already showing `url` may be driven: attached to, read by a
 * snapshot. The navigation allowlist, applied to where a page IS rather than
 * where it is asked to go -- a tab can predate the guards (opened by hand, or
 * by a Chrome that outlived an earlier daemon).
 */
export function isDrivableUrl(url: string): boolean {
  try {
    checkNavigationUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** Pages that show local content. Never snapshotted, whatever led there. */
export function isLocalContentUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('file:') || lower.startsWith('view-source:') || lower.startsWith('filesystem:');
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

function refusal(input: string, protocol: string, why: string): Error {
  return new Error(
    `Refusing to open ${truncate(input)}: ${why}. The browser only opens ${ALLOWED_SUMMARY} URLs ` +
    `(got "${protocol}").`,
  );
}

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
