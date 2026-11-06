/**
 * #1166: THIRD_PARTY_NOTICES-ui.md is exactly what a fresh UI build compiles
 * in, so a package cannot go into the shipped ui/dist without its notice.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI_NOTICES_FILE, uiBundleNotices } from "../src/workflows/pieces-library/bundle-notices";
import { uiBuildInputs } from "./third-party-notices";

const ROOT = resolve(import.meta.dir, "..");

test("the UI notices are exactly what the UI build compiles in, regenerated", () => {
  const inputs = uiBuildInputs(ROOT);
  const fresh = uiBundleNotices(ROOT, inputs);
  expect(fresh.problems).toEqual([]);
  // Not vacuous: the bundle compiles in React and the markdown renderer.
  const names = fresh.packages.map((p) => p.name);
  expect(names).toContain("react-dom");
  expect(names).toContain("react-markdown");
  expect(fresh.text).toBe(readFileSync(resolve(ROOT, UI_NOTICES_FILE), "utf8"));
}, 60_000);
