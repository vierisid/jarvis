import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BinarySpool } from './binary-spool.ts';

const dirs: string[] = [];
function makeSpool(): { spool: BinarySpool; dataDir: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'jarvis-spool-test-'));
  dirs.push(dataDir);
  const spool = new BinarySpool(dataDir);
  spool.start();
  return { spool, dataDir };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('BinarySpool', () => {
  test('descriptor keeps the inline shape and round-trips the payload', () => {
    const { spool } = makeSpool();
    try {
      const payload = Buffer.from('jarvis-spool-payload'.repeat(1000));
      const descriptor = spool.spool(payload, 'image/png')!;
      expect(descriptor.type).toBe('inline');
      expect(descriptor.mime_type).toBe('image/png');
      expect(Buffer.from(descriptor.data, 'base64').equals(payload)).toBe(true);
      // Survives JSON serialization like a plain inline descriptor
      const json = JSON.parse(JSON.stringify(descriptor));
      expect(Buffer.from(json.data, 'base64').equals(payload)).toBe(true);
    } finally {
      spool.stop();
    }
  });

  test('payload lives on disk, not in the descriptor', () => {
    const { spool, dataDir } = makeSpool();
    try {
      spool.spool(Buffer.alloc(1024, 7), 'application/octet-stream');
      const spoolDir = path.join(dataDir, 'cache', 'sidecar-spool');
      expect(readdirSync(spoolDir).length).toBe(1);
    } finally {
      spool.stop();
    }
  });

  test('start() wipes leftovers from a previous run', () => {
    const { spool, dataDir } = makeSpool();
    spool.spool(Buffer.alloc(64), 'application/octet-stream');
    spool.stop();

    const second = new BinarySpool(dataDir);
    second.start();
    try {
      const spoolDir = path.join(dataDir, 'cache', 'sidecar-spool');
      expect(existsSync(spoolDir)).toBe(true);
      expect(readdirSync(spoolDir).length).toBe(0);
    } finally {
      second.stop();
    }
  });

  test('missing spool file degrades to null so typeof-string guards reject it', () => {
    const { spool, dataDir } = makeSpool();
    try {
      const descriptor = spool.spool(Buffer.alloc(64), 'image/png')!;
      rmSync(path.join(dataDir, 'cache', 'sidecar-spool'), { recursive: true, force: true });
      expect(descriptor.data as string | null).toBeNull();
      expect(typeof descriptor.data === 'string').toBe(false);
      expect(spool.stats().expiredReads).toBeGreaterThan(0);
    } finally {
      spool.stop();
    }
  });

  test('double read within one synchronous block hits the cache, then releases', async () => {
    const { spool, dataDir } = makeSpool();
    try {
      const payload = Buffer.alloc(2048, 3);
      const descriptor = spool.spool(payload, 'image/png')!;
      // Same synchronous block: typeof guard + use, like real consumers
      expect(typeof descriptor.data === 'string').toBe(true);
      const first = descriptor.data;
      rmSync(path.join(dataDir, 'cache', 'sidecar-spool'), { recursive: true, force: true });
      // File is gone but the cache still serves the same block
      expect(descriptor.data).toBe(first);
      // After a microtask the cache is released — next read misses
      await Promise.resolve();
      expect(descriptor.data as string | null).toBeNull();
    } finally {
      spool.stop();
    }
  });

  test('write failure returns null so the caller keeps the payload inline', () => {
    const { spool, dataDir } = makeSpool();
    try {
      rmSync(path.join(dataDir, 'cache', 'sidecar-spool'), { recursive: true, force: true });
      expect(spool.spool(Buffer.alloc(64), 'image/png')).toBeNull();
      expect(spool.stats().spooled).toBe(0);
    } finally {
      spool.stop();
    }
  });

  test('stats counts spooled payloads and bytes', () => {
    const { spool } = makeSpool();
    try {
      spool.spool(Buffer.alloc(100), 'a/b');
      spool.spool(Buffer.alloc(50), 'a/b');
      expect(spool.stats().spooled).toBe(2);
      expect(spool.stats().spooledBytes).toBe(150);
    } finally {
      spool.stop();
    }
  });
});
