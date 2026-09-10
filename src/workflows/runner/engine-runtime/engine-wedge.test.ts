/**
 * The two ways a live engine stops answering, against a REAL engine and a real
 * socket. Both were found by hand while chasing a halted version rollout, and
 * both are invisible to the fake-EngineContract tests next door: one lives in
 * the socket layer the fakes replace, the other in the engine's own event loop.
 *
 * Gated on a cached bundle (or `JARVIS_TEST_ENGINE_BUILD=1`) like the other
 * engine-runtime end-to-end tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { SandboxApi } from "../../sandbox-api/server";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import { CredentialResolver } from "../../credentials/adapter";
import { EngineRuntime } from "./engine-runtime";
import { buildEngineBundle, findCachedBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildPieceCatalog } from "../../runtime/piece-catalog";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipWedgeTests = initialCached === null && !buildOptIn;

describe("a live engine that stops answering", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  const tmps: string[] = [];
  /** Set in beforeAll: the engine resolves piece MODULES through
   * customPiecesPaths, so the tree has to exist before the runtime does.
   * `pieceRoots` only drives discovery and is passed per build. */
  let wedgeRoot = "";

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ host: "127.0.0.1", port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    wedgeRoot = piecesDir([
      // Sorted discovery order: "a-blocks" is reached before "b-after".
      {
        name: "@activepieces/piece-a-blocks",
        main:
          "const until = Date.now() + 8000;\n" +
          "while (Date.now() < until) { Math.random(); }\n" +
          "export const blocks = {};\n",
      },
      { name: "@activepieces/piece-b-after", main: "export const after = {};\n" },
    ]);
    runtime = new EngineRuntime({
      api,
      bundlePath: cached.bundlePath,
      // No pooling: each acquire is its own process, so "was it replaced" is
      // observable rather than hidden behind the warm slot.
      pool: false,
      customPiecesPaths: [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"), wedgeRoot],
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    await api.stop();
    closeWorkflowDb();
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
  });

  /** A pieces tree: `main` is written verbatim as the piece's entry module. */
  function piecesDir(entries: Array<{ name: string; main: string }>): string {
    const root = mkdtempSync(resolve(tmpdir(), "jarvis-wedge-"));
    tmps.push(root);
    for (const { name, main } of entries) {
      const dir = resolve(root, "node_modules/@activepieces", name.replace("@activepieces/", ""));
      mkdirSync(resolve(dir, "src"), { recursive: true });
      writeFileSync(
        resolve(dir, "package.json"),
        JSON.stringify({ name, version: "0.0.1", main: "src/index.js" }),
      );
      writeFileSync(resolve(dir, "src/index.js"), main);
    }
    return root;
  }

  test.skipIf(skipWedgeTests)(
    "a disconnected engine fails in milliseconds rather than at the ack deadline",
    async () => {
      const handle = await runtime!.acquire({
        runId: "wedge-" + SandboxRegistry.newSandboxId(),
        projectId: "wedge-project",
      });
      try {
      // Prove the pipe works first. A non-existent piece answers with an error
      // REPLY, which is all this needs -- it means the round trip completed.
      await expect(
        handle.extractPieceMetadata({ pieceName: "@activepieces/piece-nope", pieceVersion: "0.0.1" }),
      ).rejects.toThrow();

      // Drop the connection the way a ping timeout or an over-limit frame
      // does. Reaching into `connections` because there is no public seam for
      // "pretend the socket died", and this is the fault being reproduced.
      const conns = (
        api.workerRpc as unknown as {
          connections: Map<string, { socket: { disconnect: (close: boolean) => void } }>;
        }
      ).connections;
      expect(conns.has(handle.sandboxId)).toBe(true);
      conns.get(handle.sandboxId)!.socket.disconnect(true);
      await new Promise((r) => setTimeout(r, 1500));

      // Before the per-send re-resolve, the handle kept emitting into the dead
      // socket and waited out the FULL ack deadline (60s + a 30s margin) on
      // every later operation. Anything near that is the bug back.
      const started = Date.now();
      await expect(
        handle.extractPieceMetadata({ pieceName: "@activepieces/piece-nope", pieceVersion: "0.0.1" }),
      ).rejects.toThrow(/no live connection/);
      expect(Date.now() - started).toBeLessThan(5_000);

      // And the engine is not fit to be reused, for the same reason a
      // transport failure makes one unfit.
      expect(handle.isAbandoned).toBe(true);
      } finally {
        // An acquired-but-unreleased engine survives `runtime.shutdown()` --
        // that only clears the warm slot -- and then reconnect-loops against a
        // closed port forever. A failed assertion must not leak one.
        await handle.release();
      }
    },
    60_000,
  );

  test.skipIf(skipWedgeTests)(
    "a RECONNECTING engine is picked up by the handle that was built before it",
    async () => {
      // The half the fix exists for, and the half a DISCONNECT cannot show:
      // socket.io-client treats a server-side `disconnect` packet as final and
      // never reconnects, so that path only ever proves the fail-fast branch.
      // Closing the underlying transport is what a dropped connection actually
      // looks like, and the client reconnects from it -- registering a NEW
      // client under the same sandbox id, which a handle holding the old one
      // would never see.
      const handle = await runtime!.acquire({
        runId: "reconn-" + SandboxRegistry.newSandboxId(),
        projectId: "reconn-project",
      });
      try {
        const conns = (
          api.workerRpc as unknown as {
            connections: Map<string, { id: string; socket: { conn: { close: () => void } } }>;
          }
        ).connections;
        const before = conns.get(handle.sandboxId)!.socket;
        (before as unknown as { conn: { close: () => void } }).conn.close();

        // Wait for a DIFFERENT socket object under the same sandbox id.
        let reconnected = false;
        for (let i = 0; i < 60; i++) {
          const now = conns.get(handle.sandboxId)?.socket;
          if (now && now !== before) {
            reconnected = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(reconnected).toBe(true);

        // The SAME handle must now talk to the new socket. An engine REPLY
        // (this piece does not exist, so an error reply) proves the round trip;
        // `not connected` would mean the handle never picked the new one up.
        await expect(
          handle.extractPieceMetadata({
            pieceName: "@activepieces/piece-nope",
            pieceVersion: "0.0.1",
          }),
        ).rejects.toThrow(/-> (INTERNAL_ERROR|USER_FAILURE)/);
        expect(handle.isAbandoned).toBe(false);
      } finally {
        await handle.release();
      }
    },
    60_000,
  );

  test.skipIf(skipWedgeTests)(
    "a piece that blocks the event loop does not take the rest of the catalog with it",
    async () => {
      // The production shape: one piece stops the engine answering ANYTHING
      // while the process stays alive, so every later piece times out. An
      // event loop blocked synchronously cannot be interrupted -- there is no
      // cancel message and no timer will run -- so the only recovery is to
      // destroy the process, which is what a timeout now does.
      const { failures } = await buildPieceCatalog({
        runtime: runtime!,
        pieceRoots: [resolve(wedgeRoot, "node_modules/@activepieces")],
        pieceTimeoutMs: 2_000,
        reporter: () => {},
      });

      const reasonFor = (n: string) => failures.find((f) => f.pieceName.includes(n))?.reason ?? "";
      // The blocker gets no answer, as designed.
      expect(reasonFor("a-blocks")).toContain("timed out");
      // THE ASSERTION THAT MATTERS: the piece after it was ANSWERED, on a
      // fresh engine. Carrying the blocked one forward times this out too, and
      // in prod that ran for 658 consecutive pieces.
      const after = reasonFor("b-after");
      expect(after).not.toContain("timed out");
      // An engine REPLY, not merely "some string": every reason begins with the
      // piece name, so asserting that would pass without the engine answering.
      expect(after).toMatch(/-> (INTERNAL_ERROR|USER_FAILURE)/);
    },
    120_000,
  );
});
