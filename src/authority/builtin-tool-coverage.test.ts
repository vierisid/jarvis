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
import { REVIEWED_UI_TOOLS } from './ui-intent.ts';
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
      'desktop_launch_app', 'desktop_focus_window', 'browser_click', 'browser_type', 'run_command',
      'run_skill', 'record_skill'];
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

/**
 * The same drift, one layer up. `REVIEWED_UI_TOOLS` (src/authority/ui-intent.ts)
 * is what makes a raw browser/desktop/structural mutation carry control_app and
 * a mandatory card; a tool missing from it keeps its static category and runs
 * with no review, which is the ungated state this boundary exists to end. The
 * set is matched by tool NAME, so a rename or a newly registered mutation is
 * silent: nothing throws, the tool simply stops being reviewed. These tests
 * force every tool in the three acting categories to be classified explicitly.
 */
describe('mandatory UI review coverage', () => {
  const UI_CATEGORIES: ReadonlySet<string> = new Set(['browser', 'desktop', 'ui']);

  /**
   * Observations. Note that browser_snapshot and browser_screenshot map to
   * access_browser rather than read_data, so "not a read_data entry" cannot
   * separate reads from mutations here -- they have to be named.
   */
  const UI_CATEGORY_READS: ReadonlySet<string> = new Set([
    'browser_snapshot', 'browser_screenshot',
    'desktop_list_windows', 'desktop_snapshot', 'desktop_screenshot', 'desktop_find_element',
    'ui_snapshot', 'manage_skills',
  ]);

  /** Replay/record a stored sequence; classified per call by their own authorityGate. */
  const PER_CALL_GATED: ReadonlySet<string> = new Set(['run_skill', 'record_skill']);

  test('every browser, desktop and structural builtin is explicitly classified', () => {
    const unclassified = BUILTIN_TOOLS
      .filter((t) => UI_CATEGORIES.has(t.category))
      .filter((t) => !REVIEWED_UI_TOOLS.has(t.name) && !UI_CATEGORY_READS.has(t.name) && !PER_CALL_GATED.has(t.name))
      .map((t) => `${t.name} (category "${t.category}")`);
    expect(unclassified).toEqual([]);
  });

  test('a reviewed name is never classified as a read as well', () => {
    expect([...REVIEWED_UI_TOOLS].filter((name) => UI_CATEGORY_READS.has(name))).toEqual([]);
  });

  test('every reviewed name is a builtin that still exists', () => {
    const names = new Set(BUILTIN_TOOLS.map((t) => t.name));
    expect([...REVIEWED_UI_TOOLS].filter((name) => !names.has(name))).toEqual([]);
  });
});
