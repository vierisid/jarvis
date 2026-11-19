import { describe, expect, test } from 'bun:test';
import { bounds, flattenPath, type Point } from './outline.ts';
import { CAM_CORNER, CAM_PAST, OX, bodyPaths, camNarrowMost, housedWidth, type BodyShape, type Housing } from './shape.ts';

// A MacBook's camera housing sits where the notch hangs, and nothing drawn behind it can be seen. The
// second run on a real Mac (19 November 2026) showed the notch where it belongs with most of it behind the
// housing. These are the rules it is drawn by since.

const still = (w: number, h: number): BodyShape => ({ w, h, big: false, shr: 0, sag: 0, bow: 0, lip: 0, lean: 0, wave: null });
/** A housing 185 wide and 32 tall, over the middle of a notch `w` wide. */
const over = (w: number, camW = 185, camH = 32): Housing => ({ left: OX + w / 2 - camW / 2, right: OX + w / 2 + camW / 2, h: camH });
const points = (d: string): Point[] => flattenPath(d, 2);
/** The leftmost and rightmost of the outline at one height. */
function across(outline: Point[], y: number): [number, number] {
  const xs: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
  }
  return [Math.min(...xs), Math.max(...xs)];
}

describe('a display without a camera housing', () => {
  test('the path is the one it always was', () => {
    for (const s of [still(88, 30), still(420, 40), { ...still(468, 300), big: true }]) {
      expect(bodyPaths(s, 0, null)).toEqual(bodyPaths(s));
      expect(bodyPaths(s, 2.7, null)).toEqual(bodyPaths(s, 2.7));
      // A housing with no height is no housing.
      expect(bodyPaths(s, 0, { left: 0, right: 200, h: 0 })).toEqual(bodyPaths(s));
    }
  });
});

describe('a notch narrower than the housing', () => {
  const cam = over(88), body = points(bodyPaths(still(88, 30), 0, cam).body);

  test('its ink starts at the screen\'s top edge, and what it says sits below the housing', () => {
    const b = bounds(body);
    // y = 0 is the housing's lower edge: the top edge is the housing's height above it.
    expect(b.minY).toBe(-32);
    expect(b.maxY).toBeCloseTo(30, 5);
  });

  test('it hangs from the housing with a shoulder each side, as it hangs from a screen\'s edge', () => {
    // Right under the housing it is a shoulder wider than itself each side: 88 and twice 12.
    const [l, r] = across(body, 0.01);
    expect(l).toBeCloseTo(OX - 12, 0);
    expect(r).toBeCloseTo(OX + 88 + 12, 0);
    // A shoulder's height further down it is its own width.
    const [l2, r2] = across(body, 13);
    expect(l2).toBeCloseTo(OX, 1);
    expect(r2).toBeCloseTo(OX + 88, 1);
  });

  test('nothing of it shows beside the housing', () => {
    // Above the housing's lower edge every point lies behind the housing, inside the flat of its edge.
    for (const [x, y] of body) {
      if (y >= 0) continue;
      expect(x).toBeGreaterThanOrEqual(cam.left + CAM_CORNER - 0.001);
      expect(x).toBeLessThanOrEqual(cam.right - CAM_CORNER + 0.001);
    }
  });

  test('the line that burns along its edge runs where it can be seen: from under the housing, round, and back', () => {
    const edge = points(bodyPaths(still(88, 30), 2.7, cam).edge);
    expect(edge.every(([, y]) => y >= 2.7 - 0.001)).toBe(true);
    expect(edge[0]![0]).toBeLessThan(OX + 2.7);
    expect(edge.at(-1)![0]).toBeGreaterThan(OX + 88 - 2.7);
  });
});

describe('a notch wider than the housing', () => {
  const cam = over(420), body = points(bodyPaths(still(420, 40), 0, cam).body);

  test('it takes the housing in: one piece from the top edge down, shoulders at the top edge', () => {
    const b = bounds(body);
    expect(b.minY).toBe(-32);
    expect(b.minX).toBeLessThan(OX - 10);
    // At the very top it is its shoulders wider; from a shoulder's height down, its own width, all the way.
    for (const y of [-8, -0.5, 0.5, 6, 20]) {
      const [l, r] = across(body, y);
      expect(l).toBeCloseTo(OX, 1);
      expect(r).toBeCloseTo(OX + 420, 1);
    }
  });

  test('its burning line starts up at the top edge, beside the housing', () => {
    const edge = points(bodyPaths(still(420, 40), 2.7, cam).edge);
    expect(edge[0]![1]).toBeLessThan(-10);
    expect(edge.at(-1)![1]).toBeLessThan(-10);
  });
});

describe('a side that comes down near the housing\'s corner', () => {
  test('gets less shoulder the nearer it is, and none at the corner', () => {
    // 141 wide is the widest that still has a whole shoulder; 165 has none (its side is at the corner).
    const whole = across(points(bodyPaths(still(141, 40), 0, over(141)).body), 0.01);
    expect(whole[0]).toBeCloseTo(OX - 12, 0);
    const some = across(points(bodyPaths(still(153, 40), 0, over(153)).body), 0.01);
    expect(some[0]).toBeCloseTo(OX - 6, 0);
    const none = across(points(bodyPaths(still(165, 40), 0, over(165)).body), 0.01);
    expect(none[0]).toBeCloseTo(OX, 1);
  });

  test('shaken to one side, each shoulder is what fits on its own side', () => {
    // The housing stays where it is; the notch moved 8 to the right.
    const w = 141, cam: Housing = { left: over(w).left - 8, right: over(w).right - 8, h: 32 };
    const [l, r] = across(points(bodyPaths(still(w, 40), 0, cam).body), 0.01);
    expect(l).toBeCloseTo(OX - 12, 0);
    expect(r).toBeCloseTo(OX + w + 4, 0);
  });
});

describe('how wide a notch is made under a housing', () => {
  test('clearly narrower than the housing, it keeps its width', () => {
    expect(camNarrowMost(185)).toBe(141);
    expect(housedWidth(88, 185)).toBe(88);
    expect(housedWidth(141, 185)).toBe(141);
  });

  test('about as wide as the housing, it is made a little wider than it, by a whole number of pixels each side', () => {
    for (const w of [142, 160, 185, 190]) {
      const held = housedWidth(w, 185);
      expect(held).toBeGreaterThanOrEqual(185 + 2 * CAM_PAST);
      expect(held % 2).toBe(0);
    }
    expect(housedWidth(142, 185)).toBe(198);
  });

  test('wider than that, or with no housing, it keeps its width', () => {
    expect(housedWidth(420, 185)).toBe(420);
    expect(housedWidth(160, 0)).toBe(160);
  });
});
