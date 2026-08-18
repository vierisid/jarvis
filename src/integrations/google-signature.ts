import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The HMAC seam between this instance and the control plane (GOOGLE.md).
 *
 * Two directions, two keys, and they are NOT interchangeable:
 *
 * - the DOORBELL comes in (the control plane signs with `notify_secret`, we
 *   verify) and carries `{source, at}` — no data, so the worst a forged one
 *   achieves is an early poll;
 * - a REFRESH request goes out (we sign with `refresh_secret`, the control plane
 *   verifies) and carries the refresh token, so it is the one that matters.
 *
 * They were one key once, which made `HMAC(S, body)` a valid signature at either
 * endpoint — safe only because the two body shapes happen to be disjoint. The
 * control plane derives both from its master key under separate labels and
 * renders them whole into the system config, so nothing here derives anything and
 * there is no literal to drift between the two codebases.
 *
 * This mirrors packages/orchestration/src/google-app.ts on the control plane.
 * The duplication is deliberate: the repos do not share code, and the SHAPE
 * (hex sha256 over the exact bytes, in one header) is the contract.
 */
export const INSTANCE_SIGNATURE_HEADER = 'x-jarvis-signature';

/** Sign the exact bytes being sent. The timestamp is inside them, bounding replay. */
export function signWithSecret(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verify a signature over the exact bytes received.
 *
 * Compares by BYTES. `String.length` counts UTF-16 units while `Buffer` counts
 * utf8 bytes, so a 64-CHARACTER non-ASCII signature passed a `.length` gate and
 * then made timingSafeEqual THROW — which, on a public route with no error
 * handler above it, turned an unauthenticated 401 into a 500 with a stack trace,
 * at will. The lengths compared here are the buffers' own.
 */
export function verifyWithSecret(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const provided = Buffer.from(signature);
  const expected = Buffer.from(signWithSecret(secret, body));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
