import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SidecarManager } from '../../sidecar/manager.ts';
import { desktopPointerTool, pictureFraction, pointerRequest } from './desktop.ts';
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
  test('is the middle of that pixel, as a fraction of the picture', () => {
    expect(pictureFraction(0, 1280)).toBeCloseTo(0.5 / 1280, 9);
    expect(pictureFraction(640, 1280)).toBeCloseTo(640.5 / 1280, 9);
    expect(pictureFraction(1279, 1280)).toBeLessThan(1);
    expect(pictureFraction(640.7, 1280)).toBeCloseTo(640.5 / 1280, 9);
    for (const outside of [-1, 1280, 5000, Number.NaN, Number.POSITIVE_INFINITY, '640', null, undefined]) {
      expect(pictureFraction(outside, 1280)).toBeNull();
    }
  });

  test('a click, a drag and a scroll are sent as fractions, with only what each needs', () => {
    const picture = { width: 1280, height: 720 };
    expect(pointerRequest({ x: 640, y: 360 }, picture)).toEqual({ action: 'click', fx: 640.5 / 1280, fy: 360.5 / 720 });
    expect(pointerRequest({ x: 0, y: 0, action: 'drag', to_x: 1279, to_y: 719 }, picture))
      .toEqual({ action: 'drag', fx: 0.5 / 1280, fy: 0.5 / 720, to_fx: 1279.5 / 1280, to_fy: 719.5 / 720 });
    expect(pointerRequest({ x: 10, y: 10, action: 'scroll_down' }, picture)).toMatchObject({ action: 'scroll_down', amount: 3 });
    expect(pointerRequest({ x: 10, y: 10, action: 'scroll_up', amount: 12 }, picture)).toMatchObject({ amount: 12 });
  });

  test('what cannot be placed is said, and names the picture it has to be a pixel of', () => {
    const picture = { width: 1280, height: 720 };
    expect(pointerRequest({ x: 640, y: 360 }, null)).toContain('Take a desktop_screenshot');
    expect(pointerRequest({ x: 2000, y: 360 }, picture)).toContain('1280x720');
    expect(pointerRequest({ x: 640, y: 360, action: 'drag' }, picture)).toContain('to_x and to_y');
    expect(pointerRequest({ x: 640, y: 360, action: 'drag', to_x: 640, to_y: 900 }, picture)).toContain('to_x and to_y');
    expect(pointerRequest({ x: 640, y: 360, action: 'scroll_up', amount: 0 }, picture)).toContain('1 to 30');
    expect(pointerRequest({ x: 640, y: 360, action: 'scroll_up', amount: 2.5 }, picture)).toContain('1 to 30');
    for (const said of [pointerRequest({ x: 640, y: 360 }, null), pointerRequest({ x: -4, y: 2 }, picture)]) {
      expect(said).toContain('nothing was done');
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

  test('after a picture it sends the place as a fraction of that picture, to the same machine', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(manager(calls));
    // The picture the model saw was half the size of the screen.
    rememberScreenPicture('Desk PC', 1280, 720);
    const out = await desktopPointerTool.execute({ x: 640, y: 360, action: 'double_click' }) as string;
    expect(calls).toEqual([{ method: 'pointer_action', params: { action: 'double_click', fx: 640.5 / 1280, fy: 360.5 / 720 } }]);
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
