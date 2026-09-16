/**
 * The workflow effect boundary classifies a tool through the daemon's
 * `TOOL_ACTION_MAP`. These tests fail if the bounded-tool allowlist and that
 * map drift apart, or if an unclassified tool starts inheriting the permissive
 * `read_data` default that `getActionForTool` hands the agent path.
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import type { ToolDefinition } from '../../actions/tools/registry';
import { BOUNDED_TOOL_NAMES, OPAQUE_TOOL_NAMES, refusedEffectCategory, toolEffectCapability } from './effect-capabilities';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: 'synthetic', category: 'general', parameters: {}, execute: async () => null, ...extra,
});

describe('bounded tool classification', () => {
  test('every bounded tool resolves to a real Authority action in TOOL_ACTION_MAP', () => {
    const missing = [...BOUNDED_TOOL_NAMES].filter(name => !TOOL_ACTION_MAP[name]);
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
