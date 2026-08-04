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

  test('missing spool file degrades to empty data instead of throwing', () => {
    const { spool, dataDir } = makeSpool();
    try {
      const descriptor = spool.spool(Buffer.alloc(64), 'image/png')!;
      rmSync(path.join(dataDir, 'cache', 'sidecar-spool'), { recursive: true, force: true });
      expect(descriptor.data).toBe('');
    } finally {
      spool.stop();
    }
  });
});
