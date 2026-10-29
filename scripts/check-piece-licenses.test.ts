/**
 * scripts/check-piece-licenses.ts writes --problems into a directory nothing
 * has created yet (#1177 follow-up): the catalog sync passes
 * $RUNNER_TEMP/license-problems/license-problems.txt, and a bare
 * writeFileSync threw ENOENT after the scan, so every weekly run crashed
 * instead of reporting what the scan found.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-piece-licenses.ts");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "check-piece-licenses-"));
  made.push(d);
  return d;
}

// A minimal env, never the caller's: no GIT_*, no tokens.
function env(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir() };
  if (process.env.HOME) base.HOME = process.env.HOME;
  return { ...base, ...extra };
}

async function run(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn([process.execPath, "run", SCRIPT, ...args], {
    env: env(extra),
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(p.stderr).text();
  return { code: await p.exited, stderr };
}

describe("check-piece-licenses --problems", () => {
  test("writes the scan's problems into a directory that does not exist yet", async () => {
    const root = tmp();
    const tree = join(root, "tree");
    mkdirSync(tree);
    const problems = join(root, "license-problems", "nested", "license-problems.txt");
    const { code, stderr } = await run(["--dir", tree, "--problems", problems]);
    expect(stderr).not.toContain("ENOENT");
    // An empty tree is a scan with problems (exit 1), not a crash.
    expect(code).toBe(1);
    const text = readFileSync(problems, "utf8");
    expect(text).toContain("bun.lock is missing");
    // Capped for the PR body.
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(50);
    expect(text).toMatch(/\.\.\. and \d+ more problem\(s\)/);
  }, 30_000);

  test("writes the install failure into a directory that does not exist yet", async () => {
    // A registry that answers 404 to everything fails the install at once.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not found", { status: 404 }) });
    try {
      const root = tmp();
      const problems = join(root, "license-problems", "license-problems.txt");
      const { code, stderr } = await run(["--install", join(root, "install"), "--problems", problems], {
        BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}/`,
        BUN_INSTALL_CACHE_DIR: join(root, "cache"),
      });
      expect(stderr).not.toContain("ENOENT");
      expect(code).toBe(2);
      expect(existsSync(problems)).toBe(true);
      expect(readFileSync(problems, "utf8")).toContain("bun install of the shared pieces tree failed");
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
