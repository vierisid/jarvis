/**
 * Sidecar Compatibility
 *
 * The sidecar versions itself independently of the brain (see sidecar/VERSION).
 * This module holds the brain's compatibility *floors* and the classifier that
 * the register handshake runs against a connecting sidecar's reported version.
 *
 * The floors are "the oldest sidecar this brain is happy with" — NOT "the latest
 * sidecar that exists". The brain never tracks the newest sidecar; it only bumps
 * these when the *brain itself* changes in a way that affects older sidecars, in
 * the brain release it is already cutting. That is what keeps the two release
 * cadences decoupled without a chicken-and-egg: a new sidecar release needs no
 * brain change to be considered "ok".
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

// During the current development phase the sidecar is frozen at a single
// version (sidecar/VERSION = 0.1.0) and ships as one release, so both floors sit
// at that value — nothing is incompatible yet. They only start to diverge once
// the sidecar resumes independent, per-change versioning post-development.
export const SIDECAR_MIN_VERSION = '0.1.0';
export const SIDECAR_RECOMMENDED_VERSION = '0.1.0';

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
