import { resolve } from 'node:path';

/** Bundles the fixture preview into `outdir`. Never part of the production UI build. */
export async function buildPreview(outdir: string) {
  return Bun.build({ entrypoints: [resolve(import.meta.dir, 'index.html')], outdir, target: 'browser' });
}
