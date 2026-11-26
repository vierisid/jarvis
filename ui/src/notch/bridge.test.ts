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

// Point 7 of the notch review, 26 November 2026 (docs/notch/fixes/07-page-renderer.md).
describe('a page that is told something it cannot read', () => {
  type Host = NonNullable<Parameters<typeof import('./bridge.ts')['connectNotch']>[1]>;
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** A sheet with no blocks: nothing that can be drawn. */
  const unreadable = { type: 'state', count: 1, line: { id: 'bad', kind: 'sheet', say: ['Approve?'], yes: 'approve' } };
  const readable = { type: 'state', count: 1, line: { id: 'good', kind: 'offer', say: ['Reply to Marco?'], yes: 'show' } };

  /** The real page on a desktop app that only records: what was sent to the brain, and what was written to its log. */
  async function page(helloAgainMs: number) {
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register();
    const { connectNotch, notchSend } = await import('./bridge.ts');
    const { createNotchSurface } = await import('./surface/index.ts');
    const root = document.createElement('div');
    document.body.append(root);
    const sent: { type: string; id?: string; act?: string }[] = [];
    const logs: string[] = [];
    const host: Host = { __notch_send: (text) => { sent.push(JSON.parse(text)); }, __notch_log: (text) => { logs.push(text); } };
    const surface = createNotchSurface(root, notchSend(host), { reducedMotion: true });
    connectNotch(surface, host, { helloAgainMs });
    return {
      host, sent, logs, root,
      hellos: () => sent.filter((m) => m.type === 'hello').length,
      dropped: () => logs.filter((line) => line.includes('could not be read')),
      tell: (message: unknown) => host.__notch_receive?.(message as never),
      said: () => (root.querySelector('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      end: () => { surface.destroy(); root.remove(); GlobalRegistrator.unregister(); },
    };
  }

  test('a line that cannot be drawn, told to a page that comes up, does not leave it dead: it asks again, and shows what it is told then', async () => {
    const p = await page(30);
    try {
      expect(p.hellos()).toBe(1);
      p.tell(unreadable);
      expect(p.dropped()).toEqual(['a message from the brain could not be read and was dropped: state sheet']);
      // The state had come, so the hello was never said again: the page drew nothing until it was loaded anew.
      await wait(150);
      expect(p.hellos()).toBeGreaterThan(1);
      p.tell(readable);
      expect(p.said()).toContain('Reply to Marco?');
      p.tell({ type: 'show', line: { id: 'next', kind: 'say', say: ['Sent.'], ms: 4000 } });
      expect(p.said()).toContain('Sent.');
      // And once it has been told, it stops asking.
      await wait(60);
      const asked = p.hellos();
      await wait(150);
      expect(p.hellos()).toBe(asked);
    } finally { p.end(); }
  });

  test('later on, the line that is up stays and can be answered, and the brain is asked for the whole of it again at once', async () => {
    const p = await page(40);
    try {
      p.tell(readable);
      await wait(120);
      expect(p.hellos()).toBe(1);
      p.tell({ type: 'show', line: { id: 'x', kind: 'sheet', say: ['T'], blocks: [{ kind: 'paper' }] } });
      expect(p.hellos()).toBe(2);
      // Not twice in a moment: a brain that answers with the same thing again is not asked in a loop.
      p.tell({ type: 'show', line: { id: 'x', kind: 'sheet', say: ['T'], blocks: [{ kind: 'paper' }] } });
      p.tell(unreadable);
      expect(p.hellos()).toBe(2);
      expect(p.said()).toContain('Reply to Marco?');
      p.root.querySelector<HTMLElement>('.hint .key')?.click();
      expect(p.sent.at(-1)).toEqual({ type: 'answer', id: 'good', act: 'yes' });
      p.tell(readable);
    } finally { p.end(); }
  });

  test('a brain that only ever says what cannot be read is not asked for ever, nor is the log filled; when it speaks again it is asked once more', async () => {
    const { NOTCH_HELLO_TRIES, NOTCH_DROPPED_LOGGED } = await import('./bridge.ts');
    const p = await page(4);
    try {
      // Every hello is answered with the same unreadable state.
      const send = p.host.__notch_send!;
      p.host.__notch_send = (text) => { send(text); if (JSON.parse(text).type === 'hello') queueMicrotask(() => p.tell(unreadable)); };
      p.tell(unreadable);
      await wait(400);
      const asked = p.hellos();
      expect(asked).toBeGreaterThan(5);
      expect(asked).toBeLessThanOrEqual(NOTCH_HELLO_TRIES + 2);
      await wait(100);
      expect(p.hellos()).toBe(asked);
      expect(p.dropped().length).toBe(NOTCH_DROPPED_LOGGED);
      // The brain says something else: it may have a line that can be read by now.
      p.tell({ type: 'count', count: 2 });
      expect(p.hellos()).toBe(asked + 1);
      p.host.__notch_send = send;
      p.tell(readable);
      expect(p.said()).toContain('Reply to Marco?');
    } finally { p.end(); }
  });
});
