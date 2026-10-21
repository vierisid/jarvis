/**
 * #863: a `bunfig.toml` in the cwd of the engine or of a CODE-step child must
 * not run. Bun reads one from the process's cwd and runs its `preload` before
 * the entry point, which no digest pin covers.
 *
 * Every test here drops a real `bunfig.toml` whose preload writes a marker and
 * runs a real Bun child, so they hold the behaviour, not the argv. Each has a
 * control that proves the same arrangement DOES run the preload when nothing
 * stops it, so an absent marker cannot come from a harness that never loads it.
 *
 * The same holds for a `.env` in that cwd, which Bun loads into the process's
 * environment whatever `env` it was given and whatever the config says.
 *
 * POSIX-only: the fallback config is /dev/null and one case needs a symlink.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizedEnv } from "../../../util/subprocess-env";
import {
  codeChildConfigArgs,
  noOpCodeSandbox,
} from "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox";
import { ENGINE_BUNFIG_PATH, engineConfigArg, spawnEngine } from "./spawn";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * A cwd holding a `bunfig.toml` whose preload appends to `marker`, and a
 * `.env` that sets PLANTED_BY_DOTENV.
 */
function hostileCwd(): { root: string; cwd: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-bunfig-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const marker = join(root, "preload-ran");
  writeFileSync(join(cwd, "evil.js"), `require("fs").appendFileSync(${JSON.stringify(marker)}, "x");\n`);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./evil.js"]\n');
  writeFileSync(join(cwd, ".env"), "PLANTED_BY_DOTENV=1\n");
  return { root, cwd, marker };
}

describe.skipIf(process.platform === "win32")("the engine never reads a bunfig.toml or .env from its cwd (#863)", () => {
  /** A tiny pinned bundle that records that it ran, and what .env gave it. */
  function bundleIn(root: string): { path: string; digest: string; ran: string } {
    const ran = join(root, "main-ran");
    const src = `require("fs").writeFileSync(${JSON.stringify(ran)}, "ok:" + (process.env.PLANTED_BY_DOTENV ?? "none"));\n`;
    const path = join(root, "main.js");
    writeFileSync(path, src);
    return { path, digest: createHash("sha256").update(src).digest("hex"), ran };
  }

  test("control: the same bundle in the same cwd runs the preload when started without the config", () => {
    const { root, cwd, marker } = hostileCwd();
    const bundle = bundleIn(root);
    const r = spawnSync(process.execPath, ["--smol", "--no-install", bundle.path], { cwd, env: sanitizedEnv() });
    expect(r.status).toBe(0);
    expect(readFileSync(bundle.ran, "utf8")).toBe("ok:1");
    expect(existsSync(marker)).toBe(true);
  });

  test("spawnEngine runs the bundle, not the cwd preload, and without the cwd .env", async () => {
    const { root, cwd, marker } = hostileCwd();
    const bundle = bundleIn(root);
    const engine = spawnEngine({
      bundlePath: bundle.path,
      expectedDigest: bundle.digest,
      sandboxId: "bunfig-test",
      sandboxWsPort: 1,
      baseCodeDir: join(root, "codes"),
      cwd,
    });
    const { code } = await engine.exited;
    expect(code).toBe(0);
    expect(readFileSync(bundle.ran, "utf8")).toBe("ok:none");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("the shipped engine config is an empty regular file at an absolute path", () => {
    expect(engineConfigArg()).toBe(`--config=${ENGINE_BUNFIG_PATH}`);
    expect(readFileSync(ENGINE_BUNFIG_PATH, "utf8")).toBe("");
  });

  test("a config with anything in it, a symlink, or a relative path is refused, not used", () => {
    const { root } = hostileCwd();
    const full = join(root, "full.toml");
    writeFileSync(full, 'preload = ["./x.js"]\n');
    expect(() => engineConfigArg(full)).toThrow("must be an empty regular file");
    const empty = join(root, "empty.toml");
    writeFileSync(empty, "");
    const link = join(root, "link.toml");
    symlinkSync(empty, link);
    expect(() => engineConfigArg(link)).toThrow("must be an empty regular file");
    expect(() => engineConfigArg("engine-bunfig.toml")).toThrow("must be absolute");
    expect(() => engineConfigArg(join(root, "missing.toml"))).toThrow("is missing (ENOENT)");
    expect(engineConfigArg(empty)).toBe(`--config=${empty}`);
  });
});

describe.skipIf(process.platform === "win32")("a CODE-step child never reads a bunfig.toml or .env from its cwd (#863)", () => {
  function stepIn(root: string): string {
    const file = join(root, "step.js");
    writeFileSync(file, "exports.code = async () => [42, process.env.PLANTED_BY_DOTENV ?? null];\n");
    return file;
  }

  test("control: a Bun child started the way the sandbox used to be runs the cwd preload and loads the .env", () => {
    const { cwd, marker } = hostileCwd();
    const r = spawnSync(process.execPath, ["--no-install", "--eval", "process.stdout.write(process.env.PLANTED_BY_DOTENV ?? 'none')"], {
      cwd,
      env: sanitizedEnv(),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("1");
    expect(existsSync(marker)).toBe(true);
  });

  test("runCodeModule from a hostile cwd runs the step, not the preload, and without the .env", async () => {
    const { root, cwd, marker } = hostileCwd();
    const step = stepIn(root);
    const before = process.cwd();
    process.chdir(cwd);
    try {
      expect(await noOpCodeSandbox.runCodeModule({ codeFilePath: step, inputs: {} })).toEqual([42, null]);
    } finally {
      process.chdir(before);
    }
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("inside an engine started with --config=<empty>, the child is handed that same config", () => {
    // The production shape: the engine's argv, read back from process.execArgv.
    const { root, cwd, marker } = hostileCwd();
    const step = stepIn(root);
    const sandbox = join(import.meta.dir, "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts");
    const script = join(root, "engine-like.ts");
    writeFileSync(script, [
      `import { codeChildConfigArgs, noOpCodeSandbox } from ${JSON.stringify(sandbox)};`,
      `const value = await noOpCodeSandbox.runCodeModule({ codeFilePath: ${JSON.stringify(step)}, inputs: {} });`,
      `process.stdout.write(JSON.stringify({ value, args: codeChildConfigArgs() }));`,
    ].join("\n"));
    const r = spawnSync(process.execPath, [engineConfigArg(), "--no-env-file", "--no-install", script], { cwd, env: sanitizedEnv() });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual({ value: [42, null], args: [`--config=${ENGINE_BUNFIG_PATH}`] });
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("codeChildConfigArgs forwards only a usable --config= spelling", () => {
    expect(codeChildConfigArgs(["--config=/x/empty.toml", "--smol"], "linux")).toEqual(["--config=/x/empty.toml"]);
    expect(codeChildConfigArgs(["--config=/a.toml", "--config=/b.toml"], "linux")).toEqual(["--config=/b.toml"]);
    // `--config=` with no value leaves the cwd bunfig read (measured): never forwarded.
    expect(codeChildConfigArgs(["--config="], "linux")).toEqual(["--config=/dev/null"]);
    expect(codeChildConfigArgs([], "darwin")).toEqual(["--config=/dev/null"]);
    expect(codeChildConfigArgs(["--config=C:\\jarvis\\engine-bunfig.toml"], "win32")).toEqual(["--config=C:\\jarvis\\engine-bunfig.toml"]);
    expect(() => codeChildConfigArgs([], "win32")).toThrow("CODE step refused");
  });
});
