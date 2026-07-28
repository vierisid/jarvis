import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { lintTemplates, loadTemplatesForLint, type LintableTemplate } from './lint-webapp-templates.ts';

function tpl(overrides: Partial<LintableTemplate> = {}): LintableTemplate {
  return {
    file: 'test.yaml',
    app_name: 'TestApp',
    domains: ['app.test.com'],
    keywords: ['frobnicate dashboard'],
    description: 'A test template',
    instructions: 'Navigate and click. If the login screen appears, tell the user to sign in.',
    version: 1,
    ...overrides,
  };
}

const rules = (findings: ReturnType<typeof lintTemplates>) => findings.map(f => f.rule);

describe('lintTemplates', () => {
  test('clean template produces no findings', () => {
    expect(lintTemplates([tpl()])).toEqual([]);
  });

  test('schema: missing required fields are errors', () => {
    const findings = lintTemplates([{ file: 'bad.yaml' }]);
    const errs = findings.filter(f => f.severity === 'error' && f.rule === 'schema');
    expect(errs.length).toBeGreaterThanOrEqual(3); // app_name, domains, instructions
  });

  test('schema: empty domains array is an error', () => {
    expect(rules(lintTemplates([tpl({ domains: [] })]))).toContain('schema');
  });

  test('size: oversized instructions error, large ones warn', () => {
    const warn = lintTemplates([tpl({ instructions: 'login screen ' + 'x'.repeat(13_000) })]);
    expect(warn.find(f => f.rule === 'size')?.severity).toBe('warning');

    const err = lintTemplates([tpl({ instructions: 'login screen ' + 'x'.repeat(25_000) })]);
    expect(err.find(f => f.rule === 'size')?.severity).toBe('error');
  });

  test('unknown browser tools are errors, known ones are fine', () => {
    const bad = lintTemplates([tpl({ instructions: 'login: use browser_wait then browser_hover' })]);
    const unknown = bad.filter(f => f.rule === 'unknown-tool');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.message).toContain('browser_wait');
  });

  test('desktop_press_keys and run_command are errors', () => {
    const findings = lintTemplates([tpl({
      instructions: 'login: desktop_press_keys("ctrl,b") then run_command to copy the file',
    })]);
    const desktopErrors = findings.filter(f => f.rule === 'desktop-tool' && f.severity === 'error');
    expect(desktopErrors).toHaveLength(2);
  });

  test('Chrome-reserved shortcuts are errors in both syntaxes', () => {
    const prose = lintTemplates([tpl({ instructions: 'login, then press Ctrl+N to create a page' })]);
    expect(rules(prose)).toContain('chrome-reserved-shortcut');

    const desktopSyntax = lintTemplates([tpl({ instructions: 'login, then press_keys "ctrl,shift,n"' })]);
    expect(rules(desktopSyntax)).toContain('chrome-reserved-shortcut');

    const workspaceSwitch = lintTemplates([tpl({ instructions: 'login, switch workspace with ctrl,2' })]);
    expect(rules(workspaceSwitch)).toContain('chrome-reserved-shortcut');

    // Ctrl+K reaches the page — must NOT be flagged
    const fine = lintTemplates([tpl({ instructions: 'login, open search with browser_press_key "Ctrl+K"' })]);
    expect(rules(fine)).not.toContain('chrome-reserved-shortcut');
  });

  test('wrong browser_upload_file signature is an error', () => {
    const bad = lintTemplates([tpl({ instructions: 'login: browser_upload_file([file_input_id], "/path")' })]);
    expect(rules(bad)).toContain('upload-signature');

    const alsoBad = lintTemplates([tpl({ instructions: 'login: browser_upload_file(element_id, path)' })]);
    expect(rules(alsoBad)).toContain('upload-signature');

    const good = lintTemplates([tpl({ instructions: 'login: browser_upload_file("/path/to/file.pdf")' })]);
    expect(rules(good)).not.toContain('upload-signature');
  });

  test('missing login/state handling is a warning', () => {
    const findings = lintTemplates([tpl({ instructions: 'Just click around until it works.' })]);
    expect(findings.find(f => f.rule === 'no-state-recognition')?.severity).toBe('warning');
  });

  test('positional selector on destructive action is a warning', () => {
    const findings = lintTemplates([tpl({
      instructions: 'login: click the 4th toolbar button to Delete the email',
    })]);
    expect(rules(findings)).toContain('positional-destructive');

    // Positional on a harmless action is not flagged by this rule
    const fine = lintTemplates([tpl({ instructions: 'login: click the first button to open the menu' })]);
    expect(rules(fine)).not.toContain('positional-destructive');
  });

  test('keywords are inert metadata — no hygiene findings on any content', () => {
    // The message-mention matcher is gone (templates deliver by browsed URL),
    // so even keywords that used to be trigger hazards must not be flagged.
    const findings = lintTemplates([tpl({
      app_name: 'Notion',
      keywords: ['create a folder', 'open notion', 'notion page'],
    })]);
    expect(findings).toEqual([]);
  });
});

describe('loadTemplatesForLint (real templates dir)', () => {
  test('loads and lints the repo templates without crashing', () => {
    const dir = join(import.meta.dir, '..', 'webapp-templates');
    const templates = loadTemplatesForLint(dir);
    expect(templates.length).toBeGreaterThanOrEqual(9);
    // Lint runs to completion; current templates are known to have findings
    const findings = lintTemplates(templates);
    expect(Array.isArray(findings)).toBe(true);
  });
});
