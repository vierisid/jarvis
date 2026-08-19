import type { ResolvedRealtimeVoice } from '../config/realtime.ts';

/**
 * Hosted plan gate for realtime voice, shared by every session starter AND
 * the sidecar capability advertisement (they must agree, or the pebble
 * summon key opens sessions the plan will refuse at dial).
 *
 * Semantics: BYO sessions (no modelsUrl) are always allowed — the gate only
 * asks the platform proxy's key-scoped catalog whether the plan includes the
 * uj-realtime alias. Verdicts are cached (plans change rarely; without the
 * cache every utterance on a gated plan would pay a catalog RTT and clip the
 * start of the user's speech), and fetch failures are ADVISORY-allow with a
 * hard timeout — a network blip must neither disable voice nor stall
 * voice_start indefinitely.
 *
 * Decay is asymmetric: "unknown defaults open" applies only before any
 * definitive verdict has been observed. An EXPIRED definitive "excluded"
 * keeps reading as excluded while a background re-fetch runs — decaying it
 * back to open would flip a known-excluded plan into raw-PCM capture once
 * per TTL window, and that utterance would be refused and lost.
 */
type Entry = { verdict: boolean; at: number; advisory: boolean };
const cache = new Map<string, Entry>();
/** One catalog fetch per key at a time: concurrent starters (browser
 * voice_start racing a pebble start, or a reconnect fan-out re-advertising
 * over N sidecars) share the same in-flight promise instead of each paying
 * their own RTT. */
const inFlight = new Map<string, Promise<boolean>>();
const CACHE_TTL_MS = 10 * 60_000;
/** Advisory (fetch-failed) verdicts expire fast: they are a guess, and an
 * unreachable catalog must not cost a fresh 1.5s stall on every session. */
const ADVISORY_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 1_500;

/** The KEY is part of the cache identity, not just the URL: the plan is
 * enforced by the key's models allowlist, so an upgrade rewrites the key
 * while base_url and model stay put. Keying on the URL alone would serve a
 * stale "excluded" verdict for up to the full TTL after the user paid. */
function cacheKey(resolved: ResolvedRealtimeVoice): string {
  return `${resolved.modelsUrl}|${resolved.model}|${resolved.apiKey ?? ''}`;
}

function isFresh(entry: Entry): boolean {
  return Date.now() - entry.at < (entry.advisory ? ADVISORY_TTL_MS : CACHE_TTL_MS);
}

export async function hostedRealtimeIncluded(resolved: ResolvedRealtimeVoice): Promise<boolean> {
  if (!resolved.modelsUrl) return true;
  const key = cacheKey(resolved);
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.verdict;
  // Stale definitive "excluded": answer excluded NOW (no per-utterance stall,
  // no flap back to open) and refresh in the background so a plan upgrade
  // still lands within one TTL.
  if (hit && !hit.advisory && !hit.verdict) {
    void fetchVerdict(key, resolved).catch(() => {});
    return false;
  }
  return fetchVerdict(key, resolved);
}

/** Deduped catalog fetch: one in-flight request per cache key. */
function fetchVerdict(key: string, resolved: ResolvedRealtimeVoice): Promise<boolean> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const res = await fetch(resolved.modelsUrl!, {
        headers: { Authorization: `Bearer ${resolved.apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // 401/403 is not a blip — the key is revoked, rotated away, or scoped
      // out. Advisory-allow here would dial a session the proxy is certain to
      // refuse, and repeat the stall + failed dial every ADVISORY_TTL_MS.
      if (res.status === 401 || res.status === 403) {
        cache.set(key, { verdict: false, at: Date.now(), advisory: false });
        return false;
      }
      if (!res.ok) return advisoryAllow(key); // only a definitive catalog gates
      const payload = await res.json() as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(payload.data)
        ? payload.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
        : [];
      const verdict = ids.includes(resolved.model);
      cache.set(key, { verdict, at: Date.now(), advisory: false });
      return verdict;
    } catch {
      return advisoryAllow(key);
    }
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** Allow, but remember it only briefly — see ADVISORY_TTL_MS. */
function advisoryAllow(key: string): boolean {
  cache.set(key, { verdict: true, at: Date.now(), advisory: true });
  return true;
}

/**
 * Cache-only read: the verdict if one is known, else null. Never stalls.
 *
 * Exists for read-mostly surfaces like GET /api/config/voice, which the
 * dashboard polls every ~15s — routing that poll through the fetching gate
 * would turn a UI refresh into sustained catalog traffic. A stale definitive
 * "excluded" still reads as excluded (with a background refresh) for the same
 * reason as in hostedRealtimeIncluded: this flag is what flips the browser
 * into raw-PCM capture, and a TTL flap would cost the user an utterance.
 */
export function cachedRealtimeVerdict(resolved: ResolvedRealtimeVoice): boolean | null {
  if (!resolved.modelsUrl) return true;
  const key = cacheKey(resolved);
  const hit = cache.get(key);
  if (!hit) return null;
  if (isFresh(hit)) return hit.verdict;
  if (!hit.advisory && !hit.verdict) {
    void fetchVerdict(key, resolved).catch(() => {});
    return false;
  }
  return null;
}

/** Test seam. */
export function clearRealtimeGateCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Test seam: age every cached verdict by `ms` so TTL decay is testable
 * without an injectable clock. */
export function ageRealtimeGateCacheForTest(ms: number): void {
  for (const entry of cache.values()) entry.at -= ms;
}
