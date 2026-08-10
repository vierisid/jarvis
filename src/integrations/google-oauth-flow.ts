import { createHash, randomBytes } from 'node:crypto';

export type PendingGoogleOAuthFlow = {
  redirectUri: string;
  codeVerifier: string;
  expiresAt: number;
};

export type StartedGoogleOAuthFlow = PendingGoogleOAuthFlow & {
  state: string;
  codeChallenge: string;
};

/** One-time, in-memory OAuth attempts. A daemon restart simply requires retrying connect. */
export class GoogleOAuthFlowStore {
  private readonly pending = new Map<string, PendingGoogleOAuthFlow>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxPending = 100,
  ) {}

  start(redirectUri: string, now = Date.now()): StartedGoogleOAuthFlow {
    this.prune(now);
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const flow = { redirectUri, codeVerifier, expiresAt: now + this.ttlMs };
    this.pending.set(state, flow);
    return { state, codeChallenge, ...flow };
  }

  consume(state: string, now = Date.now()): PendingGoogleOAuthFlow | null {
    const flow = this.pending.get(state);
    this.pending.delete(state);
    if (!flow || flow.expiresAt <= now) return null;
    return flow;
  }

  private prune(now: number): void {
    for (const [state, flow] of this.pending) {
      if (flow.expiresAt <= now) this.pending.delete(state);
    }
  }
}
