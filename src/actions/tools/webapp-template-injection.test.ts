import { describe, test, expect, beforeEach } from 'bun:test';
import { initDatabase } from '../../vault/schema.ts';
import { upsertWebappTemplate } from '../../vault/webapp-templates.ts';
import {
  extractSnapshotUrl,
  withWebappTemplateInstructions,
  resetDeliveredWebappTemplates,
  backdateDeliveredWebappTemplate,
} from './webapp-template-injection.ts';

const SNAPSHOT = (url: string) => [
  'Page: Test App',
  `URL: ${url}`,
  '',
  '--- Page Text ---',
  'hello',
  '',
  '--- Interactive Elements (1/1) ---',
  '[1] button "Send"',
].join('\n');

describe('extractSnapshotUrl', () => {
  test('pulls the URL line out of a formatted snapshot', () => {
    expect(extractSnapshotUrl(SNAPSHOT('https://app.test.com/inbox')))
      .toBe('https://app.test.com/inbox');
  });

  test('returns null when there is no URL line', () => {
    expect(extractSnapshotUrl('Clicked element [3]')).toBeNull();
    expect(extractSnapshotUrl('')).toBeNull();
  });

  test('only matches a line-anchored URL field, not page text', () => {
    expect(extractSnapshotUrl('--- Page Text ---\nsee URL: in the docs later'))
      .toBeNull();
  });
});

describe('withWebappTemplateInstructions', () => {
  let templateId: string;

  beforeEach(() => {
    initDatabase(':memory:');
    resetDeliveredWebappTemplates();
    templateId = upsertWebappTemplate({
      app_name: 'TestApp',
      domains: ['app.test.com'],
      description: '',
      instructions: 'Always click carefully on TestApp.',
    }).id;
  });

  test('appends the template once when landing on a known site', () => {
    const first = withWebappTemplateInstructions(SNAPSHOT('https://app.test.com/inbox'));
    expect(first).toContain('You are now on TestApp');
    expect(first).toContain('## TestApp — Browser Instructions');
    expect(first).toContain('Always click carefully on TestApp.');
    // The original snapshot is preserved at the top
    expect(first.startsWith('Page: Test App')).toBe(true);

    const second = withWebappTemplateInstructions(SNAPSHOT('https://app.test.com/other'));
    expect(second).not.toContain('You are now on TestApp');
  });

  test('unknown sites pass through untouched', () => {
    const snap = SNAPSHOT('https://unknown.example.com/');
    expect(withWebappTemplateInstructions(snap)).toBe(snap);
  });

  test('error results pass through untouched', () => {
    expect(withWebappTemplateInstructions('Error: Sidecar "x" is offline.', 'https://app.test.com'))
      .toBe('Error: Sidecar "x" is offline.');
  });

  test('falls back to the requested URL when the result has no URL line', () => {
    const out = withWebappTemplateInstructions('Task dispatched to "pc" and running in the background.', 'https://app.test.com/inbox');
    expect(out).toContain('You are now on TestApp');
  });

  test('no URL anywhere → untouched', () => {
    expect(withWebappTemplateInstructions('Clicked element [3]')).toBe('Clicked element [3]');
  });

  test('re-delivers after the TTL expires', () => {
    withWebappTemplateInstructions(SNAPSHOT('https://app.test.com/'));
    backdateDeliveredWebappTemplate(templateId, Date.now() - 31 * 60_000);
    const again = withWebappTemplateInstructions(SNAPSHOT('https://app.test.com/'));
    expect(again).toContain('You are now on TestApp');
  });

  test('different sites each get their own delivery', () => {
    upsertWebappTemplate({
      app_name: 'OtherApp',
      domains: ['other.test.com'],
      description: '',
      instructions: 'OtherApp rules.',
    });
    const a = withWebappTemplateInstructions(SNAPSHOT('https://app.test.com/'));
    const b = withWebappTemplateInstructions(SNAPSHOT('https://other.test.com/'));
    expect(a).toContain('You are now on TestApp');
    expect(b).toContain('You are now on OtherApp');
    expect(b).not.toContain('TestApp');
  });
});
