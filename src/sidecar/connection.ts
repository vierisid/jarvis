/**
 * Sidecar Connection — Per-Sidecar WebSocket Wrapper
 *
 * Manages a single sidecar's WebSocket connection, including message
 * parsing, validation, binary frame correlation, and heartbeat.
 */

import type { ServerWebSocket } from 'bun';
import type { RPCRequest, SidecarEvent } from './protocol.ts';
import type { EventScheduler } from './scheduler.ts';
import type { BinarySpool } from './binary-spool.ts';
import { SPOOL_THRESHOLD_BYTES } from './binary-spool.ts';
import { validateEvent, validateBinaryFrame, MAX_JSON_SIZE } from './validator.ts';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 3;
const BINARY_WAIT_TIMEOUT_MS = 5_000;

interface PendingBinary {
  resolve: (payload: Buffer) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

export class SidecarConnection {
  readonly sidecarId: string;
  private ws: ServerWebSocket<unknown>;
  private scheduler: EventScheduler;
  private pendingBinary = new Map<string, PendingBinary>();
  private heartbeatTimer: Timer | null = null;
  private missedPongs = 0;
  private alive = true;
  private onDisconnect: () => void;
  private binarySpool: BinarySpool | null;

  constructor(
    sidecarId: string,
    ws: ServerWebSocket<unknown>,
    scheduler: EventScheduler,
    onDisconnect: () => void,
    binarySpool?: BinarySpool,
  ) {
    this.sidecarId = sidecarId;
    this.ws = ws;
    this.scheduler = scheduler;
    this.onDisconnect = onDisconnect;
    this.binarySpool = binarySpool ?? null;
  }

  /** Send an RPC request to the sidecar */
  sendRPC(request: RPCRequest): void {
    try {
      this.ws.send(JSON.stringify(request));
    } catch (err) {
      console.error(`[SidecarConnection:${this.sidecarId}] Failed to send RPC:`, err);
    }
  }

  /** Handle an inbound text (JSON) message */
  async handleMessage(raw: string): Promise<void> {
    if (raw.length > MAX_JSON_SIZE) {
      console.warn(`[SidecarConnection:${this.sidecarId}] Message too large: ${raw.length} bytes`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[SidecarConnection:${this.sidecarId}] Invalid JSON`);
      return;
    }

    const result = validateEvent(parsed);
    if (!result.valid || !result.event) {
      console.warn(`[SidecarConnection:${this.sidecarId}] Validation failed: ${result.error}`);
      return;
    }

    const event = result.event;

    // If event references binary data via ref, wait for the binary frame, then
    // normalize it to an inline descriptor. Downstream consumers (rpc_result
    // handlers via result._binary, event listeners reading event.binary.data)
    // then see a single binary shape regardless of whether the sidecar inlined
    // it or sent it as a separate frame.
    if (event.binary?.type === 'ref') {
      const { ref_id: refId, mime_type: mimeType } = event.binary;
      try {
        const binaryPayload = await this.waitForBinary(refId);
        // Normalize to a single inline descriptor. We deliberately do NOT also
        // stash the raw Buffer on event.payload._binary: nothing reads it (events
        // consume event.binary.data; rpc_result consumers read the descriptor set
        // on the inner result by SidecarManager), and a base64 + Buffer pair held
        // both at once doubled the resident size of every ref binary (up to 50 MB).
        // Large payloads go to disk: base64 of a 50MB capture is ~66MB of
        // heap, and it would sit on the queued event until the scheduler
        // drains. The spooled descriptor keeps the same shape — `data` reads
        // the file back on access.
        const spooled = binaryPayload.length > SPOOL_THRESHOLD_BYTES
          ? this.binarySpool?.spool(binaryPayload, mimeType)
          : null;
        event.binary = spooled ?? {
          type: 'inline',
          mime_type: mimeType,
          data: binaryPayload.toString('base64'),
        };
      } catch (err) {
        console.warn(`[SidecarConnection:${this.sidecarId}] Binary wait failed for ${refId}:`, err);
        return;
      }
    }

    this.scheduler.enqueue(this.sidecarId, event, event.priority);
  }

  /** Handle an inbound binary frame */
  handleBinary(data: Buffer): void {
    const result = validateBinaryFrame(data);
    if (!result.valid || !result.refId) {
      console.warn(`[SidecarConnection:${this.sidecarId}] Invalid binary frame: ${result.error}`);
      return;
    }

    const pending = this.pendingBinary.get(result.refId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingBinary.delete(result.refId);
      pending.resolve(result.payload!);
    } else {
      console.warn(`[SidecarConnection:${this.sidecarId}] Unexpected binary ref: ${result.refId}`);
    }
  }

  /** Start heartbeat ping/pong */
  startHeartbeat(): void {
    this.missedPongs = 0;
    this.alive = true;

    this.heartbeatTimer = setInterval(() => {
      if (!this.alive) {
        this.missedPongs++;
        if (this.missedPongs >= MAX_MISSED_PONGS) {
          console.warn(`[SidecarConnection:${this.sidecarId}] ${MAX_MISSED_PONGS} missed pongs, disconnecting`);
          this.close();
          this.onDisconnect();
          return;
        }
      }

      this.alive = false;
      try {
        this.ws.ping();
      } catch {
        this.close();
        this.onDisconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Called when a pong is received */
  handlePong(): void {
    this.alive = true;
    this.missedPongs = 0;
  }

  /** Stop heartbeat */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Close connection and clean up. Pass a WS close code + reason for a graceful
   * "going away" (1001) on drain, so the sidecar sees a clean planned-restart
   * signal rather than an ambiguous drop (it reconnects either way).
   */
  close(code?: number, reason?: string): void {
    this.stopHeartbeat();

    // Reject all pending binary waits
    for (const [refId, pending] of this.pendingBinary) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingBinary.clear();

    try {
      if (code !== undefined) this.ws.close(code, reason);
      else this.ws.close();
    } catch {
      // Already closed
    }
  }

  private waitForBinary(refId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBinary.delete(refId);
        reject(new Error(`Binary frame timeout for ref ${refId}`));
      }, BINARY_WAIT_TIMEOUT_MS);

      this.pendingBinary.set(refId, { resolve, reject, timer });
    });
  }
}
