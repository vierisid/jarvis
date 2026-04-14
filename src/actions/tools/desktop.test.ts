import { afterEach, beforeEach, test, expect, describe } from 'bun:test';
import type { AppController, UIElement, WindowInfo } from '../app-control/interface.ts';
import { setNoLocalTools } from './local-tools-guard.ts';
import {
  DESKTOP_TOOLS,
  __resetLocalDesktopStateForTests,
  __setLocalDesktopControllerFactoryForTests,
} from './desktop.ts';

type FakeController = AppController & {
  launches: Array<{ executable: string; args?: string }>;
};

function createFakeElement(): UIElement {
  return {
    id: 'root',
    role: 'window',
    name: 'Calculator',
    value: null,
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    children: [],
    properties: {
      pid: 42,
      className: 'calc',
    },
  };
}

function createFakeWindow(): WindowInfo {
  return {
    pid: 42,
    title: 'Calculator',
    className: 'calc',
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    focused: true,
  };
}

function createFakeController(): FakeController {
  const launches: Array<{ executable: string; args?: string }> = [];
  return {
    launches,
    async getActiveWindow() {
      return createFakeWindow();
    },
    async getWindowTree() {
      return [createFakeElement()];
    },
    async listWindows() {
      return [createFakeWindow()];
    },
    async clickElement() {},
    async typeText() {},
    async pressKeys() {},
    async captureScreen() {
      return Buffer.from('png-data');
    },
    async captureWindow() {
      return Buffer.from('png-data');
    },
    async focusWindow() {},
    async launchApp(executable: string, args?: string) {
      launches.push({ executable, args });
      return { pid: 9001, executable, args: args ?? '' };
    },
  };
}

describe('DESKTOP_TOOLS', () => {
  beforeEach(() => {
    setNoLocalTools(false);
    __resetLocalDesktopStateForTests();
    __setLocalDesktopControllerFactoryForTests(() => createFakeController());
  });

  afterEach(() => {
    setNoLocalTools(false);
    __setLocalDesktopControllerFactoryForTests(null);
  });

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

  test('desktop_list_windows uses the local controller', async () => {
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_list_windows');
    const result = await tool!.execute({});
    expect(String(result)).toContain('PID 42');
    expect(String(result)).toContain('Calculator');
  });

  test('desktop_snapshot caches local elements for follow-up actions', async () => {
    const snapshotTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_snapshot');
    const clickTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_click');

    const snapshot = await snapshotTool!.execute({});
    expect(String(snapshot)).toContain('[1] window');

    const clickResult = await clickTool!.execute({ element_id: 1 });
    expect(clickResult).toBe('Clicked element [1] with action "click".');
  });

  test('desktop_launch_app uses local launch support', async () => {
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_launch_app');
    const result = await tool!.execute({ executable: 'xcalc', args: '--help' });
    expect(String(result)).toContain('"executable": "xcalc"');
    expect(String(result)).toContain('"args": "--help"');
  });

  test('desktop_screenshot returns a tool result locally', async () => {
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_screenshot');
    const result = await tool!.execute({});
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Desktop screenshot captured.' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from('png-data').toString('base64'),
          },
        },
      ],
    });
  });

  test('respects --no-local-tools for desktop tools', async () => {
    setNoLocalTools(true);
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_list_windows');
    const result = await tool!.execute({});
    expect(String(result)).toContain('Local tool execution is disabled');
  });
});
