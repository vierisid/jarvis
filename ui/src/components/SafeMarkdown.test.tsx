import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown, safeMarkdownUrl } from './SafeMarkdown';
import { MarkdownBody } from '../v2/thread/MarkdownBody';
import { richAttack } from '../../../src/trust-boundaries/fixtures';

for (const [name, render] of [
  ['shared result', (text: string) => <SafeMarkdown text={text} />],
  ['thread activity', (text: string) => <MarkdownBody text={text} />],
] as const) {
  test(`${name}: rich untrusted results remain useful without active HTML or automatic requests`, () => {
    const html = renderToStaticMarkup(render(richAttack));
    expect(html).not.toMatch(/<(script|img|iframe|object|embed|link)\b/i);
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('jarvis:');
    expect(html).toContain('Image: private result');
    expect(html).toContain('href="/q21-image-probe?data=synthetic"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<table>');
    expect(html).toContain('fixture:piece-account');
  });
}
test.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/svg+xml,x', 'file:///tmp/x',
  'jarvis://settings', '//example.invalid/x', '\\example.invalid/x', 'https:\\example.invalid', 'java\nscript:x', 'vbscript:x'])
  ('rejects executable or ambiguous URL %s', url => expect(safeMarkdownUrl(url)).toBe(''));
test.each(['https://example.invalid/a', 'http://localhost:1234/a', 'mailto:owner@example.invalid', '/api/report', '#result'])
  ('preserves explicit link %s', url => expect(safeMarkdownUrl(url)).toBe(url));

test('a linked image keeps its explicit destination without nesting anchors or loading the image', () => {
  const html = renderToStaticMarkup(<SafeMarkdown text="[![preview](https://example.invalid/tracker)](https://example.invalid/report)" />);
  expect(html.match(/<a\b/g)).toHaveLength(1);
  expect(html).toContain('href="https://example.invalid/report"');
  expect(html).not.toContain('tracker');
  expect(html).not.toContain('<img');
  expect(html).toContain('Image: preview');
});
