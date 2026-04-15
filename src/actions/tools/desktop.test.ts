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
  clickedActions: string[];
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
  const clickedActions: string[] = [];
  return {
    launches,
    clickedActions,
    async getActiveWindow() {
      return createFakeWindow();
    },
    async getWindowTree() {
      return [createFakeElement()];
    },
    async listWindows() {
      return [createFakeWindow()];
    },
    async clickElement(element) {
      clickedActions.push(String(element.properties.action ?? 'click'));
    },
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

function createSnapshotController() {
  const clickedIds: number[] = [];
  let lastDepth: number | undefined;

  return {
    clickedIds,
    lastDepth: () => lastDepth,
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
    async snapshot(_pid?: number, depth?: number) {
      lastDepth = depth;
      return {
        window: { pid: 42, title: 'Calculator', className: 'calc' },
        elements: [
          {
            id: 7,
            role: 'button',
            name: 'Equals',
            value: null,
            depth: 1,
            properties: {
              className: 'calc-button',
              automationId: 'equals-button',
            },
          },
        ],
        totalElements: 1,
      };
    },
    async clickById(elementId: number) {
      clickedIds.push(elementId);
      return `Clicked ${elementId}`;
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

  test('desktop_click supports local action variants on tree-based controllers', async () => {
    const controller = createFakeController();
    __setLocalDesktopControllerFactoryForTests(() => controller);
    const snapshotTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_snapshot');
    const clickTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_click');

    await snapshotTool!.execute({});
    await clickTool!.execute({ element_id: 1, action: 'double_click' });
    await clickTool!.execute({ element_id: 1, action: 'right_click' });
    await clickTool!.execute({ element_id: 1, action: 'focus' });

    expect(controller.clickedActions).toEqual(['double_click', 'right_click', 'focus']);
  });

  test('desktop_click returns unsupported actions for snapshot-based controllers', async () => {
    const controller = createSnapshotController();
    __setLocalDesktopControllerFactoryForTests(() => controller);
    const snapshotTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_snapshot');
    const clickTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_click');

    await snapshotTool!.execute({});
    const result = await clickTool!.execute({ element_id: 7, action: 'double_click' });

    expect(result).toBe('Error: Local desktop action "double_click" is not supported by this platform controller.');
    expect(controller.clickedIds).toEqual([]);
  });

  test('desktop_snapshot honors depth and omits unknown bounds for snapshot controllers', async () => {
    const controller = createSnapshotController();
    __setLocalDesktopControllerFactoryForTests(() => controller);
    const snapshotTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_snapshot');

    const result = await snapshotTool!.execute({ depth: 3 });

    expect(controller.lastDepth()).toBe(3);
    expect(String(result)).toContain('[7] button "Equals" class="calc-button"');
    expect(String(result)).not.toContain('bounds=');
  });

  test('desktop_find_element matches snapshot controller properties', async () => {
    const controller = createSnapshotController();
    __setLocalDesktopControllerFactoryForTests(() => controller);
    const findTool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_find_element');

    const result = await findTool!.execute({
      automation_id: 'equals-button',
      class_name: 'calc-button',
    });

    expect(result).toBe('[7] button "Equals"');
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
