/**
 * #961: every loaded core piece's compiled bundle loads in the engine's
 * runtime and lists its actions. A bundle that throws on load (an ES module
 * dependency reading `import.meta.url`, as openpgp does; jsdom resolving a
 * worker file the bundle does not carry) would be a piece the editor offers and
 * the engine cannot run.
 *
 * Needs the compiled pieces; skips without them, and builds them under
 * `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildPiece, loadedCorePieceDirs } from './build-pieces';

const bundle = (dir: string) => resolve(dir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !loadedCorePieceDirs().every((dir) => existsSync(bundle(dir)));
const require = createRequire(import.meta.url);

interface LoadedPiece {
  metadata(): { actions: Record<string, unknown>; triggers: Record<string, unknown> };
  getAction(name: string): { run(context: Record<string, unknown>): Promise<unknown> } | undefined;
}
const loaded = new Map<string, LoadedPiece>();

describe.skipIf(skip)('every loaded core piece bundle', () => {
  beforeAll(async () => {
    for (const dir of loadedCorePieceDirs()) {
      if (buildOptIn) await buildPiece(dir);
      const mod = require(bundle(dir)) as Record<string, unknown>;
      const piece = Object.values(mod).find((v) => v !== null && typeof v === 'object' && typeof (v as LoadedPiece).metadata === 'function');
      loaded.set(dir.split('/').pop()!, piece as LoadedPiece);
    }
  });

  test('loads and lists its actions (schedule only triggers)', () => {
    const counts = Object.fromEntries([...loaded].map(([name, piece]) => {
      const { actions, triggers } = piece.metadata();
      return [name, Object.keys(name === 'schedule' ? triggers : actions).length > 0];
    }));
    expect(counts).toEqual(Object.fromEntries(loadedCorePieceDirs().map((dir) => [dir.split('/').pop()!, true])));
  });

  test('the text helper parses HTML with jsdom and never runs its scripts', async () => {
    const run = loaded.get('text-helper')!.getAction('extract_from_html')!.run;
    const html = '<p class="x">hello</p><script>document.querySelector(".x").textContent = "ran"</script>';
    await expect(run({ propsValue: { html, target: 'custom', selector: '.x', extractionType: 'textContent', returnMultiple: false } })).resolves.toBe('hello');
  });

  test('the crypto piece runs openpgp, which reads import.meta.url as it loads', async () => {
    const run = loaded.get('crypto')!.getAction('openpgpEncrypt')!.run;
    const out = await run({ propsValue: { publicKey: 'not a key', file: { filename: 'a.txt', data: Buffer.from('x') } } }) as Record<string, unknown>;
    // openpgp's own armor parser answered, so the library loaded and ran.
    expect(out).toEqual({ success: false, error: 'Misformed armored text' });
  });

  test('the PDF piece does not offer "Convert to Image", which shells out to pdftoppm', () => {
    const actions = Object.keys(loaded.get('pdf')!.metadata().actions).sort();
    expect(actions).toEqual(['addTextToPdf', 'extractPdfPages', 'extractText', 'imageToPdf', 'mergePdfs', 'pdfPageCount', 'textToPdf']);
  });
});
