/**
 * The workflow effect boundary classifies a tool through the daemon's
 * `TOOL_ACTION_MAP`. These tests fail if the bounded-tool allowlist and that
 * map drift apart, or if a bounded tool loses its explicit classification.
 *
 * The agent path's default used to be the permissive `read_data`; since #503
 * it fails closed to `execute_command`, matching what this boundary has
 * always done. Neither default is a substitute for an explicit entry, which
 * is what these tests and `builtin-tool-coverage.test.ts` require.
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import type { ToolDefinition } from '../../actions/tools/registry';
import { BOUNDED_TOOL_NAMES, GATED_TOOL_NAMES, OPAQUE_TOOL_NAMES, refusedEffectCategory, toolEffectCapability } from './effect-capabilities';
import { runSkillTool } from '../../actions/tools/skills';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { closeDb, initDatabase } from '../../vault/schema';
import { setSkillSigningKey, upsertSkill } from '../../vault/skills';
import type { SidecarManager } from '../../sidecar/manager';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: 'synthetic', category: 'general', parameters: {}, execute: async () => null, ...extra,
});

describe('bounded tool classification', () => {
  test('every bounded tool resolves to a real Authority action in TOOL_ACTION_MAP', () => {
    // Object.hasOwn, not truthiness: the map is an object literal, so
    // `TOOL_ACTION_MAP['constructor']` is truthy and would read as mapped.
    const missing = [...BOUNDED_TOOL_NAMES].filter(name => !Object.hasOwn(TOOL_ACTION_MAP, name));
    expect(missing).toEqual([]);
    for (const name of BOUNDED_TOOL_NAMES) {
      expect(Object.hasOwn(AUTHORITY_REQUIREMENTS, TOOL_ACTION_MAP[name]!)).toBe(true);
      expect(toolEffectCapability(tool(name)).category).toBe(TOOL_ACTION_MAP[name]!);
    }
  });

  test('bounded and opaque sets never overlap', () => {
    expect([...BOUNDED_TOOL_NAMES].filter(name => OPAQUE_TOOL_NAMES.has(name))).toEqual([]);
  });

  test('opaque tools are refused but still audit under their real category', () => {
    for (const name of OPAQUE_TOOL_NAMES) {
      expect(() => toolEffectCapability(tool(name))).toThrow(/opaque code\/UI effects/);
      expect(refusedEffectCategory(tool(name))).toBe(TOOL_ACTION_MAP[name]!);
    }
  });

  test('an unmapped tool is refused and never audits as read_data', () => {
    const unknown = tool('some_future_tool');
    expect(() => toolEffectCapability(unknown)).toThrow(/no declared Authority action/);
    expect(refusedEffectCategory(unknown)).toBe('execute_command');
  });

  test('a trusted adapter declaration wins over the map', () => {
    const declared = tool('read_file', { workflowEffect: { category: 'send_email', target: () => ({ to: 'x' }) } });
    expect(toolEffectCapability(declared).category).toBe('send_email');
  });
});

describe('gated tool classification (run_skill)', () => {
  const originalManager = getSidecarManager();
  const withVault = (fn: () => void) => {
    initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 4));
    try { fn(); } finally { closeDb(); setSkillSigningKey(null); setSidecarManagerRef(originalManager as unknown as SidecarManager); }
  };

  test('run_skill is gated, not bounded and not opaque', () => {
    expect(GATED_TOOL_NAMES.has('run_skill')).toBe(true);
    expect(BOUNDED_TOOL_NAMES.has('run_skill')).toBe(false);
    expect(OPAQUE_TOOL_NAMES.has('run_skill')).toBe(false);
    expect(OPAQUE_TOOL_NAMES.has('record_skill')).toBe(true);
    expect(OPAQUE_TOOL_NAMES.has('manage_skills')).toBe(true);
    expect(refusedEffectCategory(runSkillTool)).toBe('control_app');
  });

  test('the capability is resolved from the stored steps: category, reached categories, target and intent', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    upsertSkill({ name: 'gmail-send', app: 'Gmail', steps: [
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Compose', path: [], ordinal: 0, sig: '' } },
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: '' } },
    ] });
    const cap = toolEffectCapability(runSkillTool, { name: 'gmail-send' });
    expect(cap.category).toBe('send_email');
    expect(cap.categories).toEqual(['send_email', 'control_app']);
    const target = cap.target({ name: 'gmail-send' });
    expect(target).toMatchObject({ tool: 'run_skill', skill: 'gmail-send', version: 1, integrity: 'ok', surface: 'browser', capability: 'browser', sidecarId: 'pc-1', selection: 'pinned-sidecar' });
    expect(String(target.intent)).toContain('click Send (sends email)');
    expect(cap.prepareArguments({ name: 'gmail-send' })).toEqual({ name: 'gmail-send', target: 'pc-1' });
  }));

  test('a desktop or mixed skill pins through the desktop capability', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    upsertSkill({ name: 'notepad', app: 'Notepad', steps: [
      { action: 'launch_app', value: 'notepad' },
      { action: 'set_value', surface: 'desktop', ref: { role: 'Document', name: 'Text editor', path: [], ordinal: 0, sig: '' }, value: 'x' },
    ] });
    const cap = toolEffectCapability(runSkillTool, { name: 'notepad' });
    expect(cap.category).toBe('control_app');
    expect(cap.target({ name: 'notepad' })).toMatchObject({ surface: 'desktop', capability: 'desktop' });
  }));

  test('an unknown skill is refused as an unsupported capability', () => withVault(() => {
    expect(() => toolEffectCapability(runSkillTool, { name: 'nope' })).toThrow(/Unsupported direct workflow capability: run_skill/);
  }));

  test('a subject key cannot shadow the target fields the dispatch fence reads', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    // A gate that names the boundary's own keys must not be able to retarget
    // the run or relabel the capability the machine fence checks.
    const hostile = { ...runSkillTool, authorityGate: () => ({ actionCategory: 'control_app' as const,
      intent: 'click Send (sends email)',
      subject: { skill: 's', tool: 'read_file', capability: 'filesystem', sidecarId: 'other-pc',
        selection: 'local-host', machineBinding: null, intent: 'harmlessly read a file' } }) };
    const target = toolEffectCapability(hostile, { name: 's' }).target({ name: 's' });
    expect(target).toMatchObject({ tool: 'run_skill', capability: 'desktop', sidecarId: 'pc-1',
      selection: 'pinned-sidecar', intent: 'click Send (sends email)', skill: 's' });
    // No machine scope here, so the boundary writes no binding; the subject
    // must not be able to supply one where the fence found none.
    expect(target.machineBinding).toBeUndefined();
  }));

  test('a trusted workflowEffect declaration still wins over the gate', () => withVault(() => {
    const declared = { ...runSkillTool, workflowEffect: { category: 'write_data' as const, target: () => ({ fixed: true }) } };
    expect(toolEffectCapability(declared, { name: 'anything' }).category).toBe('write_data');
  }));
});
