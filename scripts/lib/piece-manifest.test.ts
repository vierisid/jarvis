import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classificationRank, extractManifest, fetchPieceManifest } from "./piece-manifest";

function bundle(source: string): { entry: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "piece-manifest-test-"));
  const entry = join(dir, "index.js");
  writeFileSync(entry, source);
  return { entry, dir };
}

describe("extractManifest", () => {
  test("reads names, classifications and sorted props of the piece export", () => {
    const { entry, dir } = bundle(`
      module.exports = {
        auth: { required: true },
        acme: { _actions: {
          b: { name: "b_send", classification: "WRITE", props: { to: {}, body: {} }, description: "Send" },
          a: { name: "a_read", props: {} },
        } },
      };`);
    try {
      const r = extractManifest(entry, dir);
      expect(r).toEqual({ kind: "ok", manifest: { version: "", actions: [
        { name: "a_read", classification: null, props: [] },
        { name: "b_send", classification: "WRITE", props: ["body", "to"], description: "Send" },
      ] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The sync job holds a GITHUB_TOKEN, and the bundle is third-party code. A
   * child spawned without an explicit env inherits the parent's, even after a
   * `delete process.env.X`, so the extractor is given PATH and HOME only.
   */
  test("the piece's code runs without the parent's environment", () => {
    const { entry, dir } = bundle(`
      const seen = Object.keys(process.env).filter((k) => k !== "PATH" && k !== "HOME").join(",");
      module.exports = { probe: { _actions: { a: { name: "env:" + seen, props: {} } } } };`);
    process.env.PIECE_MANIFEST_TEST_SECRET = "s3cret";
    try {
      const r = extractManifest(entry, dir);
      expect(r.kind === "ok" && r.manifest.actions[0]!.name).toBe("env:");
    } finally {
      delete process.env.PIECE_MANIFEST_TEST_SECRET;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the piece's code runs in its temp dir, not the checkout", () => {
    const { entry, dir } = bundle(`module.exports = { p: { _actions: { a: { name: "cwd:" + process.cwd(), props: {} } } } };`);
    try {
      const r = extractManifest(entry, dir);
      expect(r.kind === "ok" && r.manifest.actions[0]!.name).toBe(`cwd:${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A hostile package that ignores SIGTERM must not hold the job past the limit. */
  test("a load that traps SIGTERM and spins is killed at the time limit", () => {
    const { entry, dir } = bundle(`process.on("SIGTERM", () => {}); const end = Date.now() + 60000; while (Date.now() < end) {}`);
    try {
      const started = Date.now();
      const r = extractManifest(entry, dir, { timeoutMs: 1500 });
      expect(r.kind).toBe("error");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same piece exported under two names is one piece", () => {
    const { entry, dir } = bundle(`const p = { _actions: { a: { name: "a", props: {} } } }; module.exports = { p, alias: p };`);
    try {
      expect(extractManifest(entry, dir).kind).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module that throws, or exports no single piece, is an error", () => {
    for (const source of [
      `throw new Error("boom")`,
      `module.exports = { helper: 1 }`,
      `module.exports = { a: { _actions: {} }, b: { _actions: {} } }`,
    ]) {
      const { entry, dir } = bundle(source);
      try {
        expect(extractManifest(entry, dir).kind).toBe("error");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("fetchPieceManifest", () => {
  test("a tarball that does not match the registry's integrity is refused before it is unpacked", async () => {
    const fakeFetch = (async (url: string | URL) => {
      if (String(url).endsWith(".tgz")) return new Response("not the published bytes");
      return Response.json({ dist: { tarball: "https://registry.test/acme-1.0.0.tgz", integrity: "sha512-AAAA" } });
    }) as typeof fetch;
    expect(await fetchPieceManifest("@activepieces/piece-acme", "1.0.0", { fetch: fakeFetch })).toEqual({
      kind: "error",
      error: "tarball does not match the registry's integrity",
    });
  });

  test("metadata without a sha512 integrity is refused", async () => {
    const fakeFetch = (async () => Response.json({ dist: { tarball: "x", shasum: "abc" } })) as unknown as typeof fetch;
    expect((await fetchPieceManifest("@activepieces/piece-acme", "1.0.0", { fetch: fakeFetch })).kind).toBe("error");
  });
});

test("classificationRank orders the upstream vocabulary and puts the unknown last", () => {
  expect(classificationRank(null)).toBeNull();
  expect(classificationRank("READ")).toBe(classificationRank("SEARCH"));
  expect(classificationRank("READ")!).toBeLessThan(classificationRank("WRITE")!);
  expect(classificationRank("WRITE")!).toBeLessThan(classificationRank("DESTRUCTIVE")!);
  expect(classificationRank("DESTRUCTIVE")!).toBeLessThan(classificationRank("SOMETHING_NEW")!);
});
