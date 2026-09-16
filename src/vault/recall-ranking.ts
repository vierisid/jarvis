import type { Entity } from './entities.ts';
import type { Fact } from './facts.ts';

/** Ranking consumes the repository's truth metadata; it never creates it. */
export type RecallFact = Fact;

const STOPWORDS = new Set(('i me my mine myself we our ours ourselves you your yours yourself '
  + 'he him his himself she her hers herself it its itself they them their theirs themselves '
  + 'yourselves what which who whom '
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
  // Drop a possessive ending before the remaining apostrophes, so "Ann's" still
  // anchors on the subject Ann. Stored names normalise the same way, so a
  // subject actually named "Ann's Diner" keeps matching itself.
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[’']s\b/g, '').replace(/[’']/g, '');
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

/** Default recall carries only what applies now; corrected and expired rows stay
 *  inspectable through the fact APIs. Contested rows are current and included.
 *  The period test is nullish-tolerant where appliesAt is strict: a row without
 *  the columns must read as unbounded, never as expired. */
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

export type RecallFactDependency = { factId: string; requiredFactIds: string[] };
export type RankedEntity = { entity: Entity; facts: RecallFact[]; matchedAliasIds: string[];
  factDependencies: RecallFactDependency[]; score: number;
  /** A task match, so the subject holds an answer rather than only a name. */
  taskMatch: boolean;
  /** Query terms this subject actually matched, for cross-reference recovery. */
  matchedTerms: string[];
  /** The subject's own name and alias terms, as matched against the query. */
  anchorTerms: string[];
  /** Ranking dropped candidates that this result's slice does not show. */
  omitted: boolean };

/** Include transitive requirements once, including mutually contested confirmations. */
export function expandRecallDependencies(ids: Iterable<string>, dependencies: RecallFactDependency[] = []): string[] {
  const required = new Map(dependencies.map(dependency => [dependency.factId, dependency.requiredFactIds]));
  const selected = new Set(ids);
  for (const id of selected) for (const peer of required.get(id) ?? []) selected.add(peer);
  return [...selected];
}

/** Above this many unrelated subjects, a name is shared vocabulary, not a reference. */
const CROSS_REFERENCE_SUBJECTS = 2;

/** Summation order differs between records, so a tie must still reach the tiebreak chain. */
const near = (a: number, b: number) => Math.abs(b - a) < 1e-9 ? 0 : b - a;

/**
 * An explicit request for what is known about the owner. The self reference has
 * to be the object of the knowing and stay inside the same clause: this also
 * boosts the owner's profile, so "what do you know about the budget? send it to
 * me" must not read as one. Whole words only, so an embedded "me" (melatonin,
 * meeting, same) is not a self request either.
 */
export function isRecallSelfOverview(message: string): boolean {
  return /\b(?:what|how much)\b[^.?!]*\b(?:know|remember)\b[^.?!]*\b(?:about|regarding|concerning|of)\s+(?:me|myself)\b/i.test(message)
    || /\bwho am i\b/i.test(message);
}

/** Full candidate scoring before limits. No model confidence is used for relevance. */
export function rankRecall(message: string, entities: Entity[], facts: RecallFact[], at = Date.now()): RankedEntity[] {
  const query = new Set(recallTerms(message));
  const selfOverview = isRecallSelfOverview(message);
  if (!query.size && !selfOverview) return [];
  const normalized = normalizeRecallText(message);
  const current = facts.filter(fact => isCurrentRecallFact(fact, at));
  // Superseded and out-of-period rows never reach the prompt, but they are still
  // records this subject has: the block has to admit it is not the whole ledger.
  const stored = new Map<string, number>();
  for (const fact of facts) stored.set(fact.subject_id, (stored.get(fact.subject_id) ?? 0) + 1);
  // Every overview request is a self request; the two must not disagree, or a
  // message reads the whole vault and then scores as if it mentioned nobody.
  const selfQuery = selfOverview || /\b(?:my|mine|myself)\b/i.test(message)
    || /\b(?:about|of) me\b/i.test(message)
    || /^\s*(?:who|what) am i\b/i.test(message);
  const user = entities.filter(entity => entity.source === 'user_profile')
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))[0];

  const docs = current.map(fact => {
    const predicate = new Set(recallTerms(fact.predicate));
    const object = new Set(recallTerms(fact.object));
    const scope = new Set(recallTerms(fact.scope ?? ''));
    return { fact, predicate, object, scope, terms: new Set([...predicate, ...object, ...scope]) };
  });
  const frequencies = new Map<string, number>();
  for (const doc of docs) for (const term of doc.terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const weight = (term: string) => 1 + Math.log(1 + docs.length / (1 + (frequencies.get(term) ?? 0)));
  const grouped = new Map<string, typeof docs>();
  const subjectsByTerm = new Map<string, Set<string>>();
  for (const doc of docs) {
    const list = grouped.get(doc.fact.subject_id) ?? [];
    list.push(doc); grouped.set(doc.fact.subject_id, list);
    for (const term of doc.terms) {
      const subjects = subjectsByTerm.get(term) ?? new Set<string>();
      subjects.add(doc.fact.subject_id); subjectsByTerm.set(term, subjects);
    }
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
    const taskTerms = new Set([...query].filter(term => !anchorTerms.has(term)));
    const ownProfile = selfQuery && entity.id === user?.id;
    const matchedTerms = new Set<string>();
    const scored = entityDocs.map(doc => {
      let match = 0, taskMatch = 0;
      // Walk the record's own terms rather than the query. Scoring stays linear
      // in stored text, so a pasted document cannot stall the synchronous
      // recall call the daemon makes on every message.
      for (const term of doc.terms) {
        if (!query.has(term)) continue;
        const hit = (doc.predicate.has(term) ? 2 : 0) + (doc.object.has(term) ? 1 : 0) + (doc.scope.has(term) ? 1 : 0);
        const value = hit * weight(term);
        match += value;
        if (hit) matchedTerms.add(term);
        if (taskTerms.has(term)) taskMatch += value;
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
      near(a.score, b.score) || Number(b.fact.verified_at != null) - Number(a.fact.verified_at != null)
      || a.fact.predicate.localeCompare(b.fact.predicate) || a.fact.object.localeCompare(b.fact.object)
      || (a.fact.scope ?? '').localeCompare(b.fact.scope ?? '') || a.fact.id.localeCompare(b.fact.id);
    scored.sort(compare);
    const primary = hasTaskMatch ? scored.filter(doc => doc.taskMatch > 0 || doc.alias) : scored;
    const score = primary[0]?.score ?? (fullNameMatch || aliasMatches.length || (ownProfile && selfOverview) ? 12 : 8 * nameCoverage);
    if (score > 0) {
      // C8 supplies the conflict state and canonical predicate. A lexical hit on
      // an old inferred value must retain the confirmed answer, even if that
      // answer has no query-token match. Both records already apply at `at`.
      const contextKey = (fact: RecallFact) => JSON.stringify([fact.predicate_key ?? fact.predicate, fact.scope ?? '']);
      const confirmations = new Map<string, string[]>();
      for (const { fact } of entityDocs) if (fact.verified_at != null) {
        const key = contextKey(fact), peers = confirmations.get(key) ?? [];
        peers.push(fact.id); confirmations.set(key, peers);
      }
      const dependencies = entityDocs.flatMap(({ fact }) => {
        if (fact.status !== 'contested') return [];
        const requiredFactIds = (confirmations.get(contextKey(fact)) ?? []).filter(id => id !== fact.id).sort();
        return requiredFactIds.length ? [{ factId: fact.id, requiredFactIds }] : [];
      });
      const ids = new Set(expandRecallDependencies(primary.map(doc => doc.fact.id), dependencies));
      const byId = new Map(entityDocs.map(doc => [doc.fact.id, doc.fact]));
      results.push({ entity, facts: [...ids].map(id => byId.get(id)!),
        matchedAliasIds: primary.filter(doc => doc.alias).map(doc => doc.fact.id),
        factDependencies: dependencies.filter(dependency => ids.has(dependency.factId)), score,
        taskMatch: hasTaskMatch, matchedTerms: [...matchedTerms], anchorTerms: [...anchorTerms],
        omitted: ids.size < (stored.get(entity.id) ?? entityDocs.length) });
    }
  }
  results.sort((a, b) => near(a.score, b.score) || a.entity.name.localeCompare(b.entity.name) || a.entity.id.localeCompare(b.entity.id));
  // Avoid weak generic matches filling the prompt after a strong task match.
  // When the best subject matched on its name alone it holds no answer, so keep
  // the subjects that name it back: the flat name bonus would otherwise floor
  // out the record that stores the requested value against the other subject.
  // A merely lexical hit on a generic task term is not such a cross-reference.
  const top = results[0];
  const floor = (top?.score ?? 0) * 0.45;
  // A subject named with a common word ("Mark", "Platform") would otherwise
  // recover every record that happens to use the word, so the anchor has to
  // identify the subject: a name that unrelated subjects keep mentioning is
  // vocabulary, not a reference. Corpus size does not enter into it.
  const identifies = (term: string) => {
    const subjects = [...(subjectsByTerm.get(term) ?? [])].filter(id => id !== top!.entity.id);
    return subjects.length <= CROSS_REFERENCE_SUBJECTS;
  };
  const anchors = new Set(top != null && !top.taskMatch ? top.anchorTerms.filter(identifies) : []);
  const kept = results.filter(result => result.score >= floor
    || (result !== top && result.matchedTerms.some(term => anchors.has(term))));
  if (kept.length < results.length && kept[0]) kept[0].omitted = true;
  return kept;
}
