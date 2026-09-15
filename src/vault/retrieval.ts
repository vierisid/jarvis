/**
 * Vault Retrieval — Memory Query Engine
 *
 * Takes a user message, extracts search terms, queries the knowledge graph
 * for matching entities/facts/relationships, and returns formatted context
 * that gets injected into the system prompt.
 */

import { getDb } from './schema.ts';
import { findEntities } from './entities.ts';
import { getFact } from './facts.ts';
import { getEntityRelationships } from './relationships.ts';
import { expandRecallDependencies, isRecallSelfOverview, rankRecall, recallTerms, type RecallFact } from './recall-ranking.ts';
import { packRecallContext, RECALL_LIMITS, type RecallProfile } from './recall-context.ts';

export type EntityProfile = RecallProfile;
export const extractSearchTerms = recallTerms;

/** Score every current candidate before selecting subjects or loading evidence. */
export function retrieveForMessage(message: string): EntityProfile[] {
  const terms = new Set(recallTerms(message));
  if (!terms.size && !isRecallSelfOverview(message)) return [];
  const entities = findEntities({});
  const facts = getDb().query<RecallFact, []>('SELECT * FROM facts').all();
  const ranked = rankRecall(message, entities, facts);
  return ranked.slice(0, RECALL_LIMITS.entities).map(({ entity, facts, matchedAliasIds, factDependencies }, index) => {
    const byId = new Map(facts.map(fact => [fact.id, fact]));
    const finalists = new Set(expandRecallDependencies(matchedAliasIds, factDependencies));
    for (const fact of facts) {
      // Reserve confirmed counterparts before their matching inferences. The
      // dependency metadata lets packing reject any group the cap leaves incomplete.
      const group = expandRecallDependencies([fact.id], factDependencies).sort((a, b) =>
        Number(byId.get(b)?.verified_at != null) - Number(byId.get(a)?.verified_at != null));
      for (const id of group) finalists.add(id);
      if (finalists.size > RECALL_LIMITS.factsPerEntity) break;
    }
    return {
      entity,
      matchedAliasIds,
      factDependencies,
      hasMore: index === 0 && ranked.length > RECALL_LIMITS.entities,
      // The extra record is a limit sentinel; provenance hydration stays bounded.
      facts: [...finalists].slice(0, RECALL_LIMITS.factsPerEntity + 1).flatMap(id => {
        const complete = getFact(id);
        return complete ? [complete] : [];
      }),
      relationships: getEntityRelationships(entity.id).map(rel => ({
        type: rel.type,
        target: rel.from_id === entity.id ? rel.to_entity.name : rel.from_entity.name,
        direction: rel.from_id === entity.id ? 'from' as const : 'to' as const,
      })).sort((a, b) => {
        const score = (rel: typeof a) => recallTerms(`${rel.type} ${rel.target}`).filter(term => terms.has(term)).length;
        return score(b) - score(a) || a.type.localeCompare(b.type) || a.target.localeCompare(b.target) || a.direction.localeCompare(b.direction);
      }).slice(0, RECALL_LIMITS.relationshipsPerEntity + 1),
    };
  });
}

export function formatKnowledgeContext(profiles: EntityProfile[], maxChars?: number): string {
  return packRecallContext(profiles, maxChars);
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
