import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

// Review-only extraction, never imported by the production view. Uses this exact
// existing D-06 object if present locally; no fetch, checkout, cherry-pick or install.
export const SHELL_SHA = "f77b6e712f2e223ac2d781dbcf38f606c324ba03";
const root = resolve(import.meta.dir, "../../../../../..");
const cache = mkdtempSync(join(tmpdir(), "jarvis-on-u-06-"));
symlinkSync(join(root, "node_modules"), join(cache, "node_modules"), "dir");
let available = process.env.ON_U_06_MISSING_SHELL !== "1";
if (available) {
  try {
    const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", SHELL_SHA, "ui/src/brief"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    for (const file of listing) {
      if (!file.startsWith("ui/src/brief/") || file.split("/").includes("..")) throw new Error("Invalid fixture path");
      const target = join(cache, file); mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, execFileSync("git", ["show", `${SHELL_SHA}:${file}`], { cwd: root, maxBuffer: 5_000_000 }));
    }
  } catch { available = false; }
}
const fixture: BunPlugin = { name: "on-u-06-existing-shell", setup(build) {
  build.onResolve({ filter: /^on-u-06-shell-fixture$/ }, () => ({ path: "shell", namespace: "on-u-06" }));
  build.onLoad({ filter: /.*/, namespace: "on-u-06" }, () => ({ loader: "tsx", contents: available
    ? `export { PebbleLayout } from ${JSON.stringify(join(cache, "ui/src/brief/shell/pebble-layout/PebbleLayout.tsx"))};
       export { BriefBrand } from ${JSON.stringify(join(cache, "ui/src/brief/styles/BriefBrand.tsx"))};
       import ${JSON.stringify(join(cache, "ui/src/brief/styles/index.css"))}; export const available = true;`
    : `export const available = false; export function PebbleLayout(){return null} export function BriefBrand(){return "usejarvis"}` }));
} };
const output = join(cache, "dist");
const build = await Bun.build({ entrypoints: [join(import.meta.dir, "preview.tsx")], outdir: output, plugins: [fixture], target: "browser", sourcemap: "linked", naming: "[dir]/[name].[ext]" });
if (!build.success) { console.error(build.logs); process.exit(1); }
console.log(`ON-U-06 preview build passed. Shell: ${available ? SHELL_SHA : "unavailable fixture"}. Output: ${output}`);
if (!process.argv.includes("--build")) {
  const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jarvis · Pebble tutorial</title><link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@0,400..700;1,400&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>';
  const assets = new Map(build.outputs.map(asset => ["/" + asset.path.slice(output.length + 1), asset]));
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4415), fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    const asset = assets.get(path);
    return asset ? new Response(asset) : new Response("Not found", { status: 404 });
  } });
  console.log(`ON-U-06 preview: ${server.url}`);
}
