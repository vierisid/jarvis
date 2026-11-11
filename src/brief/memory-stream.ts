import type { MemoryForget } from './memory-forget';
import type { MemoryUsageCoverage } from '../vault/memory-usage';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';
import type { FactRow } from '../vault/fact-policy';
import type { FactEvidence } from '../vault/facts';
import type { BriefMemoryUse } from './contracts';
import type { MemoryStreamItem, MemoryStreamPage, MemoryStreamQuery, MemoryStreamResult, MemoryUsageReader } from './memory-stream-contracts';

/** Facts and evidence are paged from the database, so only the usage ledger and history lineage are bounded. */
export const MEMORY_STREAM_LIMITS = { uses: 50000, bytes: 16 * 1024 * 1024, lineage: 100, idChunk: 10000,
  snapshots: 16, ttlMs: 5 * 60_000, page: 100 } as const;
export class MemoryQueryError extends Error {}
class CapacityError extends Error {}
type Row = FactRow & { subject_name: string };
type Usage = { byFact: Map<string, BriefMemoryUse[]> | null; usedIn: MemoryStreamPage['usedIn']; coverage?: MemoryUsageCoverage; fingerprint: string };
/** A frozen view of one query: facts added after it began (higher rowid) never join it, and any change to a member ends it. */
type Snapshot = { queryKey: string; asOf: number; expiresAt: number; maxRowid: number; fingerprint: string;
  total: number; matched: number; usedIn: MemoryStreamPage['usedIn'] };
type After = { updatedAt: number; id: string };
// A cheap per-column mix: enough to notice an edit without hashing every row in JavaScript.
const mix = (col: string) => `(COALESCE(length(${col}), 0) * 131 + COALESCE(unicode(${col}), 0) * 7 + COALESCE(unicode(substr(${col}, -1)), 0) * 3)`;
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
      if (typeof value !== 'string' || !value.trim() || value.length > max || (key !== 'source' && /[\u0000-\u001f\u007f]/.test(value))) throw new MemoryQueryError(`Invalid ${key}`);
      // Source labels are canonical text, including stored whitespace, not identifiers.
      result[key] = key === 'source' ? value : value.trim();
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
  constructor(private readonly db: Database, readonly usage?: MemoryUsageReader, readonly forget?: MemoryForget, private readonly correctionAvailable: () => boolean = () => false) {}
  readiness(): 'ready' | 'unavailable' {
    try {
      if (getDb() !== this.db) return 'unavailable';
      this.db.query('SELECT id, status FROM facts LIMIT 1').get();
      this.db.query('SELECT id FROM fact_evidence LIMIT 1').get();
      return 'ready';
    } catch { return 'unavailable'; }
  }
  /** Validated usage for the given facts. `byFact` is null when no ledger is attached. */
  private readUsage(factIds: readonly string[]): Usage {
    if (!this.usage) return { byFact: null, usedIn: { state: 'unavailable', reason: 'provider_unavailable' }, fingerprint: 'none' };
    if (this.usage.readiness() !== 'ready') throw Error('Usage unavailable');
    const uses: BriefMemoryUse[] = []; let coverage: MemoryUsageCoverage | undefined;
    for (let i = 0; i < Math.max(factIds.length, 1); i += MEMORY_STREAM_LIMITS.idChunk) {
      const read = this.usage.readUses(factIds.slice(i, i + MEMORY_STREAM_LIMITS.idChunk));
      if (read.state !== 'ready') throw Error('Usage unavailable');
      if (!Array.isArray(read.uses)) throw Error('Invalid usage');
      uses.push(...read.uses);
      if (read.coverage && (!timestamp(read.coverage.startedAt) || !timestamp(read.coverage.retainedFrom)
        || !Number.isSafeInteger(read.coverage.retentionDays) || read.coverage.retentionDays <= 0
        || !Number.isSafeInteger(read.coverage.maxRecords) || read.coverage.maxRecords <= 0)) throw Error('Invalid usage coverage');
      if (read.coverage) coverage = { startedAt: read.coverage.startedAt, retainedFrom: read.coverage.retainedFrom,
        retentionDays: read.coverage.retentionDays, maxRecords: read.coverage.maxRecords,
        paths: ['brief_conversation_recall', 'workflow_ask_recall'], meaning: 'retained_provider_handoffs_not_model_reliance',
        completeness: 'recorded_events_only' };
      if (uses.length > MEMORY_STREAM_LIMITS.uses) throw new CapacityError();
    }
    if (Buffer.byteLength(JSON.stringify(uses)) > MEMORY_STREAM_LIMITS.bytes) throw new CapacityError();
    const ids = new Set(factIds), useIds = new Set<string>(), byFact = new Map<string, BriefMemoryUse[]>();
    for (const use of uses) {
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
      const list = byFact.get(use.factId) ?? []; list.push(safe); byFact.set(use.factId, list);
    }
    for (const list of byFact.values()) list.sort((a, b) => b.at - a.at || compareText(a.useId, b.useId));
    const usedIn: MemoryStreamPage['usedIn'] = uses.some(u => u.stage !== 'selected') ? { state: 'ready' } : { state: 'unavailable', reason: 'no_supplied_evidence' };
    const fingerprint = digest([uses.length, uses.reduce((sum, u) => sum + u.at, 0), uses.filter(u => u.stage !== 'selected').length]);
    return { byFact, usedIn, ...(coverage ? { coverage } : {}), fingerprint };
  }
  private evidenceFor(factIds: readonly string[]): Map<string, FactEvidence[]> {
    const byFact = new Map<string, FactEvidence[]>();
    for (let i = 0; i < factIds.length; i += 500) {
      const rows = this.db.query<FactEvidence, [string]>(`SELECT id, fact_id, source, source_ref, basis, confidence, recorded_at
        FROM fact_evidence WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(factIds.slice(i, i + 500)));
      for (const e of rows) { const list = byFact.get(e.fact_id) ?? []; list.push(e); byFact.set(e.fact_id, list); }
    }
    for (const list of byFact.values()) list.sort((a, b) => b.recorded_at - a.recorded_at || compareText(a.id, b.id));
    return byFact;
  }
  private toItem(row: Row, ev: FactEvidence[], factUses: BriefMemoryUse[] | null, coverage: MemoryUsageCoverage | undefined): MemoryStreamItem {
    if (!idValid(row.id) || !idValid(row.subject_id) || !timestamp(row.created_at) || (row.verified_at !== null && !timestamp(row.verified_at))) throw Error('Invalid fact');
    const labels = [...new Set([row.source, ...ev.map(e => e.source)].filter((v): v is string => v !== null))].sort(compareText);
    // Same precedence as canonical fact decoration; confirmation comes from verified_at.
    const fallback = ev[0]?.basis ?? 'unspecified';
    const basis = row.verified_at !== null ? 'confirmed' : ev.some(e => e.basis === 'reported') ? 'reported'
      : row.source === 'llm_extraction' ? 'inferred' : fallback === 'confirmed' ? 'unspecified' : fallback;
    const updatedAt = Math.max(row.created_at, row.verified_at ?? row.created_at, ...ev.map(e => e.recorded_at));
    if (!timestamp(updatedAt)) throw Error('Invalid provenance');
    const revision = digest([row, ev, factUses]);
    const href = `/api/brief/memory/${encodeURIComponent(row.id)}`;
    return { factId: row.id, sourceId: null, sentence: `${row.subject_name} ${row.predicate} ${row.object}`,
      revision, ...(coverage ? { usageCoverage: coverage } : {}), subjectId: row.subject_id, scope: row.scope, updatedAt, basis, status: row.status,
      validity: { from: row.valid_from, to: row.valid_to }, sourceSummary: { labels, evidenceCount: ev.length },
      provenance: ev.map(e => ({ kind: 'source', id: e.id, revision: digest(e) })), uses: factUses,
      permissions: { canRead: true, canCorrect: row.status !== 'superseded' && this.correctionAvailable(), canForget: this.forget?.readiness() === 'ready' },
      detailHref: href, historyHref: `${href}/history`, supersededBy: row.superseded_by };
  }
  /** Fact rows by id, with their evidence and usage, in the order asked. */
  private items(ids: readonly string[], usage: Usage): MemoryStreamItem[] {
    if (!ids.length) return [];
    const rows = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of this.db.query<Row, [string]>(`SELECT f.*, e.name AS subject_name FROM facts f JOIN entities e ON e.id = f.subject_id
        WHERE f.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids.slice(i, i + 500)))) rows.set(r.id, r);
    }
    const evidence = this.evidenceFor(ids);
    return ids.flatMap(id => { const row = rows.get(id); return row ? [this.toItem(row, evidence.get(id) ?? [], usage.byFact === null ? null : (usage.byFact.get(id) ?? []), usage.coverage)] : []; });
  }
  /** Changes when any member fact, its evidence, its subject, or any usage record changes. Later inserts do not count. */
  private fingerprint(maxRowid: number, usage: Usage): string {
    const f = this.db.query<Record<string, number>, [number]>(`SELECT count(*) AS n, total(created_at) AS c, total(COALESCE(verified_at, 0)) AS v,
      total(COALESCE(valid_from, 0) + COALESCE(valid_to, 0)) AS w, total(${mix('object')} + ${mix('predicate')} + ${mix('scope')} + ${mix('status')}
      + ${mix('superseded_by')} + ${mix('source')}) AS m FROM facts WHERE rowid <= ?`).get(maxRowid)!;
    const e = this.db.query<Record<string, number>, [number]>(`SELECT count(*) AS n, total(e.recorded_at) AS r, total(${mix('e.source')} + ${mix('e.basis')}) AS m,
      total(COALESCE(e.confidence, 0) * 1000) AS c FROM fact_evidence e JOIN facts f ON f.id = e.fact_id WHERE f.rowid <= ?`).get(maxRowid)!;
    const s = this.db.query<Record<string, number>, [number]>(`SELECT count(*) AS n, total(${mix('name')}) AS m FROM entities
      WHERE id IN (SELECT subject_id FROM facts WHERE rowid <= ?)`).get(maxRowid)!;
    return digest([f, e, s, usage.fingerprint]);
  }
  private encode(id: string, after: After | null): string {
    const body = `${id}.${Buffer.from(JSON.stringify(after ?? null)).toString('base64url')}`;
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  private decode(cursor: string): { id: string; after: After | null } | null {
    const match = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) throw new MemoryQueryError('Invalid cursor');
    const [, id, raw, signature] = match, body = `${id}.${raw}`;
    // An unknown session is expired (including daemon restart), never an empty page.
    if (!this.snapshots.has(id!)) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature!), Buffer.from(expected))) throw new MemoryQueryError('Invalid cursor');
    try {
      const after = JSON.parse(Buffer.from(raw!, 'base64url').toString()) as After | null;
      if (after !== null && (!timestamp(after.updatedAt) || !idValid(after.id))) throw Error();
      return { id: id!, after };
    } catch { throw new MemoryQueryError('Invalid cursor'); }
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
        const allIds = this.usage ? this.db.query<{ id: string }, []>('SELECT id FROM facts').all().map(r => r.id) : [];
        const usage = this.readUsage(allIds);
        if (query.usedIn && usage.usedIn.state !== 'ready') return { state: 'unavailable', reason: 'usage_unavailable' };
        const maxRowid = previous?.maxRowid ?? this.db.query<{ m: number }, []>('SELECT COALESCE(MAX(rowid), 0) AS m FROM facts').get()!.m;
        const fingerprint = this.fingerprint(maxRowid, usage);
        if (previous && (previous.fingerprint !== fingerprint || JSON.stringify(previous.usedIn) !== JSON.stringify(usage.usedIn))) {
          this.snapshots.delete(decoded!.id); return { state: 'stale', reason: 'source_changed' };
        }
        // Search, Source, Used in and the Updated range run in the database over the member facts.
        const where: string[] = [], params: (string | number)[] = [];
        if (query.q) { where.push(`instr(lower(subject_name || ' ' || predicate || ' ' || object), ?) > 0`); params.push(query.q.toLowerCase()); }
        if (query.source) { where.push(`(source = ? OR EXISTS (SELECT 1 FROM fact_evidence ev WHERE ev.fact_id = r.id AND ev.source = ?))`); params.push(query.source, query.source); }
        if (query.updatedFrom !== undefined) { where.push('updated_at >= ?'); params.push(query.updatedFrom); }
        if (query.updatedBefore !== undefined) { where.push('updated_at < ?'); params.push(query.updatedBefore); }
        if (query.usedIn) {
          const target = query.usedIn, usedFacts = [...usage.byFact!].filter(([, list]) => list.some(u => u.stage !== 'selected'
            && ((u.turn !== null && target === `conversation:${u.turn.conversationId}`) || (u.runId !== null && target === `run:${u.runId}`)))).map(([id]) => id);
          where.push('id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(usedFacts));
        }
        const cte = `WITH r AS (SELECT f.*, e.name AS subject_name,
          MAX(f.created_at, COALESCE(f.verified_at, f.created_at), COALESCE((SELECT MAX(recorded_at) FROM fact_evidence WHERE fact_id = f.id), f.created_at)) AS updated_at
          FROM facts f JOIN entities e ON e.id = f.subject_id WHERE f.rowid <= ${maxRowid} AND f.status IS NOT 'superseded')`;
        const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        let snapshot = previous, id = decoded?.id;
        if (!snapshot) {
          const total = this.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM facts WHERE rowid <= ${maxRowid} AND status IS NOT 'superseded'`).get()!.n;
          const matched = where.length ? this.db.query<{ n: number }, (string | number)[]>(`${cte} SELECT count(*) AS n FROM r${filter}`).get(...params)!.n : total;
          snapshot = { queryKey, asOf: now, expiresAt: now + MEMORY_STREAM_LIMITS.ttlMs, maxRowid, fingerprint, total, matched, usedIn: usage.usedIn };
          id = randomBytes(16).toString('hex');
          if (matched > query.limit) {
            while (this.snapshots.size >= MEMORY_STREAM_LIMITS.snapshots) this.snapshots.delete(this.snapshots.keys().next().value!);
            this.snapshots.set(id, snapshot);
          }
        }
        const after = decoded?.after ?? null;
        const pageWhere = [...where], pageParams = [...params];
        if (after) { pageWhere.push('(updated_at < ? OR (updated_at = ? AND id > ?))'); pageParams.push(after.updatedAt, after.updatedAt, after.id); }
        const rows = this.db.query<Row & { updated_at: number }, (string | number)[]>(`${cte} SELECT * FROM r${pageWhere.length ? ` WHERE ${pageWhere.join(' AND ')}` : ''}
          ORDER BY updated_at DESC, id LIMIT ${query.limit}`).all(...pageParams);
        const evidence = this.evidenceFor(rows.map(r => r.id));
        const items = rows.map(r => this.toItem(r, evidence.get(r.id) ?? [], usage.byFact === null ? null : (usage.byFact.get(r.id) ?? []), usage.coverage));
        const last = items[items.length - 1];
        const more = last !== undefined && rows.length === query.limit && this.snapshots.has(id!)
          && this.db.query<{ n: number }, (string | number)[]>(`${cte} SELECT count(*) AS n FROM (SELECT 1 FROM r WHERE ${[...where, '(updated_at < ? OR (updated_at = ? AND id > ?))'].join(' AND ')} LIMIT 1)`)
            .get(...params, last.updatedAt, last.updatedAt, last.factId)!.n > 0;
        const nextCursor = more ? this.encode(id!, { updatedAt: last!.updatedAt, id: last!.factId }) : null;
        return { state: snapshot.matched ? 'ready' : 'empty', asOf: snapshot.asOf,
          data: { items, nextCursor, ...(usage.coverage ? { usageCoverage: usage.coverage } : {}), count: { total: snapshot.total, matched: snapshot.matched, returned: items.length }, usedIn: snapshot.usedIn } };
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
        const exists = this.db.query<{ id: string }, [string]>('SELECT id FROM facts WHERE id = ?').get(id);
        if (!exists) {
          const forgotten = this.db.query<{ forgotten_at: number }, [string]>('SELECT forgotten_at FROM memory_forget_receipts WHERE fact_id = ?').get(id);
          return forgotten ? { state: 'forgotten' as const, data: { factId: id, forgottenAt: forgotten.forgotten_at } } : { state: 'not_found' as const };
        }
        if (!history) return { state: 'ready' as const, data: this.items([id], this.readUsage([id]))[0]!, asOf: Date.now() };
        // Follow only canonical supersession edges, never textual similarity.
        const family = new Set([id]); let changed = true;
        while (changed) {
          changed = false;
          const edges = this.db.query<{ id: string; superseded_by: string | null }, [string, string]>(`SELECT id, superseded_by FROM facts
            WHERE id IN (SELECT value FROM json_each(?)) OR superseded_by IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...family]), JSON.stringify([...family]));
          for (const edge of edges) for (const related of [edge.id, edge.superseded_by]) {
            if (related && !family.has(related)) { family.add(related); changed = true; }
          }
          if (family.size > MEMORY_STREAM_LIMITS.lineage) throw new CapacityError();
        }
        // A superseded_by that names a fact which no longer exists is not an edge.
        const members = [...family], items = this.items(members, this.readUsage(members));
        return { state: 'ready' as const, data: items.sort((a, b) => b.updatedAt - a.updatedAt || compareText(a.factId, b.factId)), asOf: Date.now() };
      })();
    } catch { return { state: 'unavailable' as const }; }
  }
}
