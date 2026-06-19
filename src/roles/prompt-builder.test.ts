import { describe, expect, test } from 'bun:test';
import { buildSystemPromptParts, buildSystemPrompt } from './prompt-builder.ts';
import type { RoleDefinition } from './types.ts';

const ROLE: RoleDefinition = {
  id: 'test-assistant',
  name: 'Test Assistant',
  description: 'A role used for prompt-builder tests.',
  responsibilities: ['Answer questions'],
  tools: ['browser', 'file-ops'],
  authority_level: 5,
};

describe('buildSystemPromptParts — cache split', () => {
  test('stable half holds role/tools, volatile half holds time + activity', () => {
    const { stable, volatile } = buildSystemPromptParts(ROLE, {
      userName: 'Ada',
      currentTime: '2026-06-19T19:27:47.342Z',
      recentObservations: ['[9:27:47 PM] file_change: {"path":"/x"}'],
      activeCommitments: ['[normal] Pay rent — pending'],
    });

    // Stable: identity, tools, user — the byte-identical prefix.
    expect(stable).toContain('# Identity');
    expect(stable).toContain('You are Test Assistant');
    expect(stable).toContain('User: Ada');

    // Volatile: everything that churns turn-to-turn must NOT be in stable.
    expect(stable).not.toContain('2026-06-19T19:27:47');
    expect(stable).not.toContain('Recent Activity');
    expect(stable).not.toContain('Pay rent');

    expect(volatile).toContain('Time: 2026-06-19T19:27:47.342Z');
    expect(volatile).toContain('Recent Activity');
    expect(volatile).toContain('Pay rent');
  });

  test('volatile is empty when no churny context is present', () => {
    const { volatile } = buildSystemPromptParts(ROLE, { userName: 'Ada' });
    expect(volatile).toBe('');
  });

  test('buildSystemPrompt joins both halves with stable first', () => {
    const joined = buildSystemPrompt(ROLE, {
      userName: 'Ada',
      currentTime: '2026-06-19T19:27:47.342Z',
    });
    expect(joined.indexOf('# Identity')).toBeLessThan(joined.indexOf('Time:'));
  });
});
