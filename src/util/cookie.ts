/**
 * Reading one cookie off a Request.
 *
 * Lifted out of comms/websocket.ts, which had the only copy, once the API
 * routes needed the same read: a route that answers "what has THIS machine
 * granted" has to identify the panel the question came from, and the panel
 * session lives in a cookie. Two copies of a parser on the authentication path
 * is exactly the kind of duplication that drifts.
 */

/**
 * The value of `name`, or null when it is absent or unusable.
 *
 * A malformed escape (`%E0%A4%A`) makes decodeURIComponent throw, which would
 * unwind out of the fetch handler as a 500. This value is attacker-controlled
 * and read on the authentication path, so an unusable cookie has to read as
 * "no cookie" rather than as a server fault.
 */
export function getCookie(req: Request, name: string): string | null {
  const cookies = req.headers.get('Cookie');
  if (!cookies) return null;
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapeForRegExp(name)}=([^;]*)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Cookie names are ours, not user input - but building a RegExp from an
 *  unescaped string is a footgun waiting for the first name with a dot in it. */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
