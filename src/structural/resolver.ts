/**
 * Structural Runtime — ref resolver.
 *
 * Re-locates a stored SemanticRef against a fresh surface. This is the
 * rot-proofing mechanism: a skill stores refs, the UI relayouts or restarts,
 * and the resolver re-finds the same element by durable signals instead of
 * dead session ids.
 *
 * Scoring ladder (highest wins):
 *   sig identical                 → 1.0
 *   stableId + role exact         → 1.0
 *   path + exact name             → 0.8 × path similarity
 *   role + name + ordinal         → 0.6
 *   fuzzy name (same role)        → ≤ 0.5
 * Results below the confidence floor resolve to none — callers then climb
 * the self-heal ladder (re-snapshot → retry → vision → ask).
 */

import type {
  ResolveResult,
  SemanticNode,
  SemanticPathSegment,
  SemanticRef,
} from './types.ts';

export const DEFAULT_CONFIDENCE_FLOOR = 0.55;

export function resolveRef(
  ref: SemanticRef,
  nodes: SemanticNode[],
  floor: number = DEFAULT_CONFIDENCE_FLOOR,
): ResolveResult {
  let best: ResolveResult = { node: null, confidence: 0, method: 'none' };

  for (const node of nodes) {
    const candidate = scoreCandidate(ref, node);
    if (candidate.confidence > best.confidence) {
      best = { node, ...candidate };
    }
  }

  if (best.confidence < floor) {
    return { node: null, confidence: best.confidence, method: 'none' };
  }
  return best;
}

function scoreCandidate(
  ref: SemanticRef,
  node: SemanticNode,
): { confidence: number; method: ResolveResult['method'] } {
  const r = node.ref;

  if (ref.sig && r.sig && ref.sig === r.sig) {
    return { confidence: 1.0, method: 'sig' };
  }

  const roleMatches = ref.role === r.role;

  if (ref.stableId && r.stableId && ref.stableId === r.stableId && roleMatches) {
    return { confidence: 1.0, method: 'stableId' };
  }

  if (!roleMatches) {
    // Role changes are rare and usually mean a different element entirely.
    return { confidence: 0, method: 'none' };
  }

  const nameExact = normalize(ref.name) === normalize(r.name) && ref.name !== '';

  if (nameExact && ref.path.length > 0) {
    const sim = pathSimilarity(ref.path, r.path);
    if (sim > 0) {
      return { confidence: 0.8 * sim, method: 'path+name' };
    }
  }

  if (nameExact && ref.ordinal === r.ordinal) {
    return { confidence: 0.6, method: 'role+name+ordinal' };
  }

  const fuzzy = fuzzyNameScore(ref.name, r.name);
  if (fuzzy > 0) {
    // Same ordinal nudges ties toward the positional match.
    const ordinalBonus = ref.ordinal === r.ordinal ? 0.05 : 0;
    return { confidence: Math.min(0.5, fuzzy * 0.5 + ordinalBonus), method: 'fuzzy' };
  }

  return { confidence: 0, method: 'none' };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Similarity of two ancestry paths in [0, 1]: fraction of aligned segments
 * whose roles match, weighted toward the leaf end (deep ancestry shifts more
 * often than the immediate container). Segment names must loosely agree when
 * both sides have one.
 */
export function pathSimilarity(
  a: SemanticPathSegment[],
  b: SemanticPathSegment[],
): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Align from the leaf end: the segments closest to the element matter most.
  const ra = [...a].reverse();
  const rb = [...b].reverse();
  const n = Math.max(ra.length, rb.length);

  let score = 0;
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    const weight = 1 / (i + 1); // leaf-most segment weighs most
    weightSum += weight;
    const sa = ra[i];
    const sb = rb[i];
    if (!sa || !sb) continue;
    if (sa.role !== sb.role) continue;
    if (sa.name && sb.name && !looseNameMatch(sa.name, sb.name)) {
      // Same role but clearly different container names → half credit;
      // window titles legitimately change (e.g. "doc — Word" → "doc2 — Word").
      score += weight * 0.5;
      continue;
    }
    score += weight;
  }
  return score / weightSum;
}

function looseNameMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Fuzzy name score in [0, 1]: containment or word-token overlap.
 */
export function fuzzyNameScore(want: string, have: string): number {
  const a = normalize(want);
  const b = normalize(have);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  let common = 0;
  for (const t of ta) if (t.length >= 3 && tb.has(t)) common++;
  if (common === 0) return 0;
  return common / Math.max(ta.size, tb.size);
}
