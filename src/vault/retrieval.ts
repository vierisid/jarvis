/**
 * Vault Retrieval — Memory Query Engine
 *
 * Takes a user message, extracts search terms, queries the knowledge graph
 * for matching entities/facts/relationships, and returns formatted context
 * that gets injected into the system prompt.
 */

import { getDb } from './schema.ts';
import { searchEntitiesByName, type Entity } from './entities.ts';
import { findFacts, type Fact } from './facts.ts';
import { getEntityRelationships } from './relationships.ts';
import { USER_PROFILE_VAULT_SOURCE } from './user-profile.ts';

// Common stopwords to filter from search queries
const STOPWORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
  'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'can', 'will', 'just', 'don', 'should', 'now', 'could', 'would', 'shall',
  'may', 'might', 'must', 'tell', 'know', 'think', 'say', 'said', 'get', 'go',
  'make', 'like', 'also', 'well', 'back', 'way', 'want', 'look', 'first', 'even',
  'give', 'yeah', 'yes', 'please', 'thanks', 'thank', 'hi', 'hello', 'hey',
  'okay', 'ok', 'sure', 'right', 'much', 'many', 'need', 'let', 'remember',
  'recall', 'told', 'mentioned', 'talked', 'work', 'works', 'working',
]);

export type EntityProfile = {
  entity: Entity;
  facts: Fact[];
  relationships: Array<{ type: string; target: string; direction: 'from' | 'to' }>;
};

/**
 * Extract meaningful search terms from a user message.
 * Filters stopwords and short words, deduplicates.
 */
export function extractSearchTerms(message: string): string[] {
  const words = message
    .toLowerCase()
    .split(/[^a-zA-Z0-9']+/)
    .map(w => w.replace(/^'+|'+$/g, '')) // trim quotes
    .filter(w => w.length > 1 && !STOPWORDS.has(w));

  return [...new Set(words)];
}

/**
 * Search the vault for entities matching the given terms.
 * Searches entity names and fact objects/predicates.
 */
export function retrieveForMessage(message: string): EntityProfile[] {
  const terms = extractSearchTerms(message);
  const entityMap = new Map<string, Entity>();

  if (looksLikeSelfQuery(message)) {
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT * FROM entities WHERE source = ? ORDER BY updated_at DESC LIMIT 1'
      ).get(USER_PROFILE_VAULT_SOURCE) as {
        id: string;
        type: Entity['type'];
        name: string;
        properties: string | null;
        created_at: number;
        updated_at: number;
        source: string | null;
      } | null;

      if (row) {
        entityMap.set(row.id, {
          ...row,
          properties: row.properties ? JSON.parse(row.properties) : null,
        });
      }
    } catch {
      // DB not available — skip self-profile bootstrap
    }
  }

  if (terms.length === 0 && entityMap.size === 0) return [];

  // 1. Search entity names
  for (const term of terms) {
    const matches = searchEntitiesByName(term);
    for (const entity of matches) {
      entityMap.set(entity.id, entity);
    }
  }

  // 2. Search fact objects and predicates for matching terms
  try {
    const db = getDb();
    for (const term of terms) {
      const stmt = db.prepare(`
        SELECT DISTINCT e.id, e.type, e.name, e.properties, e.created_at, e.updated_at, e.source
        FROM entities e
        JOIN facts f ON e.id = f.subject_id
        WHERE f.object LIKE ? OR f.predicate LIKE ?
        LIMIT 10
      `);
      const rows = stmt.all(`%${term}%`, `%${term}%`) as any[];
      for (const row of rows) {
        if (!entityMap.has(row.id)) {
          entityMap.set(row.id, {
            ...row,
            properties: row.properties ? JSON.parse(row.properties) : null,
          });
        }
      }
    }
  } catch {
    // DB not available — return what we have from entity search
  }

  // 3. Build full profiles for matched entities (cap at 10)
  const entities = [...entityMap.values()].slice(0, 10);
  const profiles: EntityProfile[] = [];

  for (const entity of entities) {
    const facts = findFacts({ subject_id: entity.id });

    let relationships: EntityProfile['relationships'] = [];
    try {
      const rels = getEntityRelationships(entity.id);
      relationships = rels.map(r => ({
        type: r.type,
        target: r.from_id === entity.id ? r.to_entity.name : r.from_entity.name,
        direction: (r.from_id === entity.id ? 'from' : 'to') as 'from' | 'to',
      }));
    } catch {
      // Relationship query failed — skip
    }

    profiles.push({ entity, facts, relationships });
  }

  return profiles;
}

function looksLikeSelfQuery(message: string): boolean {
  return /\b(i|me|my|mine|myself)\b/i.test(message);
}

/**
 * Format entity profiles into readable text for the system prompt.
 */
export function formatKnowledgeContext(profiles: EntityProfile[]): string {
  if (profiles.length === 0) return '';

  const sections: string[] = [];

  for (const { entity, facts, relationships } of profiles) {
    const lines: string[] = [];

    lines.push(`**${entity.name}** (${entity.type})`);

    for (const fact of facts) {
      lines.push(`  - ${fact.predicate}: ${fact.object}`);
    }

    for (const rel of relationships) {
      if (rel.direction === 'from') {
        lines.push(`  - ${rel.type} -> ${rel.target}`);
      } else {
        lines.push(`  - ${rel.target} -> ${rel.type} -> ${entity.name}`);
      }
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Main entry point: get formatted knowledge context for a user message.
 * Returns empty string if no relevant knowledge found.
 */
export function getKnowledgeForMessage(message: string): string {
  try {
    const profiles = retrieveForMessage(message);
    return formatKnowledgeContext(profiles);
  } catch (err) {
    console.error('[Retrieval] Error querying vault:', err);
    return '';
  }
}

/**
 * Get a summary of active goals for system prompt injection.
 * Returns formatted text showing goal hierarchy with scores, or empty string.
 */
export function getActiveGoalsSummary(): string {
  try {
    const { findGoals } = require('./goals.ts');
    const activeGoals = findGoals({ status: 'active' }) as Array<{
      id: string;
      parent_id: string | null;
      level: string;
      title: string;
      score: number;
      health: string;
      deadline: number | null;
    }>;

    if (activeGoals.length === 0) return '';

    const levelOrder: Record<string, number> = {
      objective: 0,
      key_result: 1,
      milestone: 2,
      task: 3,
      daily_action: 4,
    };

    // Sort by level then title
    activeGoals.sort((a, b) => {
      const la = levelOrder[a.level] ?? 5;
      const lb = levelOrder[b.level] ?? 5;
      if (la !== lb) return la - lb;
      return a.title.localeCompare(b.title);
    });

    // Cap at 15 most important goals (objectives + key results + top milestones)
    const topGoals = activeGoals.slice(0, 15);

    const lines: string[] = [];
    for (const goal of topGoals) {
      const indent = '  '.repeat(levelOrder[goal.level] ?? 0);
      const healthIcon = goal.health === 'on_track' ? '+' :
        goal.health === 'at_risk' ? '~' :
        goal.health === 'behind' ? '-' : '!';
      const deadlineStr = goal.deadline
        ? ` (due: ${new Date(goal.deadline).toLocaleDateString()})`
        : '';
      lines.push(`${indent}[${healthIcon}] ${goal.title} — ${goal.score.toFixed(1)}/1.0${deadlineStr}`);
    }

    if (activeGoals.length > 15) {
      lines.push(`  ... and ${activeGoals.length - 15} more active goals`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
