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
 * Word-bounded, case-insensitive phrase search: "slack" matches "on Slack?"
 * but not "cut me some slack" ... it does — word boundaries can't fix
 * homonyms, but they DO stop "notion" matching "notions", "gcal" matching
 * "gcalc", and keyword edges bleeding into larger words. The homonym problem
 * ("slack" the word vs Slack the app) is handled by keyword/app-name CHOICE
 * in the templates, not here.
 */
export function wordBoundedIncludes(haystack: string, phrase: string): boolean {
  const trimmed = phrase.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Custom boundaries instead of \b: they behave sensibly when the phrase
  // starts/ends with a non-word char (e.g. "e-mail").
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
  return re.test(haystack);
}

export type WebappTemplateMatch = {
  template: WebappTemplate;
  score: number;
  /** true when the app was named explicitly (app name or domain in message) */
  explicit: boolean;
  reasons: string[];
};

/**
 * Match webapp templates against a user message, scored.
 *
 * - App-name and domain mentions are EXPLICIT matches (the user named the
 *   app); keyword hits are implicit.
 * - If any explicit match exists, implicit (keyword-only) matches are
 *   dropped — "send a message to John on Slack" must not inject WhatsApp
 *   just because it also says "send a message to".
 * - With no explicit match, only the single best keyword match is returned;
 *   generic keywords must never co-inject several templates at once.
 * - When one template's matched domain string contains another's (e.g.
 *   "docs.google.com/spreadsheets" vs "docs.google.com"), the less specific
 *   domain hit is discarded.
 */
export function matchWebappTemplatesScored(message: string): WebappTemplateMatch[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM webapp_templates WHERE enabled = 1'
  ).all() as WebappRow[];

  if (rows.length === 0) return [];

  const msgLower = message.toLowerCase();

  type Candidate = WebappTemplateMatch & { domainHits: string[] };
  const candidates: Candidate[] = [];

  for (const row of rows) {
    let score = 0;
    let explicit = false;
    const reasons: string[] = [];
    const domainHits: string[] = [];

    if (wordBoundedIncludes(msgLower, row.app_name.toLowerCase())) {
      score += 100;
      explicit = true;
      reasons.push(`app name "${row.app_name}"`);
    }

    const domains: string[] = JSON.parse(row.domains);
    for (const domain of domains) {
      if (msgLower.includes(domain.toLowerCase())) {
        // Longer domain entries are more specific (path-qualified) hits
        score += 50 + domain.length;
        explicit = true;
        domainHits.push(domain.toLowerCase());
        reasons.push(`domain "${domain}"`);
      }
    }

    const keywords: string[] = JSON.parse(row.keywords);
    let keywordHits = 0;
    for (const keyword of keywords) {
      if (wordBoundedIncludes(msgLower, keyword.toLowerCase())) {
        // Longer keywords are stronger evidence; cap so keyword spam can't
        // outrank an explicit mention of another app
        if (keywordHits < 3) {
          score += 5 + keyword.length;
          reasons.push(`keyword "${keyword}"`);
        }
        keywordHits++;
      }
    }

    if (score > 0) {
      candidates.push({ template: rowToTemplate(row), score, explicit, reasons, domainHits });
    }
  }

  // Domain shadowing: drop a domain hit when another candidate matched a more
  // specific domain string that contains it (docs.google.com/spreadsheets
  // shadows docs.google.com). If that was the candidate's only explicit
  // evidence, it becomes implicit.
  for (const a of candidates) {
    if (a.domainHits.length === 0) continue;
    const surviving = a.domainHits.filter(d =>
      !candidates.some(b => b !== a && b.domainHits.some(bd => bd !== d && bd.includes(d)))
    );
    if (surviving.length < a.domainHits.length) {
      for (const dropped of a.domainHits.filter(d => !surviving.includes(d))) {
        a.score -= 50 + dropped.length;
        a.reasons = a.reasons.filter(r => r !== `domain "${dropped}"`);
      }
      a.domainHits = surviving;
      if (surviving.length === 0 && !a.reasons.some(r => r.startsWith('app name'))) {
        a.explicit = false;
      }
      if (a.score <= 0) a.score = 0;
    }
  }

  const scored = candidates.filter(c => c.score > 0);
  const explicitMatches = scored.filter(c => c.explicit);

  let result: Candidate[];
  if (explicitMatches.length > 0) {
    result = explicitMatches;
  } else {
    // Keyword-only: single best match, ties broken by score then app name
    const best = scored.sort((x, y) => y.score - x.score || x.template.app_name.localeCompare(y.template.app_name))[0];
    result = best ? [best] : [];
  }

  return result
    .sort((x, y) => y.score - x.score)
    .map(({ domainHits: _dropped, ...match }) => match);
}

/**
 * Match webapp templates against a user message.
 * Checks for app name mentions, URL patterns, and keyword triggers.
 * Returns matching templates, best first (usually 0-1).
 */
export function matchWebappTemplates(message: string): WebappTemplate[] {
  return matchWebappTemplatesScored(message).map(m => m.template);
}

/**
 * Hard cap on injected instruction characters (~10K tokens). Templates are
 * injected best-match-first; when the next template would blow the budget it
 * is skipped and replaced by a one-line pointer, so the model knows the
 * instructions exist rather than silently missing them.
 */
const MAX_INJECTED_CHARS = 40_000;

/**
 * Format matched templates into prompt-ready text.
 */
export function formatWebappInstructions(templates: WebappTemplate[]): string {
  if (templates.length === 0) return '';

  const sections: string[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const t of templates) {
    const block = [
      `## ${t.app_name} — Browser Instructions`,
      `Domains: ${t.domains.join(', ')}`,
      '',
      t.instructions,
    ].join('\n');

    // Always inject at least the best match, even if oversized
    if (sections.length > 0 && used + block.length > MAX_INJECTED_CHARS) {
      skipped.push(t.app_name);
      continue;
    }
    sections.push(block);
    used += block.length;
  }

  if (skipped.length > 0) {
    sections.push(
      `(Instructions for ${skipped.join(', ')} also matched but were omitted for space — ask again mentioning that app specifically if needed.)`
    );
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
