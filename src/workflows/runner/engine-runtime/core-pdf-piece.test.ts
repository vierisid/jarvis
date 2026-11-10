/**
 * F-18: the compiled core PDF piece. Text the built-in PDF font cannot draw
 * (emoji, Chinese, Japanese) fails in plain words unless the author opts in to
 * a ? stand-in, and "Add Text to PDF" works with no Font Size.
 *
 * Needs the compiled piece. Skips without it, and builds it under
 * `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';

const dir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/pdf');
const bundle = resolve(dir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: Record<string, unknown>) => Promise<unknown>;
let textToPdf: Run;
let addText: Run;
const files = { write: async ({ data }: { data: Buffer }) => data };

const convert = (text: string, replace?: boolean) => textToPdf({ propsValue: { text, replaceUnsupportedCharacters: replace }, files }) as Promise<Buffer>;

describe.skipIf(skip)('the compiled core PDF piece', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(dir);
    const mod = require(bundle) as Record<string, { getAction(name: string): { run: Run } }>;
    const piece = Object.values(mod).find((v) => typeof v?.getAction === 'function')!;
    textToPdf = piece.getAction('textToPdf').run;
    addText = piece.getAction('addTextToPdf').run;
  });

  test('Text to PDF still converts Latin text, accents and CRLF line breaks', async () => {
    const pdf = await convert('Caffe latte, crème brûlée\r\nSecond line\twith a tab');
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('emoji and CJK text fail by default in plain words, naming the characters', async () => {
    for (const text of ['Launch \u{1F680}', '日本語']) {
      const error = await convert(text).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('cannot show emoji or some non-Latin characters');
      expect(message).toContain('Replace characters the PDF cannot show');
      expect(message).not.toContain('WinAnsi');
    }
  });

  test('with the option on, those characters become a ? and the PDF is made', async () => {
    const pdf = await convert('Launch \u{1F680} 日本', true);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });

  const blankPdf = () => convert('A page to stamp');
  const item = (extra: Record<string, unknown>) => ({ text: 'Hello', applyToAllPages: true, distanceFromLeft: 50, distanceFromTop: 50, font: 'Helvetica', ...extra });
  const stamp = async (extra: Record<string, unknown>) => addText({ propsValue: { file: { data: await blankPdf() }, textItems: [item(extra)] }, files });

  test('Add Text to PDF works with no Font Size and still refuses a Font Size of 0', async () => {
    await expect(stamp({})).resolves.toBeDefined();
    await expect(stamp({ fontSize: 0 })).rejects.toThrow(/Font Size must be a positive number/);
  });

  test('Add Text to PDF fails in plain words on emoji', async () => {
    await expect(stamp({ text: 'Hi \u{1F680}' })).rejects.toThrow(/cannot show emoji or some non-Latin characters/);
  });
});
