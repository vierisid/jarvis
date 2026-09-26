/**
 * Gate for the control-plane bench endpoint (/api/debug/rpc).
 *
 * Whoever holds the secret can call any RPC on every connected sidecar (shell
 * commands, file read/write, clipboard, browser JavaScript, desktop input)
 * with no LLM, approval step or audit trail in the loop, so it is opt-in twice
 * over: the daemon must be started with JARVIS_DEBUG_RPC set to a secret of at
 * least MIN_SECRET_LENGTH characters, and every request must echo that secret
 * in the `x-debug-rpc-token` header. A short or missing secret, or a hosted
 * install, leaves the route absent (404), never "open by mistake".
 *
 * The secret stops network callers, not local ones. Anything running as the
 * daemon's user can recover it (a command the terminal tool runs can read
 * /proc/<daemon pid>/environ on Linux), so an open gate hands every connected
 * sidecar to that user's local processes.
 */

import { timingSafeEqual } from 'node:crypto';

export const DEBUG_RPC_ENV = 'JARVIS_DEBUG_RPC';
export const DEBUG_RPC_HEADER = 'x-debug-rpc-token';
export const MIN_SECRET_LENGTH = 16;

export type DebugRpcGateState = 'off' | 'too-short' | 'refused-hosted' | 'open';

let activeSecret: string | null = null;

/**
 * Resolve the gate once, at startup. The secret is removed from `env` whatever
 * the outcome, so that spawns building their env from `process.env` do not
 * copy it. That is defense in depth only: a Bun or node spawn that omits `env`
 * inherits the startup environment, delete or not. What keeps it from a
 * command an agent runs is modelExecEnv() (util/model-exec-env.ts), which
 * lists JARVIS_DEBUG_RPC among the daemon's secrets, and sanitizedEnv()'s
 * allowlist elsewhere.
 */
export function initDebugRpcGate(opts: { hosted: boolean }, env: NodeJS.ProcessEnv = process.env): DebugRpcGateState {
  const raw = env[DEBUG_RPC_ENV];
  delete env[DEBUG_RPC_ENV];
  activeSecret = null;
  if (!raw) return 'off';
  if (raw.length < MIN_SECRET_LENGTH) return 'too-short';
  // A hosted brain is internet-facing by design; the bench harness has no
  // business there.
  if (opts.hosted) return 'refused-hosted';
  activeSecret = raw;
  return 'open';
}

/** The active gate secret, or null when the route must not exist. */
export function debugRpcGate(): string | null {
  return activeSecret;
}

/** Constant-time compare of a presented token against the gate secret. */
export function debugRpcTokenMatches(presented: string | null | undefined, gate: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(gate, 'utf8');
  // Byte-length compare first: timingSafeEqual throws on unequal lengths,
  // which would turn a bad token into a 500 with a stack trace.
  return a.length === b.length && timingSafeEqual(a, b);
}
