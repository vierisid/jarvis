import { test, expect, describe, afterEach } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from './websocket.ts';
import { resolveListen } from '../config/loader.ts';

describe('resolveListen', () => {
  test('defaults to TCP on daemon.port', () => {
    expect(resolveListen({ port: 3142 })).toEqual({ kind: 'tcp', port: 3142 });
    expect(resolveListen({ port: 3142, listen: '' })).toEqual({ kind: 'tcp', port: 3142 });
  });

  test('parses unix specs and requires an absolute path', () => {
    expect(resolveListen({ port: 3142, listen: 'unix:/run/jarvis/u_42.sock' })).toEqual({
      kind: 'unix',
      path: '/run/jarvis/u_42.sock',
    });
    expect(() => resolveListen({ port: 3142, listen: 'unix:relative.sock' })).toThrow(/absolute/);
  });

  test('rejects unknown schemes loudly (never a silent TCP fallback)', () => {
    // A malformed listen value on a shared host must NOT quietly bind a TCP
    // port that other tenants could reach.
    expect(() => resolveListen({ port: 3142, listen: 'tcp:0.0.0.0:80' })).toThrow(/Unsupported/);
  });
});

describe('unix-domain socket listener', () => {
  let server: WebSocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  test('serves HTTP over the socket, no TCP port bound, 0660 perms, stale file replaced', async () => {
    const sockPath = join(tmpdir(), `jarvis-test-${process.pid}-${Date.now()}.sock`);
    // Pre-create a stale socket file: a previous daemon run that crashed.
    await Bun.write(sockPath, '');

    server = new WebSocketServer(39997, sockPath);
    server.start();

    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).mode & 0o777).toBe(0o660);

    // Health endpoint answers through the socket...
    const res = await fetch('http://localhost/health', { unix: sockPath });
    expect(res.status).toBe(200);

    // ...and nothing answers on the TCP port (it was never bound).
    let tcpRefused = false;
    try {
      await fetch('http://localhost:39997/health', { signal: AbortSignal.timeout(500) });
    } catch {
      tcpRefused = true;
    }
    expect(tcpRefused).toBe(true);
  });
});

test('stop() removes the socket file (no dead-but-present socket)', async () => {
  const { existsSync } = await import('node:fs');
  const sockPath = join(tmpdir(), `jarvis-test-stop-${process.pid}-${Date.now()}.sock`);
  const s = new WebSocketServer(39995, sockPath);
  s.start();
  expect(existsSync(sockPath)).toBe(true);
  s.stop();
  expect(existsSync(sockPath)).toBe(false);
});

test('the socket is removed on graceful process exit even when stop() is never called', async () => {
  // Regression: the daemon stops several slow services (goal, awareness, the
  // bg-agent browser) BEFORE it reaches the WS service, so an ordered stop()
  // can run late or be cut off by jarvis stop's SIGKILL. A process.on('exit')
  // handler must clean the socket regardless of shutdown ordering. A child
  // process binds the socket and process.exit(0)s WITHOUT calling stop().
  const { existsSync } = await import('node:fs');
  const sockPath = join(tmpdir(), `jarvis-test-exit-${process.pid}-${Date.now()}.sock`);
  const child = `
    import { WebSocketServer } from ${JSON.stringify(join(import.meta.dir, 'websocket.ts'))};
    const s = new WebSocketServer(39994, ${JSON.stringify(sockPath)});
    s.start();
    if (!require('node:fs').existsSync(${JSON.stringify(sockPath)})) process.exit(2);
    // Exit WITHOUT s.stop() — the exit handler is the only cleanup path.
    process.exit(0);
  `;
  const proc = Bun.spawn(['bun', '-e', child], { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  expect(code).toBe(0);                 // child bound the socket
  expect(existsSync(sockPath)).toBe(false); // ...and the exit handler removed it
});

test('stop() deregisters the exit handler (restart-in-place on a new path is untouched)', async () => {
  const { existsSync, writeFileSync, unlinkSync } = await import('node:fs');
  const pathA = join(tmpdir(), `jarvis-test-a-${process.pid}-${Date.now()}.sock`);
  const pathB = join(tmpdir(), `jarvis-test-b-${process.pid}-${Date.now()}.sock`);
  // A child binds A, stops it, binds B, then exits without stopping B. If A's
  // handler leaked, it could unlink whatever now sits at A. Prove B is cleaned
  // and a decoy file left at A survives (A's handler was deregistered by stop).
  const child = `
    import { WebSocketServer } from ${JSON.stringify(join(import.meta.dir, 'websocket.ts'))};
    const fs = require('node:fs');
    const a = new WebSocketServer(39993, ${JSON.stringify(pathA)});
    a.start(); a.stop();
    fs.writeFileSync(${JSON.stringify(pathA)}, 'decoy'); // reclaim path A
    const b = new WebSocketServer(39992, ${JSON.stringify(pathB)});
    b.start();
    process.exit(0);
  `;
  const proc = Bun.spawn(['bun', '-e', child], { stdout: 'ignore', stderr: 'ignore' });
  expect(await proc.exited).toBe(0);
  expect(existsSync(pathB)).toBe(false); // B's handler cleaned it
  expect(existsSync(pathA)).toBe(true);  // A's decoy survived (handler deregistered)
  try { unlinkSync(pathA); } catch { /* cleanup */ }
});
