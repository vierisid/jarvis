/**
 * Wire-compatible re-implementation of activepieces' RPC helpers
 * (`@activepieces/shared/lib/automation/engine/rpc.ts`).
 *
 * Why we don't import upstream's: the vendored tree is excluded from our
 * tsconfig, and dragging it back in would require widening tsc to swallow
 * upstream's Nx workspace path aliases. The helpers themselves are tiny
 * (proxies emitting `rpc` / `rpc-notify` events with `{method, payload}` and
 * an ack envelope on errors). We copy them here verbatim-by-shape so the
 * engine's own client speaks the same protocol.
 *
 * Event names + envelope shape MUST match upstream:
 *   - `rpc` event: payload `{method, payload}`, server replies via ack callback.
 *     On handler error, ack is called with `{__rpcError: string}` so the client
 *     can throw `RPC [method] handler threw: <message>`.
 *   - `rpc-notify` event: fire-and-forget (no ack), payload `{method, payload}`.
 */

const RPC_EVENT = "rpc";
const NOTIFY_EVENT = "rpc-notify";

// Loose contract type so callers don't have to spell every method out before
// using the proxy. Upstream uses `Record<string, (input: any) => any>` which
// rejects typed contracts whose methods don't include an index signature; we
// loosen to `object` and let the proxy do the wiring.
type Contract = object;

interface RpcSocket {
  emit(event: string, ...args: unknown[]): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
}

function isRpcErrorEnvelope(value: unknown): value is { __rpcError: string } {
  return typeof value === "object" && value !== null && "__rpcError" in value;
}

export function createRpcClient<T extends Contract>(socket: RpcSocket, timeoutMs: number): T {
  return new Proxy({} as T, {
    get(_target, method: string) {
      return async (payload: unknown) => {
        try {
          const result = await socket.timeout(timeoutMs).emitWithAck(RPC_EVENT, { method, payload });
          if (isRpcErrorEnvelope(result)) {
            throw new Error(`RPC [${method}] handler threw: ${result.__rpcError}`);
          }
          return result;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("RPC [")) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`RPC [${method}] failed (timeout: ${timeoutMs}ms): ${message}`);
        }
      };
    },
  });
}

export function createRpcServer<T extends Contract>(socket: RpcSocket, handlers: T): void {
  // The proxy-based client uses `keyof T` strings; the server side just looks
  // up by name at runtime. Cast through unknown so TS doesn't infer the
  // handlers as untyped function values.
  const dispatch = handlers as unknown as Record<string, (input: unknown) => unknown>;
  socket.on(
    RPC_EVENT,
    async (msg: { method: string; payload: unknown }, ack: (result: unknown) => void) => {
      const handler = dispatch[msg.method];
      if (!handler) {
        ack({ __rpcError: `unknown method ${msg.method}` });
        return;
      }
      try {
        const result = await handler(msg.payload);
        ack(result);
      } catch (error) {
        ack({ __rpcError: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}

export function createNotifyServer<T extends Contract>(socket: RpcSocket, handlers: T): void {
  const dispatch = handlers as unknown as Record<string, (input: unknown) => void>;
  socket.on(NOTIFY_EVENT, (msg: { method: string; payload: unknown }) => {
    const handler = dispatch[msg.method];
    if (!handler) return;
    try {
      handler(msg.payload);
    } catch {
      // Notify channel is fire-and-forget; swallow handler errors.
    }
  });
}

/** Useful for tests when we need a client with the same wire format. */
export function createNotifyClient<T extends Contract>(socket: RpcSocket): T {
  return new Proxy({} as T, {
    get(_target, method: string) {
      return (payload: unknown) => socket.emit(NOTIFY_EVENT, { method, payload });
    },
  });
}
