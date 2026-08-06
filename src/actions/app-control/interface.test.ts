import { test, expect, describe } from 'bun:test';
import { getAppController } from './interface.ts';

describe('getAppController', () => {
  test('returns the same instance across calls', () => {
    // Regression (review): a fresh controller per tool call reset the sidecar
    // probe backoff and leaked one sidecar TCP connection per invocation.
    expect(getAppController()).toBe(getAppController());
  });
});
