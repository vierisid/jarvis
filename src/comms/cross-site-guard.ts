/**
 * Cross-site write guard for the JSON API.
 *
 * The session cookie is SameSite=Lax, which already blocks a foreign
 * origin's POST when a cookie is in play. Two cases remain:
 *
 *   - a sibling subdomain: same-site, not same-origin, and Lax still sends
 *     the cookie there (multi-tenant hosts);
 *   - auth.insecure_open_access: no cookie at all, so a text/plain POST from
 *     any page the user is browsing is a CORS "simple request" that needs no
 *     preflight.
 *
 * Browsers stamp Sec-Fetch-Site on every request. A non-browser client
 * (sidecar, curl, the engine) sends none and is unaffected. Public routes
 * (webhooks) take cross-site POSTs by design and are excluded by the caller.
 */
export function rejectsCrossSiteWrite(method: string, secFetchSite: string | null, isPublicRoute: boolean): boolean {
  if (isPublicRoute) return false;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const site = (secFetchSite ?? '').toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}
