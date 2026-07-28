import { describe, test, expect, beforeEach } from 'bun:test';
import { initDatabase } from './schema.ts';
import {
  upsertWebappTemplate,
  getWebappTemplateByDomain,
  getWebappInstructionsForUrl,
  formatWebappInstructions,
  type WebappTemplate,
} from './webapp-templates.ts';

function seed(t: Partial<Parameters<typeof upsertWebappTemplate>[0]> & { app_name: string }) {
  return upsertWebappTemplate({
    domains: [],
    keywords: [],
    description: '',
    instructions: `instructions for ${t.app_name}`,
    ...t,
  });
}

describe('getWebappTemplateByDomain', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    seed({ app_name: 'Google Docs', domains: ['docs.google.com/document'] });
    seed({ app_name: 'Google Sheets', domains: ['docs.google.com/spreadsheets'] });
    seed({ app_name: 'WhatsApp', domains: ['web.whatsapp.com'] });
  });

  test('resolves path-qualified domains to the right app', () => {
    expect(getWebappTemplateByDomain('https://docs.google.com/spreadsheets/d/x/edit')?.app_name)
      .toBe('Google Sheets');
    expect(getWebappTemplateByDomain('https://docs.google.com/document/d/x/edit')?.app_name)
      .toBe('Google Docs');
  });

  test('plain hostname domains still work, including subdomains', () => {
    expect(getWebappTemplateByDomain('web.whatsapp.com')?.app_name).toBe('WhatsApp');
    expect(getWebappTemplateByDomain('https://web.whatsapp.com/some/path')?.app_name).toBe('WhatsApp');
  });

  test('most specific domain entry wins when both match', () => {
    seed({ app_name: 'Legacy Docs', domains: ['docs.google.com'] });
    expect(getWebappTemplateByDomain('https://docs.google.com/spreadsheets/d/x/edit')?.app_name)
      .toBe('Google Sheets');
  });

  test('unmatched host returns null', () => {
    expect(getWebappTemplateByDomain('https://example.com')).toBeNull();
  });

  test('disabled templates never resolve', () => {
    seed({ app_name: 'Ghost', domains: ['ghost.example.com'], enabled: false });
    expect(getWebappTemplateByDomain('https://ghost.example.com')).toBeNull();
  });
});

describe('getWebappInstructionsForUrl', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    seed({ app_name: 'Slack', domains: ['app.slack.com'] });
  });

  test('resolves a browsed URL to formatted instructions', () => {
    const resolved = getWebappInstructionsForUrl('https://app.slack.com/client/T123/C456');
    expect(resolved).not.toBeNull();
    expect(resolved!.appName).toBe('Slack');
    expect(resolved!.templateId).toBeTruthy();
    expect(resolved!.instructions).toContain('## Slack — Browser Instructions');
    expect(resolved!.instructions).toContain('instructions for Slack');
  });

  test('returns null for URLs no template claims', () => {
    expect(getWebappInstructionsForUrl('https://example.com/whatever')).toBeNull();
  });

  test('never throws on garbage input', () => {
    expect(getWebappInstructionsForUrl('')).toBeNull();
    expect(getWebappInstructionsForUrl('not a url at all')).toBeNull();
  });
});

describe('formatWebappInstructions', () => {
  test('formats a single template into a prompt-ready block', () => {
    const template: WebappTemplate = {
      id: 'a',
      app_name: 'A',
      domains: ['a.example.com', 'alias.example.com'],
      keywords: [],
      description: '',
      instructions: 'Be careful on A.',
      version: 1,
      enabled: true,
      created_at: 0,
      updated_at: 0,
    };
    expect(formatWebappInstructions(template)).toBe(
      '## A — Browser Instructions\nDomains: a.example.com, alias.example.com\n\nBe careful on A.'
    );
  });
});
