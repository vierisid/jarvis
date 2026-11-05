/**
 * Host header check for `auth.insecure_open_access`.
 *
 * With open access on, nothing authenticates a request, and the docs tell the
 * operator it is safe on a machine reachable only from localhost. DNS
 * rebinding breaks that: a page on a name the attacker controls re-resolves
 * that name to 127.0.0.1, and the browser then treats the daemon as the
 * attacker's own origin. Every request it sends is same-origin (so the
 * cross-site write guard passes it), and the /ws Origin check passes too,
 * because Origin and Host carry the same rebound name.
 *
 * What the browser cannot hide is the name: Host is the attacker's domain. So
 * while open access is on, a request is served only when its Host is a name
 * the attacker cannot point at this machine:
 *
 *   - an IP literal (v4 or bracketed v6): no DNS lookup, nothing to rebind;
 *   - `localhost` and `*.localhost`, which browsers resolve to loopback
 *     themselves (RFC 6761) and never through DNS;
 *   - the host of the configured external origin (`daemon.public_url`), which
 *     the operator chose.
 *
 * Not this machine's own hostname, bare or `.local`, though LAN use would
 * like it: those names resolve over LLMNR, NetBIOS and mDNS, which any peer on
 * the LAN can answer, so a LAN attacker could rebind them into a daemon bound
 * to loopback only. A LAN name is opted in by naming it in public_url.
 *
 * Off open access the panel-session cookie is the gate: it is host-only for
 * the name the panel was opened on, so a rebound name carries none.
 */
export interface OpenAccessHostOptions {
  /** The configured external origin, e.g. `https://jarvis.example.com`. */
  corsOrigin?: string | null;
}

/** The host part of a Host header, lower-cased, without port or brackets kept. */
function hostName(header: string): string | null {
  const value = header.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(value.slice(colon + 1))) return null;
    return value.slice(0, colon).replace(/\.$/, '');
  }
  return value.replace(/\.$/, '');
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpLiteral(name: string): boolean {
  if (IPV4.test(name)) return true;
  if (name.startsWith('[') && name.endsWith(']')) {
    try {
      return new URL(`http://${name}/`).hostname === name;
    } catch {
      return false;
    }
  }
  return false;
}

export function isOpenAccessHostAllowed(hostHeader: string | null, opts: OpenAccessHostOptions = {}): boolean {
  if (!hostHeader) return false;
  const name = hostName(hostHeader);
  if (!name) return false;
  if (isIpLiteral(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (opts.corsOrigin) {
    try {
      if (new URL(opts.corsOrigin).hostname.toLowerCase() === name) return true;
    } catch { /* not a URL: ignored */ }
  }
  return false;
}
