/**
 * Webapp template linter — keeps the template library honest.
 *
 * Checks every webapp-templates/*.yaml against the REAL browser tool surface
 * and the trigger-hygiene rules from WEBAPP_TEMPLATES_AUDIT.md:
 *   - schema: required fields, sane types
 *   - executability: only real browser_* tools, no desktop-tool routing,
 *     no Chrome-reserved shortcuts, correct browser_upload_file signature
 *   - keyword hygiene: no keywords that fire on everyday non-webapp requests,
 *     no redundant (app-name-containing) keywords, no cross-template shadowing
 *   - structure: state recognition present, no positional selectors on
 *     destructive actions, size budget
 *
 * Usage: bun run scripts/lint-webapp-templates.ts [dir]
 * Exits 1 if any template has errors (warnings don't fail the build).
 */

import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYAML } from 'yaml';
import { wordBoundedIncludes } from '../src/vault/webapp-templates.ts';

export type LintSeverity = 'error' | 'warning';

export type LintFinding = {
  file: string;
  severity: LintSeverity;
  rule: string;
  message: string;
};

export type LintableTemplate = {
  file: string;
  app_name?: unknown;
  domains?: unknown;
  keywords?: unknown;
  description?: unknown;
  instructions?: unknown;
  version?: unknown;
};

/** The browser tools that actually exist (src/actions/tools/builtin.ts). */
const KNOWN_BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_hover',
  'browser_press_key',
  'browser_scroll',
  'browser_upload_file',
  'browser_evaluate',
  'browser_screenshot',
  'browser_close',
]);

/**
 * Shortcuts Chrome intercepts at the browser level — they NEVER reach the
 * page, so no template may instruct pressing them (matches both
 * "Ctrl+N" prose and "ctrl,n" desktop_press_keys syntax).
 */
const CHROME_RESERVED_RE = /\bctrl\s*[+,]\s*(shift\s*[+,]\s*)?(n|t|w|f5|[0-9])\b/i;

/**
 * Everyday requests that must NOT trigger any webapp template. A keyword that
 * fires on one of these will hijack unrelated conversations with a full
 * template injection.
 */
export const NON_WEBAPP_PROMPTS = [
  'create a folder for the screenshots',
  'delete the file config.old from the repo',
  'find a file called notes.txt on my desktop',
  'open the file in vim',
  'rename the file to index.ts',
  'move the file into src/utils',
  'list files in the downloads folder',
  'what is the word count of this README',
  'insert a comment above this function',
  'read the docs for bun test',
  'take notes while I dictate',
  'my presentation is tomorrow morning',
  'make a deck of flashcards for spanish',
  'add event listener to the button',
  'create event handlers for the form',
  'reschedule the cron job to midnight',
  'what do i have to change in this file',
  'do i have anything misconfigured here',
  'find the event loop bug',
  'enter data into the signup form',
  'add a row to the database table',
  'add a column to the users table',
  'find and replace across the project',
  'add a tab to the settings page',
  'sort the data with pandas',
  'filter the data by date in sql',
  'send a message to the team on discord',
  'post in channel on discord',
  'check my messages on telegram',
  'upload a file to the s3 bucket',
  'give access to the deploy key',
  'text message me when the build is done',
];

const MAX_INSTRUCTIONS_WARN = 12_000;
const MAX_INSTRUCTIONS_ERROR = 24_000;

export function lintTemplates(templates: LintableTemplate[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (file: string, severity: LintSeverity, rule: string, message: string) =>
    findings.push({ file, severity, rule, message });

  // Per-template checks
  for (const t of templates) {
    const file = t.file;

    // --- schema ---
    if (typeof t.app_name !== 'string' || !t.app_name.trim()) {
      add(file, 'error', 'schema', 'missing or empty app_name');
    }
    if (!Array.isArray(t.domains) || t.domains.length === 0 || !t.domains.every(d => typeof d === 'string')) {
      add(file, 'error', 'schema', 'domains must be a non-empty string array');
    }
    if (typeof t.instructions !== 'string' || !t.instructions.trim()) {
      add(file, 'error', 'schema', 'missing or empty instructions');
    }
    if (t.keywords !== undefined && (!Array.isArray(t.keywords) || !t.keywords.every(k => typeof k === 'string'))) {
      add(file, 'error', 'schema', 'keywords must be a string array');
    }
    if (t.version !== undefined && typeof t.version !== 'number') {
      add(file, 'error', 'schema', 'version must be a number');
    }
    if (typeof t.description !== 'string' || !t.description.trim()) {
      add(file, 'warning', 'schema', 'missing description');
    }

    const instructions = typeof t.instructions === 'string' ? t.instructions : '';
    const appName = typeof t.app_name === 'string' ? t.app_name : '';
    const keywords = Array.isArray(t.keywords) ? (t.keywords as string[]) : [];

    // --- size budget ---
    if (instructions.length > MAX_INSTRUCTIONS_ERROR) {
      add(file, 'error', 'size',
        `instructions are ${(instructions.length / 1024).toFixed(1)}KB (hard cap ${MAX_INSTRUCTIONS_ERROR / 1000}KB) — the whole block is injected into the system prompt`);
    } else if (instructions.length > MAX_INSTRUCTIONS_WARN) {
      add(file, 'warning', 'size',
        `instructions are ${(instructions.length / 1024).toFixed(1)}KB (target ≤${MAX_INSTRUCTIONS_WARN / 1000}KB)`);
    }

    // --- executability: unknown browser tools ---
    const toolMentions = new Set(instructions.match(/browser_[a-z_]+/g) ?? []);
    for (const tool of toolMentions) {
      if (!KNOWN_BROWSER_TOOLS.has(tool)) {
        add(file, 'error', 'unknown-tool',
          `references "${tool}" which does not exist (known: ${[...KNOWN_BROWSER_TOOLS].join(', ')})`);
      }
    }

    // --- executability: desktop/OS tools in a browser template ---
    if (/desktop_press_keys/.test(instructions)) {
      add(file, 'error', 'desktop-tool',
        'uses desktop_press_keys (OS-level, hits the focused window, breaks headless/sidecar) — use browser_press_key instead');
    }
    if (/\brun_command\b/.test(instructions)) {
      add(file, 'error', 'desktop-tool',
        'instructs using run_command — browser templates must stay inside the browser tool surface');
    }
    const otherDesktop = new Set((instructions.match(/desktop_[a-z_]+/g) ?? []).filter(d => d !== 'desktop_press_keys'));
    for (const d of otherDesktop) {
      add(file, 'warning', 'desktop-tool', `mentions ${d} — browser templates should not route through desktop tools`);
    }

    // --- executability: Chrome-reserved shortcuts ---
    for (const line of instructions.split('\n')) {
      const m = line.match(CHROME_RESERVED_RE);
      if (m) {
        add(file, 'error', 'chrome-reserved-shortcut',
          `"${m[0]}" is intercepted by Chrome and never reaches the page: "${line.trim().slice(0, 100)}"`);
      }
    }

    // --- executability: browser_upload_file signature ---
    if (/browser_upload_file\s*\(\s*(\[|\belement)/.test(instructions)) {
      add(file, 'error', 'upload-signature',
        'browser_upload_file takes (file_path, selector?) — a CSS selector string, not an element id');
    }

    // --- structure: state recognition ---
    if (instructions && !/log[ -]?in|logged[ -]?(in|out)|sign[ -]?in|auth|qr code/i.test(instructions)) {
      add(file, 'warning', 'no-state-recognition',
        'no login/auth state handling found — templates must detect the logged-out state and tell the user to intervene');
    }

    // --- structure: positional selectors on destructive actions ---
    for (const line of instructions.split('\n')) {
      if (
        /(first|second|third|fourth|1st|2nd|3rd|4th|last|right-?most|left-?most)\s+(\S+\s+){0,3}button/i.test(line) &&
        /delete|trash|remove|archive|discard|permanent/i.test(line)
      ) {
        add(file, 'warning', 'positional-destructive',
          `positional button selector on a destructive action: "${line.trim().slice(0, 100)}"`);
      }
    }

    // --- keyword hygiene: genericity against the corpus ---
    for (const keyword of keywords) {
      const hits = NON_WEBAPP_PROMPTS.filter(p => wordBoundedIncludes(p, keyword.toLowerCase()));
      if (hits.length > 0) {
        add(file, 'error', 'generic-keyword',
          `keyword "${keyword}" fires on non-webapp requests, e.g. "${hits[0]}"`);
      }
    }

    // --- keyword hygiene: redundant keywords (app name already matches) ---
    if (appName) {
      const redundant = keywords.filter(k => wordBoundedIncludes(k, appName.toLowerCase()));
      if (redundant.length > 0) {
        add(file, 'warning', 'redundant-keyword',
          `${redundant.length} keyword(s) contain the app name and are dead weight (the app name already matches): ${redundant.slice(0, 3).map(k => `"${k}"`).join(', ')}${redundant.length > 3 ? ', …' : ''}`);
      }
    }
  }

  // Cross-template: keyword shadowing (A's keyword inside B's keyword → both inject)
  for (const a of templates) {
    const aKeywords = Array.isArray(a.keywords) ? (a.keywords as string[]) : [];
    for (const b of templates) {
      if (a === b) continue;
      const bKeywords = Array.isArray(b.keywords) ? (b.keywords as string[]) : [];
      for (const ka of aKeywords) {
        for (const kb of bKeywords) {
          if (ka.toLowerCase() !== kb.toLowerCase() && wordBoundedIncludes(kb, ka.toLowerCase())) {
            add(a.file, 'warning', 'keyword-shadowing',
              `keyword "${ka}" is contained in ${String(b.app_name)}'s keyword "${kb}" — a message with the longer phrase matches both templates`);
          }
        }
      }
    }
  }

  return findings;
}

export function loadTemplatesForLint(dir: string): LintableTemplate[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const templates: LintableTemplate[] = [];
  for (const file of files) {
    try {
      const parsed = parseYAML(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>;
      templates.push({ file, ...parsed });
    } catch (err) {
      templates.push({ file, app_name: undefined });
      console.error(`[lint] ${file}: YAML parse failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return templates;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, '..', 'webapp-templates');
  const templates = loadTemplatesForLint(dir);
  const findings = lintTemplates(templates);

  const byFile = new Map<string, LintFinding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  let errors = 0;
  let warnings = 0;
  for (const [file, fileFindings] of [...byFile.entries()].sort()) {
    console.log(`\n${file}`);
    for (const f of fileFindings.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1))) {
      const tag = f.severity === 'error' ? 'ERROR' : 'warn ';
      console.log(`  ${tag} [${f.rule}] ${f.message}`);
      if (f.severity === 'error') errors++;
      else warnings++;
    }
  }

  console.log(`\n${templates.length} templates: ${errors} errors, ${warnings} warnings`);
  if (errors > 0) process.exit(1);
}
