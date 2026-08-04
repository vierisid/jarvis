/**
 * Binary Spool — Disk-Backed Large Binary Payloads
 *
 * Ref-protocol binaries (screenshots, region captures, audio segments) can be
 * up to 50 MB raw — ~66 MB once base64-encoded. Holding them inline on queued
 * events means a burst of captures pins hundreds of MB of heap until the
 * scheduler drains. Above a threshold the payload is written to disk instead,
 * and the event carries a descriptor whose `data` property lazily reads and
 * base64-encodes the file on first access. Consumers keep reading
 * `binary.data` unchanged; memory is only paid at the moment of consumption.
 *
 * Spool files are wiped at startup and swept on a TTL: descriptors can escape
 * the dispatch scope (rpc_result consumers read `result._binary` after the
 * RPC promise resolves), so files must outlive dispatch but not the process.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Payloads above this size are spooled to disk instead of held as base64. */
export const SPOOL_THRESHOLD_BYTES = 1024 * 1024; // 1 MB

const SWEEP_INTERVAL_MS = 60_000;
const FILE_TTL_MS = 10 * 60_000;

export interface SpooledBinaryDescriptor {
  type: 'inline';
  mime_type: string;
  /**
   * Lazy getter: reads the spool file and base64-encodes on access. If the
   * file is gone (TTL sweep, manager restart) it yields `null` at runtime —
   * deliberately failing consumers' `typeof data === 'string'` guards so
   * they take their missing-binary path rather than serving a payload that
   * decodes to zero bytes. Declared `string` to match BinaryDataInline.
   */
  data: string;
}

/** Counters for observability — see BinarySpool.stats(). */
export interface BinarySpoolStats {
  /** Payloads written to disk since start(). */
  spooled: number;
  /** Total raw bytes written since start(). */
  spooledBytes: number;
  /** Accesses that found the spool file already deleted. */
  expiredReads: number;
}

export class BinarySpool {
  private readonly dir: string;
  private sweepTimer: Timer | null = null;
  private spooledCount = 0;
  private spooledBytes = 0;
  private expiredReads = 0;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'cache', 'sidecar-spool');
  }

  /** Counters since start(). Not persisted; resets on construction. */
  stats(): BinarySpoolStats {
    return {
      spooled: this.spooledCount,
      spooledBytes: this.spooledBytes,
      expiredReads: this.expiredReads,
    };
  }

  /** Wipe leftovers from a previous run and start the TTL sweep. */
  start(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Write the payload to a spool file and return a descriptor that looks like
   * an inline binary but materializes `data` from disk on access. Returns null
   * if the write fails (caller falls back to holding the payload in memory).
   */
  spool(payload: Buffer, mimeType: string): SpooledBinaryDescriptor | null {
    const filePath = path.join(this.dir, crypto.randomUUID());
    try {
      writeFileSync(filePath, payload);
    } catch (err) {
      console.warn('[BinarySpool] Write failed, keeping payload in memory:', err);
      return null;
    }
    this.spooledCount++;
    this.spooledBytes += payload.length;

    // Consumers read `data` twice in one synchronous block (a typeof guard,
    // then the actual use). Cache the encoded string across those reads and
    // release it on the next microtask, so a 50MB capture is read+encoded
    // once per consumption without pinning ~66MB for the descriptor's
    // (potentially long) lifetime.
    let cached: string | null = null;
    const spoolRef = this;
    const descriptor = { type: 'inline', mime_type: mimeType } as SpooledBinaryDescriptor;
    Object.defineProperty(descriptor, 'data', {
      enumerable: true,
      configurable: true,
      get(): string | null {
        if (cached !== null) return cached;
        try {
          cached = readFileSync(filePath).toString('base64');
        } catch (err) {
          spoolRef.expiredReads++;
          console.warn(`[BinarySpool] Spool file gone (TTL ${FILE_TTL_MS}ms exceeded?):`, err);
          return null;
        }
        queueMicrotask(() => { cached = null; });
        return cached;
      },
    });
    return descriptor;
  }

  private sweep(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const name of entries) {
      const filePath = path.join(this.dir, name);
      try {
        if (statSync(filePath).mtimeMs < cutoff) {
          rmSync(filePath, { force: true });
        }
      } catch {
        // Raced with another delete — fine.
      }
    }
  }
}
