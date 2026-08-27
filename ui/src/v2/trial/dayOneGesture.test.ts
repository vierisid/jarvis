import { describe, expect, test } from "bun:test";
import { agentAnchor, flightToRow, GESTURE_GAP, labelAt, type Rect } from "./dayOneGesture";

/**
 * D26's gesture is arithmetic, and the arithmetic is where it went wrong in
 * the conducted hour: the pebble covered the step after the one it was
 * pointing at, measured in a real browser on a real flow. Same class of
 * mistake is available here, so the placement is checked without one.
 */

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** The shell's docked pebble: fixed, right 18, bottom 16, on a 1440x900 page. */
const PEBBLE = rect(1440 - 18 - 42, 900 - 16 - 60, 42, 60);

describe("flightToRow", () => {
  test("stands beside the row, level with its middle, not on top of it", () => {
    const row = rect(320, 200, 620, 96);
    const f = flightToRow(PEBBLE, row);
    const landed = { left: PEBBLE.left + f.dx, top: PEBBLE.top + f.dy };
    expect(f.side).toBe("left");
    // Clear of the row's left edge by the gap, so nothing it points at is covered.
    expect(landed.left + PEBBLE.width).toBe(row.left - GESTURE_GAP);
    // Centred on the row.
    expect(landed.top + PEBBLE.height / 2).toBe(row.top + row.height / 2);
  });

  test("a row hard against the left edge is approached from the right instead", () => {
    // The 290px strip panel, where there is no room on the left at all.
    const row = rect(6, 120, 278, 88);
    const f = flightToRow(PEBBLE, row);
    expect(f.side).toBe("right");
    expect(PEBBLE.left + f.dx).toBe(row.right + GESTURE_GAP);
  });

  test("it never lands off the left of the screen", () => {
    for (const left of [0, 4, 20, 60, 200]) {
      const f = flightToRow(PEBBLE, rect(left, 100, 240, 80));
      expect(PEBBLE.left + f.dx).toBeGreaterThanOrEqual(0);
    }
  });

  test("a row below the pebble's dock is reached by going down, not up", () => {
    const above = flightToRow(PEBBLE, rect(300, 100, 400, 80));
    const below = flightToRow(PEBBLE, rect(300, 860, 400, 80));
    expect(above.dy).toBeLessThan(0);
    expect(below.dy).toBeGreaterThan(0);
  });
});

describe("labelAt", () => {
  test("opens away from the row, so the label does not cover it either", () => {
    const row = rect(320, 200, 620, 96);
    const f = flightToRow(PEBBLE, row);
    const l = labelAt(PEBBLE, f);
    // Approached from the left, so the label runs leftwards into empty space.
    expect(l.align).toBe("right");
    expect(l.left).toBeLessThan(row.left);
  });

  test("and the other way when the pebble came from the right", () => {
    const row = rect(6, 120, 278, 88);
    const l = labelAt(PEBBLE, flightToRow(PEBBLE, row));
    expect(l.align).toBe("left");
    expect(l.left).toBeGreaterThan(row.right);
  });

  test("is vertically centred on where the pebble came to rest", () => {
    const row = rect(320, 200, 620, 96);
    const f = flightToRow(PEBBLE, row);
    expect(labelAt(PEBBLE, f).top).toBe(row.top + row.height / 2);
  });
});

describe("agentAnchor", () => {
  test("is what the daemon names and what the strip renders", () => {
    expect(agentAnchor("task-1")).toBe("agent:task-1");
  });
});
