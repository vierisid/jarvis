import { describe, expect, test } from 'bun:test';
import { computeAnonId } from './anon-id.ts';

describe('computeAnonId', () => {
  test('is deterministic for the same inputs', () => {
    const a = computeAnonId({ hostname: 'box', username: 'alice' });
    const b = computeAnonId({ hostname: 'box', username: 'alice' });
    expect(a).toBe(b);
  });

  test('differs when hostname or username changes', () => {
    const base = computeAnonId({ hostname: 'box', username: 'alice' });
    expect(computeAnonId({ hostname: 'box2', username: 'alice' })).not.toBe(base);
    expect(computeAnonId({ hostname: 'box', username: 'bob' })).not.toBe(base);
  });

  test('is a 128-bit (32 hex char) lowercase digest', () => {
    const id = computeAnonId({ hostname: 'box', username: 'alice' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('does not leak the raw inputs', () => {
    const id = computeAnonId({ hostname: 'secret-host', username: 'secret-user' });
    expect(id).not.toContain('secret-host');
    expect(id).not.toContain('secret-user');
  });

  test('falls back to defaults without throwing when no input given', () => {
    expect(() => computeAnonId()).not.toThrow();
    expect(computeAnonId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
