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
const BASELINE: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', "frame-ancestors 'self'"],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
];

export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res; // WebSocket upgrade, nothing to harden
  const apply = (h: Headers) => {
    for (const [name, value] of BASELINE) if (!h.has(name)) h.set(name, value);
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    // Immutable headers (a Response built from fetch()): rebuild around the body.
    const headers = new Headers(res.headers);
    apply(headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
