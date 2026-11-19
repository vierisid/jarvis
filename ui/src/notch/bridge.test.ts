import { describe, expect, test } from 'bun:test';
import { devicePolygons, withinWindow } from './bridge.ts';

const body: [number, number][] = [[344, -2], [356, 12], [356, 30], [444, 30], [444, 12], [456, -2]];

describe('the outline the desktop app is given', () => {
  // Found on the first run in the real window: a bump that starts a birth sits
  // 80 pixels left of the window, the desktop app allows 64, and it refused
  // the whole outline, notch and all, until the bump had come closer.
  test('a shape that starts outside the window is held to just past its edge', () => {
    const bump: [number, number][] = [[-80, -2], [-80, 0], [-44, 9], [-8, 0], [-8, -2]];
    expect(withinWindow([body, bump], 800, 680)).toEqual([body]);
    const entering: [number, number][] = [[-60, -2], [-60, 0], [-24, 9], [12, 0], [12, -2]];
    const [, held] = withinWindow([body, entering], 800, 680);
    expect(held!.map(([x]) => x)).toEqual([-8, -8, -8, 12, 12]);
    expect(held!.map(([, y]) => y)).toEqual([-2, 0, 9, 0, -2]);
  });

  test('the same on the right, and nothing inside the window is touched', () => {
    const leaving: [number, number][] = [[790, -2], [790, 0], [826, 9], [862, 0], [862, -2]];
    const [kept, held] = withinWindow([body, leaving], 800, 680);
    expect(kept).toEqual(body);
    expect(Math.max(...held!.map(([x]) => x))).toBe(808);
    expect(withinWindow([[[850, -2], [850, 5], [900, -2]]], 800, 680)).toEqual([]);
  });

  test('it goes out in the window\'s own pixels, with fractions kept to two places', () => {
    expect(devicePolygons([[[10.126, 0.004], [20.5, 30]]], 1.5)).toEqual([[[15.19, 0.01], [30.75, 45]]]);
    expect(devicePolygons([], 2)).toEqual([]);
  });
});

// The hardening audit, 17 November 2026.
describe('how often, and how large, an outline is sent', () => {
  test('one that differs by less than can be seen is not sent again; a change in its make-up always is', async () => {
    const { outlineMoved } = await import('./bridge.ts');
    const a = [[[0, 0], [10, 0], [10, 10]]];
    expect(outlineMoved(a, null, 0.25)).toBe(true);
    expect(outlineMoved(a, [[[0, 0], [10, 0], [10, 10]]], 0.25)).toBe(false);
    expect(outlineMoved(a, [[[0, 0], [10.2, 0], [10, 10.1]]], 0.25)).toBe(false);
    expect(outlineMoved(a, [[[0, 0], [10.3, 0], [10, 10]]], 0.25)).toBe(true);
    expect(outlineMoved(a, [[[0, 0], [10, 0], [10, 10], [0, 10]]], 0.25)).toBe(true);
    expect(outlineMoved(a, [...a, ...a], 0.25)).toBe(true);
  });

  test('an outline is held to the number of points the desktop app takes', async () => {
    const { withinPoints, NOTCH_OUTLINE_POINTS_MAX } = await import('./bridge.ts');
    const circle = (n: number): number[][] => Array.from({ length: n }, (_, i) => [Math.cos(i / n * 6.283) * 300, Math.sin(i / n * 6.283) * 300]);
    const small = [circle(200), circle(100)];
    expect(withinPoints(small, NOTCH_OUTLINE_POINTS_MAX)).toBe(small);
    // 782 points were measured at a display scale of 300 %, and 720 is the most that is taken.
    const large = withinPoints([circle(600), circle(182)], NOTCH_OUTLINE_POINTS_MAX);
    expect(large.reduce((sum, polygon) => sum + polygon.length, 0)).toBeLessThanOrEqual(NOTCH_OUTLINE_POINTS_MAX);
    expect(large.length).toBe(2);
    expect(large.every((polygon) => polygon.length >= 3)).toBe(true);
    // It is the same shape, more coarsely.
    expect(large[0]![0]).toEqual([300, 0]);
  });
});

// The second run on a real Mac, 19 November 2026.
describe('the display\'s camera housing', () => {
  test('is asked for once at the start, and a change is heard afterwards', async () => {
    const { connectHousing } = await import('./bridge.ts');
    const told: [unknown, unknown][] = [];
    const surface = { setHousing: (w: unknown, h: unknown) => { told.push([w, h]); } };
    const host: Parameters<typeof connectHousing>[1] = { __notch_housing: () => Promise.resolve([185, 32]) };
    connectHousing(surface, host);
    await Promise.resolve();
    expect(told).toEqual([[185, 32]]);
    host.__notch_cam?.(0, 0);
    expect(told).toEqual([[185, 32], [0, 0]]);
  });

  test('a desktop app that does not answer, answers with something else, or fails, changes nothing', async () => {
    const { connectHousing } = await import('./bridge.ts');
    const told: unknown[] = [];
    const surface = { setHousing: (w: unknown, h: unknown) => { told.push([w, h]); } };
    connectHousing(surface, {});
    connectHousing(surface, { __notch_housing: () => 'no' });
    connectHousing(surface, { __notch_housing: () => Promise.reject(new Error('gone')) });
    connectHousing(surface, { __notch_housing: () => { throw new Error('refused'); } });
    await Promise.resolve();
    await Promise.resolve();
    expect(told).toEqual([]);
  });
});
