/**
 * Webapp Template Seeds — Load templates from YAML files
 *
 * Scans these directories for .yaml/.yml files, later ones winning:
 *   1. Built-in: webapp-templates/ in the package root (shipped with codebase)
 *   2. An earlier install's overrides: ~/.jarvis/webapp-templates/, read only
 *      when it exists and is not the data dir's own
 *   3. User overrides: <data dir>/webapp-templates/ (user-created or customized)
 *
 * User files override built-in files when they share the same app_name.
 * Seeding never stops the daemon starting: a folder that cannot be created or
 * read (a read-only home, a container) is skipped and said so.
 * Called once at startup — uses upsert so templates update without data loss.
 */

import { join, resolve } from 'node:path';
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseYAML } from 'yaml';
import { upsertWebappTemplate } from './webapp-templates.ts';

/** The home directory, or '' when the platform cannot say (a bare container user). */
function safeHomedir(): string {
  try { return homedir(); } catch { return ''; }
}

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
export function seedWebappTemplates(opts: { dataDir?: string; legacyDir?: string; builtinDir?: string } = {}): void {
  // Resolve built-in directory relative to this source file (works for npm + git)
  const pkgRoot = join(import.meta.dir, '../..');
  const builtinDir = opts.builtinDir ?? join(pkgRoot, 'webapp-templates');

  // User override directory: inside the data dir, so an instance that sets
  // JARVIS_HOME keeps everything it writes there and starts with a read-only
  // or missing home. The default mirrors how the data dir itself is chosen.
  const dataDir = opts.dataDir ?? (process.env.JARVIS_HOME || join(safeHomedir(), '.jarvis'));
  const userDir = join(dataDir, 'webapp-templates');
  // Where earlier versions kept them. Read, never written: existing installs
  // keep their overrides without having to move them.
  const legacyDir = opts.legacyDir ?? join(safeHomedir(), '.jarvis', 'webapp-templates');

  // Ensure the override directory exists, so there is a place to put one.
  // Best effort: a failure here is not a reason to stop the daemon.
  try {
    mkdirSync(userDir, { recursive: true });
  } catch (err) {
    console.warn(`[WebappTemplates] Could not create ${userDir}: ${err instanceof Error ? err.message : err}. Built-in templates are used; your own overrides are read from there when it exists.`);
  }

  // 1. Load built-in templates
  const templates = loadTemplatesFromDir(builtinDir);
  const builtinCount = templates.size;

  // 2. Layer overrides, the data dir's last (same app_name replaces the earlier one)
  const userTemplates = new Map<string, TemplateSeed>();
  if (resolve(legacyDir) !== resolve(userDir)) {
    for (const [key, seed] of loadTemplatesFromDir(legacyDir)) userTemplates.set(key, seed);
  }
  for (const [key, seed] of loadTemplatesFromDir(userDir)) userTemplates.set(key, seed);
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
