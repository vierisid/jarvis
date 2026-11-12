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
