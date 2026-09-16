import type { Entity } from './entities.ts';
import { defangFactText as line, formatFact, MEMORY_USE_RULES } from './fact-format.ts';
import { expandRecallDependencies, isCurrentRecallFact, type RecallFact, type RecallFactDependency } from './recall-ranking.ts';

export type RecallProfile = { entity: Entity; facts: RecallFact[]; hasMore?: boolean;
  matchedAliasIds?: string[];
  factDependencies?: RecallFactDependency[];
  relationships: Array<{ type: string; target: string; direction: 'from' | 'to' }> };
export const RECALL_LIMITS = { chars: 12_000, entities: 6, facts: 18, factsPerEntity: 8, relationshipsPerEntity: 4 } as const;
// Qualification, the per-fact evidence bound and the rules preamble belong to
// the fact repository. This module only ranks, selects and bounds the block.
const omission = '\n\n[Additional memory omitted by relevance and context limits; this is not an exhaustive record.]';

/** Round-robin allocation keeps a dense first subject from starving later subjects. */
export function packRecallContext(profiles: RecallProfile[], maxChars: number = RECALL_LIMITS.chars): string {
  const budget = Math.min(RECALL_LIMITS.chars, Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : RECALL_LIMITS.chars);
  if (!profiles.length || budget < MEMORY_USE_RULES.length + omission.length) return '';
  const at = Date.now();
  const selected = profiles.slice(0, RECALL_LIMITS.entities);
  const sections = selected.map(profile => ({ header: `**${line(profile.entity.name)}** (${profile.entity.type})`, lines: [] as string[] }));
  let length = MEMORY_USE_RULES.length, count = 0, omitted = profiles.length > selected.length || profiles.some(profile => profile.hasMore);
  const append = (index: number, value: string) => {
    const section = sections[index]!;
    const extra = (section.lines.length ? 1 : section.header.length + 3) + value.length;
    if (length + extra + omission.length > budget) { omitted = true; return false; }
    section.lines.push(value); length += extra; return true;
  };
  const facts = selected.map(profile => profile.facts.filter(fact => isCurrentRecallFact(fact, at)));
  const byId = facts.map(list => new Map(list.map(fact => [fact.id, fact])));
  const included = selected.map(() => new Set<string>());
  const aliases = selected.map((profile, i) => [...new Set(profile.matchedAliasIds ?? [])]
    .map(id => facts[i]!.find(fact => fact.id === id)));
  // A missing, expired or over-limit selection dependency cannot become an
  // unqualified entity heading, ordinary fact or relationship in the prompt.
  const blocked = aliases.map(list => list.length > RECALL_LIMITS.factsPerEntity || list.some(fact => !fact));
  if (blocked.some(Boolean)) omitted = true;
  for (let round = 0; round < Math.max(0, ...facts.map(list => list.length)); round++) {
    for (let i = 0; i < selected.length; i++) {
      const fact = facts[i]![round];
      if (!fact || blocked[i] || included[i]!.has(fact.id)) continue;
      const required = expandRecallDependencies([...(selected[i]!.matchedAliasIds ?? []), fact.id], selected[i]!.factDependencies);
      if (required.some(id => !byId[i]!.has(id))) { omitted = true; continue; }
      const group = required.filter(id => !included[i]!.has(id)).map(id => byId[i]!.get(id)!);
      if (included[i]!.size + group.length > RECALL_LIMITS.factsPerEntity || count + group.length > RECALL_LIMITS.facts) {
        omitted = true; continue;
      }
      if (append(i, group.map(item => `  - ${formatFact(item)}`).join('\n'))) {
        for (const item of group) included[i]!.add(item.id);
        count += group.length;
      }
    }
  }
  for (let i = 0; i < selected.length; i++) {
    const profile = selected[i]!;
    // Relationships are unverified and carry no qualification of their own, so
    // they cannot stand in for facts that the budget rejected: that would put
    // the subject and a related name in the prompt with nothing qualifying them.
    if (blocked[i] || (facts[i]!.length && !included[i]!.size)
      || aliases[i]!.some(fact => !included[i]!.has(fact!.id))) continue;
    for (const [index, rel] of profile.relationships.entries()) {
      if (index >= RECALL_LIMITS.relationshipsPerEntity) { omitted = true; break; }
      const text = rel.direction === 'from' ? `${rel.type} -> ${rel.target}` : `${rel.target} -> ${rel.type} -> ${profile.entity.name}`;
      append(i, `  - Unverified relationship: ${line(text)}`);
    }
    // Judge emptiness on the current-fact view: a subject whose every record is
    // superseded or out of period must read the same as one with no records.
    if (!facts[i]!.length && !profile.relationships.length) append(i, '  - No current facts recorded.');
  }
  const body = sections.filter(section => section.lines.length).map(section => section.header + '\n' + section.lines.join('\n')).join('\n\n');
  if (!body) return omitted ? MEMORY_USE_RULES + omission : '';
  return MEMORY_USE_RULES + '\n\n' + body + (omitted ? omission : '');
}
