/**
 * #671. The shared bundle was verified once, at resolution, and then spawned
 * from disk for the daemon's whole life with no re-check -- so the window
 * between check and use was the daemon's lifetime. These pin that a verified
 * bundle whose bytes change afterwards is refused at spawn, before anything
 * starts, and that everything that was never verified spawns as before.
 *
 * #762. The verified digest used to live in a global map keyed by resolved
 * path, so a different spelling of the same file MISSED it and spawned
 * unchecked, and a later resolution re-pinned what every existing runtime
 * accepted. It now travels with the bundle (`digest`) into the runtime
 * (`expectedDigest`); the last describe block pins both faults closed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { bundleHash, findCachedBundle } from "./build";
import { BundleIntegrityError } from "./bundle-integrity";
import { liveEngines, spawnEngine } from "./spawn";
import { EngineRuntime } from "./engine-runtime";
import { EngineTokenSigner } from "../../sandbox-api/engine-token";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import type { SandboxApi } from "../../sandbox-api/server";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const sha256 = (body: string): string => createHash("sha256").update(body).digest("hex");

interface Verified { root: string; bundlePath: string; digest: string | null }

/** A shared root the way a host builds one -- bundle plus manifest -- resolved through the real lookup. */
function verifiedSharedBundle(body = "// the bytes the host built\n"): Verified {
  const root = mkdtempSync(resolve(tmpdir(), "jarvis-671-shared-"));
  roots.push(root);
  const dir = resolve(root, bundleHash());
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "main.js"), body);
  writeFileSync(resolve(dir, "main.js.sha256"), sha256(body) + "\n");
  const found = findCachedBundle({ sharedRoot: root });
  expect(found?.bundlePath).toBe(resolve(dir, "main.js"));
  return { root, bundlePath: found!.bundlePath, digest: found!.digest };
}

function codeDir(): string {
  const d = mkdtempSync(resolve(tmpdir(), "jarvis-671-code-"));
  roots.push(d);
  return d;
}

/** `/bin/true` as the runtime: a spawn that is real but runs nothing from the bundle. */
const spawnOpts = (bundlePath: string, expectedDigest: string | null) => ({
  bundlePath,
  expectedDigest,
  sandboxId: "integrity-probe",
  sandboxWsPort: 1,
  baseCodeDir: codeDir(),
  runtime: "/bin/true",
});

async function spawnsCleanly(bundlePath: string, expectedDigest: string | null): Promise<void> {
  const engine = spawnEngine(spawnOpts(bundlePath, expectedDigest));
  engine.stdout?.resume();
  engine.stderr?.resume();
  const exit = await engine.exited;
  expect(exit.code).toBe(0);
}

/** A runtime that would spawn `/bin/true`, over a registry the test can inspect. */
function runtimeFor(bundlePath: string, expectedDigest: string | null): { runtime: EngineRuntime; registry: SandboxRegistry } {
  const registry = new SandboxRegistry();
  const api = { signer: new EngineTokenSigner(), registry, sandboxWsPort: 1 } as unknown as SandboxApi;
  const runtime = new EngineRuntime({
    api,
    bundlePath,
    expectedDigest,
    runtime: "/bin/true",
    baseCodeDir: codeDir(),
    devPieces: [],
    customPiecesPaths: [],
    handshakeTimeoutMs: 2_000,
  });
  return { runtime, registry };
}

describe("a verified engine bundle is re-checked at spawn (#671)", () => {
  test("the lookup returns the digest it verified", () => {
    const body = "// the bytes the host built\n";
    expect(verifiedSharedBundle(body).digest).toBe(sha256(body));
  });

  test("bytes swapped after verification are refused, and nothing is started", () => {
    const { bundlePath, digest } = verifiedSharedBundle();
    // The swap the issue describes, and the manifest with it: whatever can
    // write main.js can write the digest beside it, so a check that re-read the
    // manifest would pass this. Only the digest pinned at resolution refuses.
    const swapped = "// something else entirely\n";
    writeFileSync(bundlePath, swapped);
    writeFileSync(bundlePath + ".sha256", sha256(swapped) + "\n");

    const before = liveEngines().length;
    let thrown: unknown;
    try {
      spawnEngine(spawnOpts(bundlePath, digest));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BundleIntegrityError);
    expect((thrown as BundleIntegrityError).reason).toBe("changed_since_verification");
    expect((thrown as Error).message).toContain("reason=changed_since_verification");
    expect(liveEngines().length).toBe(before);
  });

  test("a verified bundle deleted afterwards is refused as unreadable", () => {
    const { bundlePath, digest } = verifiedSharedBundle();
    rmSync(bundlePath);
    // The errno code is carried (diagnosable) and the path is not.
    expect(() => spawnEngine(spawnOpts(bundlePath, digest))).toThrow(/reason=unreadable .*\(ENOENT\)$/u);
  });

  test.skipIf(process.platform === "win32")(
    "a verified bundle replaced by a FIFO is refused at once, not read forever",
    () => {
      // A FIFO with no writer blocks a plain read on the daemon's own event
      // loop, and the hash now runs on every spawn. Before the regular-file
      // check this test never returned.
      const { bundlePath, digest } = verifiedSharedBundle();
      rmSync(bundlePath);
      const made = spawnSync("mkfifo", [bundlePath]);
      expect(made.status).toBe(0);
      expect(() => spawnEngine(spawnOpts(bundlePath, digest))).toThrow(/reason=unreadable/u);
    },
    5_000,
  );

  test("the refusal names the bundle by its hash directory, never by its configured root", () => {
    const { bundlePath, digest } = verifiedSharedBundle();
    writeFileSync(bundlePath, "// changed\n");
    let message = "";
    try {
      spawnEngine(spawnOpts(bundlePath, digest));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`bundle=${bundleHash()}/main.js`);
    expect(message).not.toContain(tmpdir());
  });

  test("an unchanged verified bundle spawns", async () => {
    const { bundlePath, digest } = verifiedSharedBundle();
    await spawnsCleanly(bundlePath, digest);
  });

  test("a bundle that was never verified spawns as before", async () => {
    // The per-user cache has no manifest by design, so there is nothing to pin
    // it to (`digest: null`); and every test fixture spawns a path no lookup
    // ever verified.
    const dir = codeDir();
    const bundlePath = resolve(dir, "main.js");
    writeFileSync(bundlePath, "// per-user build\n");
    await spawnsCleanly(bundlePath, null);
    writeFileSync(bundlePath, "// rebuilt\n");
    await spawnsCleanly(bundlePath, null);
  });

  test("a republished shared root is followed by the next resolution", async () => {
    // The host republishes with its manifest. A FRESH resolution verifies the
    // new bytes and carries their digest, so whatever is built from it spawns.
    // (What an EXISTING runtime does with the republished bytes is the #762
    // case below: it refuses them until it is replaced.)
    const { root, bundlePath, digest: v1 } = verifiedSharedBundle("// v1\n");
    writeFileSync(bundlePath, "// v2\n");
    writeFileSync(bundlePath + ".sha256", sha256("// v2\n") + "\n");
    expect(() => spawnEngine(spawnOpts(bundlePath, v1))).toThrow(BundleIntegrityError);
    const again = findCachedBundle({ sharedRoot: root });
    expect(again?.digest).toBe(sha256("// v2\n"));
    await spawnsCleanly(bundlePath, again!.digest);
  });

  test("a refused spawn does not leave its sandbox registered", async () => {
    // spawnFresh mints a token and registers the sandbox BEFORE spawning, so a
    // spawn that throws must take the registration back with it, or a sandbox
    // with a live token and no engine stays in the registry.
    const { bundlePath, digest } = verifiedSharedBundle();
    writeFileSync(bundlePath, "// changed\n");
    const { runtime, registry } = runtimeFor(bundlePath, digest);
    await expect(runtime.acquire({ runId: "r-671", projectId: "p-671" })).rejects.toBeInstanceOf(BundleIntegrityError);
    expect(registry.liveCount()).toBe(0);
    await runtime.shutdown();
  });
});

describe("the verified digest travels with the bundle, and fails closed (#762)", () => {
  test.skipIf(process.platform === "win32")(
    "a different spelling of a verified bundle is still checked, not skipped",
    async () => {
      // The fail-open the path-keyed map had: the root reached through a
      // symlink (a bind mount or a case-insensitive filesystem does the same)
      // resolves to a different string, the lookup missed, and a miss meant
      // "never verified" -- so the swapped bytes below were spawned. With the
      // digest on the runtime there is no lookup to miss.
      const { root, digest } = verifiedSharedBundle();
      const alias = mkdtempSync(resolve(tmpdir(), "jarvis-762-alias-"));
      roots.push(alias);
      const linked = resolve(alias, "root");
      symlinkSync(root, linked);
      const spelled = resolve(linked, bundleHash(), "main.js");
      writeFileSync(spelled, "// swapped, reached through the other spelling\n");

      expect(() => spawnEngine(spawnOpts(spelled, digest))).toThrow(BundleIntegrityError);
      const { runtime, registry } = runtimeFor(spelled, digest);
      await expect(runtime.acquire({ runId: "r-762", projectId: "p-762" })).rejects.toBeInstanceOf(BundleIntegrityError);
      expect(registry.liveCount()).toBe(0);
      await runtime.shutdown();
    },
  );

  test("a later resolution does not change what an existing runtime accepts", async () => {
    // The map was global, so ANY later verification of the same path -- an
    // evaluation engine built mid-life, a second bootstrap -- silently moved
    // the pin for every runtime already holding that path. A runtime now keeps
    // the digest it was built with until it is replaced.
    const { root, bundlePath, digest: v1 } = verifiedSharedBundle("// v1\n");
    const { runtime, registry } = runtimeFor(bundlePath, v1);
    writeFileSync(bundlePath, "// v2\n");
    writeFileSync(bundlePath + ".sha256", sha256("// v2\n") + "\n");
    // Somebody else resolves the republished root, and it verifies.
    expect(findCachedBundle({ sharedRoot: root })?.digest).toBe(sha256("// v2\n"));
    await expect(runtime.acquire({ runId: "r-762b", projectId: "p-762" })).rejects.toBeInstanceOf(BundleIntegrityError);
    expect(registry.liveCount()).toBe(0);
    await runtime.shutdown();
  });

  test("a caller that leaves the digest out is refused, not spawned unchecked", () => {
    // `expectedDigest` is required by type, but generated JS and `as` casts do
    // not see types. Omitting it must not read as "never verified".
    const { bundlePath } = verifiedSharedBundle();
    const { expectedDigest: _omitted, ...withoutDigest } = spawnOpts(bundlePath, null);
    const before = liveEngines().length;
    expect(() => spawnEngine(withoutDigest as Parameters<typeof spawnEngine>[0])).toThrow(/expectedDigest is required/u);
    expect(liveEngines().length).toBe(before);
  });

  test("a relative bundle path is refused: the daemon would hash one file and the engine run another", () => {
    // The hash resolves a relative path against the daemon's cwd, the child
    // against its own `cwd`. Two files at the same relative path in the two
    // directories, with the pin matching the daemon-side one, used to spawn
    // the OTHER bytes under a passing check.
    const here = codeDir();
    const there = codeDir();
    mkdirSync(resolve(here, "x"));
    mkdirSync(resolve(there, "x"));
    writeFileSync(resolve(here, "x", "main.js"), "// verified\n");
    writeFileSync(resolve(there, "x", "main.js"), "// what would have run\n");
    const cwd = process.cwd();
    const before = liveEngines().length;
    process.chdir(here);
    try {
      expect(() => spawnEngine({ ...spawnOpts("x/main.js", sha256("// verified\n")), cwd: there }))
        .toThrow(/bundlePath must be absolute/u);
    } finally {
      process.chdir(cwd);
    }
    expect(liveEngines().length).toBe(before);
  });

  test("a runtime given a relative bundle path fails at construction", () => {
    const api = { signer: new EngineTokenSigner(), registry: new SandboxRegistry(), sandboxWsPort: 1 } as unknown as SandboxApi;
    expect(() => new EngineRuntime({ api, bundlePath: "x/main.js", expectedDigest: null }))
      .toThrow(/bundlePath must be absolute/u);
  });

  test("a runtime built without a digest fails at construction, not at its first spawn", () => {
    const { bundlePath } = verifiedSharedBundle();
    const api = { signer: new EngineTokenSigner(), registry: new SandboxRegistry(), sandboxWsPort: 1 } as unknown as SandboxApi;
    expect(() => new EngineRuntime({ api, bundlePath } as unknown as ConstructorParameters<typeof EngineRuntime>[0]))
      .toThrow(/expectedDigest is required/u);
  });

  test("a malformed digest refuses rather than matching nothing", () => {
    const { bundlePath } = verifiedSharedBundle();
    expect(() => spawnEngine(spawnOpts(bundlePath, ""))).toThrow(BundleIntegrityError);
    expect(() => spawnEngine(spawnOpts(bundlePath, "not-a-digest"))).toThrow(BundleIntegrityError);
  });
});
