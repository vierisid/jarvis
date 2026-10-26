import { join } from "node:path";

/** Bundles the ON-U-06 preview in memory from the tree it sits in. The D-06
 * Pebble layout, logo and styles are imported straight from ui/src/brief, so
 * a fresh clone builds the real shell: no git object, temporary checkout or
 * fixture fallback is involved (#1072). Review-only; production never
 * imports the preview. */
export async function buildPreview() {
  return Bun.build({ entrypoints: [join(import.meta.dir, "preview.tsx")], target: "browser", sourcemap: "inline", naming: "[name].[ext]" });
}
