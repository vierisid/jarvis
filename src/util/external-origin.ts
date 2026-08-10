import type { JarvisConfig } from '../config/types.ts';

export type ExternalOriginSource = 'public_url' | 'brain_domain' | 'fallback';

export type ExternalOriginResolution = {
  httpOrigin: string;
  wsOrigin: string;
  source: ExternalOriginSource;
  proxyDetected: boolean;
  warnings: string[];
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

/** Validate and canonicalize a user/config supplied public origin. */
export function normalizePublicOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Public Jarvis URL cannot be empty');

  let withScheme = value;
  if (!/^(https?|wss?):\/\//i.test(value)) {
    const host = value.replace(/\/+$/, '');
    const hostname = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.split(':')[0];
    withScheme = `${LOOPBACK_HOSTS.has(hostname?.toLowerCase() ?? '') ? 'http' : 'https'}://${host}`;
  }

  const parsed = new URL(withScheme);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported public Jarvis URL scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Public Jarvis URL must not contain credentials, a query, or a fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Public Jarvis URL must be an origin without a path');
  }

  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  return `${secure ? 'https' : 'http'}://${parsed.host}`;
}

/**
 * Legacy `brain_domain` values were never validated, so a config that booted
 * fine before this validation existed must keep booting. Keep the host and
 * drop whatever made the value invalid; return null only when unparseable.
 */
function salvageLegacyPublicOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // A scheme-looking prefix that is not a supported scheme (ftp://) or is
  // malformed (https:/one-slash) would parse into a nonsense host; give up.
  if (/^[a-z][a-z0-9+.-]*:\//i.test(value) && !/^(https?|wss?):\/\//i.test(value)) return null;
  const hadScheme = /^(https?|wss?):\/\//i.test(value);
  try {
    const parsed = new URL(hadScheme ? value : `https://${value}`);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.host) {
      return null;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname.includes('.') && !hostname.includes(':') && !isLoopbackHostname(hostname)) {
      return null;
    }
    const secure = hadScheme
      ? parsed.protocol === 'https:' || parsed.protocol === 'wss:'
      : !isLoopbackHostname(parsed.hostname);
    return `${secure ? 'https' : 'http'}://${parsed.host}`;
  } catch {
    return null;
  }
}

function wsOrigin(httpOrigin: string): string {
  const parsed = new URL(httpOrigin);
  return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}`;
}

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Origin the reverse proxy reports via Forwarded / X-Forwarded-* headers.
 * Diagnostics only: it feeds warnings shown to the operator and never decides
 * the resolved origin, so no proxy trust model is needed.
 */
function observedProxyOrigin(req: Request): { origin: string | null; detected: boolean } {
  const standard = firstHeaderValue(req.headers.get('forwarded'));
  let proto: string | undefined;
  let host: string | undefined;
  if (standard) {
    for (const part of standard.split(';')) {
      const [rawKey, ...rawValue] = part.split('=');
      const key = rawKey?.trim().toLowerCase();
      const value = rawValue.join('=').trim().replace(/^"|"$/g, '');
      if (key === 'proto') proto = value;
      if (key === 'host') host = value;
    }
  }
  proto ??= firstHeaderValue(req.headers.get('x-forwarded-proto'));
  host ??= firstHeaderValue(req.headers.get('x-forwarded-host'));
  const detected = Boolean(standard || req.headers.has('x-forwarded-proto') || req.headers.has('x-forwarded-host'));

  if (!proto || !/^https?$/i.test(proto)) return { origin: null, detected };
  const effectiveHost = host ?? req.headers.get('host') ?? undefined;
  if (!effectiveHost) return { origin: null, detected };
  try {
    return { origin: normalizePublicOrigin(`${proto.toLowerCase()}://${effectiveHost}`), detected };
  } catch {
    return { origin: null, detected };
  }
}

/**
 * Resolve the canonical externally reachable Jarvis origin.
 *
 * Purely a function of configuration: `daemon.public_url` (or the legacy
 * `daemon.brain_domain` alias), falling back to `localhost:<port>`. The
 * optional request only contributes diagnostics (proxy detection, mismatch
 * warnings) — it never changes the resolved origin.
 */
export function resolveExternalOrigin(config: JarvisConfig, req?: Request): ExternalOriginResolution {
  const publicUrl = config.daemon.public_url?.trim();
  const brainDomain = config.daemon.brain_domain?.trim();
  const configured = publicUrl || brainDomain;
  const configuredSource: ExternalOriginSource = publicUrl
    ? 'public_url'
    : brainDomain
      ? 'brain_domain'
      : 'fallback';
  const warnings: string[] = [];

  let httpOrigin: string | null = null;
  if (configured) {
    try {
      httpOrigin = normalizePublicOrigin(configured);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const salvaged = salvageLegacyPublicOrigin(configured);
      if (salvaged) {
        warnings.push(
          `Configured public URL "${configured}" is not a plain origin (${detail}); using ${salvaged}`,
        );
        httpOrigin = salvaged;
      } else {
        warnings.push(
          `Configured public URL "${configured}" is unusable (${detail}); falling back to localhost:${config.daemon.port}`,
        );
      }
    }
  }
  const source = httpOrigin ? configuredSource : 'fallback';
  httpOrigin ??= `http://localhost:${config.daemon.port}`;

  const observed = req ? observedProxyOrigin(req) : { origin: null, detected: false };
  if (source === 'fallback' && observed.detected) {
    warnings.push(
      'This request came through a reverse proxy but daemon.public_url is not set — '
      + 'OAuth callbacks and enrollment tokens will point at localhost. '
      + 'Set daemon.public_url (or JARVIS_PUBLIC_URL) to the public origin.',
    );
  } else if (observed.origin && observed.origin !== httpOrigin) {
    warnings.push(
      `Configured public origin ${httpOrigin} differs from the origin reported by the proxy (${observed.origin}). `
      + 'Check daemon.public_url if external links are wrong.',
    );
  }

  return {
    httpOrigin,
    wsOrigin: wsOrigin(httpOrigin),
    source,
    proxyDetected: observed.detected,
    warnings,
  };
}

export function externalUrl(origin: ExternalOriginResolution, pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${origin.httpOrigin}${path}`;
}
