/**
 * The engine's file sandbox (#1154): the setting, the fallback, and a real
 * sandboxed engine against secrets planted in a data folder.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow, setFlowCodeStepsEnabled } from "../../db/repos/flow";
import { createDraftVersion, getFlowVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { buildEngineBundle, findCachedBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import {
  bundledLauncherPath,
  codeTreeFor,
  decideSandbox,
  detectSandboxSupport,
  EngineSandboxUnavailableError,
  engineAllowList,
  launcherArgs,
  sandboxArgv,
  seatbeltProfile,
  resetSandboxSupportCache,
  resolveSandboxMode,
  type SandboxSupport,
} from "./sandbox";

const NONE: SandboxSupport = { kind: "none", reason: "test: no sandbox here" };

describe("workflows.sandbox", () => {
  test("config wins, then the env var, then prefer; an unknown value is never read as off", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveSandboxMode("require", { JARVIS_WORKFLOW_SANDBOX: "off" }, warn)).toBe("require");
    expect(resolveSandboxMode(undefined, { JARVIS_WORKFLOW_SANDBOX: " OFF " }, warn)).toBe("off");
    expect(resolveSandboxMode(undefined, {}, warn)).toBe("prefer");
    expect(warnings).toEqual([]);
    expect(resolveSandboxMode("disabled", { JARVIS_WORKFLOW_SANDBOX: "require" }, warn)).toBe("require");
    expect(resolveSandboxMode("nope", {}, warn)).toBe("prefer");
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("workflows.sandbox");
  });

  test("off never asks the machine; a sandbox that is there is used", () => {
    expect(decideSandbox("off", () => { throw new Error("probed"); })).toBeNull();
    const landlock: SandboxSupport = { kind: "landlock", launcher: "/opt/jarvis-sandbox", abi: 6 };
    expect(decideSandbox("require", () => landlock)).toEqual(landlock);
    expect(decideSandbox("prefer", () => landlock)).toEqual(landlock);
    const seatbelt: SandboxSupport = { kind: "seatbelt", launcher: "/usr/bin/sandbox-exec" };
    expect(decideSandbox("require", () => seatbelt)).toEqual(seatbelt);
  });

  test("prefer without a sandbox runs unsandboxed and warns once; require refuses", () => {
    resetSandboxSupportCache();
    const warnings: string[] = [];
    expect(decideSandbox("prefer", () => NONE, (m) => warnings.push(m))).toBeNull();
    expect(decideSandbox("prefer", () => NONE, (m) => warnings.push(m))).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("WITHOUT a file sandbox");
    expect(warnings[0]).toContain(NONE.reason);
    expect(() => decideSandbox("require", () => NONE)).toThrow(EngineSandboxUnavailableError);
  });

  test("a missing launcher or an unsupported platform is reported, not guessed", () => {
    resetSandboxSupportCache();
    expect(detectSandboxSupport({ platform: "win32" }).kind).toBe("none");
    const missing = detectSandboxSupport({ env: { JARVIS_SANDBOX_LAUNCHER: "/nonexistent/jarvis-sandbox" } });
    expect(missing).toEqual({ kind: "none", reason: expect.stringContaining("does not exist") });
    expect(detectSandboxSupport({ env: { JARVIS_SANDBOX_LAUNCHER: "relative" } }).kind).toBe("none");
  });

  test("a kernel without Landlock reads as no sandbox", () => {
    resetSandboxSupportCache();
    const dir = mkdtempSync(join(tmpdir(), "jarvis-fake-launcher-"));
    try {
      const fake = join(dir, "jarvis-sandbox");
      writeFileSync(fake, "#!/bin/sh\necho 0\n", { mode: 0o755 });
      const support = detectSandboxSupport({ platform: "linux", env: { JARVIS_SANDBOX_LAUNCHER: fake } });
      expect(support).toEqual({ kind: "none", reason: expect.stringContaining("no Landlock") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the allow-list holds the run's own paths and nothing of the data folder", () => {
    const allow = engineAllowList({
      runtime: "/usr/local/bin/bun-not-there",
      bundlePath: "/data/.jarvis/cache/engine/abc/main.js",
      bunfigPath: "/app/engine-bunfig.toml",
      cwd: "/app/src/workflows/activepieces",
      customPiecesPaths: ["/app/pieces", "/data/.jarvis/pieces"],
      codeTree: "/data/.jarvis/workflow-codes/v1",
      transpilerCache: "0",
      privateDir: "/tmp/jarvis-engine-x",
    }, "linux");
    expect(allow.readOnly).toContain("/data/.jarvis/cache/engine/abc");
    expect(allow.readOnly).toContain("/data/.jarvis/workflow-codes/v1");
    expect(allow.readOnly).toContain("/usr/local/bin/bun-not-there");
    expect(allow.readOnly).not.toContain("/data/.jarvis");
    expect(allow.readOnly).not.toContain("/data/.jarvis/workflow-codes");
    expect(allow.readOnly).not.toContain("0");
    expect(allow.readWrite).toEqual(["/dev/null", "/tmp/jarvis-engine-x"]);
    expect(launcherArgs({ readOnly: ["/a"], readWrite: ["/b"] }, ["/bun", "main.js"]))
      .toEqual(["--ro", "/a", "--rw", "/b", "--", "/bun", "main.js"]);
  });

  test("the macOS profile denies files by default and allows exactly the list", () => {
    const allow = engineAllowList({
      runtime: "/opt/homebrew/bin/bun-not-there",
      bundlePath: "/Users/me/.jarvis/cache/engine/abc/main.js",
      bunfigPath: "/app/engine-bunfig.toml",
      codeTree: "/Users/me/.jarvis/workflow-codes/v1",
      privateDir: "/private/var/folders/x/T/jarvis-engine-1",
    }, "darwin");
    expect(allow.readOnly).toContain("/System");
    expect(allow.readOnly).toContain("/private/etc");
    expect(allow.readOnly).not.toContain("/proc");
    const profile = seatbeltProfile({ ...allow, readOnly: [...allow.readOnly, '/odd "path\\x'] });
    const lines = profile.trim().split("\n");
    expect(lines.slice(0, 4)).toEqual(["(version 1)", "(allow default)", "(deny file-read* file-write*)", "(allow file-read-metadata)"]);
    expect(lines[4]).toContain('(subpath "/Users/me/.jarvis/workflow-codes/v1")');
    expect(lines[4]).toContain('(subpath "/Users/me/.jarvis/cache/engine/abc")');
    expect(lines[4]).not.toContain('(subpath "/Users/me/.jarvis")');
    expect(lines[4]).toContain('(subpath "/odd \\"path\\\\x")');
    expect(lines[5]).toBe('(allow file-write* (subpath "/dev/null") (subpath "/private/var/folders/x/T/jarvis-engine-1"))');
    expect(lines[6]).toBe('(deny process-exec* (subpath "/private/var/folders/x/T/jarvis-engine-1"))');
    expect(sandboxArgv({ kind: "seatbelt", launcher: "/usr/bin/sandbox-exec" }, allow, ["/bun", "main.js"]))
      .toEqual(["-p", seatbeltProfile(allow), "/bun", "main.js"]);
  });

  test("only a plain version id becomes a code tree", () => {
    expect(codeTreeFor("/codes", "abcDEF_123-x")).toBe("/codes/abcDEF_123-x");
    for (const bad of [undefined, "", "..", "../x", "a/b", "a.b", "x".repeat(200)]) {
      expect(codeTreeFor("/codes", bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// A real engine. Needs the bundle and pieces (JARVIS_TEST_ENGINE_BUILD=1 or
// built already) and, for the sandboxed half, Linux with Landlock and a
// launcher: the built one, or one built here when Go is installed.
// ---------------------------------------------------------------------------

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const piecesBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/test/dist/src/index.js"));
const skipEngine = (findCachedBundle() === null || !piecesBuilt) && !buildOptIn;

function launcherForTests(): string | null {
  if (process.platform !== "linux") return null;
  const built = bundledLauncherPath();
  if (existsSync(built)) return built;
  if (spawnSync("go", ["version"]).status !== 0) return null;
  const build = spawnSync(process.execPath, [resolve(ENGINE_BUILD_PATHS.REPO_ROOT, "scripts/build-sandbox-launcher.ts")], { stdio: "inherit" });
  return build.status === 0 && existsSync(built) ? built : null;
}

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";

describe("a sandboxed engine", () => {
  let api: SandboxApi;
  let dataDir: string;
  let baseCodeDir: string;
  let secrets: string[];
  let siblingTree: string;
  let launcher: string | null = null;
  let landlock: SandboxSupport = NONE; // the sandbox this machine has, Landlock or Seatbelt
  let bundle: { bundlePath: string; digest: string | null } | null = null;

  beforeAll(async () => {
    if (skipEngine) return;
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });
    bundle = findCachedBundle() ?? (await buildEngineBundle());
    if (buildOptIn) await buildAllJarvisPieces();
    resetSandboxSupportCache();
    if (process.platform === "darwin") {
      landlock = detectSandboxSupport();
    } else {
      launcher = launcherForTests();
      if (launcher) landlock = detectSandboxSupport({ env: { JARVIS_SANDBOX_LAUNCHER: launcher } });
    }
    // A data folder laid out like the daemon's: the secrets beside the code
    // trees, and another flow's tree beside this one's.
    dataDir = mkdtempSync(join(tmpdir(), "jarvis-sandbox-data-"));
    baseCodeDir = join(dataDir, "workflow-codes");
    secrets = ["workflow-encryption.key", "google-tokens.json", "jarvis.db"].map((name) => {
      const path = join(dataDir, name);
      writeFileSync(path, `planted-secret-${name}`, { mode: 0o600 });
      return path;
    });
    siblingTree = join(baseCodeDir, "another-flow-version", "step");
    mkdirSync(siblingTree, { recursive: true });
    writeFileSync(join(siblingTree, "index.js"), "planted-secret-other-flow");
    secrets.push(join(siblingTree, "index.js"));
  }, 600_000);

  afterAll(async () => {
    if (skipEngine) return;
    await api.stop();
    closeWorkflowDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Publish a flow whose one CODE step tries to read each planted secret. */
  function probeFlow(): { flowId: string; versionId: string } {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const trigger: FlowTriggerNode = {
      name: "trigger",
      type: "PIECE_TRIGGER",
      displayName: "Manual",
      settings: { pieceName: PIECE_TEST_NAME, pieceVersion: "0.0.1", triggerName: "manual", input: { payload: {} } },
      nextAction: {
        name: "probe",
        type: "CODE",
        displayName: "Probe",
        settings: {
          input: { paths: secrets, daemonPid: process.pid, health: `${api.baseUrl}/health` },
          sourceCode: {
            packageJson: "{}",
            code:
              "exports.code = async (inputs) => {" +
              "  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');" +
              "  const attempt = (f) => { try { return 'READ:' + f(); } catch (e) { return e.code || String(e); } };" +
              "  const scratch = path.join(os.tmpdir(), 'scratch.txt');" +
              "  return { probeResult: {" +
              "    secrets: inputs.paths.map((p) => attempt(() => fs.readFileSync(p, 'utf8')))," +
              "    daemonEnviron: attempt(() => fs.readFileSync('/proc/' + inputs.daemonPid + '/environ', 'utf8').slice(0, 8))," +
              "    ownSource: attempt(() => fs.readFileSync(__filename, 'utf8').slice(0, 7))," +
              "    scratch: attempt(() => { fs.writeFileSync(scratch, 'ok'); return fs.readFileSync(scratch, 'utf8'); }),"
              + "    proxied: Boolean(process.env.HTTPS_PROXY),"
              + "    health: await fetch(inputs.health).then((r) => r.status, (e) => e.code || e.name)," +
              "  } };" +
              "};",
          },
        },
      },
    };
    const v = createDraftVersion({ flowId: flow.id, displayName: "sandbox-probe", trigger });
    updateDraftVersion(v.id, { trigger, valid: true });
    setFlowCodeStepsEnabled(flow.id, true);
    return { flowId: flow.id, versionId: v.id };
  }

  async function runProbe(runtime: EngineRuntime): Promise<{ secrets: string[]; daemonEnviron: string; ownSource: string; scratch: string; proxied: boolean; health: number | string }> {
    const { flowId, versionId } = probeFlow();
    const run = createFlowRun({ flowId, flowVersionId: versionId, environment: "TESTING" });
    const handle = await runtime.acquire({ runId: run.id, projectId: DEFAULT_IDS.project, flowId, flowVersionId: versionId });
    try {
      const done = await handle.executeFlow({
        flowVersion: getFlowVersion(versionId)!, streamStepProgress: "WEBSOCKET", runEnvironment: "TESTING",
      });
      expect(done.status).toBe("SUCCEEDED");
      return findKey(getFlowRun(run.id)?.steps, "probeResult") as never;
    } finally {
      await handle.release();
    }
  }

  test.skipIf(skipEngine || (process.platform !== "linux" && process.platform !== "darwin"))("cannot read the secrets planted in the data folder, and still runs its CODE step", async () => {
    if (landlock.kind === "none") {
      console.warn(`[sandbox.test] skipped: ${landlock.kind === "none" ? landlock.reason : ""}`);
      return;
    }
    const runtime = new EngineRuntime({
      api, bundlePath: bundle!.bundlePath, expectedDigest: bundle!.digest, baseCodeDir,
      sandbox: "require", sandboxSupport: () => landlock,
    });
    try {
      const result = await runProbe(runtime);
      // EACCES from Landlock, EPERM from Seatbelt.
      const denied = landlock.kind === "seatbelt" ? "EPERM" : "EACCES";
      expect(result.secrets).toEqual(secrets.map(() => denied));
      // Landlock refuses a sandboxed process the daemon's /proc/<pid>/environ.
      if (landlock.kind === "landlock") expect(result.daemonEnviron).toBe("EACCES");
      expect(result.ownSource).toBe("READ:exports");
      expect(result.scratch).toBe("READ:ok");
      // The egress proxy (#1153) is a TCP port on loopback, which the file
      // sandbox does not touch: a sandboxed step's fetch goes through it.
      expect(result.proxied).toBe(true);
      expect(result.health).toBe(200);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  test.skipIf(skipEngine)("prefer without a sandbox warns and runs unsandboxed; require refuses before anything starts", async () => {
    resetSandboxSupportCache();
    const warn = spyOn(console, "warn");
    const prefer = new EngineRuntime({
      api, bundlePath: bundle!.bundlePath, expectedDigest: bundle!.digest, baseCodeDir,
      sandbox: "prefer", sandboxSupport: () => NONE,
    });
    try {
      const result = await runProbe(prefer);
      // Unsandboxed, the same step reads them: what the sandbox takes away.
      expect(result.secrets[0]).toBe("READ:planted-secret-workflow-encryption.key");
      expect(warn.mock.calls.some(([m]) => String(m).includes("WITHOUT a file sandbox"))).toBe(true);
    } finally {
      warn.mockRestore();
      await prefer.shutdown();
    }

    const require = new EngineRuntime({
      api, bundlePath: bundle!.bundlePath, expectedDigest: bundle!.digest, baseCodeDir,
      sandbox: "require", sandboxSupport: () => NONE,
    });
    try {
      const before = api.registry.size();
      await expect(require.acquire({ runId: "sandbox-refused", projectId: DEFAULT_IDS.project }))
        .rejects.toBeInstanceOf(EngineSandboxUnavailableError);
      // Refused before a sandbox was registered or a process started.
      expect(api.registry.size()).toBe(before);
      expect(api.registry.byRunId("sandbox-refused")).toBeNull();
    } finally {
      await require.shutdown();
    }
  }, 120_000);
});

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
