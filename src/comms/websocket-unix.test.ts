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
