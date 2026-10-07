import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';
import type { FactRow } from '../vault/fact-policy';
import type { FactEvidence } from '../vault/facts';
import type { BriefMemoryUse } from './contracts';
import type { MemoryStreamItem, MemoryStreamPage, MemoryStreamQuery, MemoryStreamResult, MemoryUsageReader } from './memory-stream-contracts';

export const MEMORY_STREAM_LIMITS = { facts: 10000, evidence: 50000, uses: 50000, bytes: 16 * 1024 * 1024,
  snapshots: 16, ttlMs: 5 * 60_000, page: 100 } as const;
export class MemoryQueryError extends Error {}
class CapacityError extends Error {}
type Row = FactRow & { subject_name: string };
type Collection = { items: Map<string, MemoryStreamItem>; usedIn: MemoryStreamPage['usedIn'] };
type Snapshot = { queryKey: string; asOf: number; expiresAt: number; members: [string, string][];
  matches: string[]; total: number; usedIn: MemoryStreamPage['usedIn'] };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const idValid = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\\/\u0000-\u001f\u007f]/.test(v) && v !== '.' && v !== '..';
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 8.64e15;
export function memoryFactId(value: unknown): string {
  if (!idValid(value)) throw new MemoryQueryError('Invalid fact ID'); return value;
}
export function memoryStreamQuery(input: MemoryStreamQuery): Required<Pick<MemoryStreamQuery, 'limit'>> & MemoryStreamQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['cursor', 'limit', 'q', 'source', 'usedIn', 'updatedFrom', 'updatedBefore'].includes(k))) throw new MemoryQueryError('Unsupported query');
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_STREAM_LIMITS.page) throw new MemoryQueryError('limit must be 1 to 100');
  const result: MemoryStreamQuery & { limit: number } = { limit };
  for (const [key, max] of [['q', 256], ['source', 4000], ['usedIn', 220], ['cursor', 256]] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new MemoryQueryError(`Invalid ${key}`);
      result[key] = value.trim();
    }
  }
  if (result.usedIn) {
    const match = /^(conversation|run):(.+)$/.exec(result.usedIn);
    if (!match || !idValid(match[2])) throw new MemoryQueryError('usedIn requires conversation:<id> or run:<id>');
  }
  for (const key of ['updatedFrom', 'updatedBefore'] as const) {
    const value = input[key];
    if (value !== undefined) { if (!timestamp(value)) throw new MemoryQueryError(`Invalid ${key}`); result[key] = value; }
  }
  if (result.updatedFrom !== undefined && result.updatedBefore !== undefined && result.updatedBefore <= result.updatedFrom) throw new MemoryQueryError('Updated range must be increasing');
  return result;
}

/** Read projection only. No fact, recall, retrieval, or usage writer lives here. */
export class MemoryStream {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly secret = randomBytes(32);
  constructor(private readonly db: Database, readonly usage?: MemoryUsageReader) {}
  readiness(): 'ready' | 'unavailable' {
    try {
      if (getDb() !== this.db) return 'unavailable';
      this.db.query('SELECT id, status FROM facts LIMIT 1').get();
      this.db.query('SELECT id FROM fact_evidence LIMIT 1').get();
      return 'ready';
    } catch { return 'unavailable'; }
  }
  private collection(): Collection {
    const rows = this.db.query<Row, []>(`SELECT f.*, e.name AS subject_name FROM facts f
      JOIN entities e ON e.id = f.subject_id ORDER BY f.id LIMIT ${MEMORY_STREAM_LIMITS.facts + 1}`).all();
    const evidence = this.db.query<FactEvidence, []>(`SELECT id, fact_id, source, source_ref, basis, confidence, recorded_at
      FROM fact_evidence ORDER BY id LIMIT ${MEMORY_STREAM_LIMITS.evidence + 1}`).all();
    if (rows.length > MEMORY_STREAM_LIMITS.facts || evidence.length > MEMORY_STREAM_LIMITS.evidence
      || Buffer.byteLength(JSON.stringify([rows, evidence])) > MEMORY_STREAM_LIMITS.bytes) throw new CapacityError();
    const byFact = new Map<string, FactEvidence[]>();
    for (const e of evidence) { const list = byFact.get(e.fact_id) ?? []; list.push(e); byFact.set(e.fact_id, list); }
    for (const list of byFact.values()) list.sort((a, b) => b.recorded_at - a.recorded_at || compareText(a.id, b.id));
    let uses: BriefMemoryUse[] | null = null;
    if (this.usage) {
      if (this.usage.readiness() !== 'ready') throw Error('Usage unavailable');
      const read = this.usage.readUses(rows.map(r => r.id));
      if (read.state !== 'ready') throw Error('Usage unavailable');
      uses = read.uses;
      if (!Array.isArray(uses)) throw Error('Invalid usage');
      if (uses.length > MEMORY_STREAM_LIMITS.uses || Buffer.byteLength(JSON.stringify(uses)) > MEMORY_STREAM_LIMITS.bytes) throw new CapacityError();
    }
    const ids = new Set(rows.map(r => r.id)), useIds = new Set<string>(), byUse = new Map<string, BriefMemoryUse[]>();
    for (const use of uses ?? []) {
      if (!use || !idValid(use.useId) || useIds.has(use.useId) || !ids.has(use.factId) || !idValid(use.factId)
        || typeof use.sourceRevision !== 'string' || !use.sourceRevision.trim() || use.sourceRevision.length > 200
        || !['selected', 'supplied', 'outcome_verified'].includes(use.stage) || !timestamp(use.at)
        || (use.runId !== null && !idValid(use.runId))
        || (use.turn !== null && (!use.turn || !idValid(use.turn.conversationId) || !idValid(use.turn.turnId) || !idValid(use.turn.requestId)))
        || (!use.turn && !use.runId)) throw Error('Invalid usage');
      useIds.add(use.useId);
      // Explicit projection: an adapter cannot accidentally expose prompt/secret fields.
      const safe: BriefMemoryUse = { useId: use.useId, factId: use.factId, sourceRevision: use.sourceRevision, stage: use.stage,
        at: use.at, runId: use.runId, turn: use.turn ? { conversationId: use.turn.conversationId, turnId: use.turn.turnId, requestId: use.turn.requestId } : null };
      const list = byUse.get(use.factId) ?? []; list.push(safe); byUse.set(use.factId, list);
    }
    const usedIn: MemoryStreamPage['usedIn'] = uses === null ? { state: 'unavailable', reason: 'provider_unavailable' }
      : uses.some(u => u.stage !== 'selected') ? { state: 'ready' } : { state: 'unavailable', reason: 'no_supplied_evidence' };
    const items = new Map<string, MemoryStreamItem>();
    for (const row of rows) {
      if (!idValid(row.id) || !idValid(row.subject_id) || !timestamp(row.created_at) || (row.verified_at !== null && !timestamp(row.verified_at))) throw Error('Invalid fact');
      const ev = byFact.get(row.id) ?? [], factUses = uses === null ? null : (byUse.get(row.id) ?? []).sort((a, b) => b.at - a.at || compareText(a.useId, b.useId));
      const labels = [...new Set([row.source, ...ev.map(e => e.source)].filter((v): v is string => v !== null))].sort(compareText);
      // Same precedence as canonical fact decoration; confirmation comes from verified_at.
      const fallback = ev[0]?.basis ?? 'unspecified';
      const basis = row.verified_at !== null ? 'confirmed' : ev.some(e => e.basis === 'reported') ? 'reported'
        : row.source === 'llm_extraction' ? 'inferred' : fallback === 'confirmed' ? 'unspecified' : fallback;
      const updatedAt = Math.max(row.created_at, row.verified_at ?? row.created_at, ...ev.map(e => e.recorded_at));
      if (!timestamp(updatedAt)) throw Error('Invalid provenance');
      const revision = digest([row, ev, factUses]);
      const href = `/api/brief/memory/${encodeURIComponent(row.id)}`;
      items.set(row.id, { factId: row.id, sourceId: null, sentence: `${row.subject_name} ${row.predicate} ${row.object}`,
        revision, subjectId: row.subject_id, updatedAt, basis, status: row.status,
        validity: { from: row.valid_from, to: row.valid_to }, sourceSummary: { labels, evidenceCount: ev.length },
        provenance: ev.map(e => ({ kind: 'source', id: e.id, revision: digest(e) })), uses: factUses,
        permissions: { canRead: true, canCorrect: false, canForget: false },
        detailHref: href, historyHref: `${href}/history`, supersededBy: row.superseded_by });
    }
    return { items, usedIn };
  }
  private encode(id: string, offset: number): string {
    const body = `${id}.${offset}`;
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  private decode(cursor: string): { id: string; offset: number } | null {
    const match = /^([a-f0-9]{32})\.([0-9]{1,5})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) throw new MemoryQueryError('Invalid cursor');
    const [, id, raw, signature] = match, body = `${id}.${raw}`;
    // An unknown session is expired (including daemon restart), never an empty page.
    if (!this.snapshots.has(id!)) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature!), Buffer.from(expected))) throw new MemoryQueryError('Invalid cursor');
    return { id: id!, offset: Number(raw) };
  }
  async read(input: MemoryStreamQuery = {}): Promise<MemoryStreamResult> {
    const query = memoryStreamQuery(input), { cursor, ...filters } = query, queryKey = digest(filters), now = Date.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
    if (this.readiness() !== 'ready') return { state: 'unavailable', reason: 'provider_unavailable' };
    const decoded = cursor ? this.decode(cursor) : null;
    if (cursor && !decoded) return { state: 'stale', reason: 'cursor_expired' };
    const previous = decoded ? this.snapshots.get(decoded.id)! : undefined;
    if (previous && previous.queryKey !== queryKey) throw new MemoryQueryError('Cursor belongs to a different query');
    try {
      return this.db.transaction((): MemoryStreamResult => {
        const collection = this.collection();
        if (query.usedIn && collection.usedIn.state !== 'ready') return { state: 'unavailable', reason: 'usage_unavailable' };
        let snapshot = previous, id = decoded?.id, offset = decoded?.offset ?? 0;
        if (snapshot) {
          if (snapshot.members.some(([factId, revision]) => collection.items.get(factId)?.revision !== revision)
            || JSON.stringify(snapshot.usedIn) !== JSON.stringify(collection.usedIn)) {
            this.snapshots.delete(id!); return { state: 'stale', reason: 'source_changed' };
          }
        } else {
          const visible = [...collection.items.values()].filter(f => f.status !== 'superseded');
          const matches = visible.filter(f => (!query.q || f.sentence.toLowerCase().includes(query.q.toLowerCase()))
            && (!query.source || f.sourceSummary.labels.includes(query.source))
            && (query.updatedFrom === undefined || f.updatedAt >= query.updatedFrom)
            && (query.updatedBefore === undefined || f.updatedAt < query.updatedBefore)
            && (!query.usedIn || f.uses?.some(u => u.stage !== 'selected'
              && ((u.turn !== null && query.usedIn === `conversation:${u.turn.conversationId}`) || (u.runId !== null && query.usedIn === `run:${u.runId}`)))))
            .sort((a, b) => b.updatedAt - a.updatedAt || compareText(a.factId, b.factId)).map(f => f.factId);
          snapshot = { queryKey, asOf: now, expiresAt: now + MEMORY_STREAM_LIMITS.ttlMs,
            members: [...collection.items].map(([id, item]) => [id, item.revision]), matches, total: visible.length, usedIn: collection.usedIn };
          id = randomBytes(16).toString('hex');
          if (matches.length > query.limit) {
            while (this.snapshots.size >= MEMORY_STREAM_LIMITS.snapshots) this.snapshots.delete(this.snapshots.keys().next().value!);
            this.snapshots.set(id, snapshot);
          }
        }
        if (offset >= snapshot.matches.length && offset !== 0) throw new MemoryQueryError('Invalid cursor offset');
        const items = snapshot.matches.slice(offset, offset + query.limit).map(id => collection.items.get(id)!);
        const nextCursor = offset + items.length < snapshot.matches.length ? this.encode(id!, offset + items.length) : null;
        return { state: snapshot.matches.length ? 'ready' : 'empty', asOf: snapshot.asOf,
          data: { items, nextCursor, count: { total: snapshot.total, matched: snapshot.matches.length, returned: items.length }, usedIn: snapshot.usedIn } };
      })();
    } catch (e) {
      if (e instanceof MemoryQueryError) throw e;
      return { state: 'unavailable', reason: e instanceof CapacityError ? 'capacity_exceeded' : 'provider_unavailable' };
    }
  }
  detail(id: string, history = false) {
    memoryFactId(id);
    if (this.readiness() !== 'ready') return { state: 'unavailable' as const };
    try {
      return this.db.transaction(() => {
        const { items } = this.collection(), item = items.get(id);
        if (!item) return { state: 'not_found' as const };
        if (!history) return { state: 'ready' as const, data: item, asOf: Date.now() };
        // Follow only canonical supersession edges, never textual similarity.
        const family = new Set([id]); let changed = true;
        while (changed) {
          changed = false;
          for (const fact of items.values()) if (fact.supersededBy && items.has(fact.supersededBy)
            && (family.has(fact.factId) || family.has(fact.supersededBy))) {
            for (const related of [fact.factId, fact.supersededBy]) if (!family.has(related)) { family.add(related); changed = true; }
          }
          if (family.size > 100) throw new CapacityError();
        }
        return { state: 'ready' as const, data: [...family].map(id => items.get(id)!).sort((a, b) => b.updatedAt - a.updatedAt || compareText(a.factId, b.factId)), asOf: Date.now() };
      })();
    } catch { return { state: 'unavailable' as const }; }
  }
}
