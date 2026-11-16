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
let extractText: Run;
const files = { write: async ({ data }: { data: Buffer }) => data };

const convert = (text: string, replace?: boolean) => textToPdf({ propsValue: { text, replaceUnsupportedCharacters: replace }, files }) as Promise<Buffer>;
const textOf = async (pdf: Buffer) => String(await extractText({ propsValue: { file: { data: Buffer.from(pdf) } } }));
const failure = async (run: Promise<unknown>) => {
  const error = await run.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
};

describe.skipIf(skip)('the compiled core PDF piece', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(dir);
    const mod = require(bundle) as Record<string, { getAction(name: string): { run: Run } }>;
    const piece = Object.values(mod).find((v) => typeof v?.getAction === 'function')!;
    textToPdf = piece.getAction('textToPdf').run;
    addText = piece.getAction('addTextToPdf').run;
    extractText = piece.getAction('extractText').run;
  });

  test('Text to PDF still converts Latin text, accents and CRLF line breaks', async () => {
    const pdf = await convert('Caffe latte, cr\u00e8me br\u00fbl\u00e9e\r\nSecond line\twith a tab');
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('everything the font can show is accepted: Latin-1, typographic symbols, accents typed as separate marks', async () => {
    const latin1 = Array.from({ length: 0x100 - 0xa0 }, (_, i) => String.fromCodePoint(0xa0 + i)).join('');
    const symbols = '\u20ac \u2122 \u201c\u201d \u2018\u2019 \u2014 \u2013 \u2022 \u2026 \u2020 \u2021 \u2030 \u0152\u0153 \u0160\u0161 \u017d\u017e \u0178 \u0192';
    for (const text of [latin1, symbols]) {
      expect(Buffer.from(await convert(text)).subarray(0, 5).toString()).toBe('%PDF-');
    }
    // "cafe" with the accent as a combining mark (as macOS often stores it).
    expect(await textOf(await convert('cafe\u0301'))).toContain('caf\u00e9');
  });

  test('emoji and CJK text fail by default in plain words, naming the characters', async () => {
    for (const [text, named] of [['Launch \u{1F680}', '"\u{1F680}"'], ['\u65e5\u672c\u8a9e', '"\u65e5", "\u672c", "\u8a9e"']] as const) {
      const message = await failure(convert(text));
      expect(message).toContain(`The PDF font cannot show some characters (found ${named})`);
      expect(message).toContain('Western European text only');
      expect(message).toContain('Replace characters the PDF cannot show');
      expect(message).not.toContain('WinAnsi');
    }
  });

  test('the characters it names are clipped to five and kept on one line, invisible ones as U+ codes', async () => {
    const message = await failure(convert('a\u0007b\u000bc\u2028d\u202ee\u{1F680}\u{1F681}\u{1F682}'));
    expect(message).toContain('(found U+0007, U+000B, U+2028, U+202E, "\u{1F680}" and 2 more)');
    expect(message).not.toMatch(/[\p{C}\p{Zl}\p{Zp}]/u);
  });

  test('with the option on, each such character becomes one ? and the PDF is made', async () => {
    const pdf = await convert('Launch \u{1F680} \u65e5\u672c, love \u2764\ufe0f', true);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await textOf(pdf)).toContain('Launch ? ??, love ?');
  });

  const blankPdf = () => convert('A page to stamp');
  const item = (extra: Record<string, unknown>) => ({ text: 'Hello', applyToAllPages: true, distanceFromLeft: 50, distanceFromTop: 50, font: 'Helvetica', ...extra });
  const stamp = async (extra: Record<string, unknown>) => addText({ propsValue: { file: { data: await blankPdf() }, textItems: [item(extra)] }, files });

  test('Add Text to PDF works with no Font Size and still refuses a Font Size of 0', async () => {
    await expect(stamp({})).resolves.toBeDefined();
    await expect(stamp({ fontSize: 0 })).rejects.toThrow(/Font Size must be a positive number/);
  });

  test('Add Text to PDF accepts accents and tabs', async () => {
    await expect(stamp({ text: 'cr\u00e8me cafe\u0301\tbr\u00fbl\u00e9e \u20ac' })).resolves.toBeDefined();
  });

  test('Add Text to PDF fails in plain words on emoji, quoting its text on one line', async () => {
    const message = await failure(stamp({ text: 'Hi\n\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}' }));
    expect(message).toContain('The Helvetica PDF font cannot show some characters (found "\u{1F680}")');
    expect(message).toContain('Western European text only');
    expect(message).toContain('in "Hi \u{1F680}');
    expect(message).not.toMatch(/[\p{C}\p{Zl}\p{Zp}]/u);
  });

  test('Add Text to PDF with the Symbol font says it has symbols only', async () => {
    const message = await failure(stamp({ text: 'Hello', font: 'Symbol' }));
    expect(message).toContain('The Symbol PDF font cannot show some characters');
    expect(message).toContain('pick another font for ordinary text');
  });
});
