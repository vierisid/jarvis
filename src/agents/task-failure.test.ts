import { describe, expect, test } from 'bun:test';
import { classifyAgentFailure, isInfrastructureFailure } from './task-failure.ts';

describe('classifyAgentFailure', () => {
  test('the failure that started all this: a billing refusal says it is billing', () => {
    // Verbatim shape of what today's log carried three times before the very
    // next line said the task had completed.
    const f = classifyAgentFailure(
      'Sub-agent error: 429 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"Your credit balance is too low to access the API"}} credit_balance_exhausted',
    );
    expect(f.kind).toBe('billing');
    expect(f.says).toContain('billing');
  });

  test('billing wins over the 429 it also is', () => {
    expect(classifyAgentFailure('429 insufficient_quota: exceeded your current quota').kind).toBe('billing');
  });

  test('a plain 429 with no money in it is a rate limit', () => {
    expect(classifyAgentFailure('HTTP 429 Too Many Requests').kind).toBe('rate_limit');
  });

  test('a bad key is auth, not billing', () => {
    expect(classifyAgentFailure('401 invalid_api_key').kind).toBe('auth');
  });

  test('the provider falling over on its own is provider', () => {
    expect(classifyAgentFailure('503 service unavailable').kind).toBe('provider');
  });

  test('not reaching it at all is network', () => {
    expect(classifyAgentFailure('fetch failed: ECONNREFUSED 127.0.0.1:11434').kind).toBe('network');
  });

  test('an unrecognisable message is still a failure and still says something true', () => {
    const f = classifyAgentFailure('the wheels came off');
    expect(f.kind).toBe('unknown');
    expect(f.says.length).toBeGreaterThan(20);
    expect(f.detail).toBe('the wheels came off');
  });

  test('an Error, a string and a plain object all classify the same', () => {
    const msg = 'credit_balance_exhausted';
    expect(classifyAgentFailure(new Error(msg)).kind).toBe('billing');
    expect(classifyAgentFailure(msg).kind).toBe('billing');
    expect(classifyAgentFailure({ message: msg }).kind).toBe('billing');
  });

  test('the raw detail is kept whole even when the sentence is short', () => {
    const raw = 'Sub-agent error: 402 payment_required from the gateway at 14:02:11';
    expect(classifyAgentFailure(raw).detail).toBe(raw);
  });

  test('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 0, [], {}, Symbol('x')]) {
      expect(() => classifyAgentFailure(junk)).not.toThrow();
    }
  });

  test('no sentence a founder sees hands them a job', () => {
    const messages = [
      'credit_balance_exhausted', '401 invalid_api_key', '429 rate limit', 'timed out',
      'ECONNREFUSED', '503 overloaded', 'cannot read property of undefined', 'nothing recognisable',
    ];
    for (const m of messages) {
      const says = classifyAgentFailure(m).says.toLowerCase();
      for (const imperative of ['you should', 'you can', 'please ', 'try again', 'check your', 'top up', 'in the meantime']) {
        expect(says).not.toContain(imperative);
      }
    }
  });

  test('and no sentence contains an em dash', () => {
    for (const m of ['credit_balance_exhausted', '401', '429', 'timed out', 'ECONNREFUSED', '503', 'tool threw', 'x']) {
      expect(classifyAgentFailure(m).says).not.toContain('—');
    }
  });

  test('infrastructure failures are the ones that say nothing about the question', () => {
    expect(isInfrastructureFailure('billing')).toBe(true);
    expect(isInfrastructureFailure('auth')).toBe(true);
    expect(isInfrastructureFailure('network')).toBe(true);
    expect(isInfrastructureFailure('tooling')).toBe(false);
    expect(isInfrastructureFailure('unknown')).toBe(false);
  });
});
