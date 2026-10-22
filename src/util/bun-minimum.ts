/**
 * The oldest Bun Jarvis supports, kept equal to package.json `engines.bun`,
 * install.sh's MIN_BUN and scripts/ensure-bun.cjs (src/cli/doctor.test.ts
 * pins all of them).
 *
 * Measured with a local TLS server and public hosts: Bun 1.3.8, 1.3.9 and
 * 1.3.10 cannot verify the certificate of an HTTPS request made through the
 * workflow egress guard's lookup (ERR_TLS_CERT_ALTNAME_INVALID), so the
 * workflow HTTP step and pasted OAuth2 refresh fail on them; 1.3.11, 1.3.12
 * and 1.4.2 verify. CI and the release image run 1.4.2.
 */
export const MIN_BUN_VERSION = '1.3.11';

/** Numeric x.y.z comparison; a pre-release or build suffix is ignored. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
