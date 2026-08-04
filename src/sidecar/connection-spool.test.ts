import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerWebSocket } from 'bun';
import { SidecarConnection } from './connection.ts';
import { EventScheduler } from './scheduler.ts';
import { BinarySpool, SPOOL_THRESHOLD_BYTES } from './binary-spool.ts';
import type { SidecarEvent } from './protocol.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'jarvis-conn-spool-'));
  dirs.push(dataDir);
  const spool = new BinarySpool(dataDir);
  spool.start();
  const scheduler = new EventScheduler(); // not started — we inspect the queue
  const conn = new SidecarConnection(
    'sc-test',
    { send: () => {} } as unknown as ServerWebSocket<unknown>,
    scheduler,
    () => {},
    spool,
  );
  const spoolDir = path.join(dataDir, 'cache', 'sidecar-spool');
  const queued = () =>
    (scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> })
      .queues.get('sc-test') ?? [];
  return { conn, spool, spoolDir, queued };
}

async function sendRefEvent(conn: SidecarConnection, payload: Buffer): Promise<void> {
  const refId = crypto.randomUUID();
  const message = conn.handleMessage(JSON.stringify({
    type: 'sidecar_event',
    event_type: 'screen.capture',
    timestamp: Date.now(),
    payload: { kind: 'test' },
    binary: { type: 'ref', ref_id: refId, mime_type: 'image/png', size: payload.length },
  }));
  // Let handleMessage reach waitForBinary before delivering the frame
  await Promise.resolve();
  conn.handleBinary(Buffer.concat([Buffer.from(refId, 'ascii'), payload]));
  await message;
}

describe('SidecarConnection binary spooling', () => {
  test('ref binary above the threshold is spooled, payload intact via getter', async () => {
    const { conn, spool, spoolDir, queued } = setup();
    try {
      const payload = Buffer.alloc(SPOOL_THRESHOLD_BYTES + 1, 42);
      await sendRefEvent(conn, payload);

      expect(readdirSync(spoolDir).length).toBe(1);
      const event = queued()[0]!.event;
      const binary = event.binary as { type: string; mime_type: string; data: string };
      expect(binary.type).toBe('inline');
      expect(binary.mime_type).toBe('image/png');
      expect(Buffer.from(binary.data, 'base64').equals(payload)).toBe(true);
    } finally {
      spool.stop();
    }
  });

  test('ref binary at or below the threshold stays inline in memory', async () => {
    const { conn, spool, spoolDir, queued } = setup();
    try {
      const payload = Buffer.alloc(1024, 7);
      await sendRefEvent(conn, payload);

      expect(readdirSync(spoolDir).length).toBe(0);
      const binary = queued()[0]!.event.binary as { type: string; data: string };
      expect(binary.type).toBe('inline');
      expect(Buffer.from(binary.data, 'base64').equals(payload)).toBe(true);
    } finally {
      spool.stop();
    }
  });

  test('without a spool, large ref binaries still normalize inline', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'jarvis-conn-nospool-'));
    dirs.push(dataDir);
    const scheduler = new EventScheduler();
    const conn = new SidecarConnection(
      'sc-test',
      { send: () => {} } as unknown as ServerWebSocket<unknown>,
      scheduler,
      () => {},
    );
    const payload = Buffer.alloc(SPOOL_THRESHOLD_BYTES + 1, 9);
    await sendRefEvent(conn, payload);
    const queue = (scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> })
      .queues.get('sc-test')!;
    const binary = queue[0]!.event.binary as { type: string; data: string };
    expect(binary.type).toBe('inline');
    expect(Buffer.from(binary.data, 'base64').equals(payload)).toBe(true);
  });
});
