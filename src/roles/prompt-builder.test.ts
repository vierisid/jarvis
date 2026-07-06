import { describe, expect, it } from 'bun:test';
import { buildSystemPrompt, buildSystemPromptParts, type PromptContext } from './prompt-builder.ts';
import type { RoleDefinition } from './types.ts';

const role: RoleDefinition = {
  id: 'test-role',
  name: 'Test Assistant',
  description: 'A test role.',
  responsibilities: ['Answer questions', 'Run tasks'],
  tools: ['calendar', 'browser'],
  authority_level: 5,
};

function makeContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    userName: 'Alice',
    currentTime: new Date().toISOString(),
    recentObservations: ['User opened the dashboard'],
    activeGoals: 'Ship v1 (0.4)',
    knowledgeContext: 'Alice prefers dark mode.',
    ...overrides,
  };
}

describe('buildSystemPromptParts', () => {
  it('keeps the static part free of per-turn volatile content', () => {
    const parts = buildSystemPromptParts(role, makeContext());
    expect(parts.static).toContain('# Identity');
    expect(parts.static).toContain('Test Assistant');
    expect(parts.static).toContain('# Intent Gating');
    expect(parts.static).not.toContain('Time:');
    expect(parts.static).not.toContain('# Current Context');
    expect(parts.static).not.toContain('User opened the dashboard');
  });

  it('puts all volatile context in the dynamic part', () => {
    const context = makeContext();
    const parts = buildSystemPromptParts(role, context);
    expect(parts.dynamic).toContain('# Current Context');
    expect(parts.dynamic).toContain(`Time: ${context.currentTime}`);
    expect(parts.dynamic).toContain('User opened the dashboard');
    expect(parts.dynamic).toContain('Ship v1 (0.4)');
  });

  it('static part is byte-identical across calls with different volatile context', () => {
    const a = buildSystemPromptParts(role, makeContext({ currentTime: '2026-07-06T10:00:00Z' }));
    const b = buildSystemPromptParts(role, makeContext({
      currentTime: '2026-07-06T10:05:00Z',
      recentObservations: ['Something completely different happened'],
    }));
    expect(a.static).toBe(b.static);
    expect(a.dynamic).not.toBe(b.dynamic);
  });

  it('legacy buildSystemPrompt equals the joined parts', () => {
    const context = makeContext();
    const parts = buildSystemPromptParts(role, context);
    const legacy = buildSystemPrompt(role, context);
    expect(legacy).toBe(`${parts.static}\n${parts.dynamic}`);
  });

  it('legacy buildSystemPrompt without context has no dynamic tail', () => {
    const parts = buildSystemPromptParts(role, undefined);
    expect(parts.dynamic).toBe('');
    expect(buildSystemPrompt(role, undefined)).toBe(parts.static);
  });
});
