/**
 * #1166: a piece bundle compiles its packages from the engine staging install
 * only, so THIRD_PARTY_NOTICES-engine.md (built from that install) describes
 * what the npm package's piece bundles carry. Before, esbuild walked up from
 * the piece's source into the repository's own node_modules first.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { assertPieceInputsFromStaging } from "./build-pieces";

test("a piece input from any node_modules but staging is refused; staging and the repo sources pass", () => {
  const staging = resolve("/x/cache/engine-build/node_modules");
  const ok = [
    resolve("/x/cache/engine-build/node_modules/axios/index.js"),
    "src/workflows/activepieces/packages/pieces/core/http/src/index.ts",
  ];
  expect(() => assertPieceInputsFromStaging("p", ok, staging)).not.toThrow();
  expect(() => assertPieceInputsFromStaging("p", [...ok, "node_modules/nanoid/url-alphabet/index.js"], staging))
    .toThrow(/piece p REFUSED: 1 input\(s\) came from outside the engine staging install, e\.g\. "node_modules\/nanoid\/url-alphabet\/index\.js"/);
  // A path that only starts with the staging dir's name is not inside it.
  expect(() => assertPieceInputsFromStaging("p", [resolve("/x/cache/engine-build/node_modules-evil/a/node_modules/b.js")], staging)).toThrow(/REFUSED/);
});
