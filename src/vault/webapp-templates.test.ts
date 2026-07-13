import { describe, test, expect, beforeEach } from 'bun:test';
import { initDatabase } from './schema.ts';
import {
  upsertWebappTemplate,
  matchWebappTemplates,
  matchWebappTemplatesScored,
  getWebappTemplateByDomain,
  formatWebappInstructions,
  wordBoundedIncludes,
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

describe('wordBoundedIncludes', () => {
  test('matches whole words and phrases', () => {
    expect(wordBoundedIncludes('send it on slack please', 'slack')).toBe(true);
    expect(wordBoundedIncludes('Open Slack.', 'slack')).toBe(true);
    expect(wordBoundedIncludes('check my email now', 'check my email')).toBe(true);
  });

  test('does not match inside larger words', () => {
    expect(wordBoundedIncludes('I have many notions about this', 'notion')).toBe(false);
    expect(wordBoundedIncludes('use gcalc for that', 'gcal')).toBe(false);
    expect(wordBoundedIncludes('rescheduled the job', 'reschedule')).toBe(false);
    expect(wordBoundedIncludes('unslackable', 'slack')).toBe(false);
  });

  test('handles phrases with non-word edges', () => {
    expect(wordBoundedIncludes('send an e-mail to bob', 'e-mail')).toBe(true);
    expect(wordBoundedIncludes('emailing is fine', 'e-mail')).toBe(false);
  });

  test('empty phrase never matches', () => {
    expect(wordBoundedIncludes('anything', '')).toBe(false);
    expect(wordBoundedIncludes('anything', '  ')).toBe(false);
  });
});

describe('matchWebappTemplates (scored matcher)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    seed({
      app_name: 'Slack',
      domains: ['app.slack.com'],
      keywords: ['slack message', 'slack dm'],
    });
    seed({
      app_name: 'WhatsApp',
      domains: ['web.whatsapp.com'],
      keywords: ['send a message to', 'check my messages'],
    });
    seed({
      app_name: 'Google Docs',
      domains: ['docs.google.com/document'],
      keywords: ['create a document'],
    });
    seed({
      app_name: 'Google Sheets',
      domains: ['docs.google.com/spreadsheets', 'sheets.google.com'],
      keywords: ['spreadsheet'],
    });
  });

  test('explicit app-name mention wins over another template keyword', () => {
    // "send a message to" is a WhatsApp keyword, but Slack is named explicitly
    const matches = matchWebappTemplates('send a message to John on Slack');
    expect(matches.map(m => m.app_name)).toEqual(['Slack']);
  });

  test('keyword-only match returns single best template', () => {
    const matches = matchWebappTemplates('can you check my messages?');
    expect(matches.map(m => m.app_name)).toEqual(['WhatsApp']);
  });

  test('app name does not match inside larger words', () => {
    expect(matchWebappTemplates('whatsapping is not a word but whatsappish either')).toEqual([]);
  });

  test('two explicit mentions both match, best first', () => {
    const matches = matchWebappTemplates('check Slack and WhatsApp for updates');
    expect(matches.map(m => m.app_name).sort()).toEqual(['Slack', 'WhatsApp']);
  });

  test('path-specific domain shadows the shorter overlapping one', () => {
    // Sheets URL contains "docs.google.com/spreadsheets"; if Docs claimed bare
    // docs.google.com it would be shadowed. Verify with a template that does.
    seed({ app_name: 'Legacy Docs', domains: ['docs.google.com'], keywords: [] });
    const matches = matchWebappTemplates(
      'summarize https://docs.google.com/spreadsheets/d/abc123/edit'
    );
    expect(matches.map(m => m.app_name)).toEqual(['Google Sheets']);
  });

  test('unrelated messages match nothing', () => {
    expect(matchWebappTemplates('refactor the auth module and run the tests')).toEqual([]);
  });

  test('scored matcher reports explicit flag and reasons', () => {
    const scored = matchWebappTemplatesScored('post a slack message please');
    expect(scored).toHaveLength(1);
    expect(scored[0]!.template.app_name).toBe('Slack');
    expect(scored[0]!.explicit).toBe(true); // app name "slack" inside the keyword phrase counts as name mention
    expect(scored[0]!.reasons.length).toBeGreaterThan(0);
  });

  test('disabled templates never match', () => {
    seed({ app_name: 'Ghost', domains: ['ghost.example.com'], keywords: ['ghost'], enabled: false });
    expect(matchWebappTemplates('open ghost.example.com')).toEqual([]);
  });
});

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

  test('unmatched host returns null', () => {
    expect(getWebappTemplateByDomain('https://example.com')).toBeNull();
  });
});

describe('formatWebappInstructions injection cap', () => {
  const template = (name: string, size: number): WebappTemplate => ({
    id: name,
    app_name: name,
    domains: [`${name.toLowerCase()}.example.com`],
    keywords: [],
    description: '',
    instructions: 'x'.repeat(size),
    version: 1,
    enabled: true,
    created_at: 0,
    updated_at: 0,
  });

  test('injects everything under the cap', () => {
    const out = formatWebappInstructions([template('A', 1000), template('B', 1000)]);
    expect(out).toContain('## A — Browser Instructions');
    expect(out).toContain('## B — Browser Instructions');
    expect(out).not.toContain('omitted for space');
  });

  test('skips templates beyond the cap and says so', () => {
    const out = formatWebappInstructions([template('A', 35_000), template('B', 20_000)]);
    expect(out).toContain('## A — Browser Instructions');
    expect(out).not.toContain('## B — Browser Instructions');
    expect(out).toContain('omitted for space');
    expect(out).toContain('B');
  });

  test('always injects the best match even when oversized', () => {
    const out = formatWebappInstructions([template('Huge', 60_000)]);
    expect(out).toContain('## Huge — Browser Instructions');
  });

  test('empty input produces empty output', () => {
    expect(formatWebappInstructions([])).toBe('');
  });
});
