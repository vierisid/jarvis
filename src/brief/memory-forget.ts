import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';
import { profileSourceRevisionsForFact } from '../vault/user-profile';
import { getFact } from '../vault/facts';
import { memoryFactRef } from '../vault/memory-usage';
import { assertionKey, automaticSourceKey } from '../vault/memory-suppression';
import { reconcileFacts } from '../vault/fact-schema';

export const MEMORY_FORGET_LIMITS = { receipts: 10_000, sources: 100_000, perFact: 1000 } as const;
/**
 * Forget deletes rows rather than tombstoning them: the chosen fact, its evidence and every earlier
 * version it replaced (the chain of `superseded_by` links) leave the facts table, so no read path
 * (facts list, Memory detail and history, vault search, recall, workflow context) can return them.
 * Only content-free receipts and suppression keys remain, one per removed version's source.
 */
export const MEMORY_FORGET_SCOPE = {
  removed: ['chosen_canonical_fact', 'earlier_versions_it_replaced', 'its_evidence', 'future_canonical_recall'],
  retained: ['content_free_receipt_and_usage', 'other_facts_and_their_history', 'entity_identity_and_relationships',
    'original_messages_and_source_documents', 'profile_settings_and_interview_sources', 'backups_and_database_free_pages', 'already_sent_model_context'],
  suppression: 'same_normalized_assertion_and_automatic_source_revision',
  legacySuppression: 'unknown_revision_blocks_same_automatic_assertion_until_explicit_manual_input',
  profile: 'matching_source_field_is_withheld_from_future_profile_prompts_until_changed',
  confirmation: 'local_confirmation_required',
} as const;
export class MemoryForgetError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
type Stored = { fact_id: string; request_id: string; expected_revision: string; forgotten_at: number; suppressed_sources: number };
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const receipt = (r: Stored) => ({ factId: r.fact_id, requestId: r.request_id, revision: r.expected_revision,
  forgottenAt: r.forgotten_at, suppressedSources: r.suppressed_sources, scope: MEMORY_FORGET_SCOPE });
export type ForgetCommand = { requestId: string; expectedRevision: string; confirmed: true };

export class MemoryForget {
  constructor(readonly db: Database, private readonly enabled = () => process.env.JARVIS_BRIEF_MEMORY_FORGET === '1') {}
  readiness(): 'ready' | 'unavailable' {
    try {
      return this.enabled() && getDb() === this.db && this.db.query('SELECT singleton FROM memory_forget_state WHERE singleton = 1').get()
        ? 'ready' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  private ready() { if (this.readiness() !== 'ready') throw new MemoryForgetError('unavailable', 503); }
  private stored(id: string) { return this.db.query<Stored, [string]>('SELECT * FROM memory_forget_receipts WHERE fact_id = ?').get(id); }
  private source(id: string) {
    const fact = getFact(id);
    if (!fact) throw new MemoryForgetError('not_found', 404);
    const entity = this.db.query<{ name: string }, [string]>('SELECT name FROM entities WHERE id = ?').get(fact.subject_id);
    if (!entity) throw new MemoryForgetError('unavailable', 503);
    return { fact, revision: memoryFactRef(fact, entity.name).sourceRevision };
  }
  get(id: string) {
    this.ready(); if (!validId(id)) throw new MemoryForgetError('invalid_fact_id');
    return this.db.transaction(() => {
      const old = this.stored(id);
      if (old) return { state: 'forgotten' as const, receipt: receipt(old) };
      const { revision } = this.source(id);
      return { state: 'ready' as const, factId: id, revision, scope: MEMORY_FORGET_SCOPE };
    })();
  }
  forget(id: string, input: ForgetCommand) {
    this.ready();
    if (!validId(id) || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['requestId', 'expectedRevision', 'confirmed'].includes(k))
      || !validId(input.requestId) || !revision(input.expectedRevision) || input.confirmed !== true) throw new MemoryForgetError('invalid_forget_command');
    return this.db.transaction(() => {
      const used = this.db.query<Stored, [string]>('SELECT * FROM memory_forget_receipts WHERE request_id = ?').get(input.requestId);
      if (used && (used.fact_id !== id || used.expected_revision !== input.expectedRevision)) throw new MemoryForgetError('request_conflict', 409);
      const old = this.stored(id);
      if (old) {
        if (old.expected_revision !== input.expectedRevision) throw new MemoryForgetError('revision_conflict', 409);
        return { state: 'forgotten' as const, replayed: true, receipt: receipt(old) };
      }
      let source: ReturnType<MemoryForget['source']>;
      try { source = this.source(id); } catch (e) {
        if (e instanceof MemoryForgetError && e.status === 404) throw new MemoryForgetError('revision_conflict', 409);
        throw e;
      }
      if (source.revision !== input.expectedRevision) throw new MemoryForgetError('revision_conflict', 409);
      const { fact } = source;
      // Forgetting a fact forgets its whole history: every earlier version it replaced is removed too.
      const chain = [fact]; const seen = new Set([fact.id]);
      for (let i = 0; i < chain.length; i++) {
        for (const prior of this.db.query<{ id: string }, [string]>('SELECT id FROM facts WHERE superseded_by = ?').all(chain[i]!.id)) {
          if (seen.has(prior.id)) continue; seen.add(prior.id);
          const earlier = getFact(prior.id); if (earlier) chain.push(earlier);
        }
        if (chain.length > MEMORY_FORGET_LIMITS.perFact) throw new MemoryForgetError('capacity_exceeded', 503);
      }
      if (chain.reduce((n, f) => n + f.evidence.length, 0) > MEMORY_FORGET_LIMITS.perFact) throw new MemoryForgetError('capacity_exceeded', 503);
      const sourceKeys = (f: typeof fact) => {
        const keys = new Set(f.evidence.flatMap(e => [automaticSourceKey(this.db, e),
          e.replay_source_ref ? automaticSourceKey(this.db, { ...e, source_ref: e.replay_source_ref }) : null,
        ]).filter((k): k is string => k !== null));
        // Old rows without provenance still cannot silently reappear from a legacy automatic writer.
        if (!f.evidence.length) {
          const fallback = automaticSourceKey(this.db, { source: f.source }); if (fallback) keys.add(fallback);
        }
        if (f.source === 'user_profile' || f.evidence.some(e => e.source === 'user_profile')) {
          for (const source of profileSourceRevisionsForFact(f)) keys.add(automaticSourceKey(this.db, source)!);
        }
        return keys;
      };
      const pairs = chain.flatMap(f => { const assertion = assertionKey(this.db, f); return [...sourceKeys(f)].map(key => ({ assertion, key })); });
      const keys = new Set(pairs.map(p => p.key));
      const count = (table: string) => (this.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      if (count('memory_forget_receipts') >= MEMORY_FORGET_LIMITS.receipts
        || count('memory_forget_suppressions') + pairs.length > MEMORY_FORGET_LIMITS.sources) throw new MemoryForgetError('capacity_exceeded', 503);
      const stored: Stored = { fact_id: id, request_id: input.requestId, expected_revision: input.expectedRevision,
        forgotten_at: Date.now(), suppressed_sources: keys.size };
      this.db.run('INSERT INTO memory_forget_receipts VALUES (?, ?, ?, ?, ?)',
        [id, input.requestId, input.expectedRevision, stored.forgotten_at, keys.size]);
      // A shared replay alias must point to the latest Forget, so a turn accepted
      // between two deletions cannot bypass the newer suppression boundary.
      for (const { assertion, key } of pairs) this.db.run(`INSERT INTO memory_forget_suppressions VALUES (?, ?, ?)
        ON CONFLICT(assertion_key, source_key) DO UPDATE SET fact_id = excluded.fact_id`, [assertion, key, id]);
      for (const f of chain) {
        this.db.run('DELETE FROM fact_evidence WHERE fact_id = ?', [f.id]);
        this.db.run('DELETE FROM facts WHERE id = ?', [f.id]);
      }
      reconcileFacts(this.db, fact.subject_id, fact.predicate_key, fact.scope);
      return { state: 'forgotten' as const, replayed: false, receipt: receipt(stored) };
    }).immediate();
  }
}
