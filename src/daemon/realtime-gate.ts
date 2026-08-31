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

/**
 * Warm from a config, resolving it first. The shape both callers need.
 *
 * `resolve` is injected because this module must not import the daemon's
 * enablement view — usejarvis-ai.ts already imports nothing from here, and the
 * reverse edge would close a cycle through config/realtime.ts.
 */
export function warmRealtimeGateFor(
  resolve: () => { ok: true; resolved: ResolvedRealtimeVoice } | { ok: false; reason: string },
): void {
  try {
    const res = resolve();
    if (res.ok) warmRealtimeGate(res.resolved);
  } catch (err) {
    console.warn('[RealtimeGate] could not warm the plan verdict:', err);
  }
}

/**
 * Prime the verdict before anyone speaks.
 *
 * Realtime is now ON by default for hosted tenants (usejarvis-ai.ts
 * realtimeEnablement), so the plan gate decides for EVERY hosted install
 * rather than the few that had opted in. That made the cold-cache path a
 * user-visible cost rather than a rare one:
 *
 * `GET /api/config/voice` reports `available` from the CACHE only, and an
 * unknown verdict reads as available (the gate's advisory-open stance). The
 * browser captures raw PCM when `enabled && available` (ui useVoice.ts:431).
 * So on a plan WITHOUT realtime, the first utterance after every boot is
 * captured as PCM, refused by the gate, and DROPPED — raw frames are useless
 * to the WAV pipeline, which is why ws-service deletes the buffer rather than
 * feeding Whisper headerless audio. The user says something and nothing
 * happens; only the second utterance works.
 *
 * What warming actually guarantees, stated precisely because the next reader
 * will rely on it: the request is ISSUED before the daemon binds its listener,
 * so when the proxy answers within FETCH_TIMEOUT_MS the first
 * `GET /api/config/voice` already has a definitive verdict and the browser
 * never enters PCM mode on a plan that cannot serve it. It is not a guarantee
 * for a proxy that is slow or still booting — there the entry is advisory and
 * expires. That gap is covered separately: `cachedRealtimeVerdict` starts a
 * fetch on a cache miss, so the dashboard poll heals it ~15s later. Warming is
 * the fast path, not the only one.
 *
 * Fire-and-forget by design — it shares fetchVerdict's in-flight dedup, so a
 * voice_start racing the warm waits on the SAME request rather than issuing a
 * second, and a failure is simply an advisory entry that expires in 30s.
 */
export function warmRealtimeGate(resolved: ResolvedRealtimeVoice): void {
  if (!resolved.modelsUrl) return; // BYO sessions are never gated
  const key = cacheKey(resolved);
  const hit = cache.get(key);
  if (hit && isFresh(hit) && !hit.advisory) return;
  void fetchVerdict(key, resolved).catch(() => {});
}

/**
 * Allow, but remember it only briefly — see ADVISORY_TTL_MS.
 *
 * NEVER over a definitive "excluded". Both the session starter and the
 * cache-only read kick a background refresh when a definitive exclusion goes
 * stale; if that refresh fails, overwriting would replace a known exclusion
 * with advisory-true and read as OPEN for the next 30 seconds — flipping the
 * browser into raw-PCM capture and costing an utterance. That is precisely the
 * flap the asymmetric decay at the top of this file exists to prevent, reached
 * through the back door. A failed refresh teaches us nothing, so the old
 * answer stands.
 */
function advisoryAllow(key: string): boolean {
  const hit = cache.get(key);
  // A stale exclusion whose refresh keeps failing IS re-attempted on every
  // read, and that is deliberate. Two tidier-looking options both break
  // something: bumping `at` makes the entry fresh for the full CACHE_TTL_MS,
  // so a plan UPGRADE would go unnoticed for ten minutes; marking it advisory
  // gets the 30s retry cadence but then decays to "unknown", which reads as
  // available and flips the browser into PCM capture — the exact flap the
  // asymmetry at the top of this file exists to prevent. Retrying costs one
  // 1.5s-timeout request per read against a catalog that is already down, and
  // it stops the moment the catalog answers.
  if (hit && !hit.advisory && !hit.verdict) return false;
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
 *
 * ## A MISS starts a fetch too
 *
 * Answering null forever on an empty cache made the boot warm the only defence
 * against the cold-cache lost utterance, and there are several ways back to an
 * empty cache that boot does not cover: `reloadAll` calls
 * clearRealtimeGateCache on every SIGHUP (settings-reload.ts) — which hosted
 * ops do routinely, including the key rotation that delivers a plan change —
 * and a warm issued while the proxy was still coming up leaves only an
 * advisory entry that expires back to nothing.
 *
 * Kicking a background fetch here makes the poll SELF-HEALING for every one of
 * those, and demotes the boot warm to an optimisation rather than the single
 * line of defence. It stays cheap: `fetchVerdict` dedups in flight, and a
 * result of any kind ends the misses, so the ceiling is one request per
 * cache-empty poll — not one per poll. The honest exception is a stale
 * definitive exclusion whose refresh keeps failing: that one is re-attempted
 * per read, for the reason spelled out on advisoryAllow.
 */
export function cachedRealtimeVerdict(resolved: ResolvedRealtimeVoice): boolean | null {
  if (!resolved.modelsUrl) return true;
  const key = cacheKey(resolved);
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.verdict;
  // Everything below is a miss or a STALE entry, and both start a fetch.
  //
  // Stale mattered more than it looked. Entries are never deleted, so an
  // advisory one does not expire back to absent — it becomes a stale HIT, and
  // returning null there without fetching was a dead end that swallowed the
  // self-healing entirely: a re-warm whose fetch failed (the proxy restarting,
  // which is exactly what correlates with a key-rotation SIGHUP) parked an
  // advisory entry, and every poll from then on read "available" and never
  // asked again. On an excluded plan that is the lost utterance, permanently.
  void fetchVerdict(key, resolved).catch(() => {});
  // A stale definitive EXCLUDED still answers excluded while that refresh
  // runs — decaying it back to open would flip the browser into raw-PCM
  // capture once per TTL and cost an utterance each time (see the header).
  if (hit && !hit.advisory && !hit.verdict) return false;
  // Never stall a poll: this read is unknown, the next one ~15s later is not.
  return null;
}

/** Test seam. */
export function clearRealtimeGateCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Test seam: await whatever fetches are in flight.
 *
 * Tests of the fire-and-forget paths (warming, the miss-triggered refresh) must
 * not settle them with a bare `setTimeout(0)` — that works only while the
 * mocked body happens to resolve within one macrotask flush, and it fails
 * SILENTLY the other way: an assertion that the cache is still empty passes
 * just as well against a fetch that has not finished.
 */
export function settleRealtimeGateForTest(): Promise<unknown> {
  return Promise.all([...inFlight.values()]);
}

/** Test seam: age every cached verdict by `ms` so TTL decay is testable
 * without an injectable clock. */
export function ageRealtimeGateCacheForTest(ms: number): void {
  for (const entry of cache.values()) entry.at -= ms;
}
