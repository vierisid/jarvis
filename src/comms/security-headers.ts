/**
 * Baseline browser-hardening headers for every HTTP response the daemon sends.
 *
 * The dashboard is served to a logged-in browser whose session cookie is
 * SameSite=Lax, which is also sent to a page on another loopback port. Without
 * a framing policy that page could frame the dashboard and overlay its approve
 * buttons (clickjacking).
 *
 * The only first-party iframe is the site preview, which loads this same
 * origin. The desktop app and the Pebble window load the URL directly in a
 * native window, not in a frame. So `'self'` is every ancestor the product
 * needs.
 *
 * Deliberately no script-src / default-src policy here: that needs its own
 * pass over the bundle so it cannot break the UI.
 *
 * A header the route (or a proxied dev server) already set is left alone.
 */
const FRAMING: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', "frame-ancestors 'self'"],
  ['X-Frame-Options', 'SAMEORIGIN'],
];

const BASELINE: ReadonlyArray<readonly [string, string]> = [
  ...FRAMING,
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
];

/**
 * Responses relayed from a site dev server (sites/proxy.ts). They are the
 * user's own page, so they get the framing policy (they are on the dashboard
 * origin) but not the page-behaviour headers: a Referrer-Policy would change
 * what the previewed site sends to third parties (embeds such as YouTube
 * refuse a request with no Referer), and nosniff would refuse a script a
 * plain static server labels text/plain. The dev server's own values pass.
 */
const relayed = new WeakSet<Response>();

export function markRelayedResponse(res: Response): Response {
  relayed.add(res);
  return res;
}

export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res; // WebSocket upgrade, nothing to harden
  const wanted = relayed.has(res) ? FRAMING : BASELINE;
  const apply = (h: Headers) => {
    for (const [name, value] of wanted) if (!h.has(name)) h.set(name, value);
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    // Immutable headers: rebuild around the body. A status the Response
    // constructor refuses (0 from Response.error()) is a network error the
    // browser never renders, so it goes out as it came.
    if (res.status < 200 || res.status > 599) return res;
    const headers = new Headers(res.headers);
    apply(headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
