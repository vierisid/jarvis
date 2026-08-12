/**
 * RPC client/server helpers. The per-call ack timeout is the interesting
 * part: a single client-wide default cannot bound both a sub-second metadata
 * extraction and a ten-minute flow, and using the default for EXECUTE_FLOW
 * is what made every long flow fail at exactly 60s.
 */

import { describe, expect, test } from "bun:test";
import { createRpcClient } from "./rpc";

interface Contract {
  doThing(input: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** Records the timeout each call asks for; always acks successfully. */
function stubSocket(): {
  socket: Parameters<typeof createRpcClient>[0];
  timeouts: number[];
} {
  const timeouts: number[] = [];
  const socket = {
    emit: () => undefined,
    on: () => undefined,
    timeout(ms: number) {
      timeouts.push(ms);
      return { emitWithAck: async () => "ok" };
    },
  };
  return { socket: socket as Parameters<typeof createRpcClient>[0], timeouts };
}

describe("createRpcClient per-call timeout", () => {
  test("uses the client default when no override is given", async () => {
    const { socket, timeouts } = stubSocket();
    const client = createRpcClient<Contract>(socket, 60_000);
    await client.doThing({});
    expect(timeouts).toEqual([60_000]);
  });

  test("an override replaces the default for that call only", async () => {
    const { socket, timeouts } = stubSocket();
    const client = createRpcClient<Contract>(socket, 60_000);
    await client.doThing({}, { timeoutMs: 630_000 });
    await client.doThing({});
    expect(timeouts).toEqual([630_000, 60_000]);
  });

  test("a non-positive override falls back to the default", async () => {
    const { socket, timeouts } = stubSocket();
    const client = createRpcClient<Contract>(socket, 60_000);
    await client.doThing({}, { timeoutMs: 0 });
    expect(timeouts).toEqual([60_000]);
  });

  test("the timeout error names the deadline that was actually applied", async () => {
    const socket = {
      emit: () => undefined,
      on: () => undefined,
      timeout: () => ({
        emitWithAck: async () => {
          throw new Error("operation has timed out");
        },
      }),
    } as unknown as Parameters<typeof createRpcClient>[0];
    const client = createRpcClient<Contract>(socket, 60_000);
    await expect(client.doThing({}, { timeoutMs: 630_000 })).rejects.toThrow(
      /timeout: 630000ms/,
    );
  });
});
