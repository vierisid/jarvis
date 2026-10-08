import { test, expect, describe, spyOn, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findSidecarExecutable, isSidecarRunning } from './sidecar-launcher.ts';
import { DesktopController } from './desktop-controller.ts';
import { WSLBridge } from '../terminal/wsl-bridge.ts';

describe('sidecar-launcher', () => {
  test('findSidecarExecutable returns string or null', () => {
    const result = findSidecarExecutable();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

/**
 * #801: the exe's existence is what lets the port be contacted (#747), and
 * the exe is run, so only the path Windows names as the user's own profile
 * may count. Here the Windows profile is `winuser` and the Linux user
 * `linuxuser`, as on a box where the two differ.
 */
describe('findSidecarExecutable trusts only %USERPROFILE% (#801)', () => {
  const OWN = '/mnt/c/Users/winuser/.jarvis/sidecar/desktop-bridge.exe';
  const OTHER_PROFILE = '/mnt/c/Users/linuxuser/.jarvis/sidecar/desktop-bridge.exe';
  // The package's legacy build output, relative to this directory.
  const REPO_BUILD = join(import.meta.dir, '../../../sidecar/desktop-bridge/bin/publish/desktop-bridge.exe');
  const REPO_RELEASE = join(import.meta.dir, '../../../sidecar/desktop-bridge/bin/Release/net8.0-windows/win-x64/publish/desktop-bridge.exe');

  let savedUser: string | undefined;
  afterEach(() => {
    if (savedUser === undefined) delete process.env.USER; else process.env.USER = savedUser;
  });

  /** WSL, where cmd.exe reports `profile` (or fails), and exactly `present` exist on disk. */
  function world(opts: { wsl: boolean; profile: string | null; present: string[] | 'everything'; exitCode?: number }): void {
    savedUser = process.env.USER;
    process.env.USER = 'linuxuser';
    spies.push(spyOn(WSLBridge, 'isWSL').mockReturnValue(opts.wsl));
    spies.push(spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      if (cmd[0] !== 'cmd.exe') throw new Error(`unexpected spawn ${cmd.join(' ')}`);
      if (opts.profile === null) throw new Error('cmd.exe: not found (interop disabled)');
      const exitCode = opts.exitCode ?? 0;
      return { stdout: Buffer.from(`${opts.profile}\r\n`), stderr: Buffer.from(''), exitCode, success: exitCode === 0 };
    }) as unknown as typeof Bun.spawnSync));
    const present = opts.present === 'everything' ? null : new Set(opts.present);
    spies.push(spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => present === null || present.has(String(p))) as typeof fs.existsSync));
  }

  // With every path "present", only the parse decides: each of these used to
  // be turned into a path by position (drive = first character, the rest
  // after two), and that path was trusted (#801 review).
  for (const [label, profile, exitCode] of [
    ['a UNC profile', '\\\\server\\share\\winuser', 0],
    ['a profile path with a .. segment', 'C:\\Users\\winuser\\..\\Public', 0],
    ['a .. segment behind forward slashes', 'C:\\Users\\winuser/../Public', 0],
    ['a NUL in the profile', 'C:\\Users\\win\u0000user', 0],
    ['a warning line ahead of the profile', 'warning: UNC paths are not supported\r\nC:\\Users\\winuser', 0],
    ['a cmd.exe that failed', 'C:\\Users\\winuser', 1],
    ['no drive letter', 'Users\\winuser', 0],
  ] as const) {
    test(`trusts no path from ${label}`, () => {
      world({ wsl: true, profile, present: 'everything', exitCode });
      expect(findSidecarExecutable()).toBeNull();
    });
  }

  test('a profile at a drive root still maps to one clean path', () => {
    world({ wsl: true, profile: 'D:\\', present: ['/mnt/d/.jarvis/sidecar/desktop-bridge.exe'] });
    expect(findSidecarExecutable()).toBe('/mnt/d/.jarvis/sidecar/desktop-bridge.exe');
  });

  test('finds the exe in the Windows profile', () => {
    world({ wsl: true, profile: 'C:\\Users\\winuser', present: [OWN, OTHER_PROFILE, REPO_BUILD] });
    expect(findSidecarExecutable()).toBe(OWN);
  });

  test('does not run an exe from the profile the Linux username names', () => {
    world({ wsl: true, profile: 'C:\\Users\\winuser', present: [OTHER_PROFILE] });
    expect(findSidecarExecutable()).toBeNull();
  });

  test('does not guess a profile from the Linux username when cmd.exe cannot say', () => {
    world({ wsl: true, profile: null, present: [OTHER_PROFILE] });
    expect(findSidecarExecutable()).toBeNull();
  });

  test('does not guess when %USERPROFILE% is unset (cmd.exe echoes the name back)', () => {
    world({ wsl: true, profile: '%USERPROFILE%', present: [OTHER_PROFILE] });
    expect(findSidecarExecutable()).toBeNull();
  });

  for (const wsl of [true, false]) {
    test(`does not run the package's legacy build output (${wsl ? 'WSL' : 'native'})`, () => {
      world({ wsl, profile: 'C:\\Users\\winuser', present: [REPO_BUILD, REPO_RELEASE] });
      expect(findSidecarExecutable()).toBeNull();
    });
  }

  test('natively, finds the exe under the home directory', () => {
    const own = join(homedir(), '.jarvis', 'sidecar', 'desktop-bridge.exe');
    world({ wsl: false, profile: null, present: [own] });
    expect(findSidecarExecutable()).toBe(own);
  });
});

/**
 * #800: on WSL the bridge used to be looked for on the first nameserver in
 * /etc/resolv.conf as well as on localhost. That is the Windows host only on
 * a default NAT-mode install; with a custom resolv.conf it is another machine.
 *
 * The "other machine" here is 127.0.0.2: on Linux the whole of 127/8 is
 * loopback, so it can be bound, but `localhost` does not reach it -- which is
 * exactly the relation a LAN resolver has to the bridge's real host.
 */
const OTHER_HOST = '127.0.0.2';

type FakeBridge = { server: Server; port: number; connections: number; typed: string[] };

/**
 * A bridge that answers `pong`, except to its first `silentFirst` connections,
 * which it holds open without a word -- so the daemon's first probe times out
 * and only a later one is answered.
 */
async function fakeBridge(host: string, silentFirst = 0): Promise<FakeBridge> {
  const bridge: FakeBridge = { server: null as unknown as Server, port: 0, connections: 0, typed: [] };
  bridge.server = createServer((socket: Socket) => {
    const n = ++bridge.connections;
    let buf = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line) as { method: string; params: { text?: string }; id: number };
        if (n <= silentFirst) continue;
        if (req.method === 'ping') socket.write(JSON.stringify({ jsonrpc: '2.0', result: 'pong', id: req.id }) + '\n');
        else {
          if (req.method === 'typeText') bridge.typed.push(String(req.params.text));
          socket.write(JSON.stringify({ jsonrpc: '2.0', result: { success: true }, id: req.id }) + '\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    bridge.server.once('error', reject);
    bridge.server.listen(0, host, () => resolve());
  });
  bridge.port = (bridge.server.address() as { port: number }).port;
  return bridge;
}

/** WSL, with a resolv.conf whose first nameserver is OTHER_HOST. */
function onWslWithCustomResolver(): void {
  spies.push(spyOn(WSLBridge, 'isWSL').mockReturnValue(true));
  const real = fs.readFileSync;
  spies.push(spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    path === '/etc/resolv.conf'
      ? `# custom\nnameserver ${OTHER_HOST}\nnameserver 1.1.1.1\n`
      : (real as (...a: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync));
}

const spies: Array<{ mockRestore(): void }> = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  for (const s of servers.splice(0)) s.close();
});

describe.skipIf(process.platform !== 'linux')('the bridge is looked for on localhost only (#800)', () => {
  test('a bridge answering on the resolv.conf nameserver is not adopted, or even contacted', async () => {
    const remote = await fakeBridge(OTHER_HOST);
    servers.push(remote.server);
    onWslWithCustomResolver();

    expect(await isSidecarRunning(remote.port)).toBe(false);
    expect(remote.connections).toBe(0);
  });

  test('typed text never reaches the nameserver host, even when it answers the launch poll', async () => {
    // Silent to the first probe, so the controller goes on to launch the
    // bridge and poll for it -- the path that used to aim the connection at
    // whichever host answered.
    const remote = await fakeBridge(OTHER_HOST, 1);
    servers.push(remote.server);
    onWslWithCustomResolver();

    const trueBin = Bun.which('true');
    if (!trueBin) throw new Error('no `true` binary to stand in for desktop-bridge.exe');
    class Controller extends DesktopController {
      protected override findBridgeExecutable(): string { return trueBin!; }
      protected override launchReadyTimeoutMs = 1500;
    }
    const ctrl = new Controller(remote.port);

    let typed: unknown = null;
    try {
      await ctrl.typeText('hunter2-the-model-typed-this');
      typed = 'sent';
    } catch (err) {
      typed = err;
    }
    await ctrl.disconnect().catch(() => {});

    expect(remote.typed).toEqual([]);
    expect(remote.connections).toBe(0);
    expect(typed).toBeInstanceOf(Error);
    expect(String((typed as Error).message)).toContain('not reachable on 127.0.0.1:');
  }, 20_000);
});

/** The bridge bound IPv4 only; a peer on [::1] at the same port is someone else. */
async function bridgeAndIpv6Squatter(): Promise<{ bridge: FakeBridge; squatter: FakeBridge } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bridge = await fakeBridge('127.0.0.1');
    servers.push(bridge.server);
    const squatter: FakeBridge = { server: null as unknown as Server, port: bridge.port, connections: 0, typed: [] };
    try {
      squatter.server = await new Promise<Server>((resolve, reject) => {
        const s = createServer((socket) => {
          squatter.connections++;
          socket.on('error', () => {});
          socket.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n').filter(Boolean)) {
              const req = JSON.parse(line) as { method: string; params: { text?: string }; id: number };
              if (req.method === 'typeText') squatter.typed.push(String(req.params.text));
              socket.write(JSON.stringify({ jsonrpc: '2.0', result: req.method === 'ping' ? 'pong' : { success: true }, id: req.id }) + '\n');
            }
          });
        });
        s.once('error', reject);
        s.listen(bridge.port, '::1', () => resolve(s));
      });
      servers.push(squatter.server);
      return { bridge, squatter };
    } catch {
      // No IPv6 loopback, or the port is taken there: try another port.
    }
  }
  return null;
}

/** Whether this host has an IPv6 loopback to squat on at all. */
const HAS_IPV6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

describe('the bridge probe (#800 review)', () => {
  test.skipIf(!HAS_IPV6_LOOPBACK)('typed text goes to the IPv4 bridge, not to a squatter on [::1] at the same port', async () => {
    const pair = await bridgeAndIpv6Squatter();
    if (!pair) throw new Error('could not bind the same port on 127.0.0.1 and ::1 in five tries');
    class Controller extends DesktopController {
      protected override findBridgeExecutable(): string { return '/legacy/desktop-bridge.exe'; }
    }
    const ctrl = new Controller(pair.bridge.port);
    try {
      await ctrl.typeText('hunter2-the-model-typed-this');
    } finally {
      await ctrl.disconnect();
    }
    expect(pair.bridge.typed).toEqual(['hunter2-the-model-typed-this']);
    expect(pair.squatter.typed).toEqual([]);
    expect(pair.squatter.connections).toBe(0);
  });

  /** A peer that answers every connection with `reply`, then holds it open. */
  async function replying(reply: (socket: Socket) => void): Promise<number> {
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => reply(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as { port: number }).port;
  }

  test('a reply that merely mentions pong is not the bridge', async () => {
    for (const line of ['pong', '{"jsonrpc":"2.0","error":{"message":"no pong for you"},"id":-1}', '{"jsonrpc":"2.0","result":"pong","id":7}']) {
      const port = await replying((s) => s.write(line + '\n'));
      expect({ line, alive: await isSidecarRunning(port) }).toEqual({ line, alive: false });
    }
    // The bridge's own reply still is (Program.cs before 28e43ed, CRLF on Windows).
    const port = await replying((s) => s.write('{"jsonrpc":"2.0","result":"pong","id":-1}\r\n'));
    expect(await isSidecarRunning(port)).toBe(true);
    // And with a leading byte-order mark, which a .NET writer can emit.
    const bomPort = await replying((s) => s.write('\uFEFF{"jsonrpc":"2.0","result":"pong","id":-1}\r\n'));
    expect(await isSidecarRunning(bomPort)).toBe(true);
  });

  test('a peer that streams a reply with no line end is dropped at the cap, not held to the timeout', async () => {
    let sent = 0;
    const port = await replying((s) => {
      const junk = 'x'.repeat(64 * 1024);
      const pump = (): void => { while (!s.destroyed && s.write(junk)) sent += junk.length; if (!s.destroyed) s.once('drain', pump); };
      pump();
    });
    const started = performance.now();
    expect(await isSidecarRunning(port)).toBe(false);
    // The probe's own timeout is 2 s (2.5 s with its safety margin).
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sent).toBeGreaterThan(0);
  });
});
