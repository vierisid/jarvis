import { test, expect, describe } from 'bun:test';
import { DesktopController } from './desktop-controller.ts';

describe('DesktopController', () => {
  for (const method of ['clickById', 'typeById'] as const) test(`${method} cannot return success for a missing element`, async () => {
    const ctrl = new DesktopController();
    let calls = 0;
    // No local Windows service is needed: only the outbound command is fake.
    (ctrl as any).ensureConnected = async () => {};
    (ctrl as any).send = async () => { calls++; };
    await expect(method === 'clickById' ? ctrl.clickById(99) : ctrl.typeById(99, 'test')).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_ELEMENT_NOT_FOUND', effect: 'not_started' },
    });
    expect(calls).toBe(0);
  });
  test('constructor accepts custom port', () => {
    const ctrl = new DesktopController(9224);
    expect(ctrl).toBeDefined();
    expect(ctrl.connected).toBe(false);
  });

  test('constructor uses default port', () => {
    const ctrl = new DesktopController();
    expect(ctrl).toBeDefined();
    expect(ctrl.connected).toBe(false);
  });

  test('constructor accepts different port', () => {
    const ctrl = new DesktopController(9999);
    expect(ctrl).toBeDefined();
  });

  test('starts disconnected', () => {
    const ctrl = new DesktopController();
    expect(ctrl.connected).toBe(false);
  });
});

/**
 * #704, the bridge half: DesktopController's own snapshot/clickById had the
 * same unchecked cache. A fake bridge stands in for desktop-bridge.exe: it
 * numbers elements from 1 on every walk, as ElementHandler.cs did.
 */
describe('DesktopController element ids (#704)', () => {
  type Node = { name: string; role: string; x: number; y: number };
  function bridge(initial: Node[], numbering: 'restart' | 'per-walk' = 'restart') {
    let tree = initial;
    let walks = 0;
    let failNextWalk = false;
    let failActive = false;
    let title = 'Dialog';
    const sent: Array<[string, Record<string, unknown> | undefined]> = [];
    const ctrl = new DesktopController();
    (ctrl as any).ensureConnected = async () => {};
    (ctrl as any).send = async (method: string, params?: Record<string, unknown>) => {
      sent.push([method, params]);
      if (method === 'getActiveWindow') {
        if (failActive) { failActive = false; return null; }
        return { pid: 42, title: 'Dialog' };
      }
      if (method === 'getWindowTree') {
        if (failNextWalk) { failNextWalk = false; throw new Error('window gone'); }
        walks++;
        // 'restart' is ElementHandler.cs: 1..N on every walk. 'per-walk' is a
        // bridge that numbers each walk differently, which is what shows the
        // click going out under the read-back's id rather than the snapshot's.
        return { window: { pid: 42, title, className: 'd' }, elements: tree.map((n, i) => ({
          id: (numbering === 'restart' ? 0 : walks * 100) + i + 1, role: n.role, name: n.name, value: null,
          bounds: { x: n.x, y: n.y, width: 80, height: 30 }, properties: {},
        })) };
      }
      return { success: true };
    };
    const acted = () => sent.filter(([m]) => m === 'clickElement' || m === 'typeText');
    return { ctrl, acted, show: (t: Node[]) => { tree = t; }, failNextWalk: () => { failNextWalk = true; },
      failActiveWindow: () => { failActive = true; }, retitle: (t: string) => { title = t; } };
  }
  const cancel: Node = { name: 'Cancel', role: 'Button', x: 100, y: 400 };
  const remove: Node = { name: 'Delete account', role: 'Button', x: 200, y: 400 };

  test('clickById refuses an element that changed since the snapshot, and sends no click', async () => {
    const b = bridge([cancel, remove]);
    const snap = await b.ctrl.snapshot(42, 5);
    b.show([{ ...remove, x: 100 }]);
    await expect(b.ctrl.clickById(snap.elements[0]!.id)).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' },
    });
    expect(b.acted()).toEqual([]);
  });

  test('an id from an earlier snapshot is not re-pointed at the new one', async () => {
    const b = bridge([cancel, remove]);
    const first = await b.ctrl.snapshot(42, 5);
    b.show([remove, cancel]);
    const second = await b.ctrl.snapshot(42, 5);
    expect(second.elements[0]!.id).not.toBe(first.elements[0]!.id);
    await expect(b.ctrl.clickById(first.elements[0]!.id)).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_ELEMENT_NOT_FOUND', effect: 'not_started' },
    });
    expect(b.acted()).toEqual([]);
  });

  test('an unchanged element is clicked by the id the bridge gave it on the read-back', async () => {
    const b = bridge([cancel, remove], 'per-walk');
    const snap = await b.ctrl.snapshot(42, 5);
    await b.ctrl.clickById(snap.elements[1]!.id);
    // Walk 1 numbered it 102; the read-back (walk 2) numbered it 202, and the
    // bridge now answers only to the latest walk's ids.
    expect(b.acted()).toEqual([['clickElement', { elementId: 202 }]]);
  });

  test('a snapshot that fails retires the ids before it', async () => {
    const b = bridge([cancel]);
    const snap = await b.ctrl.snapshot(42, 5);
    b.failNextWalk();
    await expect(b.ctrl.snapshot(42, 5)).rejects.toThrow('window gone');
    await expect(b.ctrl.clickById(snap.elements[0]!.id)).rejects.toMatchObject({
      outcome: { code: 'DESKTOP_ELEMENT_NOT_FOUND', effect: 'not_started' },
    });
    expect(b.acted()).toEqual([]);
  });

  test('a read-back that reads another window of the pid is refused', async () => {
    // The bridge walks the pid's largest named window, which can be another
    // one of the same app by the time of the click (two Explorer windows).
    const b = bridge([cancel, remove]);
    const snap = await b.ctrl.snapshot(42, 5);
    b.retitle('Another window of the same app');
    await expect(b.ctrl.clickById(snap.elements[0]!.id)).rejects.toMatchObject({
      outcome: { code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' }, message: expect.stringContaining('different window'),
    });
    expect(b.acted()).toEqual([]);
  });

  test('an element past the ones the snapshot showed has no id', async () => {
    const many: Node[] = Array.from({ length: 70 }, (_, i) => ({ name: `Item ${i}`, role: 'ListItem', x: 0, y: i * 20 }));
    const b = bridge(many);
    const snap = await b.ctrl.snapshot(42, 5);
    expect(snap.elements).toHaveLength(60);
    expect(snap.totalElements).toBe(70);
    // The id element 65 would have had, by the pattern of the ones shown.
    const unseen = snap.elements[0]!.id + 65;
    await expect(b.ctrl.clickById(unseen)).rejects.toMatchObject({ outcome: { code: 'DESKTOP_ELEMENT_NOT_FOUND', effect: 'not_started' } });
    expect(b.acted()).toEqual([]);
  });

  test('a snapshot that cannot find its window retires the ids before it', async () => {
    const b = bridge([cancel]);
    const snap = await b.ctrl.snapshot(42, 5);
    b.failActiveWindow();
    await expect(b.ctrl.snapshot(undefined, 5)).rejects.toThrow('No active window');
    await expect(b.ctrl.clickById(snap.elements[0]!.id)).rejects.toMatchObject({ outcome: { code: 'DESKTOP_ELEMENT_NOT_FOUND' } });
    expect(b.acted()).toEqual([]);
  });

  test('typeById refuses a stale element and types nothing', async () => {
    const b = bridge([cancel]);
    const snap = await b.ctrl.snapshot(42, 5);
    b.show([{ ...cancel, x: 900 }]);
    await expect(b.ctrl.typeById(snap.elements[0]!.id, 'hunter2')).rejects.toMatchObject({
      outcome: { code: 'DESKTOP_STALE_ELEMENT', effect: 'not_started' },
    });
    expect(b.acted()).toEqual([]);
  });
});

// #704 review: a reconnect whose connect never answered was never abandoned --
// the timeout checked `!this.socket`, which still held the dead socket -- and
// every queued local element tool waited behind it.
describe('DesktopController reconnect', () => {
  test('a connect that never answers is abandoned on a reconnect too', async () => {
    const { EventEmitter } = await import('node:events');
    const ctrl = new DesktopController() as any;
    ctrl.connectTimeoutMs = 50;
    let destroyed = 0;
    ctrl.createSocket = () => Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { destroyed++; } });
    // As after a dropped connection: still marked connected, socket gone.
    ctrl._connected = true;
    ctrl.socket = { destroyed: true, destroy() {} };
    ctrl.connect = async function (this: any) { await this.openSocket(); this._connected = true; };
    const started = Date.now();
    // Raced, so a regression fails here rather than hanging the run.
    const abandonedOrNot = Promise.race([ctrl.ensureConnected(),
      Bun.sleep(1500).then(() => { throw new Error('the connect was never abandoned'); })]);
    await expect(abandonedOrNot).rejects.toThrow('Failed to connect');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(destroyed).toBe(1);
  });
});
