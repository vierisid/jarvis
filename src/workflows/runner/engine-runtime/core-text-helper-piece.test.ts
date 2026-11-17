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

  // Known XSS shapes: encoded and whitespace-split schemes, SVG/MathML,
  // raw-text elements, forms, embedded documents and conditional comments.
  const payloads = [
    '<svg><script>alert(1)</script></svg>', '<svg onload=alert(1)>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<xmp><img src=x onerror=alert(1)></xmp>', '<noembed><img src=x onerror=alert(1)></noembed>',
    '<plaintext><img src=x onerror=alert(1)>', '<textarea><img src=x onerror=alert(1)></textarea>',
    '<template><img src=x onerror=alert(1)></template>', '<select><style><img src=x onerror=alert(1)></style></select>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
    '<a href="java&#x0A;script:alert(1)">x</a>', '<a href="\u0001javascript:alert(1)">x</a>', '<a href="javas\u0000cript:alert(1)">x</a>',
    '<a href="javascript&colon;alert(1)">x</a>', '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>">', '<img src=x srcset="javascript:alert(1)">',
    '<image src=x onerror=alert(1)>', '<details open ontoggle=alert(1)>x</details>',
    '<input type=checkbox autofocus onfocus=alert(1)>', '<input type=image src=x onerror=alert(1)>',
    '<form action=javascript:alert(1)><button>x</button></form>',
    '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
    '<base href="javascript:/">', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<div style="background:url(javascript:alert(1))">s</div>',
    '<img src="https://x" usemap="#m"><map name=m><area href="javascript:alert(1)">',
    '<!--[if gte mso 9]><img src=x onerror=alert(1)><![endif]-->', '<!--><img src=x onerror=alert(1)>-->',
  ];

  test('known XSS payloads come out inert when the output is parsed again', async () => {
    for (const payload of payloads) {
      const html = await md(payload);
      // A second, independent parser (lol-html) reads the output as a browser
      // or mail client would and finds no comment, no active element, no
      // event handler and no URL outside http(s), mailto, tel or relative.
      const found: string[] = [];
      new HTMLRewriter()
        .on('*', { element(el) {
          const tag = el.tagName.toLowerCase();
          if (/^(script|style|iframe|frame|object|embed|svg|math|form|base|meta|link|template|noscript|area|map)$/.test(tag)) found.push(tag);
          for (const [name, value] of el.attributes) {
            if (/^on|^style$|^srcset$|^srcdoc$|^action$|^formaction$/i.test(name)) found.push(name);
            if ((name === 'href' || name === 'src') && /^[a-z][a-z0-9+.-]*:/i.test(value.replace(/[\u0000-\u0020]+/g, '')) && !/^(https?|mailto|tel):/i.test(value.trim())) found.push(value);
          }
        } })
        .onDocument({ comments(c) { found.push(`<!--${c.text}-->`); } })
        .transform(html);
      expect({ payload, found }).toEqual({ payload, found: [] });
    }
  });

  test('a table column alignment survives as the align attribute', async () => {
    const html = await md('| l | c | r |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
    expect(html).toMatch(/<th[^>]* align="left"[^>]*>l<\/th>/);
    expect(html).toMatch(/<td[^>]* align="center"[^>]*>2<\/td>/);
    expect(html).toMatch(/<td[^>]* align="right"[^>]*>3<\/td>/);
    expect(html).not.toContain('style=');
  });

  test('harmless inline formatting in raw HTML is kept', async () => {
    const html = await md('A <mark>m</mark> <ins>i</ins> <small>s</small> <q>q</q> <cite>c</cite> <var>v</var>');
    for (const tag of ['mark', 'ins', 'small', 'q', 'cite', 'var']) expect(html).toContain(`<${tag}>`);
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
