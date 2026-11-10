/**
 * F-09: the compiled core text helper. Markdown to HTML never returns active
 * HTML (script, event handlers, javascript: links).
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

const dir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/text-helper');
const bundle = resolve(dir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: Record<string, unknown>) => Promise<unknown>;
let markdown: Run;

const md = (text: string) => markdown({ propsValue: { markdown: text, flavor: 'github', headerLevelStart: 1, tables: true, noHeaderId: false, simpleLineBreaks: false, openLinksInNewWindow: false } }) as Promise<string>;

describe.skipIf(skip)('the compiled core text helper', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(dir);
    const mod = require(bundle) as Record<string, { getAction(name: string): { run: Run } }>;
    const piece = Object.values(mod).find((v) => typeof v?.getAction === 'function')!;
    markdown = piece.getAction('markdown_to_html').run;
  });

  test('markdown to HTML drops scripts, styles, frames, event handlers and javascript: URLs', async () => {
    const html = await md([
      'Hello <script>alert(1)</script> **world**',
      '',
      '<img src="x" onerror="alert(2)">',
      '',
      '<iframe src="https://evil.example"></iframe><style>body{display:none}</style>',
      '',
      '[click](javascript:alert(3)) and <a href=" jav&#x09;ascript:alert(4)">tab</a>',
      '',
      '<a href="data:text/html,<script>alert(5)</script>" onclick="x()">d</a>',
    ].join('\n'));
    expect(html).not.toMatch(/<script|<iframe|<style|onerror|onclick|javascript:|data:text/i);
    expect(html).not.toMatch(/alert\(/);
  });

  test('markdown to HTML keeps ordinary formatting, safe links and images', async () => {
    const html = await md('# Title\n\nSome **bold** and *em* text with `code`.\n\n- one\n- two\n\n[site](https://example.com/a?b=1)\n\n![pic](https://example.com/p.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<a href="https://example.com/a?b=1">site</a>');
    expect(html).toContain('<img src="https://example.com/p.png"');
    expect(html).toContain('<table>');
  });

  test('a link that opens in a new window keeps noopener', async () => {
    const html = await markdown({ propsValue: { markdown: '[x](https://example.com)', flavor: 'github', headerLevelStart: 1, tables: true, noHeaderId: false, simpleLineBreaks: false, openLinksInNewWindow: true } }) as string;
    expect(html).toContain('target=');
    expect(html).toContain('noopener');
  });
});
