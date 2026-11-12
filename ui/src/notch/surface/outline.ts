/**
 * The silhouette as polygons. The desktop app cuts the window to them and a
 * native layer paints them black, so they have to follow the drawn path
 * closely: a point about every pixel and a half along a curve, and nothing
 * rounded (whole pixels turn an arc into short straight runs).
 *
 * Order of the points, everywhere in this file: as the notch's own path runs.
 * It starts at the top left, goes down the left side, along the bottom from
 * left to right and up the right side. With the points in that order the
 * inside is always to the left of the direction of travel as seen on screen,
 * which is what `offsetLine` relies on. (The desktop app does not care which
 * way a polygon turns: it turns them all the same way itself.)
 */

export type Point = [number, number];

/** How far apart points on a curve may be, in device pixels. */
const STEP = 1.5;
/** A curve closer than this to its chord, in device pixels, is drawn as the chord. */
const FLAT = 0.02;
const MOST = 96;

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

/**
 * Turns an svg path into points. It reads what the notch writes and no more:
 * absolute M, L, Q, C and Z. `scale` is the device pixel ratio, so a curve gets
 * as many points as its size on the real screen needs. A segment's first point
 * is never repeated, and a closing Z adds nothing.
 */
export function flattenPath(d: string, scale = 1): Point[] {
  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: Point[] = [];
  let i = 0, x = 0, y = 0, cmd = '';
  const num = (): number => { const v = Number(tokens[i++]); return Number.isFinite(v) ? v : 0; };
  const push = (px: number, py: number) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - px) > 1e-9 || Math.abs(last[1] - py) > 1e-9) out.push([px, py]);
    x = px; y = py;
  };
  // How many straight pieces a curve needs: enough for a point every STEP
  // pixels, but no more than its bend calls for, so a curve that is really a
  // straight line stays one piece.
  const pieces = (length: number, bend: number, k: number): number =>
    Math.max(1, Math.min(MOST, Math.ceil(length * scale / STEP), Math.ceil(Math.sqrt(k * bend * scale / FLAT))));
  while (i < tokens.length) {
    const tk = tokens[i] ?? '';
    if (/^[MLQCZ]$/i.test(tk)) { cmd = tk.toUpperCase(); i++; if (cmd === 'Z') continue; }
    else if (!cmd || cmd === 'Z') { i++; continue; }
    if (cmd === 'M' || cmd === 'L') { const px = num(), py = num(); push(px, py); if (cmd === 'M') cmd = 'L'; }
    else if (cmd === 'Q') {
      const x0 = x, y0 = y, x1 = num(), y1 = num(), x2 = num(), y2 = num();
      const len = (dist(x0, y0, x2, y2) + dist(x0, y0, x1, y1) + dist(x1, y1, x2, y2)) / 2;
      const n = pieces(len, Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), .25);
      for (let s = 1; s <= n; s++) {
        const t = s / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
        push(a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2);
      }
    } else if (cmd === 'C') {
      const x0 = x, y0 = y, x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      const len = (dist(x0, y0, x3, y3) + dist(x0, y0, x1, y1) + dist(x1, y1, x2, y2) + dist(x2, y2, x3, y3)) / 2;
      const bend = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
      const n = pieces(len, bend, .75);
      for (let s = 1; s <= n; s++) {
        const t = s / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
        push(a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3);
      }
    } else i++;
  }
  return out;
}

/** Twice the signed area. Negative for points in the order this file uses. */
export function area2(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a && b) sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** True when the points run in the order this file uses (see the top of the file). */
export const isClockwise = (points: readonly Point[]): boolean => area2(points) < 0;

export function bounds(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}

/** Even-odd test: is the point inside the polygon. */
export function inside(points: readonly Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (!a || !b) continue;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/**
 * Moves every point `by` pixels towards the inside: along the direction
 * halfway between the normals of the two pieces that meet there. Simple, and
 * it cannot fail: no corner is ever sharpened into a spike. `closed` says
 * whether the last point joins the first; an open line's ends use the one
 * piece they have.
 */
export function offsetLine(points: readonly Point[], by: number, closed: boolean): Point[] {
  const n = points.length;
  if (n < 2 || by === 0) return points.map(p => [p[0], p[1]] as Point);
  const normal = (a: Point, b: Point): Point => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    return len < 1e-9 ? [0, 0] : [dy / len, -dx / len];
  };
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i] as Point;
    const prev = i > 0 ? points[i - 1] : closed ? points[n - 1] : undefined;
    const next = i < n - 1 ? points[i + 1] : closed ? points[0] : undefined;
    const a: Point = prev ? normal(prev, p) : [0, 0], b: Point = next ? normal(p, next) : [0, 0];
    let nx = a[0] + b[0], ny = a[1] + b[1];
    const len = Math.hypot(nx, ny);
    // Two pieces that double back on each other have no halfway: use one of them.
    if (len < 1e-6) { nx = a[0] || b[0]; ny = a[1] || b[1]; } else { nx /= len; ny /= len; }
    out.push([p[0] + nx * by, p[1] + ny * by]);
  }
  return out;
}

/** A closed polygon moved `inset` pixels inwards, whichever way round its points run. */
export function insetPolygon(points: readonly Point[], inset: number): Point[] {
  return offsetLine(points, isClockwise(points) ? inset : -inset, true);
}

/** How far above the window's top edge a polygon reaches, so the edge itself is always covered. */
export const ABOVE = -2;

/**
 * Closes an edge that hangs from the top of the screen (the notch, or a bump)
 * into a polygon: the edge itself, moved `inset` inwards, with both ends taken
 * straight up past the top. The top is the screen's own edge, so it is not
 * moved in.
 */
export function hanging(edge: readonly Point[], inset: number): Point[] {
  const first = edge[0], last = edge[edge.length - 1];
  if (!first || !last) return [];
  const moved = inset ? offsetLine(edge, inset, false).map(([x, y]) => [x, Math.max(ABOVE, y)] as Point) : edge.map(p => [p[0], p[1]] as Point);
  return [[first[0], ABOVE], ...moved, [last[0], ABOVE]];
}
