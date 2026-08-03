/**
 * npm "latest version" lookups for the pieces-catalog sync: retry with
 * backoff, a fleet-wide 429 cooldown, and a tri-state result so callers can
 * tell "not published" (deterministic 404) apart from "npm wouldn't answer"
 * (transient). Extracted from `scripts/sync-pieces-catalog.ts` so the
 * classification logic -- whose conflation of the two cases caused 64 false
 * catalog removals in PR #285 -- stays unit-testable with an injected fetch.
 */

export type NpmFetchResult =
  | { kind: "ok"; version: string }
  /** Deterministic 404 -- the package has no published release. */
  | { kind: "not-published" }
  /** 429 / 5xx / network failure on every attempt. Says nothing about the package. */
  | { kind: "transient"; error: string };

/**
 * How many times to attempt an npm registry GET before giving up. The sync
 * fires ~650 unauthenticated GETs from a shared CI IP, so transient 429s /
 * 5xx / connection resets are expected -- retrying absorbs them. A package
 * whose retry budget is still exhausted resolves `transient`, never a skip.
 */
export const NPM_MAX_ATTEMPTS = 4;
/** Base backoff in ms. Grows exponentially per attempt (500, 1000, 2000...). */
export const NPM_BACKOFF_BASE_MS = 500;
/** Cap on a single wait for non-429 failures (5xx, network). */
export const NPM_BACKOFF_MAX_MS = 10_000;
/**
 * Higher Retry-After cap for 429s specifically. npm's rate-limit window is
 * per-minute; a 10s cap made every retry land inside the same window (the
 * root cause of the PR #285 false removals). Waiting the window out is cheap
 * relative to a weekly batch job.
 */
export const NPM_RETRY_AFTER_MAX_MS = 60_000;
/** Per-request timeout so one hung connection can't stall a whole batch. */
export const NPM_FETCH_TIMEOUT_MS = 30_000;
/**
 * Max random extra wait after a fleet cooldown ends, so the workers don't
 * all fire into the fresh rate-limit window on the same millisecond.
 */
const COOLDOWN_WAKE_JITTER_MS = 250;

export interface NpmClientDeps {
  /** HTTP implementation; injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Sleep implementation; injectable so tests can run on a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock; injectable so tests can run deterministically. */
  now?: () => number;
  /** Randomness source for jitter; injectable for determinism. */
  random?: () => number;
}

export interface NpmClient {
  fetchLatest(pkg: string): Promise<NpmFetchResult>;
}

/**
 * Create a client whose 429 cooldown is shared across every `fetchLatest`
 * call: when any request is rate-limited, ALL callers pause until the window
 * passes -- otherwise concurrent workers keep burning their retry budgets
 * inside the same rate-limit window and fail together.
 */
export function createNpmClient(deps: NpmClientDeps = {}): NpmClient {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  /** Timestamp before which no request may be sent. Extended on every 429. */
  let pauseUntil = 0;

  async function awaitCooldown(): Promise<void> {
    let waited = false;
    for (let wait = pauseUntil - now(); wait > 0; wait = pauseUntil - now()) {
      waited = true;
      await sleep(wait);
    }
    // Stagger the wake-up so the fleet doesn't burst into the fresh window.
    if (waited) await sleep(Math.floor(random() * COOLDOWN_WAKE_JITTER_MS));
  }

  function extendCooldown(ms: number): void {
    pauseUntil = Math.max(pauseUntil, now() + ms);
  }

  function backoffMs(attempt: number): number {
    const jitter = Math.floor(random() * NPM_BACKOFF_BASE_MS);
    return NPM_BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitter;
  }

  async function fetchLatest(pkg: string): Promise<NpmFetchResult> {
    const url = `https://registry.npmjs.org/${pkg}/latest`;
    let lastError = "";
    for (let attempt = 1; attempt <= NPM_MAX_ATTEMPTS; attempt++) {
      await awaitCooldown();
      let waitMs = 0;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS) });
        // A genuine 404 means the package has no npm release -- deterministic,
        // not worth retrying.
        if (res.status === 404) return { kind: "not-published" };
        if (res.ok) {
          const info = (await res.json()) as { version: string };
          return { kind: "ok", version: info.version };
        }
        // 429 (rate limit) / 5xx / anything else non-OK -- transient. Honour
        // Retry-After when the server sends it, otherwise back off.
        lastError = `HTTP ${res.status}`;
        const serverDelayMs = retryAfterMs(res);
        if (res.status === 429) {
          // Rate limiting is a per-IP verdict, not a per-package one, so pause
          // the whole fleet (even on the last attempt -- it helps the packages
          // still in flight) and allow the longer Retry-After cap.
          waitMs = Math.min(serverDelayMs ?? backoffMs(attempt), NPM_RETRY_AFTER_MAX_MS);
          extendCooldown(waitMs);
        } else {
          waitMs = Math.min(serverDelayMs ?? backoffMs(attempt), NPM_BACKOFF_MAX_MS);
        }
      } catch (e) {
        // Network-level failure (DNS, reset, timeout) -- transient.
        lastError = (e as Error).message;
        waitMs = Math.min(backoffMs(attempt), NPM_BACKOFF_MAX_MS);
      }
      if (attempt < NPM_MAX_ATTEMPTS) await sleep(waitMs);
    }
    // Exhausted retries. Soft-fail so one persistently unreachable package
    // doesn't abort the whole sync; the caller decides what to do with it.
    console.warn(
      `[warn] npm fetch failed for ${pkg} after ${NPM_MAX_ATTEMPTS} attempts: ${lastError}`,
    );
    return { kind: "transient", error: lastError };
  }

  return { fetchLatest };
}

/**
 * Parse a `Retry-After` header (RFC 7231: delay-seconds form only -- npm
 * sends integer seconds). Returns ms, or null when absent/unparseable.
 */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

export type VersionResolution =
  /** npm answered: use its latest version. */
  | { action: "use"; version: string }
  /** npm unreachable but the piece shipped before: keep the previous version. */
  | { action: "carry-forward"; version: string }
  /** Drop the piece this run. `transient: false` means a real 404. */
  | { action: "skip"; reason: string; transient: boolean };

/**
 * Decide what a piece's catalog entry should do given the npm lookup outcome
 * and the version the previously committed catalog knew (null when the piece
 * is new). The invariant this encodes -- and the regression PR #285 exposed:
 * a transient npm failure must NEVER remove an already-shipped piece.
 */
export function resolveVersion(
  result: NpmFetchResult,
  previousVersion: string | null,
): VersionResolution {
  switch (result.kind) {
    case "ok":
      return { action: "use", version: result.version };
    case "not-published":
      return { action: "skip", reason: "no npm release (404)", transient: false };
    case "transient":
      return previousVersion !== null
        ? { action: "carry-forward", version: previousVersion }
        : {
            action: "skip",
            reason: `npm unreachable (${result.error}) and no previous entry to carry forward`,
            transient: true,
          };
  }
}
