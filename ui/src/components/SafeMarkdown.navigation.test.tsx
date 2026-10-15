import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import React from 'react';

let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let SafeMarkdown: typeof import('./SafeMarkdown').SafeMarkdown;
let MarkdownBody: typeof import('../v2/thread/MarkdownBody').MarkdownBody;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;

beforeAll(async () => {
  GlobalRegistrator.register();
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ SafeMarkdown } = await import('./SafeMarkdown'));
  ({ MarkdownBody } = await import('../v2/thread/MarkdownBody'));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
afterAll(() => {
  globals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  GlobalRegistrator.unregister();
});

async function mount(content: React.ReactNode) {
  window.location.hash = '#/_answer_fixture';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(content));
}

const footnote = 'Result[^résumé]. Again[^résumé].\n\n[^résumé]: Supporting evidence.';
for (const surface of ['shared result', 'thread activity'] as const) test(`${surface}: citations keep metadata and navigate within their own result`, async () => {
  const Component = surface === 'shared result' ? SafeMarkdown : MarkdownBody;
  await mount(<><Component text={footnote} /><Component text={footnote} /></>);
  const results = host.querySelectorAll('.safe-markdown');
  expect(results).toHaveLength(2);
  const second = results[1]!;
  const refs = second.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]');
  const backs = second.querySelectorAll<HTMLAnchorElement>('a[data-footnote-backref]');
  const definition = second.querySelector<HTMLElement>('li[id]')!;
  expect(refs).toHaveLength(2);
  expect(backs).toHaveLength(2);
  expect(new Set([...host.querySelectorAll('a[id],li[id]')].map(node => node.id)).size).toBe(6);
  expect(refs[0]!.getAttribute('aria-describedby')).toBe(second.querySelector('h2')!.id);
  expect(backs[1]!.getAttribute('aria-label')).toBe('Back to reference 1-2');
  expect(backs[1]!.classList.contains('data-footnote-backref')).toBe(true);
  expect(backs[1]!.getAttribute('href')).toBe('#' + refs[1]!.id);
  expect(refs[0]!.getAttribute('target')).toBeNull();
  const scrolled: string[] = [];
  definition.scrollIntoView = () => { scrolled.push(definition.id); };
  refs[1]!.scrollIntoView = () => { scrolled.push(refs[1]!.id); };
  await act(async () => refs[1]!.click());
  expect(document.activeElement).toBe(definition);
  await act(async () => backs[1]!.click());
  expect(document.activeElement).toBe(refs[1]!);
  expect(scrolled).toEqual([definition.id, refs[1]!.id]);
  expect(window.location.hash).toBe('#/_answer_fixture');
});

test('missing/malformed fragments leave the room intact and external links retain their protections', async () => {
  await mount(<SafeMarkdown text={'[missing](#missing) [malformed](#%ZZ) [external](https://example.invalid/report "Report")'} />);
  const links = host.querySelectorAll<HTMLAnchorElement>('a');
  await act(async () => { links[0]!.click(); links[1]!.click(); });
  expect(window.location.hash).toBe('#/_answer_fixture');
  expect(links[2]!.target).toBe('_blank');
  expect(links[2]!.rel).toBe('noopener noreferrer');
  expect(links[2]!.title).toBe('Report');
});
