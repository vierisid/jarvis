import { afterEach, describe, expect, it } from 'bun:test';
import {
  DEBUG_RPC_ENV,
  debugRpcGate,
  debugRpcTokenMatches,
  initDebugRpcGate,
  MIN_SECRET_LENGTH,
} from './debug-rpc-gate.ts';

const GOOD = 'a'.repeat(MIN_SECRET_LENGTH);
const envWith = (value?: string): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [DEBUG_RPC_ENV]: value };

describe('debug RPC gate', () => {
  afterEach(() => {
    initDebugRpcGate({ hosted: false }, {});
  });

  it('is off when the env var is unset', () => {
    expect(initDebugRpcGate({ hosted: false }, envWith())).toBe('off');
    expect(debugRpcGate()).toBeNull();
  });

  it('stays closed, and says why, when the secret is too short', () => {
    expect(initDebugRpcGate({ hosted: false }, envWith('short'))).toBe('too-short');
    expect(debugRpcGate()).toBeNull();
  });

  it('opens only with a long enough secret', () => {
    expect(initDebugRpcGate({ hosted: false }, envWith(GOOD))).toBe('open');
    expect(debugRpcGate()).toBe(GOOD);
  });

  it('refuses a hosted install even with a valid secret', () => {
    expect(initDebugRpcGate({ hosted: true }, envWith(GOOD))).toBe('refused-hosted');
    expect(debugRpcGate()).toBeNull();
  });

  it('deletes the secret from the env object it resolves, whatever the outcome', () => {
    for (const [hosted, value] of [[false, GOOD], [true, GOOD], [false, 'short']] as const) {
      const env = envWith(value);
      initDebugRpcGate({ hosted }, env);
      expect(DEBUG_RPC_ENV in env).toBe(false);
    }
  });

  it('closes again when re-resolved without a secret', () => {
    initDebugRpcGate({ hosted: false }, envWith(GOOD));
    expect(initDebugRpcGate({ hosted: false }, envWith())).toBe('off');
    expect(debugRpcGate()).toBeNull();
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
