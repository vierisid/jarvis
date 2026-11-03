/**
 * Piece code must not be able to turn TLS certificate verification off for the
 * whole engine (engine-tls-guard.ts).
 *
 * Two levels. The shim itself, in a child bun process (it replaces
 * `process.env` and `fetch`, and the test runner has to keep its own), with a
 * control run WITHOUT the shim that proves the same write really does disable
 * verification, so a passing guard test is not just a broken server. Then a
 * REAL engine loading a piece module that does what the published Google
 * pieces do, gated on a cached bundle (or `JARVIS_TEST_ENGINE_BUILD=1`) like
 * the other engine-runtime end-to-end tests.
 *
 * Certificates are generated with openssl at run time rather than committed,
 * so no private key lives in the repo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ENGINE_TLS_GUARD_SHIM, TLS_REJECT_ENV } from "./engine-tls-guard";
import { ENGINE_ESBUILD_CONFIG, buildEngineBundle, findCachedBundle, ENGINE_BUILD_PATHS } from "./build";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { SandboxApi } from "../../sandbox-api/server";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import { CredentialResolver } from "../../credentials/adapter";
import { EngineRuntime } from "./engine-runtime";

const hasOpenssl = Bun.spawnSync(["openssl", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
// CI must run these; a dev box without openssl skips them.
const skipTls = !hasOpenssl && !process.env.CI;

const tmps: string[] = [];
let certDir = "";
let certPem = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let url = "";

beforeAll(() => {
  if (skipTls) return;
  certDir = mkdtempSync(resolve(tmpdir(), "jarvis-tls-guard-"));
  tmps.push(certDir);
  const gen = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", resolve(certDir, "key.pem"), "-out", resolve(certDir, "cert.pem"),
    "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdout: "ignore", stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`);
  certPem = readFileSync(resolve(certDir, "cert.pem"), "utf8");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key: readFileSync(resolve(certDir, "key.pem"), "utf8"), cert: certPem },
    fetch: async (req, srv) => {
      if (srv.upgrade(req, { data: req.headers.get("sec-websocket-protocol") ?? "" })) return undefined;
      return new Response(`${req.method}:${await req.text()}`);
    },
    websocket: { open: (ws) => { ws.send(`proto=${ws.data}`); }, message: () => {} },
  });
  url = `https://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  server?.stop(true);
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/**
 * Probes run in the child: each prints `<label> ACCEPTED|REJECTED`. `fetch`,
 * `node:https` and `WebSocket` are separate code paths in Bun and all honour
 * the env var, so each is checked.
 */
const probes = (u: string) => `
const https = require("node:https");
const tf = async (label, init) => {
  try { await (await fetch(${JSON.stringify(u)}, init)).text(); console.log(label + " ACCEPTED"); }
  catch (e) { console.log(label + " REJECTED"); }
};
const th = (label, opts) => new Promise((done) => {
  const q = https.get(${JSON.stringify(u)}, opts || {}, (r) => { r.resume(); console.log(label + " ACCEPTED"); done(); });
  q.on("error", () => { console.log(label + " REJECTED"); done(); });
});
const tw = (label, second) => new Promise((done) => {
  const ws = new WebSocket(${JSON.stringify(u.replace("https:", "wss:"))}, second);
  const t = setTimeout(() => { console.log(label + " TIMEOUT"); done(); }, 5000);
  ws.onmessage = (m) => { clearTimeout(t); console.log(label + " ACCEPTED " + m.data); ws.close(); done(); };
  ws.onerror = () => { clearTimeout(t); console.log(label + " REJECTED"); done(); };
});
`;

async function inChild(prefix: string, body: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", `${prefix}\n${probes(url)}\n(async () => {\n${body}\n})();`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}${err}`;
}

// What the published pieces' FetchHttpClient / AxiosHttpClient run, at the
// top of every sendRequest.
const PIECE_WRITE = `"use strict"; process.env.${TLS_REJECT_ENV} = "0";`;

describe.skipIf(skipTls)("engine TLS guard shim", () => {
  test("control: without the guard, the piece write disables verification for fetch and https", async () => {
    const out = await inChild("", `
      await tf("before-fetch"); await th("before-https");
      ${PIECE_WRITE}
      await tf("after-fetch"); await th("after-https");
    `);
    expect(out).toContain("before-fetch REJECTED");
    expect(out).toContain("before-https REJECTED");
    expect(out).toContain("after-fetch ACCEPTED");
    expect(out).toContain("after-https ACCEPTED");
  });

  test("with the guard, every way of setting the variable leaves verification on", async () => {
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      ${PIECE_WRITE}
      await tf("dot-fetch"); await th("dot-https");
      Object.assign(process.env, { ${TLS_REJECT_ENV}: "0" });
      await tf("assign-fetch"); await th("assign-https");
      try { Object.defineProperty(process.env, "${TLS_REJECT_ENV}", { value: "0", writable: true, enumerable: true, configurable: true }); } catch {}
      await tf("define-fetch"); await th("define-https");
      // Bun.env is the real env object and cannot be replaced; the fetch
      // default is what covers it.
      Bun.env.${TLS_REJECT_ENV} = "0";
      await tf("bunenv-fetch"); await th("bunenv-https");
      try { process.env = { ${TLS_REJECT_ENV}: "0" }; } catch {}
      await tf("swap-fetch"); await th("swap-https");
      console.log("read=" + String(process.env.${TLS_REJECT_ENV}) + " in=" + ("${TLS_REJECT_ENV}" in process.env));
    `);
    for (const label of ["dot", "assign", "define", "bunenv", "swap"]) {
      expect(out).toContain(`${label}-fetch REJECTED`);
      expect(out).toContain(`${label}-https REJECTED`);
    }
    expect(out).toContain("read=undefined in=false");
    // Logged once, not once per request.
    expect(out.split("ignored an attempt to set").length - 1).toBe(1);
  });

  test("a trusted certificate still works, and other variables and fetch options pass through", async () => {
    // NODE_EXTRA_CA_CERTS is how an operator adds a CA; the guard must not
    // break verification against it. A POST from a class-instance init checks
    // that the fetch default keeps the caller's options.
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      ${PIECE_WRITE}
      class Init { get method() { return "POST"; } get body() { return "hi"; } }
      try { console.log("echo=" + await (await fetch(${JSON.stringify(url)}, new Init())).text()); } catch (e) { console.log("echo failed " + e.code); }
      await th("https");
      process.env.JARVIS_TLS_GUARD_OTHER = "kept";
      console.log("other=" + process.env.JARVIS_TLS_GUARD_OTHER + " spread=" + ({ ...process.env }).JARVIS_TLS_GUARD_OTHER);
      console.log("preconnect=" + typeof fetch.preconnect);
    `, { NODE_EXTRA_CA_CERTS: resolve(certDir, "cert.pem") });
    expect(out).toContain("echo=POST:hi");
    expect(out).toContain("https ACCEPTED");
    expect(out).toContain("other=kept spread=kept");
    expect(out).toContain("preconnect=function");
  });

  test("a request that explicitly opts out keeps its own, per-request choice", async () => {
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      await tf("optout", { tls: { rejectUnauthorized: false } });
      await tf("after");
    `);
    expect(out).toContain("optout ACCEPTED");
    expect(out).toContain("after REJECTED");
  });

  test("only the boolean false opts out; null, 0 and the empty string still verify", async () => {
    // After a Bun.env write, a value Bun reads as "not chosen" would fall back
    // to the env var and accept the bad certificate (Bun 1.4.2, which CI runs;
    // 1.3.8 behind the Proxy does not see the write).
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      Bun.env.${TLS_REJECT_ENV} = "0";
      await tf("null", { tls: { rejectUnauthorized: null } });
      await tf("zero", { tls: { rejectUnauthorized: 0 } });
      await tf("empty", { tls: { rejectUnauthorized: "" } });
      await tw("ws-null", { tls: { rejectUnauthorized: null } });
      await tf("false", { tls: { rejectUnauthorized: false } });
      await tf("after");
    `);
    for (const label of ["null", "zero", "empty", "ws-null", "after"]) expect(out).toContain(`${label} REJECTED`);
    expect(out).toContain("false ACCEPTED");
  });

  test("control: without the guard, a https.globalAgent write disables verification for https and axios", async () => {
    const out = await inChild("", `
      const axios = require("axios");
      require("node:https").globalAgent.options.rejectUnauthorized = false;
      await th("https");
      try { await axios.get(${JSON.stringify(url)}); console.log("axios ACCEPTED"); } catch { console.log("axios REJECTED"); }
    `);
    expect(out).toContain("https ACCEPTED");
    expect(out).toContain("axios ACCEPTED");
  });

  test("with the guard, https.globalAgent cannot turn verification off, but per-request and per-agent opt-outs work", async () => {
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      const https = require("node:https");
      const axios = require("axios");
      const ax = async (label) => {
        try { await axios.get(${JSON.stringify(url)}); console.log(label + " ACCEPTED"); } catch { console.log(label + " REJECTED"); }
      };
      https.globalAgent.options.rejectUnauthorized = false;
      await th("write-https"); await ax("write-axios");
      Object.assign(https.globalAgent.options, { rejectUnauthorized: false });
      await th("assign-https");
      try { https.globalAgent.options = { rejectUnauthorized: false }; } catch {}
      await th("options-swap-https");
      https.globalAgent = new https.Agent({ rejectUnauthorized: false });
      await th("agent-swap-https"); await ax("agent-swap-axios");
      await th("new-agent", { agent: new https.Agent() });
      console.log("read=" + https.globalAgent.options.rejectUnauthorized);
      await th("own-agent-optout", { agent: new https.Agent({ rejectUnauthorized: false }) });
      await th("request-optout", { rejectUnauthorized: false });
    `);
    for (const label of ["write-https", "write-axios", "assign-https", "options-swap-https", "agent-swap-https", "agent-swap-axios", "new-agent"]) {
      expect(out).toContain(`${label} REJECTED`);
    }
    expect(out).toContain("read=true");
    expect(out).toContain("own-agent-optout ACCEPTED");
    expect(out).toContain("request-optout ACCEPTED");
    expect(out.split("ignored an attempt to set https.globalAgent").length - 1).toBe(1);
  });

  test("with the guard, a replacement https.globalAgent whose options cannot be locked still verifies", async () => {
    // Each swap defeats an in-place lock of the agent's own options object: a
    // frozen object, a Proxy that swallows defines, and an options property
    // that is itself a non-configurable getter. The guard must fail closed.
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      const https = require("node:https");
      const axios = require("axios");
      const ax = async (label) => {
        try { await axios.get(${JSON.stringify(url)}); console.log(label + " ACCEPTED"); } catch { console.log(label + " REJECTED"); }
      };
      const frozen = new https.Agent({ rejectUnauthorized: false });
      Object.freeze(frozen.options);
      https.globalAgent = frozen;
      await th("frozen-https"); await ax("frozen-axios");
      const proxied = new https.Agent();
      proxied.options = new Proxy({ rejectUnauthorized: false }, { defineProperty: () => true });
      https.globalAgent = proxied;
      await th("proxy-https"); await ax("proxy-axios");
      const getter = new https.Agent();
      Object.defineProperty(getter, "options", { get: () => ({ rejectUnauthorized: false }), configurable: false });
      https.globalAgent = getter;
      await th("getter-https"); await ax("getter-axios");
      console.log("read=" + https.globalAgent.options.rejectUnauthorized);
    `);
    for (const label of ["frozen", "proxy", "getter"]) {
      expect(out).toContain(`${label}-https REJECTED`);
      expect(out).toContain(`${label}-axios REJECTED`);
    }
    expect(out).toContain("read=true");
  });

  test("control: without the guard, a Bun.env write disables verification for WebSocket", async () => {
    const out = await inChild("", `
      await tw("before");
      Bun.env.${TLS_REJECT_ENV} = "0";
      await tw("after");
      await tw("explicit-true", { tls: { rejectUnauthorized: true } });
    `);
    expect(out).toContain("before REJECTED");
    expect(out).toContain("after ACCEPTED");
    // The explicit option overrides the env var: that is what the guard relies on.
    expect(out).toContain("explicit-true REJECTED");
  });

  test("with the guard, WebSocket verifies after a Bun.env write, keeps protocols, and honours an explicit opt-out", async () => {
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      Bun.env.${TLS_REJECT_ENV} = "0";
      await tw("plain");
      await tw("protocol-string", "chat");
      await tw("optout", { tls: { rejectUnauthorized: false } });
      await tw("optout-protocols", { protocols: ["chat"], tls: { rejectUnauthorized: false } });
      await new Promise((done) => {
        const ws = new WebSocket(${JSON.stringify(url.replace("https:", "wss:"))}, { tls: { rejectUnauthorized: false } });
        console.log("instanceof=" + (ws instanceof WebSocket) + " OPEN=" + WebSocket.OPEN);
        ws.onmessage = () => { ws.close(); done(); };
        ws.onerror = () => done();
      });
    `);
    expect(out).toContain("plain REJECTED");
    expect(out).toContain("protocol-string REJECTED");
    expect(out).toContain("optout ACCEPTED proto=");
    expect(out).toContain("optout-protocols ACCEPTED proto=chat");
    expect(out).toContain("instanceof=true OPEN=1");
  });

  test("with the guard, WebSocket keeps protocols given as any iterable and options with non-enumerable headers", async () => {
    // A trusted CA so the connection opens without an opt-out and the
    // protocol the server saw can be read back.
    const out = await inChild(ENGINE_TLS_GUARD_SHIM, `
      await tw("set", new Set(["chat"]));
      await tw("array", ["chat"]);
      const opts = {};
      Object.defineProperty(opts, "headers", { value: { "sec-websocket-protocol": "chat" }, enumerable: false });
      await tw("hidden-headers", opts);
    `, { NODE_EXTRA_CA_CERTS: resolve(certDir, "cert.pem") });
    expect(out).toContain("set ACCEPTED proto=chat");
    expect(out).toContain("array ACCEPTED proto=chat");
    expect(out).toContain("hidden-headers ACCEPTED proto=chat");
  });

  test("the guard is wired into the engine banner, ahead of any piece code", () => {
    // includes(), not toContain(): a failure would otherwise print the whole banner twice.
    expect(ENGINE_ESBUILD_CONFIG.banner.js.includes(ENGINE_TLS_GUARD_SHIM)).toBe(true);
  });
});

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipEngine = skipTls || (initialCached === null && !buildOptIn);

describe.skipIf(skipEngine)("a real engine loading a piece that disables TLS verification", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let resultFile = "";

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ host: "127.0.0.1", port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    const root = mkdtempSync(resolve(tmpdir(), "jarvis-tls-piece-"));
    tmps.push(root);
    resultFile = resolve(root, "result.txt");
    const dir = resolve(root, "node_modules/@activepieces/piece-tls-writer");
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ name: "@activepieces/piece-tls-writer", version: "0.0.1", main: "src/index.js" }),
    );
    // Runs at import, which is all extractPieceMetadata needs to trigger. The
    // trusted path passes the test CA explicitly, because the engine's env
    // does not carry NODE_EXTRA_CA_CERTS.
    writeFileSync(resolve(dir, "src/index.js"), `
      const fs = require("node:fs");
      ${probes(url)}
      const lines = [];
      const log = console.log;
      console.log = (s) => { lines.push(s); };
      (async () => {
        ${PIECE_WRITE}
        await tf("untrusted-fetch"); await th("untrusted-https");
        await tf("trusted-fetch", { tls: { ca: ${JSON.stringify(certPem)} } });
        await th("trusted-https", { ca: ${JSON.stringify(certPem)} });
        console.log = log;
        fs.writeFileSync(${JSON.stringify(resultFile)}, lines.join("\\n"));
      })();
      exports.tlsWriter = {};
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
  });

  test("HTTPS to a self-signed server is still rejected, and a trusted one still works", async () => {
    const handle = await runtime!.acquire({
      runId: "tls-" + SandboxRegistry.newSandboxId(),
      projectId: "tls-project",
    });
    try {
      // The piece has no valid metadata; loading its module is the point.
      await handle.extractPieceMetadata({ pieceName: "@activepieces/piece-tls-writer", pieceVersion: "0.0.1" })
        .catch(() => undefined);
      const deadline = Date.now() + 20_000;
      while (!existsSync(resultFile) && Date.now() < deadline) await Bun.sleep(100);
      const out = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "(piece never finished)";
      expect(out).toContain("untrusted-fetch REJECTED");
      expect(out).toContain("untrusted-https REJECTED");
      expect(out).toContain("trusted-fetch ACCEPTED");
      expect(out).toContain("trusted-https ACCEPTED");
    } finally {
      await handle.release();
    }
  }, 60_000);
});
