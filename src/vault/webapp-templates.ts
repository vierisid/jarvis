/**
 * Webapp Templates — Pre-built browser navigation instructions
 *
 * Stores per-app instructions that get delivered to the model when the
 * browser actually lands on a known webapp (browser_navigate/browser_snapshot
 * resolve the page URL through getWebappTemplateByDomain). Mentioning an app
 * in conversation does NOT load its template — only browsing it does.
 */

import { getDb, generateId } from './schema.ts';

export type WebappTemplate = {
  id: string;
  app_name: string;
  domains: string[];
  keywords: string[];
  description: string;
  instructions: string;
  version: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
};

type WebappRow = {
  id: string;
  app_name: string;
  domains: string;
  keywords: string;
  description: string;
  instructions: string;
  version: number;
  enabled: number;
  created_at: number;
  updated_at: number;
};

function rowToTemplate(row: WebappRow): WebappTemplate {
  return {
    ...row,
    domains: JSON.parse(row.domains),
    keywords: JSON.parse(row.keywords),
    enabled: row.enabled === 1,
  };
}

/**
 * Upsert a webapp template (insert or update by app_name).
 */
export function upsertWebappTemplate(template: {
  app_name: string;
  domains: string[];
  keywords?: string[];
  description: string;
  instructions: string;
  version?: number;
  enabled?: boolean;
}): WebappTemplate {
  const db = getDb();
  const now = Date.now();

  // Check if exists
  const existing = db.prepare(
    'SELECT id, version FROM webapp_templates WHERE app_name = ?'
  ).get(template.app_name) as { id: string; version: number } | null;

  if (existing) {
    db.prepare(`
      UPDATE webapp_templates
      SET domains = ?, keywords = ?, description = ?, instructions = ?, version = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(template.domains),
      JSON.stringify(template.keywords ?? []),
      template.description,
      template.instructions,
      template.version ?? existing.version + 1,
      (template.enabled ?? true) ? 1 : 0,
      now,
      existing.id,
    );
    return getWebappTemplate(existing.id)!;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO webapp_templates (id, app_name, domains, keywords, description, instructions, version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    template.app_name,
    JSON.stringify(template.domains),
    JSON.stringify(template.keywords ?? []),
    template.description,
    template.instructions,
    template.version ?? 1,
    (template.enabled ?? true) ? 1 : 0,
    now,
    now,
  );

  return getWebappTemplate(id)!;
}

/**
 * Get a template by ID.
 */
export function getWebappTemplate(id: string): WebappTemplate | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM webapp_templates WHERE id = ?').get(id) as WebappRow | null;
  return row ? rowToTemplate(row) : null;
}

/**
 * Get a template by app name (case-insensitive).
 */
export function getWebappTemplateByName(appName: string): WebappTemplate | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM webapp_templates WHERE LOWER(app_name) = LOWER(?) AND enabled = 1'
  ).get(appName) as WebappRow | null;
  return row ? rowToTemplate(row) : null;
}

/**
 * Find templates matching a domain (e.g. "web.whatsapp.com").
 *
 * Domain entries may include a path prefix (e.g. "docs.google.com/spreadsheets")
 * to disambiguate apps that share a hostname. When several templates match,
 * the most specific (longest) domain entry wins.
 */
export function getWebappTemplateByDomain(url: string): WebappTemplate | null {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM webapp_templates WHERE enabled = 1'
  ).all() as WebappRow[];

  // Extract hostname + path from URL
  let hostname: string;
  let path = '';
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    hostname = parsed.hostname;
    path = parsed.pathname;
  } catch {
    hostname = url.toLowerCase();
  }

  let best: { template: WebappTemplate; specificity: number } | null = null;

  for (const row of rows) {
    const domains: string[] = JSON.parse(row.domains);
    for (const domain of domains) {
      const [domainHost = '', ...pathParts] = domain.split('/');
      const domainPath = pathParts.length > 0 ? `/${pathParts.join('/')}` : '';
      const hostMatches = hostname === domainHost || hostname.endsWith(`.${domainHost}`);
      const pathMatches = domainPath === '' || path.startsWith(domainPath);
      if (hostMatches && pathMatches && (!best || domain.length > best.specificity)) {
        best = { template: rowToTemplate(row), specificity: domain.length };
      }
    }
  }

  return best?.template ?? null;
}

/**
 * List all webapp templates.
 */
export function listWebappTemplates(enabledOnly = true): WebappTemplate[] {
  const db = getDb();
  const query = enabledOnly
    ? 'SELECT * FROM webapp_templates WHERE enabled = 1 ORDER BY app_name'
    : 'SELECT * FROM webapp_templates ORDER BY app_name';
  const rows = db.prepare(query).all() as WebappRow[];
  return rows.map(rowToTemplate);
}

/**
 * Format a template into prompt-ready text. URL-driven delivery resolves at
 * most one template per page, so this formats exactly one.
 */
export function formatWebappInstructions(template: WebappTemplate): string {
  return [
    `## ${template.app_name} — Browser Instructions`,
    `Domains: ${template.domains.join(', ')}`,
    '',
    template.instructions,
  ].join('\n');
}

/**
 * Main entry: resolve a page URL to its template's prompt-ready instructions.
 * Used by the browser tools to deliver the playbook for the site the agent
 * just landed on. Returns null when no template claims the URL.
 */
export function getWebappInstructionsForUrl(
  url: string
): { templateId: string; appName: string; instructions: string } | null {
  try {
    const template = getWebappTemplateByDomain(url);
    if (!template) return null;
    return {
      templateId: template.id,
      appName: template.app_name,
      instructions: formatWebappInstructions(template),
    };
  } catch (err) {
    console.error('[WebappTemplates] Error resolving template for URL:', err);
    return null;
  }
}
