/**
 * #837: a CODE step can import what its package.json declares, and nothing
 * the registry happens to serve.
 *
 * Two halves, held separately:
 *   - the SANDBOX (no-op-code-sandbox.ts, compiled into the engine) runs the
 *     step with `--no-install`, so an undeclared bare require fails, names the
 *     package, and fetches nothing. Exercised on a real child, with an empty
 *     install cache that must stay empty.
 *   - MATERIALIZATION (code-materialize.ts, in the daemon) installs the
 *     declared dependencies beside the step from a manifest it synthesizes,
 *     refusing anything that is not a plain registry dependency. Exercised
 *     with an injected installer, so no test here needs the registry.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { noOpCodeSandbox } from "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox";
import {
  bunInstall,
  CODE_INSTALL_TIMEOUT_MS,
  declaredDependencies,
  INSTALLED_MANIFEST_MARKER,
  materializeCodeActions,
  runInstall,
  synthesizedManifest,
} from "./code-materialize";
import type { UpstreamFlowVersion } from "./flow-version-adapter";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(): string {
  // Under the OS tmpdir: no `node_modules` above it, which is the shape of the
  // real code directory and the precondition for Bun's auto-install.
  const dir = mkdtempSync(join(tmpdir(), "jarvis-code-pkgs-"));
  roots.push(dir);
  return dir;
}

/** Run `fn` with env overrides, restored after (bun test shares one process). */
async function withEnv<T>(over: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  Object.assign(process.env, over);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("the CODE sandbox never fetches a package (#837)", () => {
  test("an undeclared bare require fails, names the package, and installs nothing", async () => {
    const root = scratch();
    const cache = join(root, "bun-cache");
    mkdirSync(cache);
    const stepDir = join(root, "codes", "v1", "step_1");
    mkdirSync(stepDir, { recursive: true });
    writeFileSync(
      join(stepDir, "index.js"),
      `exports.code = async () => require("is-number")(5);`,
    );
    const outcome = await withEnv({ BUN_INSTALL_CACHE_DIR: cache }, () =>
      noOpCodeSandbox
        .runCodeModule({ codeFilePath: join(stepDir, "index.js"), inputs: {} })
        .then((value) => ({ ok: true as const, value }), (e: Error) => ({ ok: false as const, message: e.message })));
    // Before #837 this step SUCCEEDED: Bun fetched is-number from the registry.
    expect(outcome.ok).toBe(false);
    const message = outcome.ok ? "" : outcome.message;
    expect(message).toContain('CODE step requires package "is-number"');
    expect(message).toContain("does not declare");
    // And the registry was never consulted: the empty cache is still empty.
    expect(readdirSync(cache)).toEqual([]);
  }, 60_000);

  test("a package installed beside the step still loads", async () => {
    const root = scratch();
    const stepDir = join(root, "codes", "v1", "step_1");
    const pkgDir = join(stepDir, "node_modules", "local-dep");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pkgDir, "index.js"), `module.exports = (x) => x * 2;`);
    writeFileSync(join(stepDir, "index.js"), `exports.code = async (i) => require("local-dep")(i.n);`);
    const value = await noOpCodeSandbox.runCodeModule({ codeFilePath: join(stepDir, "index.js"), inputs: { n: 21 } });
    expect(value).toBe(42);
  }, 60_000);

  // Found in review: a missing FILE of an installed package was reported as an
  // undeclared package.
  test("a missing subpath of an installed package is not reported as undeclared", async () => {
    const root = scratch();
    const stepDir = join(root, "codes", "v1", "step_1");
    const pkgDir = join(stepDir, "node_modules", "local-dep");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pkgDir, "index.js"), `module.exports = 1;`);
    writeFileSync(join(stepDir, "index.js"), `exports.code = async () => require("local-dep/nope");`);
    const err = await noOpCodeSandbox
      .runCodeModule({ codeFilePath: join(stepDir, "index.js"), inputs: {} })
      .then(() => null, (e: Error) => e.message);
    expect(err).not.toBeNull();
    expect(err).not.toContain("does not declare");
  }, 60_000);

  /**
   * Both shapes a MODULE_NOT_FOUND message comes in, pinned directly rather
   * than through a child process -- because WHICH shape you get depends on the
   * runtime, so a test that spawns a child only ever covers the shape that
   * runtime emits. Bun 1.3.x writes "from '<path>'"; Bun 1.4.x and Node write a
   * "Require stack:" block. Reading only the first made every 1.4.x error look
   * like a missing declaration, since both exemptions need the requiring file.
   * CI found it on the first run after the image and CI converged on 1.4.2,
   * while the child-process tests above passed locally on 1.3.8.
   */
  test("the requiring file is recovered from either message shape", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts"),
      "utf8",
    );
    const raw = /const CODE_RUNNER_SCRIPT = `([\s\S]*?)`\n/.exec(src)?.[1];
    // Not an assertion for its own sake: if the constant is ever renamed or
    // reshaped, this test would silently classify nothing.
    if (raw === undefined) throw new Error("could not find CODE_RUNNER_SCRIPT in no-op-code-sandbox.ts");
    // Apply template-literal escape semantics, as loading the module does.
    const js = eval("`" + raw.replace(/\$\{/g, "\\${") + "`") as string;
    const classify = new Function(
      "require",
      js.slice(js.indexOf("function undeclaredPackageError")) + "; return undeclaredPackageError;",
    )(require) as (e: unknown) => Error;

    const root = scratch();
    const step = join(root, "step");
    mkdirSync(join(step, "node_modules", "local-dep"), { recursive: true });
    const idx = join(step, "index.js");
    const inside = join(step, "node_modules", "local-dep", "index.js");
    const notFound = (message: string) => Object.assign(new Error(message), { code: "MODULE_NOT_FOUND" });
    const rewritten = (message: string) => classify(notFound(message)).message.includes("does not declare");

    // A missing subpath of a package that IS installed is not a missing
    // declaration, in either shape.
    expect(rewritten(`Cannot find module 'local-dep/nope' from '${idx}'`)).toBe(false);
    expect(rewritten(`Cannot find module 'local-dep/nope'\nRequire stack:\n- ${idx}`)).toBe(false);
    // A require made from inside an installed package is not the step's fault.
    expect(rewritten(`Cannot find module 'x'\nRequire stack:\n- ${inside}`)).toBe(false);
    // A genuinely undeclared package still gets the rewrite, in either shape.
    expect(rewritten(`Cannot find module 'totally-absent' from '${idx}'`)).toBe(true);
    expect(rewritten(`Cannot find module 'totally-absent'\nRequire stack:\n- ${idx}`)).toBe(true);
  });

  test("a scoped undeclared package is named by its scope and name, with the original error kept", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.js"), `exports.code = async () => require("@scope/pkg/sub");`);
    const err = await noOpCodeSandbox
      .runCodeModule({ codeFilePath: join(root, "index.js"), inputs: {} })
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain('CODE step requires package "@scope/pkg"');
    expect(err).toContain("@scope/pkg/sub");
  }, 60_000);

  // Bun's own ResolveMessage, unchanged (it inspects as "ResolveMessage {}",
  // which predates #837); the point is that it is not blamed on a declaration.
  test("a missing relative module is not reported as an undeclared package", async () => {
    const root = scratch();
    writeFileSync(join(root, "index.js"), `exports.code = async () => require("./nope");`);
    const err = await noOpCodeSandbox
      .runCodeModule({ codeFilePath: join(root, "index.js"), inputs: {} })
      .then(() => null, (e: Error) => e.message);
    expect(err).not.toBeNull();
    expect(err).not.toContain("CODE step requires package");
  }, 60_000);
});

describe("declaredDependencies", () => {
  test("reads registry versions, ranges and tags, sorted", () => {
    const deps = {
      zod: "^4.0.0", "@scope/x": "1.2.3", y: "latest", z: ">=1 <2 || 3.x",
      h: "1.2.3 - 2.0.0", p: "1.0.0-rc.1", w: "*", t: "~1.4", v: "v2",
    };
    expect(declaredDependencies("s", JSON.stringify({ dependencies: deps }))).toEqual(
      Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
  });

  test("an empty or dependency-free manifest declares nothing", () => {
    for (const text of ["", "  ", "{}", JSON.stringify({ name: "x", scripts: { postinstall: "x" } })]) {
      expect(declaredDependencies("s", text)).toEqual({});
    }
  });

  test.each([
    ["file:", "file:../../../etc"],
    ["link:", "link:/tmp/x"],
    ["workspace:", "workspace:*"],
    ["npm alias", "npm:evil@1.0.0"],
    ["git", "git+ssh://git@example.com/x.git"],
    ["url", "https://example.com/x.tgz"],
    ["github shorthand", "user/repo"],
    // Specs Bun installs from disk with no ':' or '/' at all (found in review).
    ["folder (.)", "."],
    ["folder (..)", ".."],
    ["local tarball", "evil.tgz"],
    ["local .tar.gz", "evil.tar.gz"],
    ["local .tar", "evil.tar"],
    ["tarball shaped as a prerelease", "1.0.0-x.tgz"],
    ["home-relative path", "~/x"],
    ["empty", ""],
    ["garbage", "^^1"],
    ["operators only", "||"],
  ])("refuses a %s spec, naming the step", (_label, spec) => {
    expect(() => declaredDependencies("my_step", JSON.stringify({ dependencies: { a: spec } }))).toThrow(/CODE step "my_step"/);
  });

  test.each([
    ["non-string", { a: 1 }],
    ["path-shaped name", { "../x": "1.0.0" }],
    ["nested name", { "a/b/c": "1.0.0" }],
  ])("refuses a %s dependency, naming the step", (_label, deps) => {
    expect(() => declaredDependencies("my_step", JSON.stringify({ dependencies: deps }))).toThrow(/CODE step "my_step"/);
  });

  test("refuses malformed manifests rather than ignoring them", () => {
    expect(() => declaredDependencies("s", "{not json")).toThrow(/not valid JSON/);
    expect(() => declaredDependencies("s", "[]")).toThrow(/JSON object/);
    expect(() => declaredDependencies("s", JSON.stringify({ dependencies: ["a"] }))).toThrow(/must be an object/);
  });
});

function versionWithCode(packageJson: string, stepName = "compute"): UpstreamFlowVersion {
  return {
    id: "v_1",
    trigger: {
      name: "trigger",
      type: "EMPTY",
      nextAction: {
        name: stepName,
        type: "CODE",
        settings: { sourceCode: { packageJson, code: "exports.code = async () => 1;" }, input: {} },
      },
    },
  } as unknown as UpstreamFlowVersion;
}

/** What a real `bun install` leaves in the directory it ran in, plus `pkgs`. */
const fakeInstall = (pkgs: string[] = [], onCall?: (dir: string) => void) => async (dir: string) => {
  onCall?.(dir);
  writeFileSync(join(dir, "bun.lock"), "{}");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  for (const p of pkgs) mkdirSync(join(dir, "node_modules", p), { recursive: true });
};

describe("materializeCodeActions installs exactly what was declared", () => {
  test("installs from a synthesized manifest, without the step's own scripts or overrides", async () => {
    const base = scratch();
    const seen: string[] = [];
    await materializeCodeActions(
      versionWithCode(JSON.stringify({
        dependencies: { "is-number": "7.0.0" },
        scripts: { preinstall: "touch /tmp/pwned" },
        overrides: { "is-number": "file:/x" },
      })),
      base,
      { install: fakeInstall([], (dir) => seen.push(readFileSync(join(dir, "package.json"), "utf8"))) },
    );
    expect(seen).toEqual([synthesizedManifest({ "is-number": "7.0.0" })]);
    expect(JSON.parse(seen[0]!)).toEqual({ name: "jarvis-code-step", private: true, dependencies: { "is-number": "7.0.0" } });
  });

  test("the installed tree lands beside the step, and nothing of the install is left behind", async () => {
    const base = scratch();
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { "is-number": "7.0.0" } })), base, {
      install: fakeInstall(["is-number"]),
    });
    const stepDir = join(base, "v_1", "compute");
    expect(readdirSync(stepDir).sort()).toEqual(["index.js", "node_modules"]);
    expect(existsSync(join(stepDir, "node_modules", "is-number"))).toBe(true);
  });

  test("an install taken over by an enclosing workspace is refused, not trusted", async () => {
    // Reproduced in review: a package.json with "workspaces" above the code
    // directory makes Bun install THERE, with its specs, leaving nothing in the
    // directory it was run in.
    const base = scratch();
    await expect(
      materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { "is-number": "7.0.0" } })), base, {
        install: async () => {},
      }),
    ).rejects.toThrow(/did not install .* where it was run/);
    expect(existsSync(join(base, "v_1", "compute", "node_modules"))).toBe(false);
  });

  test("skips an install already done for the same manifest, redoes it when the manifest changes", async () => {
    const base = scratch();
    let installs = 0;
    const install = fakeInstall([], () => installs++);
    const a = JSON.stringify({ dependencies: { "is-number": "7.0.0" } });
    await materializeCodeActions(versionWithCode(a), base, { install });
    await materializeCodeActions(versionWithCode(a), base, { install });
    expect(installs).toBe(1);
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { "is-number": "6.0.0" } })), base, { install });
    expect(installs).toBe(2);
  });

  test("a failed install is retried next time rather than trusted", async () => {
    const base = scratch();
    let calls = 0;
    const ok = fakeInstall();
    const flaky = async (dir: string) => {
      calls++;
      if (calls === 1) throw new Error("registry down");
      await ok(dir);
    };
    const pj = JSON.stringify({ dependencies: { "is-number": "7.0.0" } });
    await expect(materializeCodeActions(versionWithCode(pj), base, { install: flaky })).rejects.toThrow("registry down");
    expect(existsSync(join(base, "v_1", "compute", "node_modules", INSTALLED_MANIFEST_MARKER))).toBe(false);
    await materializeCodeActions(versionWithCode(pj), base, { install: flaky });
    expect(calls).toBe(2);
  });

  test("a replaced tree is retired, not deleted under a run that may still use it, and swept next time", async () => {
    const base = scratch();
    const stepDir = join(base, "v_1", "compute");
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { a: "1.0.0" } })), base, { install: fakeInstall(["a"]) });
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { b: "1.0.0" } })), base, { install: fakeInstall(["b"]) });
    expect(existsSync(join(stepDir, "node_modules", "b"))).toBe(true);
    expect(existsSync(join(stepDir, "node_modules", "a"))).toBe(false);
    const retired = readdirSync(stepDir).filter((e) => e.startsWith(".retired-"));
    expect(retired.length).toBe(1);
    expect(existsSync(join(stepDir, retired[0]!, "a"))).toBe(true);
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { b: "1.0.0" } })), base, { install: fakeInstall(["b"]) });
    expect(readdirSync(stepDir).filter((e) => e.startsWith(".retired-"))).toEqual([]);
  });

  test("dropping every declaration takes the previous install away, so it stops resolving", async () => {
    const base = scratch();
    await materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { "is-number": "7.0.0" } })), base, {
      install: fakeInstall(["is-number"]),
    });
    const stepDir = join(base, "v_1", "compute");
    expect(existsSync(join(stepDir, "node_modules", "is-number"))).toBe(true);
    await materializeCodeActions(versionWithCode("{}"), base, { install: fakeInstall() });
    expect(existsSync(join(stepDir, "node_modules"))).toBe(false);
  });

  test("a refused manifest writes nothing", async () => {
    const base = scratch();
    const install = async () => {
      throw new Error("must not install");
    };
    await expect(
      materializeCodeActions(versionWithCode(JSON.stringify({ dependencies: { a: "file:/etc" } })), base, { install }),
    ).rejects.toThrow(/CODE step "compute"/);
    expect(existsSync(resolve(base, "v_1"))).toBe(false);
  });

  test("a step name that escapes the code directory is refused", async () => {
    const base = scratch();
    await expect(materializeCodeActions(versionWithCode("{}", "../../escape"), base, { install: async () => {} }))
      .rejects.toThrow(/outside the code directory/);
  });
});

describe("installs queue only behind installs (review)", () => {
  const withId = (v: UpstreamFlowVersion, id: string) => ({ ...v, id }) as UpstreamFlowVersion;

  test("a step with nothing to install does not wait behind another flow's slow install", async () => {
    const base = scratch();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = materializeCodeActions(withId(versionWithCode(JSON.stringify({ dependencies: { a: "1.0.0" } })), "v_slow"), base, {
      install: async (dir) => {
        await gate;
        await fakeInstall(["a"])(dir);
      },
    });
    const fast = await Promise.race([
      materializeCodeActions(withId(versionWithCode("{}"), "v_fast"), base, { install: fakeInstall() }).then(() => "done"),
      new Promise((r) => setTimeout(() => r("blocked"), 2_000)),
    ]);
    release();
    await slow;
    expect(fast).toBe("done");
  });

  test("two installs never run at once", async () => {
    const base = scratch();
    let running = 0;
    let peak = 0;
    const install = async (dir: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 50));
      await fakeInstall(["x"])(dir);
      running--;
    };
    await Promise.all(["v_a", "v_b", "v_c"].map((id) =>
      materializeCodeActions(withId(versionWithCode(JSON.stringify({ dependencies: { x: "1.0.0" } })), id), base, { install })));
    expect(peak).toBe(1);
  });

  test("a later step's escaping name refuses the flow before any step is written", async () => {
    const base = scratch();
    const version = {
      id: "v_1",
      trigger: {
        name: "trigger", type: "EMPTY",
        nextAction: {
          name: "first", type: "CODE",
          settings: { sourceCode: { packageJson: "{}", code: "exports.code = async () => 1;" }, input: {} },
          nextAction: {
            name: "../../escape", type: "CODE",
            settings: { sourceCode: { packageJson: "{}", code: "exports.code = async () => 1;" }, input: {} },
          },
        },
      },
    } as unknown as UpstreamFlowVersion;
    await expect(materializeCodeActions(version, base, { install: fakeInstall() })).rejects.toThrow(/outside the code directory/);
    expect(existsSync(join(base, "v_1"))).toBe(false);
  });
});

describe("the install is bounded", () => {
  test("an install that hangs is killed at its timeout and fails", async () => {
    const dir = scratch();
    const started = Date.now();
    const err = await runInstall(dir, process.execPath, ["-e", "setTimeout(() => {}, 600000)"], 300)
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain("killed after 300 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  // The real installer, run against a fake `bun` first on PATH that records
  // what it was given (the spawn-env-sites pattern), so no registry is needed.
  test.skipIf(process.platform === "win32")("the real installer runs bun install, scripts off, hoisted, in the dir, without the daemon's secrets", async () => {
    const root = scratch();
    const bin = join(root, "bin");
    const work = join(root, "work");
    mkdirSync(bin);
    mkdirSync(work);
    const log = join(root, "argv.txt");
    writeFileSync(join(bin, "bun"),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" "secret=$ANTHROPIC_API_KEY" > ${JSON.stringify(log)}\n`, { mode: 0o755 });
    await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, ANTHROPIC_API_KEY: "sentinel-do-not-log" }, () => bunInstall(work));
    const [cwd, ...rest] = readFileSync(log, "utf8").trim().split("\n");
    expect(cwd).toBe(work);
    expect(rest).toEqual(["install", "--silent", "--ignore-scripts", "--linker=hoisted", "secret="]);
    expect(CODE_INSTALL_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
