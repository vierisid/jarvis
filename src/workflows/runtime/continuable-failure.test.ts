/** "Continue on failure" never goes past a refusal a Jarvis step heard from inside its run (#1338). */
import { expect, test } from 'bun:test';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { continuableFailure } from './piece-effect-guard';

const outcome = (status: 'blocked' | 'error' | 'unknown', code: string) =>
  new ActionOutcomeError({ status, code, message: code, effect: status === 'blocked' ? 'not_started' : 'may_have_occurred' } as never);

test('a Jarvis step is continued past only on a typed outcome that ran and failed', () => {
  for (const piece of ['@jarvispieces/piece-jarvis-tool', '@jarvispieces/piece-jarvis-input', '@activepieces/piece-approval']) {
    expect(continuableFailure(piece, outcome('blocked', 'APPROVAL_DENIED'))).toBe(false);
    expect(continuableFailure(piece, outcome('blocked', 'EMERGENCY_STOPPED'))).toBe(false);
    expect(continuableFailure(piece, new Error('Human request rejected'))).toBe(false);
    expect(continuableFailure(piece, undefined)).toBe(false);
    expect(continuableFailure(piece, outcome('error', 'PROVIDER_ERROR'))).toBe(true);
    expect(continuableFailure(piece, outcome('unknown', 'DISPATCH_UNCERTAIN'))).toBe(true);
  }
});

test('any other step failing after dispatch is its own failure', () => {
  for (const piece of ['@activepieces/piece-http', '@activepieces/piece-math-helper', '@jarvis/code-step', 'community-piece']) {
    expect(continuableFailure(piece, new Error('boom'))).toBe(true);
  }
});
