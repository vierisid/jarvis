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
 */
const cache = new Map<string, { verdict: boolean; at: number }>();
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

export async function hostedRealtimeIncluded(resolved: ResolvedRealtimeVoice): Promise<boolean> {
  if (!resolved.modelsUrl) return true;
  const key = cacheKey(resolved);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;
  try {
    const res = await fetch(resolved.modelsUrl, {
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return advisoryAllow(key); // only a definitive catalog gates
    const payload = await res.json() as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(payload.data)
      ? payload.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : [];
    const verdict = ids.includes(resolved.model);
    cache.set(key, { verdict, at: Date.now() });
    return verdict;
  } catch {
    return advisoryAllow(key);
  }
}

/** Allow, but remember it only briefly — see ADVISORY_TTL_MS. */
function advisoryAllow(key: string): boolean {
  cache.set(key, { verdict: true, at: Date.now() - (CACHE_TTL_MS - ADVISORY_TTL_MS) });
  return true;
}

/**
 * Cache-only read: the verdict if one is known, else null. Never fetches.
 *
 * Exists for read-mostly surfaces like GET /api/config/voice, which the
 * dashboard polls every ~15s — routing that poll through the fetching gate
 * would turn a UI refresh into sustained catalog traffic.
 */
export function cachedRealtimeVerdict(resolved: ResolvedRealtimeVoice): boolean | null {
  if (!resolved.modelsUrl) return true;
  const hit = cache.get(cacheKey(resolved));
  if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) return null;
  return hit.verdict;
}

/** Test seam. */
export function clearRealtimeGateCache(): void {
  cache.clear();
}
