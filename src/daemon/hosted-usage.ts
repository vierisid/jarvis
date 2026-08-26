import type { JarvisConfig } from '../config/types.ts';
import { INSTANCE_SIGNATURE_HEADER, signWithSecret } from '../integrations/google-signature.ts';
import { redactSecrets } from '../util/redact.ts';

/**
 * This instance's hosted usage meter, read from the control plane.
 *
 * ## Why not straight from the proxy
 *
 * The 6-hour window IS readable here — `/key/info` carries spend, max_budget
 * and the reset, and the provider already reads it for budget copy. The WEEK is
 * not: its allowance comes from plan grants this instance does not hold, and
 * weekly spend lives in the control plane's rollups. Reading one window from
 * the proxy and the other from the control plane would mean two conversion
 * sites, and the dashboard and this app could then quote a user different
 * numbers for the same window. One endpoint answers both.
 *
 * ## What never leaves this module
 *
 * The same split the hosted provider keeps (util/hosted-error.ts): the
 * upstream body and the control-plane hostname never reach USER-FACING copy,
 * while the operator gets the detail through `console.warn`. Failures return
 * `null` and the surface above renders "unavailable" — which is honest, and
 * carries none of the hostname the settings and catalog routes deliberately
 * withhold. Log lines are the operator's channel and do name the host; that is
 * the point of them, not a leak.
 */

export interface HostedUsageMeter {
  entitled: boolean;
  blocked: boolean;
  /** % of the 6h window used, or null when the control plane could not read
   * the proxy. Never render this as 0 — "unknown" and "empty" differ. */
  sessionPct: number | null;
  /** % of the weekly window used. */
  weekPct: number;
  /** ISO-8601. */
  sessionResetsAt: string;
  weekResetsAt: string;
}

/**
 * The three fields that must travel together, or the meter is off.
 *
 * A partial set cannot authenticate, so treating it as present would poll a
 * control plane that answers 401 every minute. Absent is the honest state: the
 * meter does not render.
 */
export interface HostedUsageConfig {
  url: string;
  instanceId: string;
  secret: string;
}

export function readHostedUsageConfig(config: JarvisConfig): HostedUsageConfig | null {
  const block = config.usejarvis_ai;
  if (!block) return null;
  const url = typeof block.usage_url === 'string' ? block.usage_url.trim() : '';
  const instanceId = typeof block.instance_id === 'string' ? block.instance_id.trim() : '';
  const secret = typeof block.usage_secret === 'string' ? block.usage_secret.trim() : '';
  if (!url || !instanceId || !secret) return null;
  return { url, instanceId, secret };
}

/** How long to wait on the control plane. Nothing is blocked on this — a meter
 * that takes ten seconds is a meter nobody sees, so fail fast and retry later. */
const TIMEOUT_MS = 5_000;

/**
 * How long a reading is reused.
 *
 * Matches the control plane's own per-user cache, so polling faster buys
 * nothing but load. Both the room's poll and the threshold check read through
 * this, so a 15-minute check and an open Usage room share one request.
 *
 * A FAILURE is cached too, and for the same reason the provider caches its
 * `/key/info` miss: an unreachable control plane must not turn into a request
 * per render.
 */
export const USAGE_CACHE_MS = 60_000;

interface CacheEntry {
  at: number;
  value: HostedUsageMeter | null;
}

export interface HostedUsageReaderDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The config is passed PER CALL, not captured.
 *
 * `config.yaml`'s system block is re-read on SIGHUP so a key can be rotated
 * without a restart; a reader holding the object it was built with would keep
 * signing with the old secret and answer 401 until the daemon bounced.
 */
export function makeHostedUsageReader(
  deps: HostedUsageReaderDeps = {},
): (config: JarvisConfig) => Promise<HostedUsageMeter | null> {
  // Resolved at CALL time, not captured here: the daemon builds its shared
  // reader at module load, so binding the global then made the route
  // untestable (a stub installed later never applied) and would ignore any
  // legitimate later swap.
  const callFetch = (
    ...args: Parameters<typeof fetch>
  ): ReturnType<typeof fetch> => (deps.fetchImpl ?? fetch)(...args);
  const now = deps.now ?? (() => Date.now());
  let cache: (CacheEntry & { key: string }) | null = null;

  return async (config: JarvisConfig) => {
    const cfg = readHostedUsageConfig(config);
    if (!cfg) return null;
    // Keyed by the credentials themselves, so a converge that rotates the
    // secret or moves the endpoint invalidates the reading rather than serving
    // a minute of answers obtained with a key we no longer hold.
    const key = `${cfg.url}|${cfg.instanceId}|${cfg.secret}`;
    if (cache && cache.key === key && now() - cache.at < USAGE_CACHE_MS) return cache.value;

    const body = JSON.stringify({ instanceId: cfg.instanceId, at: new Date(now()).toISOString() });
    let value: HostedUsageMeter | null = null;
    try {
      const res = await callFetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INSTANCE_SIGNATURE_HEADER]: signWithSecret(cfg.secret, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = (await res.json()) as Partial<HostedUsageMeter> | null;
        // Validated, not trusted: a shape we do not recognise must read as
        // "unavailable" rather than render a meter of undefineds.
        if (
          parsed
          && typeof parsed.weekPct === 'number'
          && typeof parsed.sessionResetsAt === 'string'
          && typeof parsed.weekResetsAt === 'string'
        ) {
          value = {
            entitled: parsed.entitled === true,
            blocked: parsed.blocked === true,
            sessionPct: typeof parsed.sessionPct === 'number' ? parsed.sessionPct : null,
            weekPct: parsed.weekPct,
            sessionResetsAt: parsed.sessionResetsAt,
            weekResetsAt: parsed.weekResetsAt,
          };
          if (typeof parsed.entitled !== 'boolean') {
            // Not fatal — the three checked fields are all present — but it is
            // the one field whose absence degrades SILENTLY: `=== true` makes
            // it false, the strip disappears and every warning stops, fleet
            // wide, reading exactly like "this customer has no plan".
            console.warn('[usage] meter has no `entitled` field; treating as not entitled');
          }
        } else {
          console.warn('[usage] control plane returned an unrecognised meter shape; meter unavailable');
        }
      } else if (res.status === 400) {
        // 400 is the one status whose body is worth keeping. The control plane
        // puts a deliberate diagnosis there — "check the instance clock" — and
        // a >5min drift makes EVERY read fail, so the meter and every usage
        // warning vanish with no other symptom. Redacted, and to the operator's
        // console, which is the channel this module's header reserves for
        // exactly this. Bounded so a long body cannot flood the log.
        const detail = redactSecrets(await res.text().catch(() => '')).slice(0, 300);
        console.warn(`[usage] control plane rejected the request: ${detail || '(no detail)'}`);
      } else {
        // STATUS only. The body can name the control-plane host, and a 401 body
        // could echo what we presented.
        console.warn(`[usage] control plane answered ${res.status}; meter unavailable`);
      }
    } catch (err) {
      console.warn(
        '[usage] could not reach the control plane; meter unavailable:',
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
    cache = { key, at: now(), value };
    return value;
  };
}

/**
 * The daemon's one reader.
 *
 * A module-level singleton because the CACHE is the point: the Usage room's
 * poll and the threshold check must share one request rather than take one
 * each. It holds no config — that arrives per call — so a SIGHUP rotation is
 * picked up immediately, and the cache key includes the credentials so a
 * rotated secret invalidates the reading rather than serving a stale minute.
 *
 * The factory stays exported so tests drive it with their own clock and fetch
 * instead of reaching through this.
 */
const shared = makeHostedUsageReader();

export function readHostedUsage(config: JarvisConfig): Promise<HostedUsageMeter | null> {
  return shared(config);
}
