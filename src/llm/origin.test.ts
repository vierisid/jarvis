import { describe, expect, test } from 'bun:test';
import { currentOrigin, originHeaders, runWithOrigin } from './origin.ts';

describe('LLM origin', () => {
  test('unset outside any entry point, so no header is sent', () => {
    expect(currentOrigin()).toBeUndefined();
    expect(originHeaders()).toEqual({});
  });

  test('survives awaits and un-awaited follow-ups started inside the run', async () => {
    let followUp: string | undefined;
    const pending: Promise<void>[] = [];
    await runWithOrigin('user', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentOrigin()).toBe('user');
      // Fire-and-forget, like a turn's post-reply extraction.
      pending.push(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          followUp = currentOrigin();
        })(),
      );
    });
    await Promise.all(pending);
    expect(followUp).toBe('user');
    expect(currentOrigin()).toBeUndefined();
  });

  test('a nested run overrides for its own subtree only', async () => {
    await runWithOrigin('user', async () => {
      await runWithOrigin('background', async () => {
        expect(originHeaders()).toEqual({ 'x-jarvis-origin': 'background' });
      });
      expect(currentOrigin()).toBe('user');
    });
  });

  test('a stream consumed inside the run sees the origin on every step', async () => {
    async function* stream() {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield currentOrigin();
      }
    }
    // Created OUTSIDE, consumed inside: what matters is who calls next().
    const gen = stream();
    const seen = await runWithOrigin('workflow', async () => {
      const out: Array<string | undefined> = [];
      for await (const origin of gen) out.push(origin);
      return out;
    });
    expect(seen).toEqual(['workflow', 'workflow', 'workflow']);
  });
});
