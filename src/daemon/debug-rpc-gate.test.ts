import { describe, expect, it } from 'bun:test';
import {
  debugRpcGate,
  debugRpcGateRejected,
  debugRpcTokenMatches,
  MIN_SECRET_LENGTH,
} from './debug-rpc-gate.ts';

const GOOD = 'a'.repeat(MIN_SECRET_LENGTH);

describe('debug RPC gate', () => {
  it('is closed when the env var is unset', () => {
    expect(debugRpcGate({})).toBeNull();
    expect(debugRpcGateRejected({})).toBe(false);
  });

  it('is closed, and reported as rejected, when the secret is too short', () => {
    const env = { JARVIS_DEBUG_RPC: 'short' };
    expect(debugRpcGate(env)).toBeNull();
    expect(debugRpcGateRejected(env)).toBe(true);
  });

  it('opens only with a long enough secret', () => {
    expect(debugRpcGate({ JARVIS_DEBUG_RPC: GOOD })).toBe(GOOD);
    expect(debugRpcGateRejected({ JARVIS_DEBUG_RPC: GOOD })).toBe(false);
  });

  it('matches the exact token and nothing else, without throwing on length mismatch', () => {
    expect(debugRpcTokenMatches(GOOD, GOOD)).toBe(true);
    expect(debugRpcTokenMatches(GOOD + 'x', GOOD)).toBe(false);
    expect(debugRpcTokenMatches(GOOD.slice(1), GOOD)).toBe(false);
    expect(debugRpcTokenMatches('é'.repeat(MIN_SECRET_LENGTH), GOOD)).toBe(false);
    expect(debugRpcTokenMatches(null, GOOD)).toBe(false);
    expect(debugRpcTokenMatches('', GOOD)).toBe(false);
  });
});
