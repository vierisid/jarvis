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
const FETCH_TIMEOUT_MS = 1_500;

export async function hostedRealtimeIncluded(resolved: ResolvedRealtimeVoice): Promise<boolean> {
  if (!resolved.modelsUrl) return true;
  const key = `${resolved.modelsUrl}|${resolved.model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;
  try {
    const res = await fetch(resolved.modelsUrl, {
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return true; // advisory: only a definitive catalog gates
    const payload = await res.json() as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(payload.data)
      ? payload.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : [];
    const verdict = ids.includes(resolved.model);
    cache.set(key, { verdict, at: Date.now() });
    return verdict;
  } catch {
    return true; // advisory
  }
}

/** Test seam. */
export function clearRealtimeGateCache(): void {
  cache.clear();
}
