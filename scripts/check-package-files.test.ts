import { describe, expect, test } from "bun:test";
import { REQUIRED, missingFrom, parseBunPack, parseNpmPack } from "./check-package-files.ts";

describe("check-package-files parseBunPack", () => {
  test("reads paths out of bun pm pack output and ignores the footer", () => {
    const out = [
      "bun pack v1.3.8",
      "",
      "packed 3.79KB package.json",
      "packed 21.45KB bin/jarvis.ts",
      "packed 8.54KB scripts/build-shared-runtime.ts",
      "",
      "Total files: 3",
      "Unpacked size: 0.61GB",
    ].join("\n");
    expect(parseBunPack(out)).toEqual([
      "package.json",
      "bin/jarvis.ts",
      "scripts/build-shared-runtime.ts",
    ]);
  });

  test("keeps paths containing spaces, and yields nothing for unparseable output", () => {
    expect(parseBunPack("packed 1.0KB ui/public/some file.png")).toEqual([
      "ui/public/some file.png",
    ]);
    // An output format change must produce an empty list (which main() reports
    // as a broken parse) rather than partial garbage.
    expect(parseBunPack("added 1.0KB bin/jarvis.ts\nTotal files: 1")).toEqual([]);
  });
});

describe("check-package-files parseNpmPack", () => {
  const files = [{ path: "bin/jarvis.ts" }, { path: "package.json" }];
  const want = ["bin/jarvis.ts", "package.json"];
  // npm 11 shape.
  const asArray = JSON.stringify([{ name: "@usejarvis/brain", files }]);
  // npm 12 shape -- keyed by package name. Verified against npm 12.0.2, which
  // is what `npm install -g npm@latest` in release-exec.yml produces today.
  const asObject = JSON.stringify({ "@usejarvis/brain": { id: "@usejarvis/brain@0.13.1", files } });

  test("reads the file list from BOTH npm envelopes", () => {
    expect(parseNpmPack(asArray)).toEqual(want);
    expect(parseNpmPack(asObject)).toEqual(want);
  });

  test("tolerates notices printed before the JSON", () => {
    expect(parseNpmPack(`npm notice something\n${asArray}`)).toEqual(want);
    expect(parseNpmPack(`npm warn config foo\n${asObject}`)).toEqual(want);
  });

  test("yields nothing rather than throwing on any shape it does not recognize", () => {
    for (const bad of ["", "not json at all", "[", "[{}]", '[{"files":"nope"}]', "{}", "null", '"s"']) {
      expect(parseNpmPack(bad)).toEqual([]);
    }
    // Entries without a string path are dropped, not coerced.
    expect(parseNpmPack('[{"files":[{"path":"a"},{"size":1}]}]')).toEqual(["a"]);
  });
});

describe("check-package-files missingFrom", () => {
  test("matches on the exact tarball path -- a same-named file elsewhere is not it", () => {
    const req = [{ path: "scripts/build-shared-runtime.ts", why: "host builds shared artifacts" }];
    expect(missingFrom(["scripts/build-shared-runtime.ts"], req)).toEqual([]);
    // The failure mode this guards: `files` shipping src/ but not scripts/.
    expect(missingFrom(["src/scripts/build-shared-runtime.ts"], req)).toEqual(req);
    expect(missingFrom([], req)).toEqual(req);
  });
});

describe("check-package-files REQUIRED", () => {
  test("the shared-runtime builder is required -- this is the regression", () => {
    // The bug: install-version gates the whole shared-artifact phase on this
    // path and skips SILENTLY when it is absent, so nothing downstream ever
    // reported that the fleet had no shared engine/pieces/metadata artifacts.
    expect(REQUIRED.map((r) => r.path)).toContain("scripts/build-shared-runtime.ts");
  });

  test("every requirement explains who breaks without it", () => {
    for (const r of REQUIRED) {
      expect(r.path.length).toBeGreaterThan(0);
      expect(r.why.length).toBeGreaterThan(0);
    }
  });
});

describe("check-package-files against the real package", () => {
  // The unit tests above cover parsing and matching; this one closes the gap
  // the reviewer of the original fix found -- that `bun test` alone would not
  // have caught the bug, because nothing in the suite ran a packer. It does,
  // via the same entry point CI and the release use.
  test("the shipped package really does contain every REQUIRED path", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/check-package-files.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(`${stdout}${stderr}`).toContain("OK");
    expect(code).toBe(0);
  }, 60_000);
});
