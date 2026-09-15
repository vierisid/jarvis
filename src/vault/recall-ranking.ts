import type { Entity } from './entities.ts';
import type { Fact } from './facts.ts';

/** Structural C8 boundary: ranking consumes truth metadata; it never creates it. */
export type RecallFact = Fact & {
  status?: string; basis?: string; scope?: string; predicate_key?: string;
  valid_from?: number | null; valid_to?: number | null; superseded_by?: string | null;
  binding_eligible?: boolean;
  evidence?: Array<{ id?: string; fact_id?: string; basis: string; source: string | null; confidence: number;
    recorded_at: number; source_ref: string | null; quote: string | null }>;
};

const STOPWORDS = new Set(('i me my mine myself we our ours ourselves you your yours yourself '
  + 'he him his she her hers it its itself they them their theirs what which who whom '
  + 'this that these those am is are was were be been being have has had having '
  + 'do does did doing a an the and but if or because as until while of at by for with '
  + 'about against between through during before after above below to from up down in out '
  + 'on off over under again further then once here there when where why how all both '
  + 'each few more most other some such no nor not only own same so than too very can '
  + 'will just don should now could would shall may might must tell know think say said '
  + 'get go make like also well back way want look first even give yeah yes please thanks '
  + 'thank hi hello hey okay ok sure right much many need let remember recall told mentioned talked').split(' '));
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const segmenter = new Intl.Segmenter('und', { granularity: 'word' });

export function normalizeRecallText(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[’']/g, '');
}

/** Sorted sets make scoring independent of query term order and repetition. */
export function recallTerms(text: string): string[] {
  const normalized = normalizeRecallText(text).replace(/_/g, ' ');
  const terms = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(word)) {
      for (const part of segmenter.segment(word)) if (part.isWordLike) terms.add(part.segment);
      // Segmentation can change at name/predicate boundaries in unspaced queries.
      const chars = [...word];
      for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i]! + chars[i + 1]!);
    } else if (word.length > 1 && !STOPWORDS.has(word)) terms.add(word);
  }
  return [...terms].sort();
}

export function isCurrentRecallFact(fact: RecallFact, at = Date.now()): boolean {
  return fact.status !== 'superseded' && fact.superseded_by == null
    && (fact.valid_from == null || fact.valid_from <= at)
    && (fact.valid_to == null || at < fact.valid_to);
}

function mentioned(label: string, query: Set<string>, normalized: string): boolean {
  const tokens = recallTerms(label);
  if (!tokens.length) return false;
  return (CJK.test(label) && normalized.includes(normalizeRecallText(label)))
    || tokens.every(token => query.has(token));
}

export type RankedEntity = { entity: Entity; facts: RecallFact[]; score: number };

/** Full candidate scoring before limits. No model confidence is used for relevance. */
export function rankRecall(message: string, entities: Entity[], facts: RecallFact[], at = Date.now()): RankedEntity[] {
  const query = new Set(recallTerms(message));
  const normalized = normalizeRecallText(message);
  const current = facts.filter(fact => isCurrentRecallFact(fact, at));
  const selfQuery = /\b(?:my|mine|myself)\b/i.test(message)
    || /\b(?:about|of) me\b/i.test(message)
    || /^\s*(?:who|what) am i\b/i.test(message);
  const selfOverview = /(?:what.*(?:know|remember).*(?:me|myself)|who am i)/i.test(message);
  const user = entities.filter(entity => entity.source === 'user_profile')
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))[0];
  if (!query.size && !selfOverview) return [];

  const docs = current.map(fact => ({ fact, predicate: new Set(recallTerms(fact.predicate)),
    object: new Set(recallTerms(fact.object)), scope: new Set(recallTerms(fact.scope ?? '')) }));
  const frequencies = new Map<string, number>();
  for (const doc of docs) for (const term of new Set([...doc.predicate, ...doc.object, ...doc.scope])) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const weight = (term: string) => 1 + Math.log(1 + docs.length / (1 + (frequencies.get(term) ?? 0)));
  const grouped = new Map<string, typeof docs>();
  for (const doc of docs) {
    const list = grouped.get(doc.fact.subject_id) ?? [];
    list.push(doc); grouped.set(doc.fact.subject_id, list);
  }
  const results: RankedEntity[] = [];
  for (const entity of entities) {
    const entityDocs = grouped.get(entity.id) ?? [];
    const aliasMatches = entityDocs.filter(doc => ['alias', 'username', 'preferred_name', 'name'].includes(doc.fact.predicate_key ?? doc.fact.predicate)
      && mentioned(doc.fact.object, query, normalized));
    const nameTokens = recallTerms(entity.name);
    const nameCoverage = nameTokens.filter(token => query.has(token)).length / Math.max(1, nameTokens.length);
    const fullNameMatch = mentioned(entity.name, query, normalized);
    const nameMatch = fullNameMatch || nameCoverage > 0;
    const anchorTerms = new Set([
      ...(nameMatch ? recallTerms(entity.name) : []),
      ...aliasMatches.flatMap(doc => recallTerms(doc.fact.object)),
    ]);
    const taskTerms = [...query].filter(term => !anchorTerms.has(term));
    const ownProfile = selfQuery && entity.id === user?.id;
    const scored = entityDocs.map(doc => {
      let match = 0, taskMatch = 0;
      for (const term of query) {
        const hit = (doc.predicate.has(term) ? 2 : 0) + (doc.object.has(term) ? 1 : 0) + (doc.scope.has(term) ? 1 : 0);
        match += hit * weight(term);
        if (taskTerms.includes(term)) taskMatch += hit * weight(term);
      }
      const alias = aliasMatches.includes(doc);
      return { fact: doc.fact, taskMatch, alias,
        score: match + (fullNameMatch || aliasMatches.length ? 12 : 8 * nameCoverage)
          + (ownProfile && (match > 0 || selfOverview) ? 8 : 0) };
    }).filter(doc => doc.score > 0);
    const hasTaskMatch = scored.some(doc => doc.taskMatch > 0 && !doc.alias);
    // A specific task needs its matching facts and alias evidence. Unrelated
    // background notes, even only one or two, can dominate the character budget.
    const compare = (a: typeof scored[number], b: typeof scored[number]) =>
      b.score - a.score || Number(b.fact.verified_at != null) - Number(a.fact.verified_at != null)
      || a.fact.predicate.localeCompare(b.fact.predicate) || a.fact.object.localeCompare(b.fact.object)
      || (a.fact.scope ?? '').localeCompare(b.fact.scope ?? '') || a.fact.id.localeCompare(b.fact.id);
    scored.sort(compare);
    const primary = hasTaskMatch ? scored.filter(doc => doc.taskMatch > 0 || doc.alias) : scored;
    const score = primary[0]?.score ?? (fullNameMatch || aliasMatches.length || (ownProfile && selfOverview) ? 12 : 8 * nameCoverage);
    if (score > 0) results.push({ entity, facts: primary.map(doc => doc.fact), score });
  }
  results.sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name) || a.entity.id.localeCompare(b.entity.id));
  // Avoid weak generic matches filling the prompt after a strong task match.
  const floor = (results[0]?.score ?? 0) * 0.45;
  return results.filter(result => result.score >= floor);
}
