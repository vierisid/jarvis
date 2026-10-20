/**
 * #1072: the ON-U-06 preview bundles the D-06 Pebble layout from the current
 * tree. It used to extract ui/src/brief from git object f77b6e71, which is not
 * reachable from main, so a fresh clone silently built a stub with no layout
 * ("Shell: unavailable fixture") and the preview showed nothing real.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPreview } from "./build";

describe("ON-U-06 preview", () => {
  test("bundles the real PebbleLayout and Brief logo from ui/src/brief", async () => {
    const build = await buildPreview();
    expect(build.success).toBe(true);
    const entry = build.outputs.find((o) => o.kind === "entry-point")!;
    const js = await entry.text();
    // Markup only the real layout renders; the old fallback stub returned null.
    // Booleans, not toContain: a failure would otherwise print a 3MB bundle.
    expect({
      layout: js.includes("brief-pebble-layout") && js.includes("data-pebble-available"),
      logo: build.outputs.some((o) => /usejarvis-light.*\.svg$/.test(o.path)),
    }).toEqual({ layout: true, logo: true });
  }, 60_000);

  test("depends on no git object or child process", () => {
    for (const file of readdirSync(import.meta.dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect({ file, childProcess: source.includes("child_process"), fixture: source.includes("on-u-06-shell-fixture") })
        .toEqual({ file, childProcess: false, fixture: false });
    }
  });
});
