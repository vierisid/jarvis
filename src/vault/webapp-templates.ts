/**
 * Webapp Templates — Pre-built browser navigation instructions
 *
 * Stores per-app instructions that get injected into the system prompt
 * when Jarvis detects a relevant webapp in the user's message or URL.
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
 */
export function getWebappTemplateByDomain(url: string): WebappTemplate | null {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM webapp_templates WHERE enabled = 1'
  ).all() as WebappRow[];

  // Extract hostname from URL
  let hostname: string;
  try {
    hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    hostname = url.toLowerCase();
  }

  for (const row of rows) {
    const domains: string[] = JSON.parse(row.domains);
    for (const domain of domains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return rowToTemplate(row);
      }
    }
  }

  return null;
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
 * Match webapp templates against a user message.
 * Checks for app name mentions, URL patterns, and keyword triggers.
 * Returns all matching templates (usually 0-1).
 */
export function matchWebappTemplates(message: string): WebappTemplate[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM webapp_templates WHERE enabled = 1'
  ).all() as WebappRow[];

  if (rows.length === 0) return [];

  const msgLower = message.toLowerCase();
  const matched: WebappTemplate[] = [];

  for (const row of rows) {
    const appNameLower = row.app_name.toLowerCase();

    // Check if app name appears in message
    if (msgLower.includes(appNameLower)) {
      matched.push(rowToTemplate(row));
      continue;
    }

    // Check if any domain appears in message
    const domains: string[] = JSON.parse(row.domains);
    let domainMatch = false;
    for (const domain of domains) {
      if (msgLower.includes(domain)) {
        matched.push(rowToTemplate(row));
        domainMatch = true;
        break;
      }
    }
    if (domainMatch) continue;

    // Check if any keyword triggers match
    const keywords: string[] = JSON.parse(row.keywords);
    for (const keyword of keywords) {
      if (msgLower.includes(keyword.toLowerCase())) {
        matched.push(rowToTemplate(row));
        break;
      }
    }
  }

  return matched;
}

/**
 * Format matched templates into prompt-ready text.
 */
export function formatWebappInstructions(templates: WebappTemplate[]): string {
  if (templates.length === 0) return '';

  const sections: string[] = [];

  for (const t of templates) {
    sections.push(`## ${t.app_name} — Browser Instructions`);
    sections.push(`Domains: ${t.domains.join(', ')}`);
    sections.push('');
    sections.push(t.instructions);
  }

  return sections.join('\n');
}

/**
 * Main entry: get formatted webapp instructions for a user message.
 * Returns empty string if no matching templates found.
 */
export function getWebappInstructionsForMessage(message: string): string {
  try {
    const templates = matchWebappTemplates(message);
    return formatWebappInstructions(templates);
  } catch (err) {
    console.error('[WebappTemplates] Error matching templates:', err);
    return '';
  }
}
