import { describe, test, expect, beforeEach } from 'bun:test';
import { initDatabase } from '../../vault/schema.ts';
import { upsertWebappTemplate } from '../../vault/webapp-templates.ts';
import {
  extractSnapshotUrl,
  WebappTemplateDelivery,
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

describe('WebappTemplateDelivery', () => {
  let delivery: WebappTemplateDelivery;
  let templateId: string;

  beforeEach(() => {
    initDatabase(':memory:');
    delivery = new WebappTemplateDelivery();
    templateId = upsertWebappTemplate({
      app_name: 'TestApp',
      domains: ['app.test.com'],
      description: '',
      instructions: 'Always click carefully on TestApp.',
    }).id;
  });

  test('appends the template once when landing on a known site', () => {
    const first = delivery.withInstructions(SNAPSHOT('https://app.test.com/inbox'));
    expect(first).toContain('You are now on TestApp');
    expect(first).toContain('## TestApp — Browser Instructions');
    expect(first).toContain('Always click carefully on TestApp.');
    // The original snapshot is preserved at the top
    expect(first.startsWith('Page: Test App')).toBe(true);

    const second = delivery.withInstructions(SNAPSHOT('https://app.test.com/other'));
    expect(second).not.toContain('You are now on TestApp');
  });

  test('unknown sites pass through untouched', () => {
    const snap = SNAPSHOT('https://unknown.example.com/');
    expect(delivery.withInstructions(snap)).toBe(snap);
  });

  test('error results pass through untouched', () => {
    expect(delivery.withInstructions('Error: Sidecar "x" is offline.', 'https://app.test.com'))
      .toBe('Error: Sidecar "x" is offline.');
  });

  test('detached sidecar dispatches pass through — outcome is unknown', () => {
    // Navigation may fail or redirect elsewhere; the next snapshot delivers.
    const detached = 'Task dispatched to "pc" and running in the background.';
    expect(delivery.withInstructions(detached, 'https://app.test.com/inbox')).toBe(detached);
    // The TTL slot was not burned: an actual snapshot still delivers
    expect(delivery.withInstructions(SNAPSHOT('https://app.test.com/inbox')))
      .toContain('You are now on TestApp');
  });

  test('falls back to the requested URL when the result has no URL line', () => {
    // e.g. a pre-parity sidecar returning a JSON blob instead of the
    // formatted snapshot text
    const out = delivery.withInstructions('{"success": true}', 'https://app.test.com/inbox');
    expect(out).toContain('You are now on TestApp');
  });

  test('no URL anywhere → untouched', () => {
    expect(delivery.withInstructions('Clicked element [3]')).toBe('Clicked element [3]');
  });

  test('re-delivers after the TTL expires', () => {
    delivery.withInstructions(SNAPSHOT('https://app.test.com/'));
    delivery.backdate(templateId, Date.now() - 31 * 60_000);
    const again = delivery.withInstructions(SNAPSHOT('https://app.test.com/'));
    expect(again).toContain('You are now on TestApp');
  });

  test('different sites each get their own delivery', () => {
    upsertWebappTemplate({
      app_name: 'OtherApp',
      domains: ['other.test.com'],
      description: '',
      instructions: 'OtherApp rules.',
    });
    const a = delivery.withInstructions(SNAPSHOT('https://app.test.com/'));
    const b = delivery.withInstructions(SNAPSHOT('https://other.test.com/'));
    expect(a).toContain('You are now on TestApp');
    expect(b).toContain('You are now on OtherApp');
    expect(b).not.toContain('TestApp');
  });

  test('instances are isolated — one conversation cannot suppress another', () => {
    // Main agent and background agent are separate conversations with
    // separate histories; each must receive its own copy.
    const backgroundAgent = new WebappTemplateDelivery();
    expect(delivery.withInstructions(SNAPSHOT('https://app.test.com/')))
      .toContain('You are now on TestApp');
    expect(backgroundAgent.withInstructions(SNAPSHOT('https://app.test.com/')))
      .toContain('You are now on TestApp');
  });

  test('reset forgets deliveries', () => {
    delivery.withInstructions(SNAPSHOT('https://app.test.com/'));
    delivery.reset();
    expect(delivery.withInstructions(SNAPSHOT('https://app.test.com/')))
      .toContain('You are now on TestApp');
  });
});
