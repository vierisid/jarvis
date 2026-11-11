import type { GoalsPort, GoalPath, GoalDatum, GoalWrite, GoalWritesPort } from '../goals/model';
import { GOAL_CONFLICT_TEXT, GOAL_COUNTED_TEXT, GOAL_MEASURE_LOCKED_TEXT, GOAL_SAVE_FAILED_TEXT } from '../goals/model';
import type { OpportunitiesPort, FinishedOpportunity } from '../opportunities/model';
import type { DecisionsPort, DecisionView } from '../decisions/model';
import type { MemoryPort } from '../memory/stream/model';
import { queryString } from '../memory/stream/model';
import type { MemoryDetailPort } from '../memory/detail/model';
import type { HostTransport } from './http';
import { AWARENESS_OFF_TEXT, AwarenessOffError, post } from './http';

export function createDomainPorts(scopeId: string, http: HostTransport, storage: Pick<Storage, 'setItem'>) {
  const get = http.json;
  const remember = (kind: string, request: { requestId?: string; idempotencyKey?: string }) =>
    storage.setItem(`brief:request:v1:${scopeId}:${kind}:${request.requestId ?? request.idempotencyKey}`, JSON.stringify(request));
  async function collection(path: string, identity: string, signal?: AbortSignal): Promise<any[]> {
    const result: any[] = [], seen = new Set<string>(), cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const value = await get(path + '?limit=50' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), { signal });
      if (value.state === 'empty' && value.data === undefined && !cursor) return [];
      if (!['ready', 'empty'].includes(value.state) || !Array.isArray(value.data?.items)) throw new Error('Collection unavailable');
      for (const item of value.data.items) {
        if (typeof item?.[identity] !== 'string' || seen.has(item[identity]) || result.length >= 5000) throw new Error('Collection changed or exceeds display capacity');
        seen.add(item[identity]); result.push(item);
      }
      const next = value.data.nextCursor;
      if (next !== null && (typeof next !== 'string' || !next || cursors.has(next))) throw new Error('Invalid collection cursor');
      cursor = next; if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }
  /** Plain words for a refused goal write. The server's own text names fields and revisions, so it is never shown. */
  function refusal(status: number, error: unknown, defining = false): GoalWrite {
    const reason = typeof error === 'string' ? error : '';
    if (status === 409) {
      if (/already counted/.test(reason)) return { ok: false, message: 'That is already counted. Use a different name.' };
      if (/counted from its cited entries/.test(reason)) return { ok: false, message: GOAL_COUNTED_TEXT };
      if (/keeps its unit once it has entries/.test(reason)) return { ok: false, message: 'A count keeps what it counts once it has entries.' };
      // A typed measure with logged values only changes together with a new value.
      if (/later measurement time/.test(reason)) return { ok: false, message: defining ? GOAL_MEASURE_LOCKED_TEXT : 'Pick a time after your last update.' };
      return { ok: false, message: GOAL_CONFLICT_TEXT };
    }
    if (status === 400) return { ok: false, message: 'That did not save. Check what you entered and try again.' };
    return { ok: false, message: GOAL_SAVE_FAILED_TEXT };
  }
  /** Whether the server already holds this request, so a lost reply or a retry is not reported as a failure. */
  async function saved(receipt: string, requestId: string): Promise<boolean> {
    try { return !!(await http.json(`${receipt}?requestId=${encodeURIComponent(requestId)}`))?.receipt; }
    catch { return false; }
  }
  async function send(path: string, body: unknown, recover?: { receipt: string; requestId: string; defining?: boolean }): Promise<GoalWrite> {
    let result: GoalWrite;
    try {
      const response = await http.request(path, post(body));
      if (response.ok) return { ok: true };
      const reply = await response.json().catch(() => null) as { error?: unknown } | null;
      result = refusal(response.status, reply?.error, recover?.defining);
      if (response.status === 400) return result;
    } catch { result = { ok: false, message: GOAL_SAVE_FAILED_TEXT }; }
    return recover && await saved(recover.receipt, recover.requestId) ? { ok: true } : result;
  }
  const goalPath = (goal: GoalDatum) => `/api/brief/goals/${encodeURIComponent(goal.goalId)}`;
  /** A person typing a number is the source: one evidence version per request, so no two saves collide. */
  const typed = (requestId: string) => ({ id: 'entered-in-jarvis', revision: requestId });
  const write: GoalWritesPort = {
    logValue(goal, { requestId, value, measuredAt }) {
      const definition = goal.measurementDefinition;
      if (!definition) return Promise.resolve({ ok: false, message: GOAL_SAVE_FAILED_TEXT });
      remember('goal-measurement', { requestId });
      return send(`${goalPath(goal)}/measurement`, { requestId, revision: goal.measurementRevision ?? 0,
        measurement: { unit: definition.unit, baseline: definition.baseline, target: definition.target, value, measuredAt, evidence: typed(requestId) } },
        { receipt: `${goalPath(goal)}/measurement`, requestId });
    },
    addEntry(goal, { requestId, note, link }) {
      remember('goal-entry', { requestId });
      return send(`${goalPath(goal)}/observations`, { requestId,
        entry: { kind: 'counted', subject: note, observedAt: Date.now(), source: { id: link || typed(requestId).id, revision: requestId }, corrects: null } },
        { receipt: `${goalPath(goal)}/observations`, requestId });
    },
    defineMeasure(goal, { requestId, kind, unit, baseline, target }) {
      remember('goal-define', { requestId });
      const revision = goal.measurementRevision ?? 0;
      // A counted definition's receipt is recovered like any measurement's.
      const recover = { receipt: `${goalPath(goal)}/measurement`, requestId, defining: true };
      return kind === 'count'
        ? send(`${goalPath(goal)}/measurement/counted`, { requestId, revision, definition: { unit, baseline, target } }, recover)
        : send(`${goalPath(goal)}/measurement`, { requestId, revision,
          measurement: { unit, baseline, target, value: null, measuredAt: null, evidence: null } }, recover);
    },
    activate: goal => send(`/api/goals/${encodeURIComponent(goal.goalId)}/status`, { status: 'active' }),
  };
  const goals: GoalsPort = { source: 'live', scopeId, write, read: async () => {
    const value = await get('/api/brief/goals');
    if (!['ready', 'empty'].includes(value.state) || !Array.isArray(value.data)) throw new Error('Goals unavailable');
    const all = value.data as Array<GoalDatum & { parentId: string | null; pathTitle: string }>;
    const ids = new Set(all.map(g => g.goalId)); if (ids.size !== all.length) throw new Error('Goal identities changed');
    const roots = all.filter(g => g.parentId === null || !ids.has(g.parentId));
    const visited = new Set<string>();
    function descendants(goal: typeof all[number]): GoalDatum[] {
      if (visited.has(goal.goalId)) throw new Error('Goal hierarchy unavailable'); visited.add(goal.goalId);
      return all.filter(g => g.parentId === goal.goalId).flatMap(g => [g, ...descendants(g)]);
    }
    const paths: GoalPath[] = roots.map(goal => ({ goal, pathTitle: goal.pathTitle, stages: descendants(goal) }));
    if (visited.size !== all.length) throw new Error('Goal hierarchy unavailable');
    return paths.length ? { status: 'ready', data: paths } : { status: 'empty' };
  } };
  const opportunities: OpportunitiesPort = {
    read: async () => {
      let rows: any[];
      try { rows = await collection('/api/brief/prepared-opportunities', 'proposalId'); }
      catch (error) {
        // Built from recorded screen cues: hidden while awareness is off, and said so (#1314).
        if (error instanceof AwarenessOffError) return { status: 'unavailable', reason: AWARENESS_OFF_TEXT };
        throw error;
      }
      const data: FinishedOpportunity[] = rows.map(p => {
        if (!p.specification || typeof p.title !== 'string' || !Array.isArray(p.blockers) || !Array.isArray(p.evidence)) throw new Error('Opportunity unavailable');
        return { proposal: p, canApprove: p.canApprove === true, title: p.title, observation: p.specification.description,
          observationSource: p.evidence.map((e: { kind: string }) => e.kind).join(', '), goalTitle: p.goal?.rationale ?? null,
          output: null, steps: [], schedule: null, target: null, blockers: p.blockers.map((b: { message: string }) => b.message) };
      });
      return data.length ? { status: 'ready', data } : { status: 'empty' };
    },
    act: async request => {
      remember('opportunity', request);
      const value = await get(`/api/brief/opportunity-actions/${encodeURIComponent(request.proposalId)}/${request.decision}`, post({ revision: request.revision, idempotencyKey: request.idempotencyKey }));
      if (!value.receipt) throw new Error('Unconfirmed opportunity'); return value.receipt;
    },
    recover: async request => { return get(`/api/brief/opportunity-actions/${encodeURIComponent(request.proposalId)}`); },
  };
  const decisions: DecisionsPort = {
    read: async () => {
      const rows = await collection('/api/brief/decisions', 'decisionId');
      const data: DecisionView[] = [];
      // F14 supplies the typed document and server-approved action set together.
      for (const row of rows) {
        const doc = await get(`/api/brief/decisions/${encodeURIComponent(row.decisionId)}/document`);
        const d = doc.decision;
        if (!d || d.decisionId !== row.decisionId || d.revision !== row.revision || !Array.isArray(doc.actions)) throw new Error('Decision changed during read');
        const document = doc.document;
        const subject = document?.kind === 'email' ? document.subject : document?.kind === 'calendar' ? document.title : d.title;
        const body = document?.kind === 'email' ? document.body : document?.kind === 'calendar' ? document.description : 'Open Needs you to review this decision and its available actions.';
        data.push({ paper: { decision: d, title: d.title, summary: d.title, description: d.kind === 'intent' ? 'A proposed next step needs your review.' : 'A decision needs your review.',
          reviewLabel: 'Review decision', document: { subject, paragraphs: [body], ...(document?.kind === 'email' ? { recipient: document.to.join(', ') } : {}) },
          actionLabels: { ...(doc.actions.includes('approve') ? { approve: 'Approve' } : {}), ...(doc.actions.includes('keep_draft') ? { keep_draft: 'Keep draft' } : {}), ...(doc.actions.includes('reject') ? { reject: 'Reject' } : {}) },
          approveResult: 'permission_granted', queueCount: rows.length }, document, generation: doc.generation, editable: doc.editable,
          actions: doc.actions, state: doc.state, reason: doc.reason, context: null,
          options: doc.options ? Object.entries(doc.options).map(([label, value]) => ({ label, value: String(value) })) : [] });
      }
      return data.length ? { status: 'ready', data } : { status: 'empty' };
    },
    act: async request => {
      remember('decision', request); const { decisionId, ...command } = request;
      return get(`/api/brief/decisions/${encodeURIComponent(decisionId)}/document`, post(command));
    },
    recover: async request => (await get(`/api/brief/decisions/${encodeURIComponent(request.decisionId)}/document?requestId=${encodeURIComponent(request.requestId)}`)).receipt,
  };
  const memory: MemoryPort = { source: 'live', scopeId, read: (query, signal) => get('/api/brief/memory?' + queryString(query), { signal }) };
  const detail: MemoryDetailPort = { source: 'live', scopeId,
    read: async (id, signal) => {
      const path = encodeURIComponent(id);
      const item = await get(`/api/brief/memory/${path}`, { signal });
      if (item.state !== 'ready') return { state: 'unavailable', reason: 'Memory is unavailable.' };
      const fact = await get(`/api/vault/facts/${path}`, { signal });
      const fresh = await get(`/api/brief/memory/${path}`, { signal });
      if (fresh.state !== 'ready' || fresh.data?.revision !== item.data.revision) return { state: 'conflict', reason: 'This fact changed. Reload it.' };
      return { state: 'ready', data: { item: item.data, fact } };
    },
    history: async (id, signal) => { const value = await get(`/api/brief/memory/${encodeURIComponent(id)}/history`, { signal });
      return value.state === 'ready' && Array.isArray(value.data) ? { state: 'ready', items: value.data } : { state: 'unavailable', reason: 'Memory history is unavailable.' }; },
    decide: async (command, signal) => {
      const { factId, ...body } = command;
      const response = await http.request(`/api/brief/memory/${encodeURIComponent(factId)}/decision`, { ...post({ ...body, confirmed: true }), signal });
      if (response.status === 409) return { state: 'conflict', reason: 'This fact changed. Reload before saving.' };
      if (!response.ok) return { state: 'unknown', reason: 'Could not confirm the change. Reload this fact.' };
      return response.json();
    },
  };
  return { goals, opportunities, decisions, memory, detail, collection,
    async otherDecisions() {
      const rows = await collection('/api/brief/decisions', 'decisionId');
      const result = [];
      for (const row of rows) {
        const doc = await get(`/api/brief/decisions/${encodeURIComponent(row.decisionId)}/document`);
        if (doc.decision?.revision !== row.revision || !Array.isArray(doc.actions)) throw Error('Decision changed');
        // Exactly the rows DecisionsRoom leaves out (it keeps only rows with document actions), so nothing is
        // listed twice and every queued row, inspect-only receipts included, is shown in one of the two lists.
        if (!doc.actions.length) result.push(row);
      }
      return result;
    },
  };
}
