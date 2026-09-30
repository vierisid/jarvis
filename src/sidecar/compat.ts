/**
 * Sidecar Compatibility
 *
 * The sidecar versions itself independently of the brain (see sidecar/VERSION).
 * This module holds the brain's compatibility *floors*, the classifier that
 * the register handshake runs against a connecting sidecar's reported version,
 * and the sidecar version this brain ships with.
 *
 * The floors are "the oldest sidecar this brain is happy with". They are bumped
 * only when the *brain itself* changes in a way that affects older sidecars, in
 * the brain release it is already cutting, so a new sidecar release needs no
 * brain change to be considered "ok".
 *
 *   - SIDECAR_LATEST_VERSION      the sidecar released together with this
 *                                 brain (it always equals sidecar/VERSION; a
 *                                 test enforces it). Advertised to every
 *                                 connecting sidecar, which offers to update
 *                                 itself to it. It is the brain's version and
 *                                 not npm's `latest` on purpose: a brain that
 *                                 has not been upgraded yet must not push a
 *                                 sidecar newer than it was released with.
 *
 *   - SIDECAR_MIN_VERSION         hard floor. Below this the brain refuses the
 *                                 connection ("update required"). Bump when a
 *                                 brain change genuinely breaks older sidecars.
 *   - SIDECAR_RECOMMENDED_VERSION soft floor. Between MIN and this, the brain
 *                                 accepts but advises updating ("update
 *                                 suggested"). Bump when a brain change is
 *                                 works-but-buggy with older sidecars.
 *
 * Seeded equal (nothing is incompatible yet). They diverge only as real compat
 * events happen.
 */

// Both floors still sit at the first release: nothing is incompatible yet.
// They diverge only as real compat events happen.
export const SIDECAR_MIN_VERSION = '0.1.0';
export const SIDECAR_RECOMMENDED_VERSION = '0.1.0';

/** The sidecar version released with this brain. Keep equal to sidecar/VERSION. */
export const SIDECAR_LATEST_VERSION = '0.10.0';

/**
 * Outcome of classifying a sidecar's reported version against the floors:
 *   - 'ok'        >= RECOMMENDED, register normally.
 *   - 'suggested' MIN <= v < RECOMMENDED, register + advise an update.
 *   - 'blocked'   v < MIN, refuse the connection.
 *   - 'dev'       "dev" or an unparseable local build — never blocked.
 */
export type SidecarUpdateStatus = 'ok' | 'suggested' | 'blocked' | 'dev';

interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** '' for a release, the dot-separated identifiers otherwise. */
  prerelease: string;
}

/**
 * Parse a semver-ish string. Tolerant of a leading `v` and a `+build` suffix.
 * Returns null for "dev" / anything that isn't `X.Y.Z[...]` — callers treat
 * null as a never-blocked development build.
 */
export function parseSemver(raw: string): Semver | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^v/, '');
  // X.Y.Z, optional -prerelease, optional +build (build is ignored).
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

/** Compare two parsed semvers. Returns <0, 0, or >0. A prerelease sorts before its release. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Equal core: a release (no prerelease) outranks a prerelease.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  // Both prerelease: lexical identifier comparison is good enough here.
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Classify a sidecar's reported version against the brain's compatibility floors. */
export function classifySidecarVersion(reported: string): SidecarUpdateStatus {
  const v = parseSemver(reported);
  if (!v) return 'dev';
  const min = parseSemver(SIDECAR_MIN_VERSION)!;
  const recommended = parseSemver(SIDECAR_RECOMMENDED_VERSION)!;
  if (compareSemver(v, min) < 0) return 'blocked';
  if (compareSemver(v, recommended) < 0) return 'suggested';
  return 'ok';
}

/**
 * Whether a sidecar reporting `reported` is behind the version this brain
 * ships with. Dev / unparseable builds never are: they are never offered an
 * update (the sidecar refuses one too).
 */
export function isUpdateAvailable(reported: string | undefined | null, latest: string = SIDECAR_LATEST_VERSION): boolean {
  const v = parseSemver(reported ?? '');
  const l = parseSemver(latest);
  if (!v || !l) return false;
  return compareSemver(v, l) < 0;
}
