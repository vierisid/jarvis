/**
 * Every builtin tool must carry an EXPLICIT Authority action.
 *
 * `getActionForTool` falls back to the tool's category and then to
 * `read_data`. That default is how a tool can ship gated at level 1 while
 * clicking buttons on the user's machine: give it a category no map knows
 * (`ui_act` shipped as `category: 'ui'`), and it silently resolves to
 * `read_data` - below the level check, outside the background-agent and
 * taint-gating profiles that govern `control_app`, and invisible to the
 * realtime blocked-categories list. Nothing failed; it just was not gated.
 *
 * `bounded-tools.test.ts` guards the workflow effect boundary, but only
 * across two hand-maintained sets, so a tool in neither slips past it. This
 * test walks BUILTIN_TOOLS itself: if you register a tool, name its action in
 * TOOL_ACTION_MAP.
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import { TOOL_ACTION_MAP, getActionForTool } from './tool-action-map.ts';
import { AUTHORITY_REQUIREMENTS } from '../roles/authority.ts';

describe('builtin tool Authority coverage', () => {
  test('every builtin tool has an explicit TOOL_ACTION_MAP entry', () => {
    const unmapped = BUILTIN_TOOLS.filter((t) => !TOOL_ACTION_MAP[t.name]).map((t) => `${t.name} (category "${t.category}")`);
    expect(unmapped).toEqual([]);
  });

  test('every mapped action is a real Authority category', () => {
    for (const tool of BUILTIN_TOOLS) {
      const action = TOOL_ACTION_MAP[tool.name]!;
      expect(Object.hasOwn(AUTHORITY_REQUIREMENTS, action)).toBe(true);
    }
  });

  test('a tool that acts on the desktop or browser is never gated as a read', () => {
    // Tools whose effect reaches outside the daemon must clear more than
    // level 1. This is the property `ui_act` violated.
    const actors = ['ui_act', 'desktop_click', 'desktop_type', 'desktop_press_keys',
      'desktop_launch_app', 'desktop_focus_window', 'browser_click', 'browser_type', 'run_command'];
    for (const name of actors) {
      const tool = BUILTIN_TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const action = getActionForTool(name, tool!.category);
      expect(action).not.toBe('read_data');
      expect(AUTHORITY_REQUIREMENTS[action]).toBeGreaterThanOrEqual(5);
    }
  });

  test('ui_act carries the same action as the desktop click it dispatches', () => {
    expect(TOOL_ACTION_MAP['ui_act']).toBe('control_app');
    expect(TOOL_ACTION_MAP['ui_act']).toBe(TOOL_ACTION_MAP['desktop_click']);
    expect(TOOL_ACTION_MAP['ui_snapshot']).toBe('read_data');
  });
});
