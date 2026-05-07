/**
 * Per-run engineToken: an HS256 JWT scoped to one sandbox + run.
 *
 * The engine subprocess receives the token at spawn time (via env) and presents
 * it on every HTTP and WebSocket call back into the daemon. The daemon mints
 * one token per RUN_FLOW; the secret is generated fresh on each daemon start
 * (kept in memory only) so previously-issued tokens become invalid across
 * restarts. This matches upstream's posture of treating engineToken as a
 * server-scoped opaque credential.
 *
 * We use jose's `SignJWT` / `jwtVerify` with HS256. Symmetric is fine: the only
 * issuer and only verifier is this daemon process.
 */

import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import type { EngineTokenClaims, SandboxIdentity } from "./types";

const ALG = "HS256";

export class EngineTokenSigner {
  private readonly secret: Uint8Array;

  constructor(secret?: Uint8Array) {
    this.secret = secret ?? randomBytes(32);
  }

  /** Mint a token for one sandbox/run; default lifetime 1 hour. */
  async mint(identity: SandboxIdentity, ttlSeconds = 60 * 60): Promise<{
    token: string;
    expiresAt: number;
  }> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttlSeconds;
    const token = await new SignJWT({
      sandboxId: identity.sandboxId,
      runId: identity.runId,
      projectId: identity.projectId,
    })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.secret);
    return { token, expiresAt: exp * 1000 };
  }

  /**
   * Verify token signature + expiry, return decoded claims. Throws on any
   * failure (bad signature, expired, malformed). Callers should treat any
   * error as a 401.
   */
  async verify(token: string): Promise<EngineTokenClaims> {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: [ALG] });
    if (
      typeof payload.sandboxId !== "string" ||
      typeof payload.runId !== "string" ||
      typeof payload.projectId !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("engineToken claims missing required fields");
    }
    return {
      sandboxId: payload.sandboxId,
      runId: payload.runId,
      projectId: payload.projectId,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
