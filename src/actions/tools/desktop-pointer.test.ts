import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SidecarManager } from '../../sidecar/manager.ts';
import { desktopPointerTool, desktopTypeTool, pictureFraction, pointerRequest } from './desktop.ts';
import {
  forgetScreenPictures, getSidecarManager, lastScreenPicture, rememberScreenPicture, setSidecarManagerRef,
  SCREEN_PICTURE_MAX_AGE_MS,
} from './sidecar-route.ts';

const prior = getSidecarManager();
afterAll(() => setSidecarManagerRef(prior as unknown as SidecarManager));
beforeEach(() => forgetScreenPictures());

type Call = { method: string; params: Record<string, unknown> };

function manager(calls: Call[], connected = true): SidecarManager {
  return {
    listSidecars: () => [{
      id: 'sc-pc', name: 'Desk PC', connected, os: 'windows', platform: 'amd64', status: 'enrolled',
      enrolled_at: '2026-01-01', last_seen_at: '2026-01-02', hostname: 'desk',
      capabilities: ['desktop', 'screenshot'], unavailable_capabilities: [],
    }],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { success: true, action: params.action, screen_x: 1281, screen_y: 721, window_pid: 4242 };
    },
  } as unknown as SidecarManager;
}

describe('a place read off a picture of the screen', () => {
  test('is given in thousandths of the picture, so shrinking the picture does not move it', () => {
    expect(pictureFraction(0)).toBe(0);
    expect(pictureFraction(500)).toBe(0.5);
    expect(pictureFraction(1000)).toBe(1);
    expect(pictureFraction(333.5)).toBeCloseTo(0.3335, 9);
    for (const outside of [-1, 1000.5, 5000, Number.NaN, Number.POSITIVE_INFINITY, '500', null, undefined]) {
      expect(pictureFraction(outside)).toBeNull();
    }
  });

  test('a click, a drag and a scroll are sent as fractions, with only what each needs', () => {
    expect(pointerRequest({ x: 500, y: 250 }, true)).toEqual({ action: 'click', fx: 0.5, fy: 0.25 });
    expect(pointerRequest({ x: 0, y: 0, action: 'drag', to_x: 1000, to_y: 900 }, true))
      .toEqual({ action: 'drag', fx: 0, fy: 0, to_fx: 1, to_fy: 0.9 });
    expect(pointerRequest({ x: 10, y: 10, action: 'scroll_down' }, true)).toMatchObject({ action: 'scroll_down', amount: 3 });
    expect(pointerRequest({ x: 10, y: 10, action: 'scroll_up', amount: 12 }, true)).toMatchObject({ amount: 12 });
  });

  test('what cannot be placed is said, with how a place is given', () => {
    expect(pointerRequest({ x: 500, y: 500 }, false)).toContain('Take a desktop_screenshot');
    // Pixels of a large picture are not a place: the model is told the scale.
    expect(pointerRequest({ x: 1280, y: 720 }, true)).toContain('0 to 1000');
    expect(pointerRequest({ x: 500, y: 500, action: 'drag' }, true)).toContain('to_x and to_y');
    expect(pointerRequest({ x: 500, y: 500, action: 'drag', to_x: 500, to_y: 1200 }, true)).toContain('to_x and to_y');
    expect(pointerRequest({ x: 500, y: 500, action: 'scroll_up', amount: 0 }, true)).toContain('1 to 30');
    expect(pointerRequest({ x: 500, y: 500, action: 'scroll_up', amount: 2.5 }, true)).toContain('1 to 30');
    for (const said of [pointerRequest({ x: 500, y: 500 }, false), pointerRequest({ x: -4, y: 2 }, true)]) {
      expect((said as string).toLowerCase()).toContain('nothing was done');
    }
  });
});

describe('desktop_pointer', () => {
  test('with no picture of that screen it refuses before anything is sent', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls));
    await expect(desktopPointerTool.execute({ x: 640, y: 360 })).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_POINTER_PLACE', effect: 'not_started' },
    });
    expect(calls).toEqual([]);
  });

  test('after a picture it sends the place as a fraction of the screen, to the same machine', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls));
    // Whatever size the picture was, or was shrunk to on its way to the model.
    rememberScreenPicture('Desk PC', 1280, 720);
    const out = await desktopPointerTool.execute({ x: 500, y: 250, action: 'double_click' }) as string;
    expect(calls).toEqual([{ method: 'pointer_action', params: { action: 'double_click', fx: 0.5, fy: 0.25 } }]);
    expect(JSON.parse(out)).toMatchObject({ success: true, window_pid: 4242 });
  });

  test('a place outside the picture is refused before anything is sent', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls));
    rememberScreenPicture('sc-pc', 1280, 720);
    await expect(desktopPointerTool.execute({ x: 1280, y: 10 })).rejects.toMatchObject({
      outcome: { code: 'DESKTOP_POINTER_PLACE', effect: 'not_started' },
    });
    expect(calls).toEqual([]);
  });

  test('how a line break is to be typed reaches the machine that types', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls));
    await desktopTypeTool.execute({ text: 'first\nsecond', line_break: 'shift_enter' });
    expect(calls).toEqual([{ method: 'type_text', params: { text: 'first\nsecond', line_break: 'shift_enter' } }]);
  });

  test('a machine that is offline is said to be offline, not to lack a picture', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls, false));
    await expect(desktopPointerTool.execute({ x: 1, y: 1, target: 'sc-pc' })).rejects.toMatchObject({
      outcome: { code: 'SIDECAR_OFFLINE', effect: 'not_started' },
    });
    expect(calls).toEqual([]);
  });

  test('a picture is good for a few minutes, by the machine it is of, under any of its names', () => {
    setSidecarManagerRef(manager([]));
    rememberScreenPicture('Desk PC', 1280, 720, 1_000);
    expect(lastScreenPicture('sc-pc', 1_000 + SCREEN_PICTURE_MAX_AGE_MS)).toEqual({ width: 1280, height: 720 });
    expect(lastScreenPicture('sc-pc', 1_001 + SCREEN_PICTURE_MAX_AGE_MS)).toBeNull();
    expect(lastScreenPicture('another-pc', 1_000)).toBeNull();
    // A size that is not a size is not remembered.
    rememberScreenPicture('sc-pc', 0, 720, 2_000);
    expect(lastScreenPicture('sc-pc', 2_000)).toEqual({ width: 1280, height: 720 });
  });
});
