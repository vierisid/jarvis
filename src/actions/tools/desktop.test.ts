import { test, expect, describe } from 'bun:test';
import { DESKTOP_TOOLS } from './desktop.ts';

describe('DESKTOP_TOOLS', () => {
  test('contains 9 desktop tools', () => {
    expect(DESKTOP_TOOLS).toHaveLength(9);
  });

  test('all have desktop category', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.category).toBe('desktop');
    }
  });

  test('tool names match expected desktop tools', () => {
    const names = DESKTOP_TOOLS.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'desktop_click',
      'desktop_find_element',
      'desktop_focus_window',
      'desktop_launch_app',
      'desktop_list_windows',
      'desktop_press_keys',
      'desktop_screenshot',
      'desktop_snapshot',
      'desktop_type',
    ]);
  });

  test('all tools have execute functions', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  test('all tools have descriptions', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test('all tools have target parameter', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.parameters.target).toBeDefined();
      expect(tool.parameters.target!.type).toBe('string');
    }
  });

  test('returns not-implemented error without target (local execution stub)', async () => {
    for (const tool of DESKTOP_TOOLS) {
      const result = await tool.execute({});
      expect(String(result)).toContain('not yet implemented');
    }
  });
});
