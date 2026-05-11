/**
 * Socket.io WS server hosting the engine subprocess's two RPC channels:
 *
 *   - WorkerContract:        engine -> daemon, awaiting ack
 *     (updateRunProgress / updateStepProgress / uploadRunLog / sendFlowResponse)
 *
 *   - WorkerNotifyContract:  engine -> daemon, fire-and-forget
 *     (stdout / stderr -- forwarded console output from pieces)
 *
 * Plus an outbound channel where the daemon calls back into the engine:
 *
 *   - EngineContract:        daemon -> engine, awaiting ack
 *     (executeOperation -- sent at flow start / property fetch / trigger hook /
 *      auth validation / piece-metadata extraction)
 *
 * All three multiplex over the same socket.io connection per sandbox; the
 * connection is opened by the engine subprocess on boot and stays alive for
 * the sandbox's lifetime. We bind socket.io to its own port (separate from
 * the HTTP /v1/* listener) because the engine sees them as two distinct
 * endpoints (AP_SANDBOX_WS_PORT vs internalApiUrl).
 */

import { Server, type Socket } from "socket.io";
import type { SandboxRegistry } from "./sandbox-registry";
import { createNotifyServer, createRpcClient, createRpcServer } from "./rpc";
import type { WorkerContract, WorkerNotifyContract, EngineContract } from "./contracts";

export interface WorkerRpcServerOptions {
  registry: SandboxRegistry;
  /** Bind host. Default 127.0.0.1. */
  host?: string;
  /** Bind port. Default 0 (OS-assigned). */
  port?: number;
  /** WorkerContract handlers, scoped by sandboxId. */
  workerHandlers: WorkerContractHandlers;
  /** WorkerNotifyContract handlers, scoped by sandboxId. */
  notifyHandlers: NotifyContractHandlers;
  /** Engine RPC ack timeout. Default 60s, matching upstream. */
  engineRpcTimeoutMs?: number;
}

/**
 * WorkerContract methods receive an extra `sandboxId` so handlers can scope
 * state without inspecting the socket auth themselves.
 */
export interface WorkerContractHandlers {
  updateRunProgress(sandboxId: string, input: Parameters<WorkerContract["updateRunProgress"]>[0]): Promise<void>;
  updateStepProgress(sandboxId: string, input: Parameters<WorkerContract["updateStepProgress"]>[0]): Promise<void>;
  uploadRunLog(sandboxId: string, input: Parameters<WorkerContract["uploadRunLog"]>[0]): Promise<void>;
  sendFlowResponse(sandboxId: string, input: Parameters<WorkerContract["sendFlowResponse"]>[0]): Promise<void>;
}

export interface NotifyContractHandlers {
  stdout(sandboxId: string, input: Parameters<WorkerNotifyContract["stdout"]>[0]): void;
  stderr(sandboxId: string, input: Parameters<WorkerNotifyContract["stderr"]>[0]): void;
}

interface ConnectedSandbox {
  socket: Socket;
  engineClient: EngineContract;
}

type ConnectionWaiter = {
  resolve: (engineClient: EngineContract) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerRpcServer {
  private io: Server | null = null;
  private readonly connections = new Map<string, ConnectedSandbox>();
  private readonly waiters = new Map<string, ConnectionWaiter[]>();
  private readonly registry: SandboxRegistry;
  private readonly workerHandlers: WorkerContractHandlers;
  private readonly notifyHandlers: NotifyContractHandlers;
  private readonly engineRpcTimeoutMs: number;
  private readonly host: string;
  private readonly desiredPort: number;
  private actualPort: number | null = null;

  constructor(opts: WorkerRpcServerOptions) {
    this.registry = opts.registry;
    this.workerHandlers = opts.workerHandlers;
    this.notifyHandlers = opts.notifyHandlers;
    this.engineRpcTimeoutMs = opts.engineRpcTimeoutMs ?? 60_000;
    this.host = opts.host ?? "127.0.0.1";
    this.desiredPort = opts.port ?? 0;
  }

  /**
   * Start the socket.io server. Resolves once the server is listening so
   * `getPort()` is safe to call afterwards.
   */
  async start(): Promise<void> {
    if (this.io) return;
    this.io = new Server({
      // Engine clients negotiate via polling-then-upgrade by default; allow
      // both transports so the upstream client connects without a config
      // override on its side.
      transports: ["polling", "websocket"],
      path: "/worker/ws",
      // Auth check happens in the connection handler below; the middleware
      // form rejects with a generic error, which is harder to debug.
    });

    this.io.on("connection", (socket) => this.onConnection(socket));

    await new Promise<void>((res, rej) => {
      try {
        const httpServer = this.io!.listen(this.desiredPort).httpServer;
        const onListening = () => {
          httpServer?.off("error", onError);
          const addr = httpServer?.address();
          if (addr && typeof addr === "object") this.actualPort = addr.port;
          res();
        };
        const onError = (err: Error) => {
          httpServer?.off("listening", onListening);
          rej(err);
        };
        if (httpServer?.listening) {
          onListening();
        } else {
          httpServer?.once("listening", onListening);
          httpServer?.once("error", onError);
        }
      } catch (e) {
        rej(e);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.io) return;
    for (const conn of this.connections.values()) conn.socket.disconnect(true);
    this.connections.clear();
    // Reject anyone still awaiting a connect that's not going to happen now.
    for (const [sandboxId, queue] of this.waiters) {
      for (const w of queue) {
        clearTimeout(w.timer);
        w.reject(new Error(`engine ${sandboxId} wait aborted: server stopping`));
      }
    }
    this.waiters.clear();
    // socket.io's close(cb) doesn't always invoke the callback under Bun's
    // node:http shim when there are no remaining clients (observed during
    // teardown of test cases that never connected). Cap the wait so a stuck
    // close() can't deadlock the daemon's shutdown sequence.
    await Promise.race([
      new Promise<void>((res) => this.io!.close(() => res())),
      new Promise<void>((res) => setTimeout(res, 500)),
    ]);
    this.io = null;
    this.actualPort = null;
  }

  getPort(): number {
    if (this.actualPort === null) throw new Error("WorkerRpcServer not started");
    return this.actualPort;
  }

  /**
   * Returns the engine RPC client for a given sandbox. Throws if the sandbox
   * has not yet connected (race between spawn and first executeOperation call).
   */
  engineClient(sandboxId: string): EngineContract {
    const conn = this.connections.get(sandboxId);
    if (!conn) throw new Error(`engine for sandbox ${sandboxId} not connected`);
    return conn.engineClient;
  }

  /**
   * Resolve once a sandbox connects (or reject after timeout). Waiters are
   * stored per-sandboxId and drained by `onConnection` the moment the engine
   * registers, avoiding a per-call setInterval poll for every sandbox boot.
   */
  async waitForConnection(sandboxId: string, timeoutMs = 10_000): Promise<EngineContract> {
    const existing = this.connections.get(sandboxId);
    if (existing) return existing.engineClient;
    return new Promise<EngineContract>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter on timeout. Other queued waiters (rare but
        // possible if multiple callers race) keep their own timers.
        const queue = this.waiters.get(sandboxId);
        if (queue) {
          const idx = queue.findIndex((w) => w.timer === timer);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.waiters.delete(sandboxId);
        }
        reject(new Error(`engine ${sandboxId} did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter: ConnectionWaiter = { resolve, reject, timer };
      const queue = this.waiters.get(sandboxId);
      if (queue) queue.push(waiter);
      else this.waiters.set(sandboxId, [waiter]);
    });
  }

  private onConnection(socket: Socket): void {
    const auth = socket.handshake.auth as { sandboxId?: string } | undefined;
    const sandboxId = auth?.sandboxId;
    if (!sandboxId || typeof sandboxId !== "string") {
      socket.emit("worker_error", "missing sandboxId in auth");
      socket.disconnect(true);
      return;
    }
    const record = this.registry.get(sandboxId);
    if (!record) {
      socket.emit("worker_error", "unknown or terminated sandbox");
      socket.disconnect(true);
      return;
    }

    // Wire up bidirectional RPC + notify on this socket.
    createRpcServer<WorkerContract>(socket, {
      updateRunProgress: (input) => this.workerHandlers.updateRunProgress(sandboxId, input),
      updateStepProgress: (input) => this.workerHandlers.updateStepProgress(sandboxId, input),
      uploadRunLog: (input) => this.workerHandlers.uploadRunLog(sandboxId, input),
      sendFlowResponse: (input) => this.workerHandlers.sendFlowResponse(sandboxId, input),
    });
    createNotifyServer<WorkerNotifyContract>(socket, {
      stdout: (input) => this.notifyHandlers.stdout(sandboxId, input),
      stderr: (input) => this.notifyHandlers.stderr(sandboxId, input),
    });

    const engineClient = createRpcClient<EngineContract>(
      // socket.io's Socket exposes the same surface (emit/on/timeout).
      socket as unknown as Parameters<typeof createRpcClient>[0],
      this.engineRpcTimeoutMs,
    );

    this.connections.set(sandboxId, { socket, engineClient });

    // Drain any pending waiters for this sandbox.
    const queue = this.waiters.get(sandboxId);
    if (queue) {
      this.waiters.delete(sandboxId);
      for (const w of queue) {
        clearTimeout(w.timer);
        w.resolve(engineClient);
      }
    }

    socket.on("disconnect", () => {
      this.connections.delete(sandboxId);
    });
  }
}
