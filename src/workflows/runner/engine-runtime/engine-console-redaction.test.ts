/**
 * A failed HTTP request's bodies and headers never reach engine stderr
 * (runtime/engine-console-redaction.ts, wired by the registered worker-socket
 * patch). A REAL engine loads a piece module that logs what the published
 * `@activepieces/pieces-common` HttpClient logs on a failure, and what a piece
 * logs when it prints an AxiosError it caught; what the engine wrote to its
 * stdout and stderr, which the daemon copies into its own log, is checked.
 * Gated on a cached bundle (or `JARVIS_TEST_ENGINE_BUILD=1`) like the other
 * engine-runtime end-to-end tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { SandboxApi } from "../../sandbox-api/server";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import { CredentialResolver } from "../../credentials/adapter";
import { EngineRuntime } from "./engine-runtime";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skip = initialCached === null && !buildOptIn;
const PIECE = "@activepieces/piece-http-error-logger";
const SECRETS = ["BODY-SECRET-1", "RESP-SECRET-2", "HDR-SECRET-3"];

describe.skipIf(skip)("a real engine loading a piece whose HTTP request failed", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let root = "";
  let doneFile = "";

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ host: "127.0.0.1", port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    root = mkdtempSync(resolve(tmpdir(), "jarvis-console-redaction-"));
    doneFile = resolve(root, "done.txt");
    const dir = resolve(root, `node_modules/${PIECE}`);
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: PIECE, version: "0.0.1", main: "src/index.js" }));
    // The published pieces-common HttpError and its log line, verbatim in
    // shape; and an AxiosError, whose config carries the request headers.
    writeFileSync(resolve(dir, "src/index.js"), `
      class HttpError extends Error {
        constructor(requestBody, err) {
          super(JSON.stringify({ response: { status: err.response.status, body: err.response.data }, request: { body: requestBody } }));
          this.requestBody = requestBody; this.status = err.response.status; this.responseBody = err.response.data;
        }
        errorMessage() { return { response: { status: this.status, body: this.responseBody }, request: { body: this.requestBody } }; }
        get response() { return { status: this.status, body: this.responseBody }; }
        get request() { return { body: this.requestBody }; }
      }
      const axiosError = Object.assign(new Error("Request failed with status code 401"), {
        name: "AxiosError", isAxiosError: true,
        config: { headers: { Authorization: "Bearer ${SECRETS[2]}" } },
        response: { status: 401, data: { refresh_token: "${SECRETS[1]}" } },
      });
      const failure = new HttpError({ password: "${SECRETS[0]}" }, axiosError);
      console.error("[HttpClient#(sanitized error message)] Request failed:", failure);
      console.error(axiosError);
      console.warn("retrying after " + failure.message);
      console.log("marker-console-redaction-done");
      require("node:fs").writeFileSync(${JSON.stringify(doneFile)}, "done");
      exports.httpErrorLogger = {};
    `);
    runtime = new EngineRuntime({
      api,
      bundlePath: cached.bundlePath, expectedDigest: cached.digest,
      pool: false,
      customPiecesPaths: [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"), root],
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    await api.stop();
    closeWorkflowDb();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("engine stdout and stderr carry the status, never the bodies or headers", async () => {
    // The daemon forwards engine output to its own streams (bindEngineStream).
    const seen: string[] = [];
    const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { seen.push(String(chunk)); return (out as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { seen.push(String(chunk)); return (err as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
    const handle = await runtime!.acquire({ runId: "redact-" + SandboxRegistry.newSandboxId(), projectId: "redact-project" });
    try {
      // The piece has no valid metadata; loading its module is the point.
      await handle.extractPieceMetadata({ pieceName: PIECE, pieceVersion: "0.0.1" }).catch(() => undefined);
      const deadline = Date.now() + 20_000;
      while (!(existsSync(doneFile) && seen.join("").includes("marker-console-redaction-done")) && Date.now() < deadline) await Bun.sleep(100);
    } finally {
      process.stdout.write = out as typeof process.stdout.write;
      process.stderr.write = err as typeof process.stderr.write;
      await handle.release();
    }
    const text = seen.join("");
    expect(text).toContain("marker-console-redaction-done");
    expect(text).toContain("Request failed: HttpError: request failed (status 401)");
    expect(text).toContain("AxiosError: request failed (status 401)");
    expect(text).toContain("retrying after [request and response bodies withheld]");
    for (const secret of SECRETS) expect(text.includes(secret) ? secret : "absent").toBe("absent");
  }, 60_000);
});
