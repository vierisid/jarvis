/**
 * Gate for the control-plane bench endpoint (/api/debug/rpc).
 *
 * The endpoint can drive the desktop of every connected sidecar without an
 * LLM in the loop, so it is opt-in twice over: the daemon must be started
 * with JARVIS_DEBUG_RPC set to a secret of at least MIN_SECRET_LENGTH
 * characters, and every request must echo that secret in the
 * `x-debug-rpc-token` header. A short or missing secret leaves the route
 * absent (404), never "open by mistake".
 */

import { timingSafeEqual } from 'node:crypto';

export const DEBUG_RPC_ENV = 'JARVIS_DEBUG_RPC';
export const DEBUG_RPC_HEADER = 'x-debug-rpc-token';
export const MIN_SECRET_LENGTH = 16;

/** The active gate secret, or null when the route must not exist. */
export function debugRpcGate(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[DEBUG_RPC_ENV];
  if (!raw || raw.length < MIN_SECRET_LENGTH) return null;
  return raw;
}

/** True when the env var is set but too short to enable the route. */
export function debugRpcGateRejected(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEBUG_RPC_ENV];
  return !!raw && raw.length < MIN_SECRET_LENGTH;
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
