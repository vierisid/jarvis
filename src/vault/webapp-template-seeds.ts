/**
 * Webapp Template Seeds — Load templates from YAML files
 *
 * Scans two directories for .yaml/.yml files:
 *   1. Built-in: webapp-templates/ in the package root (shipped with codebase)
 *   2. User overrides: ~/.jarvis/webapp-templates/ (user-created or customized)
 *
 * User files override built-in files when they share the same app_name.
 * Called once at startup — uses upsert so templates update without data loss.
 */

import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseYAML } from 'yaml';
import { upsertWebappTemplate } from './webapp-templates.ts';

export type TemplateSeed = {
  app_name: string;
  domains: string[];
  keywords?: string[];
  description: string;
  instructions: string;
  version?: number;
};

/**
 * Load all .yaml/.yml files from a directory into TemplateSeed objects.
 * Returns a Map keyed by app_name (lowercase) for easy merging.
 */
function loadTemplatesFromDir(dir: string): Map<string, TemplateSeed> {
  const templates = new Map<string, TemplateSeed>();

  if (!existsSync(dir)) return templates;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return templates;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const parsed = parseYAML(content) as Record<string, unknown>;

      if (!parsed.app_name || !parsed.domains || !parsed.instructions) {
        console.warn(`[WebappTemplates] Skipping ${file}: missing required fields (app_name, domains, instructions)`);
        continue;
      }

      const seed: TemplateSeed = {
        app_name: parsed.app_name as string,
        domains: parsed.domains as string[],
        keywords: (parsed.keywords as string[]) || [],
        description: (parsed.description as string) || '',
        instructions: (parsed.instructions as string).trim(),
        version: parsed.version as number | undefined,
      };

      templates.set(seed.app_name.toLowerCase(), seed);
    } catch (err) {
      console.warn(`[WebappTemplates] Failed to parse ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  return templates;
}

/**
 * Seed webapp templates from YAML files into the database.
 *
 * Load order:
 *   1. Built-in templates from webapp-templates/ (package root)
 *   2. User overrides from ~/.jarvis/webapp-templates/
 *   User files override built-in files with the same app_name.
 *
 * Safe to call multiple times — uses upsert.
 */
export function seedWebappTemplates(): void {
  // Resolve built-in directory relative to this source file (works for npm + git)
  const pkgRoot = join(import.meta.dir, '../..');
  const builtinDir = join(pkgRoot, 'webapp-templates');

  // User override directory
  const userDir = join(homedir(), '.jarvis', 'webapp-templates');

  // Ensure user directory exists
  mkdirSync(userDir, { recursive: true });

  // 1. Load built-in templates
  const templates = loadTemplatesFromDir(builtinDir);
  const builtinCount = templates.size;

  // 2. Layer user overrides (same app_name replaces built-in)
  const userTemplates = loadTemplatesFromDir(userDir);
  for (const [key, seed] of userTemplates) {
    templates.set(key, seed);
  }

  // 3. Upsert all into database
  let count = 0;
  for (const seed of templates.values()) {
    try {
      upsertWebappTemplate(seed);
      count++;
    } catch (err) {
      console.error(`[WebappTemplates] Failed to seed ${seed.app_name}:`, err);
    }
  }

  const userCount = userTemplates.size;
  const overrideNote = userCount > 0 ? ` (${userCount} user override${userCount > 1 ? 's' : ''})` : '';
  console.log(`[WebappTemplates] Seeded ${count} webapp templates${overrideNote}`);
}
