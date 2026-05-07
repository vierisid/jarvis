/**
 * Shared types for the SandboxApi server (the daemon-hosted server contract
 * the activepieces engine subprocess talks to).
 *
 * The "sandbox" is one engine subprocess. Each running flow allocates one
 * sandbox; the sandbox holds the per-run context (runId, projectId, payload)
 * that route handlers need to scope their work.
 */

export interface SandboxIdentity {
  /** Stable per-sandbox id; doubles as the socket.io auth identifier. */
  sandboxId: string;
  /** flow_run row id whose execution this sandbox is driving. */
  runId: string;
  /** Project the run belongs to. Single-tenant today, but the engine wants it. */
  projectId: string;
}

export interface SandboxRecord extends SandboxIdentity {
  /** Issued engineToken (full JWT) — handed back to the engine on spawn. */
  engineToken: string;
  /** Token expiry in epoch ms; matches the JWT `exp`. */
  expiresAt: number;
  /** Set when the sandbox is terminated (engine exited or we killed it). */
  terminatedAt: number | null;
}

export interface EngineTokenClaims extends SandboxIdentity {
  /** Standard JWT issued-at, in epoch seconds. */
  iat: number;
  /** Standard JWT expires-at, in epoch seconds. */
  exp: number;
}
