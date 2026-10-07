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

/**
 * #747: the bridge channel is a plain localhost TCP port with no
 * authentication, and nothing in the repo serves it any more (the .NET bridge
 * was deleted in 28e43ed). Any local process -- any user's -- that listened on
 * the port and answered "pong" became the daemon's desktop controller: it
 * supplied the screenshots (labelled image/png whatever they were) and
 * received every typeText payload. A real TCP listener stands in for it here.
 */
describe('DesktopController and an unauthenticated bridge port (#747)', () => {
  function impostor(capture: Buffer) {
    const seen: string[] = [];
    let connections = 0;
    const server = Bun.listen<{ buf: string }>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(s) { connections++; s.data = { buf: '' }; },
        data(s, chunk) {
          s.data.buf += chunk.toString();
          const lines = s.data.buf.split('\n');
          s.data.buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
            seen.push(`${req.method} ${JSON.stringify(req.params ?? {})}`);
            const result = req.method === 'ping' ? 'pong'
              : req.method === 'captureScreen' || req.method === 'captureWindow' ? capture.toString('base64')
              : { success: true };
            s.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
          }
        },
      },
    });
    return { port: server.port, seen, connections: () => connections, stop: () => server.stop(true) };
  }

  /** A controller whose search for desktop-bridge.exe finds `exe`. */
  function controller(port: number, exe: string | null) {
    const ctrl = new DesktopController(port);
    (ctrl as any).findBridgeExecutable = () => exe;
    return ctrl;
  }

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  test('with no desktop-bridge.exe installed, whatever answers on the port is never contacted', async () => {
    const fake = impostor(PNG);
    const ctrl = controller(fake.port, null);
    try {
      await expect(ctrl.connect()).rejects.toThrow('desktop-bridge.exe');
      await expect(ctrl.typeText('hunter2')).rejects.toThrow('desktop-bridge.exe');
      expect(fake.connections()).toBe(0);
      expect(fake.seen).toEqual([]);
    } finally {
      await ctrl.disconnect();
      fake.stop();
    }
  });

  test('a capture is checked to be the PNG the bridge produces, and anything else is refused', async () => {
    const fake = impostor(PNG);
    const ok = controller(fake.port, '/legacy/desktop-bridge.exe');
    try {
      expect(await ok.screenshotBase64()).toEqual({ base64: PNG.toString('base64'), mimeType: 'image/png' });
      expect((await ok.captureScreen()).equals(PNG)).toBe(true);
    } finally {
      await ok.disconnect();
      fake.stop();
    }
    // A JPEG too: the bridge only ever wrote PNG (ScreenHandler.cs), and the
    // macOS and Windows controllers hand captureScreen's bytes on as
    // image/png, so a PNG check is what keeps that label true.
    for (const other of [Buffer.from('GIF89a not a png at all'), JPEG]) {
      const bad = impostor(other);
      const ctrl = controller(bad.port, '/legacy/desktop-bridge.exe');
      try {
        await expect(ctrl.screenshotBase64()).rejects.toThrow('not a PNG image');
        await expect(ctrl.screenshotBase64(42)).rejects.toThrow('not a PNG image');
        await expect(ctrl.captureScreen()).rejects.toThrow('not a PNG image');
        await expect(ctrl.captureWindow(42)).rejects.toThrow('not a PNG image');
      } finally {
        await ctrl.disconnect();
        bad.stop();
      }
    }
  });

  test('a reply that is not base64 text at all is refused, not decoded', async () => {
    const ctrl = new DesktopController() as any;
    ctrl.ensureConnected = async () => {};
    ctrl.send = async () => ({ base64: 'iVBORw0KGgo=' });
    await expect(ctrl.screenshotBase64()).rejects.toThrow('not a PNG image');
  });

  test('a reply that never ends is cut off at the cap, not buffered without bound', async () => {
    const { EventEmitter } = await import('node:events');
    const ctrl = new DesktopController() as any;
    ctrl.maxReplyChars = 1000;
    let destroyed = 0;
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false, setEncoding() {}, write(_d: string, cb?: (e?: Error) => void) { cb?.(); return true; },
      destroy() { destroyed++; this.destroyed = true; },
    });
    ctrl.createSocket = (onConnect: () => void) => { queueMicrotask(onConnect); return socket; };
    await ctrl.openSocket();
    ctrl._connected = true;
    const pending = ctrl.send('captureScreen');
    // 999 characters and no newline is still a reply on its way.
    socket.emit('data', 'x'.repeat(999));
    expect(destroyed).toBe(0);
    socket.emit('data', 'xx');
    await expect(pending).rejects.toThrow('longer than any capture');
    expect(destroyed).toBe(1);
    expect(ctrl.buffer).toBe('');
    expect(ctrl.connected).toBe(false);
  });

  test('the cap is derived from the largest capture the decoder takes, so no real reply reaches it', () => {
    const ctrl = new DesktopController() as any;
    // base64 of a PNG holding MAX_DECODE_BYTES of rows stored uncompressed.
    expect(ctrl.maxReplyChars).toBeGreaterThan((256_000_000 * 4) / 3);
    expect(ctrl.maxReplyChars).toBeLessThan(400_000_000);
  });

  test('what goes on is the bytes that were checked, re-encoded, not the reply as sent', async () => {
    // Node's base64 decoder skips what is not base64; the model's provider
    // may not. The check ran on the decoded bytes, so those are what is sent.
    const ctrl = new DesktopController() as any;
    ctrl.ensureConnected = async () => {};
    const canonical = PNG.toString('base64');
    ctrl.send = async () => `${canonical.slice(0, 6)}\n !${canonical.slice(6)}`;
    expect(await ctrl.screenshotBase64()).toEqual({ base64: canonical, mimeType: 'image/png' });
  });
});
