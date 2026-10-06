/**
 * #671. The shared bundle was verified once, at resolution, and then spawned
 * from disk for the daemon's whole life with no re-check -- so the window
 * between check and use was the daemon's lifetime. These pin that a verified
 * bundle whose bytes change afterwards is refused at spawn, before anything
 * starts, and that everything that was never verified spawns as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { bundleHash, findCachedBundle } from "./build";
import { BundleIntegrityError, __resetBundlePinsForTest } from "./bundle-integrity";
import { liveEngines, spawnEngine } from "./spawn";
import { EngineRuntime } from "./engine-runtime";
import { EngineTokenSigner } from "../../sandbox-api/engine-token";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import type { SandboxApi } from "../../sandbox-api/server";

const roots: string[] = [];
afterEach(() => {
  __resetBundlePinsForTest();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A shared root the way a host builds one -- bundle plus manifest -- resolved through the real lookup. */
function verifiedSharedBundle(body = "// the bytes the host built\n"): string {
  const root = mkdtempSync(resolve(tmpdir(), "jarvis-671-shared-"));
  roots.push(root);
  const dir = resolve(root, bundleHash());
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "main.js"), body);
  writeFileSync(resolve(dir, "main.js.sha256"), createHash("sha256").update(body).digest("hex") + "\n");
  const found = findCachedBundle({ sharedRoot: root });
  expect(found?.bundlePath).toBe(resolve(dir, "main.js"));
  return found!.bundlePath;
}

function codeDir(): string {
  const d = mkdtempSync(resolve(tmpdir(), "jarvis-671-code-"));
  roots.push(d);
  return d;
}

/** `/bin/true` as the runtime: a spawn that is real but runs nothing from the bundle. */
const spawnOpts = (bundlePath: string) => ({
  bundlePath,
  sandboxId: "integrity-probe",
  sandboxWsPort: 1,
  baseCodeDir: codeDir(),
  runtime: "/bin/true",
});

async function spawnsCleanly(bundlePath: string): Promise<void> {
  const engine = spawnEngine(spawnOpts(bundlePath));
  engine.stdout?.resume();
  engine.stderr?.resume();
  const exit = await engine.exited;
  expect(exit.code).toBe(0);
}

describe("a verified engine bundle is re-checked at spawn (#671)", () => {
  test("bytes swapped after verification are refused, and nothing is started", () => {
    const bundlePath = verifiedSharedBundle();
    // The swap the issue describes, and the manifest with it: whatever can
    // write main.js can write the digest beside it, so a check that re-read the
    // manifest would pass this. Only the digest pinned at resolution refuses.
    const swapped = "// something else entirely\n";
    writeFileSync(bundlePath, swapped);
    writeFileSync(bundlePath + ".sha256", createHash("sha256").update(swapped).digest("hex") + "\n");

    const before = liveEngines().length;
    let thrown: unknown;
    try {
      spawnEngine(spawnOpts(bundlePath));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BundleIntegrityError);
    expect((thrown as BundleIntegrityError).reason).toBe("changed_since_verification");
    expect((thrown as Error).message).toContain("reason=changed_since_verification");
    expect(liveEngines().length).toBe(before);
  });

  test("a verified bundle deleted afterwards is refused as unreadable", () => {
    const bundlePath = verifiedSharedBundle();
    rmSync(bundlePath);
    // The errno code is carried (diagnosable) and the path is not.
    expect(() => spawnEngine(spawnOpts(bundlePath))).toThrow(/reason=unreadable .*\(ENOENT\)$/u);
  });

  test.skipIf(process.platform === "win32")(
    "a verified bundle replaced by a FIFO is refused at once, not read forever",
    () => {
      // A FIFO with no writer blocks a plain read on the daemon's own event
      // loop, and the hash now runs on every spawn. Before the regular-file
      // check this test never returned.
      const bundlePath = verifiedSharedBundle();
      rmSync(bundlePath);
      const made = spawnSync("mkfifo", [bundlePath]);
      expect(made.status).toBe(0);
      expect(() => spawnEngine(spawnOpts(bundlePath))).toThrow(/reason=unreadable/u);
    },
    5_000,
  );

  test("the refusal names the bundle by its hash directory, never by its configured root", () => {
    const bundlePath = verifiedSharedBundle();
    writeFileSync(bundlePath, "// changed\n");
    let message = "";
    try {
      spawnEngine(spawnOpts(bundlePath));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`bundle=${bundleHash()}/main.js`);
    expect(message).not.toContain(tmpdir());
  });

  test("an unchanged verified bundle spawns", async () => {
    await spawnsCleanly(verifiedSharedBundle());
  });

  test("a bundle that was never verified spawns as before", async () => {
    // The per-user cache has no manifest by design, so there is nothing to pin
    // it to; and every test fixture spawns a path no lookup ever verified.
    const dir = codeDir();
    const bundlePath = resolve(dir, "main.js");
    writeFileSync(bundlePath, "// per-user build\n");
    await spawnsCleanly(bundlePath);
    writeFileSync(bundlePath, "// rebuilt\n");
    await spawnsCleanly(bundlePath);
  });

  test("a republished shared root is followed on the next resolution, not refused forever", async () => {
    const bundlePath = verifiedSharedBundle("// v1\n");
    const root = resolve(bundlePath, "..", "..");
    writeFileSync(bundlePath, "// v2\n");
    writeFileSync(bundlePath + ".sha256", createHash("sha256").update("// v2\n").digest("hex") + "\n");
    expect(() => spawnEngine(spawnOpts(bundlePath))).toThrow(BundleIntegrityError);
    // A fresh resolution verifies the new bytes against their manifest and re-pins.
    expect(findCachedBundle({ sharedRoot: root })?.bundlePath).toBe(bundlePath);
    await spawnsCleanly(bundlePath);
  });

  test("a refused spawn does not leave its sandbox registered", async () => {
    // spawnFresh mints a token and registers the sandbox BEFORE spawning, so a
    // spawn that throws must take the registration back with it, or a sandbox
    // with a live token and no engine stays in the registry.
    const bundlePath = verifiedSharedBundle();
    writeFileSync(bundlePath, "// changed\n");
    const registry = new SandboxRegistry();
    const api = { signer: new EngineTokenSigner(), registry, sandboxWsPort: 1 } as unknown as SandboxApi;
    const runtime = new EngineRuntime({
      api,
      bundlePath,
      runtime: "/bin/true",
      baseCodeDir: codeDir(),
      devPieces: [],
      customPiecesPaths: [],
    });
    await expect(runtime.acquire({ runId: "r-671", projectId: "p-671" })).rejects.toBeInstanceOf(BundleIntegrityError);
    expect(registry.liveCount()).toBe(0);
    await runtime.shutdown();
  });
});
