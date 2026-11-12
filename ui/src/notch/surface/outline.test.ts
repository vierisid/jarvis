import { describe, expect, test } from 'bun:test';
import { ABOVE, area2, bounds, flattenPath, hanging, inside, insetPolygon, isClockwise, offsetLine, type Point } from './outline.ts';
import { bodyPaths } from './shape.ts';
import { bumpD } from './edge.ts';

/** The notch at rest, as the shape module writes it. */
const REST = bodyPaths({ w: 88, h: 30, big: false, shr: 0, sag: 0, bow: 0, lip: 0, lean: 0, wave: null }).body;

describe('a path becomes points', () => {
  test('the resting notch: 112 wide at the top with its shoulders, 30 tall', () => {
    const points = flattenPath(REST);
    const b = bounds(points);
    expect([b.minX, b.maxX, b.minY]).toEqual([18, 130, 0]);
    expect(b.maxY).toBeCloseTo(30, 5);
    // From the left shoulder's tip round to the right one's.
    expect(points[0]).toEqual([18, 0]);
    expect(points.at(-1)).toEqual([130, 0]);
  });

  // Whole pixels turn an arc into short straight runs: this is why the first
  // smooth edge still looked like a polygon.
  test('curves get a point about every pixel and a half, and nothing is rounded', () => {
    const points = flattenPath(REST);
    expect(points.length).toBeGreaterThan(40);
    expect(points.some(([x, y]) => x % 1 !== 0 || y % 1 !== 0)).toBe(true);
    // Wherever the edge turns (both coordinates change), the steps are short.
    // A straight run, like the bottom between its two corners, stays one piece.
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const turning = Math.abs(b[0] - a[0]) > 0.01 && Math.abs(b[1] - a[1]) > 0.01;
      if (turning) expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(2);
    }
  });

  test('a screen with more pixels gets more points for the same curve', () => {
    expect(flattenPath(REST, 2).length).toBeGreaterThan(flattenPath(REST, 1).length);
  });

  test('a straight line stays two points, and a closing Z adds none', () => {
    expect(flattenPath('M0 0 L10 0 L10 10 Z')).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(flattenPath('M0 0 Q5 0 10 0')).toEqual([[0, 0], [10, 0]]);
  });

  test('what is not a path is no points', () => {
    expect(flattenPath('')).toEqual([]);
    expect(flattenPath('nonsense')).toEqual([]);
  });
});

describe('a shape that hangs from the top of the screen', () => {
  test('is closed above the top edge, so the edge itself is always covered', () => {
    const polygon = hanging(flattenPath(REST), 0);
    expect(polygon[0]).toEqual([18, ABOVE]);
    expect(polygon.at(-1)).toEqual([130, ABOVE]);
    expect(isClockwise(polygon)).toBe(isClockwise(hanging(flattenPath(bumpD(200, 8)), 0)));
  });

  test('moved inwards it lies strictly inside the true shape, and the top stays put', () => {
    const outer = hanging(flattenPath(REST), 0), inner = hanging(flattenPath(REST), 1.5);
    expect(Math.abs(area2(inner))).toBeLessThan(Math.abs(area2(outer)));
    for (const [x, y] of inner) {
      if (y <= 0.01) continue;
      expect(inside(outer, x, y)).toBe(true);
    }
    const b = bounds(inner);
    expect(b.maxY).toBeCloseTo(28.5, 1);
    expect(b.minY).toBe(ABOVE);
  });

  test('a bump is a polygon of its own', () => {
    const polygon = hanging(flattenPath(bumpD(200, 8)), 0);
    const b = bounds(polygon);
    expect([b.minX, b.maxX]).toEqual([164, 236]);
    expect(b.maxY).toBeCloseTo(8, 5);
    expect(inside(polygon, 200, 4)).toBe(true);
    expect(inside(polygon, 200, 9)).toBe(false);
    expect(inside(polygon, 100, 2)).toBe(false);
  });
});

describe('moving a line sideways', () => {
  const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  test('a closed polygon moved inwards shrinks, whichever way round its points run', () => {
    for (const polygon of [square, [...square].reverse()]) {
      const inner = insetPolygon(polygon, 1);
      const b = bounds(inner);
      expect(b.minX).toBeGreaterThan(0);
      expect(b.maxX).toBeLessThan(10);
      expect(Math.abs(area2(inner))).toBeLessThan(Math.abs(area2(polygon)));
    }
  });

  test('by nothing it is a copy, not the same points', () => {
    const copy = offsetLine(square, 0, true);
    expect(copy).toEqual(square);
    expect(copy[0]).not.toBe(square[0]);
  });
});
