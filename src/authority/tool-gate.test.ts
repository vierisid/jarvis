import { describe, expect, test } from 'bun:test';
import { resolveToolGate, gateContext, stricterCategory, TOOL_ACTION_MAP } from './tool-action-map.ts';
import { approvalNeedsClick, approvalIntentFromContext } from './approval.ts';
import { AuthorityEngine, applyProfile } from './engine.ts';
import type { ToolDefinition } from '../actions/tools/registry.ts';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: 't', category: 'ui', parameters: {}, execute: async () => null, ...extra,
});

describe('resolveToolGate', () => {
  test('without a gate the static map decides', () => {
    const g = resolveToolGate(tool('run_skill'), 'run_skill', {});
    expect(g.actionCategory).toBe('control_app');
    expect(g.floorCategory).toBe('control_app');
    expect(g.intent).toBeUndefined();
  });

  test('a gate can raise a call above its floor, never lower it', () => {
    const up = resolveToolGate(tool('run_skill', { authorityGate: () => ({ actionCategory: 'send_email', intent: 'x' }) }), 'run_skill', {});
    expect(up.actionCategory).toBe('send_email');
    expect(up.floorCategory).toBe('control_app');
    const down = resolveToolGate(tool('run_skill', { authorityGate: () => ({ actionCategory: 'read_data', intent: 'x' }) }), 'run_skill', {});
    expect(down.actionCategory).toBe('control_app');
  });

  test('a null gate leaves the floor; a broken gate demands explicit review', () => {
    expect(resolveToolGate(tool('run_skill', { authorityGate: () => null }), 'run_skill', {}).actionCategory).toBe('control_app');
    const broken = resolveToolGate(tool('run_skill', { authorityGate: () => { throw new Error('boom'); } }), 'run_skill', {});
    expect(broken.actionCategory).toBe('control_app');
    expect(broken.intent).toContain('classifier failed');
    expect(broken.confirm).toBe('always');
  });

  test('a gate cannot name a category the engine does not know', () => {
    const g = resolveToolGate(tool('run_skill', { authorityGate: () => ({ actionCategory: 'nuke' as never, intent: 'x' }) }), 'run_skill', {});
    expect(g.actionCategory).toBe('control_app');
  });

  test('every skill tool has a static floor and none of them is a read that acts', () => {
    expect(TOOL_ACTION_MAP.run_skill).toBe('control_app');
    expect(TOOL_ACTION_MAP.record_skill).toBe('control_app');
    expect(TOOL_ACTION_MAP.manage_skills).toBe('read_data');
    expect(stricterCategory('read_data', 'delete_data')).toBe('delete_data');
  });
});

describe('gateContext and the approval helpers', () => {
  test('a gated call writes JSON the card and the voice gate can read', () => {
    const gate = resolveToolGate(tool('record_skill', { authorityGate: () => ({ actionCategory: 'control_app', intent: 'Start recording a skill', confirm: 'always' }) }), 'record_skill', { action: 'start' });
    const ctx = gateContext(gate, 'record_skill', { action: 'start' });
    expect(JSON.parse(ctx)).toEqual({ intent: 'Start recording a skill', confirm: 'always' });
    expect(approvalNeedsClick({ context: ctx })).toBe(true);
    expect(approvalIntentFromContext({ context: ctx })).toBe('Start recording a skill');
  });

  test('an above_level gate is not click-only', () => {
    const gate = resolveToolGate(tool('run_skill', { authorityGate: () => ({ actionCategory: 'send_email', intent: 'Run skill', confirm: 'above_level' }) }), 'run_skill', {});
    const ctx = gateContext(gate, 'run_skill', {});
    expect(approvalNeedsClick({ context: ctx })).toBe(false);
    expect(approvalIntentFromContext({ context: ctx })).toBe('Run skill');
  });

  test('an ungated call keeps the plain context and neither helper fires', () => {
    const ctx = gateContext(resolveToolGate(tool('read_file'), 'read_file', { path: '/tmp/a' }), 'read_file', { path: '/tmp/a' });
    expect(ctx.startsWith('Agent attempted: read_file(')).toBe(true);
    expect(approvalNeedsClick({ context: ctx })).toBe(false);
    expect(approvalIntentFromContext({ context: ctx })).toBeNull();
    expect(approvalNeedsClick({ context: '{not json' })).toBe(false);
    expect(approvalIntentFromContext({ context: '{"target":{"to":"x"}}' })).toBeNull();
  });
});

describe('deniedByLevel', () => {
  const engine = new AuthorityEngine({
    default_level: 1, governed_categories: [], overrides: [{ action: 'send_message', allowed: false }], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
  });
  const check = (actionCategory: 'send_email' | 'send_message' | 'read_data', level: number) => engine.checkAuthority({
    agentId: 'a', agentAuthorityLevel: level, agentRoleId: 'r', toolName: 't', toolCategory: 'ui', actionCategory, temporaryGrants: new Map(),
  });

  test('is set only for a pure level shortfall', () => {
    expect(check('send_email', 5).deniedByLevel).toBe(true);
    expect(check('send_email', 7).deniedByLevel).toBeUndefined();
    expect(check('send_message', 9).allowed).toBe(false);
    expect(check('send_message', 9).deniedByLevel).toBeUndefined();
  });

  test('a profile cap denial is not a level shortfall', () => {
    const capped = applyProfile(check('read_data', 9), { label: 'bg', level_cap: 0 });
    expect(capped.allowed).toBe(false);
    expect(capped.deniedByLevel).toBeUndefined();
  });
});
