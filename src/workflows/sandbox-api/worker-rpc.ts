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

import { createServer } from "node:http";
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

/** How long a timed-out sandboxId stays eligible for late-arrival reporting. */
const ABANDONED_RETENTION_MS = 5 * 60_000;

type ConnectionWaiter = {
  resolve: (engineClient: EngineContract) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerRpcServer {
  private io: Server | null = null;
  private readonly connections = new Map<string, ConnectedSandbox>();
  private readonly waiters = new Map<string, ConnectionWaiter[]>();
  /**
   * sandboxId -> when we stopped waiting for it. An engine that dials in
   * after the deadline is the single most useful thing to know when acquires
   * time out: it separates "the host is too slow for the budget" (raise the
   * budget) from "the engine never dialed at all" (something upstream of the
   * socket is broken). Without this the two look identical in the log.
   */
  private readonly abandoned = new Map<string, number>();
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

    // Bind the HTTP server ourselves rather than via `io.listen(port)`: that
    // helper ignores the bind host and listens on every interface, which on a
    // shared host exposes the engine RPC channel (and the sandboxIds flowing
    // over it) to anything that can reach the box. The engine always dials
    // 127.0.0.1, so loopback is the only address it needs.
    const httpServer = createServer();
    this.io.attach(httpServer);

    await new Promise<void>((res, rej) => {
      const onListening = () => {
        httpServer.off("error", onError);
        const addr = httpServer.address();
        if (addr && typeof addr === "object") this.actualPort = addr.port;
        res();
      };
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        rej(err);
      };
      httpServer.once("listening", onListening);
      httpServer.once("error", onError);
      httpServer.listen(this.desiredPort, this.host);
    });

    // Keep listening for errors past startup. A server-level error after bind
    // (EMFILE when the daemon has exhausted its file descriptors, for
    // instance) stops new engines from being accepted while every other part
    // of the daemon keeps running -- engines then dial, get nothing, and
    // silently retry until their acquire times out. Unhandled, that error is
    // invisible; logged, it names the problem outright.
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      console.error(
        `[worker-rpc] engine RPC server error (${err.code ?? "unknown"}): ${err.message}. ` +
          `Engines cannot connect while this persists.`,
      );
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
    this.abandoned.clear();
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
        this.markAbandoned(sandboxId);
        reject(new Error(`engine ${sandboxId} did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter: ConnectionWaiter = { resolve, reject, timer };
      const queue = this.waiters.get(sandboxId);
      if (queue) queue.push(waiter);
      else this.waiters.set(sandboxId, [waiter]);
    });
  }

  /**
   * Note that we stopped waiting on a sandbox, so a late connection can be
   * reported. Entries are pruned by age -- an engine that never arrives must
   * not leave one behind forever.
   */
  private markAbandoned(sandboxId: string): void {
    const cutoff = Date.now() - ABANDONED_RETENTION_MS;
    for (const [id, at] of this.abandoned) {
      if (at < cutoff) this.abandoned.delete(id);
    }
    this.abandoned.set(sandboxId, Date.now());
  }

  private onConnection(socket: Socket): void {
    const auth = socket.handshake.auth as { sandboxId?: string } | undefined;
    const sandboxId = auth?.sandboxId;
    if (!sandboxId || typeof sandboxId !== "string") {
      // Never expected from our own engine bundle, so say so rather than
      // dropping the socket in silence.
      console.warn("[worker-rpc] rejected engine connection: missing sandboxId in auth");
      socket.emit("worker_error", "missing sandboxId in auth");
      socket.disconnect(true);
      return;
    }
    // Report a late arrival before the registry check: by the time an engine
    // dials in past its deadline, `EngineRuntime` has already terminated the
    // sandbox, so the rejection below would otherwise be the only trace and
    // it would look like a different problem entirely.
    const abandonedAt = this.abandoned.get(sandboxId);
    if (abandonedAt !== undefined) {
      this.abandoned.delete(sandboxId);
      console.warn(
        `[worker-rpc] engine ${sandboxId} connected ${Date.now() - abandonedAt}ms AFTER the daemon ` +
          `gave up waiting for it. The engine works; the handshake budget is too small for this ` +
          `host -- raise JARVIS_ENGINE_HANDSHAKE_TIMEOUT_MS.`,
      );
    }
    const record = this.registry.get(sandboxId);
    if (!record) {
      // The engine's socket.io client reconnects forever, so a sandbox that
      // is rejected here keeps dialing while its acquire waits out the full
      // deadline -- indistinguishable from an engine that never booted unless
      // we log the rejection.
      console.warn(
        `[worker-rpc] rejected engine connection for sandbox ${sandboxId}: unknown or terminated sandbox`,
      );
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
