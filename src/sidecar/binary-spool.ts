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
  /** Lazy getter: reads the spool file and base64-encodes on access. */
  data: string;
}

export class BinarySpool {
  private readonly dir: string;
  private sweepTimer: Timer | null = null;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'cache', 'sidecar-spool');
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

    const descriptor = { type: 'inline', mime_type: mimeType } as SpooledBinaryDescriptor;
    Object.defineProperty(descriptor, 'data', {
      enumerable: true,
      configurable: true,
      get(): string {
        try {
          return readFileSync(filePath).toString('base64');
        } catch (err) {
          console.warn(`[BinarySpool] Spool file gone (TTL ${FILE_TTL_MS}ms exceeded?):`, err);
          return '';
        }
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
