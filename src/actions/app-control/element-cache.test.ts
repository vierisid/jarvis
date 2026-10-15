import { describe, expect, test } from 'bun:test';
import { ELEMENT_ID_STRIDE, ElementCache, elementChange, LOCAL_GENERATION_BASE, resolveElement, type ElementPrint } from './element-cache.ts';

// The TypeScript side of #661's comparison (#704). Same cases as the sidecar's
// TestDesktopElementChange (sidecar/desktop_element_identity_test.go), so the
// two paths cannot drift on what "still the same element" means.
describe('elementChange', () => {
  const snap: ElementPrint = { name: 'Cancel', role: 'push button', autoID: '', x: 100, y: 400, w: 80, h: 30 };
  for (const [label, live, positional, want] of [
    ['unchanged, positional', snap, true, ''],
    ['unchanged, live element', snap, false, ''],
    ['moved, positional', { ...snap, x: 600 }, true, 'has moved'],
    ['resized, positional', { ...snap, h: 31 }, true, 'has moved'],
    ['moved, live element', { ...snap, x: 600 }, false, ''],
    ['renamed, positional', { ...snap, name: 'Delete account' }, true, 'is a different element now'],
    ['renamed, live element', { ...snap, name: 'Delete account' }, false, 'is a different element now'],
    ['recast, live element', { ...snap, role: 'link' }, false, 'is a different element now'],
    ['other automation id', { ...snap, autoID: 'deleteButton' }, false, 'is a different element now'],
  ] as const) {
    test(label, () => expect(elementChange(snap, live, positional)).toBe(want));
  }
});

describe('ElementCache', () => {
  // Generation g's ids are g * 1000 + index, from LOCAL_GENERATION_BASE + 1.
  const first = (LOCAL_GENERATION_BASE + 1) * ELEMENT_ID_STRIDE;

  test('ids name one fill: generation * stride + index', () => {
    const c = new ElementCache<string>();
    expect(c.fill({ elements: ['a', 'b'] }, 7, 5)).toEqual([first, first + 1]);
    expect(c.lookup(first + 1)).toEqual({ element: 'b', index: 1, pid: 7, depth: 5, generation: LOCAL_GENERATION_BASE + 1, context: undefined });
    expect(c.fill({ elements: ['c'], context: 'w' }, 8, 3)).toEqual([first + ELEMENT_ID_STRIDE]);
    // The first fill's ids are unknown now, not re-pointed.
    expect(c.lookup(first)).toBeNull();
    expect(c.lookup(first + ELEMENT_ID_STRIDE + 1)).toBeNull();
    for (const bad of [-1, first + 0.5, NaN, 0, 999]) expect(c.lookup(bad)).toBeNull();
  });

  test('a local id is never one a sidecar mints', () => {
    // The sidecar counts generations from 1 (and Windows ids from 1): its ids
    // sit far below the first local one, so one arriving here is unknown.
    const c = new ElementCache<string>();
    c.fill({ elements: Array.from({ length: 10 }, (_, i) => String(i)) }, 1, 1);
    for (const sidecarId of [1000, 1005, 2003, 7]) expect(c.lookup(sidecarId)).toBeNull();
    expect(first).toBe(1_000_001_000);
  });

  test('only the elements a snapshot showed are addressable', () => {
    const c = new ElementCache<number>();
    const ids = c.fill({ elements: [0, 1, 2, 3] }, 1, 1, 2);
    expect(ids).toEqual([first, first + 1, null, null]);
    expect(c.lookup(first + 2)).toBeNull();
  });

  test('an element past the stride gets no id rather than one in the next fill\'s range', () => {
    const c = new ElementCache<number>();
    const ids = c.fill({ elements: Array.from({ length: ELEMENT_ID_STRIDE + 2 }, (_, i) => i) }, 1, 1);
    expect(ids[ELEMENT_ID_STRIDE - 1]).toBe(first + ELEMENT_ID_STRIDE - 1);
    expect(ids.slice(ELEMENT_ID_STRIDE)).toEqual([null, null]);
  });

  test('forget retires every id', () => {
    const c = new ElementCache<string>();
    c.fill({ elements: ['a'] }, 1, 1);
    c.forget();
    expect(c.lookup(first)).toBeNull();
    expect(c.fill({ elements: ['b'] }, 1, 1)).toEqual([first + 2 * ELEMENT_ID_STRIDE]);
  });
});

describe('resolveElement', () => {
  type El = { name: string; x: number };
  const print = (e: El): ElementPrint => ({ name: e.name, role: 'button', autoID: '', x: e.x, y: 0, w: 10, h: 10 });

  test('re-walks with the same pid and depth and returns the live element', async () => {
    const c = new ElementCache<El>();
    const [id] = c.fill({ elements: [{ name: 'OK', x: 1 }] }, 42, 3);
    const live = { name: 'OK', x: 1 };
    const walks: Array<[number, number]> = [];
    expect(await resolveElement(c, id!, async (pid, depth) => { walks.push([pid, depth]); return { elements: [live] }; }, print)).toBe(live);
    expect(walks).toEqual([[42, 3]]);
  });

  test('a snapshot that lands during the read-back supersedes the id', async () => {
    const c = new ElementCache<El>();
    const [id] = c.fill({ elements: [{ name: 'OK', x: 1 }] }, 42, 3);
    await expect(resolveElement(c, id!, async () => { c.fill({ elements: [{ name: 'Other', x: 9 }] }, 99, 3); return { elements: [{ name: 'OK', x: 1 }] }; }, print))
      .rejects.toMatchObject({ outcome: { code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' }, message: expect.stringContaining('replaced') });
  });

  test('a read-back that fails is a refusal before anything is done', async () => {
    const c = new ElementCache<El>();
    const [id] = c.fill({ elements: [{ name: 'OK', x: 1 }] }, 42, 3);
    await expect(resolveElement(c, id!, async () => { throw new Error('bus gone'); }, print))
      .rejects.toMatchObject({ outcome: { status: 'blocked', code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' }, message: expect.stringContaining('bus gone') });
  });

  test('a read-back that read another window of the same pid is refused', async () => {
    // A bridge walks the pid's largest window; by the read-back that can be another one.
    const c = new ElementCache<El>();
    const [id] = c.fill({ elements: [{ name: 'Delete', x: 1 }], context: 'Explorer - Folder X' }, 42, 3);
    await expect(resolveElement(c, id!, async () => ({ elements: [{ name: 'Delete', x: 1 }], context: 'Explorer - Folder Y' }), print))
      .rejects.toMatchObject({ outcome: { code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' }, message: expect.stringContaining('different window') });
    expect(await resolveElement(c, id!, async () => ({ elements: [{ name: 'Delete', x: 1 }], context: 'Explorer - Folder X' }), print))
      .toEqual({ name: 'Delete', x: 1 });
  });

  test('an element with no size is refused before any walk', async () => {
    const c = new ElementCache<El>();
    const [id] = c.fill({ elements: [{ name: 'OK', x: 1 }] }, 42, 3);
    let walks = 0;
    const flat = (e: El): ElementPrint => ({ ...print(e), w: 0, h: 0 });
    await expect(resolveElement(c, id!, async () => { walks++; return { elements: [] }; }, flat))
      .rejects.toMatchObject({ outcome: { code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' }, message: expect.stringContaining('no on-screen size') });
    expect(walks).toBe(0);
  });
});
