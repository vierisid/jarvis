import { afterEach, beforeEach, test, expect, describe } from 'bun:test';
import type { AppController, UIElement, WindowInfo } from '../app-control/interface.ts';
import { setNoLocalTools } from './local-tools-guard.ts';
import { isUntrustedSourceTool } from '../../roles/untrusted.ts';
import { guardImageSize } from '../../llm/provider.ts';
import { encodePng, noiseRgbRows } from '../app-control/fixtures/png.ts';
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

  test('#629: every desktop tool is framed, by exactly one of the two mechanisms', () => {
    // With a `target` all nine dispatch through `routeToSidecarAction`, whose
    // throws carry the reply a remote machine sent. So each one needs either a
    // place in `UNTRUSTED_TOOL_NAMES` (whole result framed, for the ones whose
    // SUCCESS reply carries a field the target machine wrote) or a
    // `failureIsOutsideContent` declaration (failure text only). Exactly one:
    // declaring the flag on a name-framed tool would be redundant, and having
    // neither is the gap #629 reported.
    const byName = new Map(DESKTOP_TOOLS.map((t) => [t.name, t]));
    const expected: Record<string, 'name' | 'declaration'> = {
      desktop_snapshot: 'name',
      desktop_find_element: 'name',
      desktop_list_windows: 'name',
      desktop_click: 'name',
      desktop_launch_app: 'name',
      desktop_focus_window: 'name',
      desktop_type: 'declaration',
      desktop_press_keys: 'declaration',
      desktop_screenshot: 'declaration',
    };
    expect(Object.keys(expected).sort()).toEqual(DESKTOP_TOOLS.map((t) => t.name).sort());
    for (const [name, how] of Object.entries(expected)) {
      const tool = byName.get(name)!;
      const framedByName = isUntrustedSourceTool(tool.name, tool.category);
      const declared = tool.failureIsOutsideContent === true;
      expect(`${name}:name=${framedByName}`).toBe(`${name}:name=${how === 'name'}`);
      expect(`${name}:declared=${declared}`).toBe(`${name}:declared=${how === 'declaration'}`);
    }
  });

  test('desktop_list_windows uses the local controller', async () => {
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_list_windows');
    const result = await tool!.execute({});
    expect(String(result)).toContain('PID 42');
    expect(String(result)).toContain('Calculator');
  });

  test('desktop_type reports typing nothing as typing nothing', async () => {
    // `Typed "".` reads like a keystroke landed. Empty text is a no-op on the
    // local path (typeText in app-control/linux.ts), so the model is told that
    // rather than being told it typed an empty string (#554).
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_type');

    expect(await tool!.execute({ text: '' })).toBe('Nothing to type: the text was empty.');
    // Ordinary text is unchanged.
    expect(await tool!.execute({ text: 'hello' })).toBe('Typed "hello".');
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
    await expect(clickTool!.execute({ element_id: 7, action: 'double_click' })).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_ACTION_UNSUPPORTED', effect: 'not_started' },
    });
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

  // #711: a raw PNG of a large or high-DPI display passes guardImageSize's
  // 5 MB cap, and the orchestrator then swaps the picture for a placeholder.
  // The local branch now compacts it with the routed fallback's values.
  test('an over-cap local capture is compacted to fit instead of becoming a placeholder', async () => {
    const png = encodePng(2000, 1000, 2, 8, noiseRgbRows(2000, 1000));
    const raw = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: png.toString('base64') } };
    // Measured, not assumed: this capture as it stands would not reach the model.
    expect(guardImageSize(raw).type).toBe('text');
    __setLocalDesktopControllerFactoryForTests(() => ({ ...createFakeController(), captureScreen: async () => png }));
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_screenshot')!;
    const result = await tool.execute({}) as { content: Array<{ type: string; text?: string; source?: { media_type: string; data: string } }> };
    expect(result.content[0]).toEqual({ type: 'text', text: 'Desktop screenshot captured (1600x800, downscaled from 2000x1000 to fit).' });
    const image = result.content[1]!;
    expect(image.source!.media_type).toBe('image/jpeg');
    expect(guardImageSize(image as never).type).toBe('image');
  });

  test('a local capture that cannot be made to fit is a typed failure, not a placeholder', async () => {
    const huge = Buffer.alloc(4 * 1024 * 1024, 7); // not a PNG, and over the cap once encoded
    __setLocalDesktopControllerFactoryForTests(() => ({ ...createFakeController(), captureScreen: async () => huge }));
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_screenshot')!;
    await expect(tool.execute({})).rejects.toMatchObject({
      outcome: { status: 'error', code: 'LOCAL_IMAGE_TOO_LARGE', effect: 'not_started' },
    });
  });

  test('respects --no-local-tools for desktop tools', async () => {
    setNoLocalTools(true);
    const tool = DESKTOP_TOOLS.find((entry) => entry.name === 'desktop_list_windows');
    await expect(tool!.execute({})).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'LOCAL_TOOLS_DISABLED', effect: 'not_started' },
    });
  });
});
