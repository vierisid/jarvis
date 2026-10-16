import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../workflows/db';
import { createFlowRun } from '../workflows/db/repos/flow-run';
import { enqueue } from '../workflows/db/repos/job-queue';
import { assertCodeStepsAllowed } from '../workflows/db/repos/flow-code-steps';
import { assertVersionReady } from '../workflows/db/repos/flow-readiness';
import { boundedJson, canonicalManualPayload, inspectionId, inspectionValue, INSPECTION_LIMITS as LIMIT,
  object, opaque, WorkflowInspectionError } from './inspection-values';
import type { ContextGroup, InspectionContext, InspectionContextEntry, InspectionRunDetail,
  InspectionRunStatus, InspectionRunSummary, InspectionSelection, InspectionState, ManualInspectionRunResult } from './workflow-context-contracts';

interface RunRow {
  id: string; flow_id: string; flow_version_id: string; project_id: string; status: string;
  created: number; start_time: number | null; finish_time: number | null; updated: number;
}
interface Version { id: string; flow_id: string; state: string; trigger: string; connection_ids: string; updated: number }
const ready = <T>(data: T): InspectionState<T> => ({ status: 'ready', data });
const missing = (reason: string): InspectionState<never> => ({ status: 'unavailable', reason });
const states: Record<string, InspectionRunStatus> = { QUEUED: 'queued', RUNNING: 'running', PAUSED: 'paused',
  SUCCEEDED: 'succeeded', STOPPED: 'cancelled' };
const status = (v: string): InspectionRunStatus => Object.hasOwn(states, v) ? states[v]! : (['FAILED','TIMEOUT','INTERNAL_ERROR','QUOTA_EXCEEDED','MEMORY_LIMIT_EXCEEDED','SCHEDULE_FAILURE'].includes(v) ? 'failed' : 'uncertain');
const runColumns = 'id, flow_id, flow_version_id, project_id, status, created, start_time, finish_time, updated';
const groups: ContextGroup[] = ['goal', 'memory', 'bindings', 'target', 'rules'];
const kinds = { goal: 'Goal', memory: 'Memory', bindings: 'Connection', target: 'Device', rules: 'Rule' } as const;
const referenceId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,200}$/.test(v);
const safeName = (v: unknown, fallback: string) => inspectionId(v) ? v : fallback;

/** Read-only projections, plus the manual-start command called exclusively by the
 * existing /api/workflows/:id/run route. No recovery/effect state is written here. */
export class WorkflowContext {
  constructor(readonly db: Database, readonly projectId: string = DEFAULT_IDS.project,
    private readonly enabled = () => process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT === '1') {}
  readiness(): 'ready' | 'unavailable' {
    try { return this.enabled() && getWorkflowDb() === this.db
      && this.db.query("SELECT 1 FROM sqlite_master WHERE name='brief_manual_run_requests'").get() ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  private assertReady() { if (this.readiness() !== 'ready') throw new WorkflowInspectionError('unavailable', 503); }
  private flow(flowId: string) {
    this.assertReady();
    if (!inspectionId(flowId)) throw new WorkflowInspectionError('invalid_identity');
    if (!this.db.query('SELECT id FROM flow WHERE id=? AND project_id=?').get(flowId, this.projectId))
      throw new WorkflowInspectionError('not_found', 404);
  }
  private run(flowId: string, runId: string): RunRow {
    this.flow(flowId);
    if (!inspectionId(runId)) throw new WorkflowInspectionError('invalid_identity');
    const r = this.db.query<RunRow, [string, string, string]>(`SELECT ${runColumns} FROM flow_run WHERE id=? AND flow_id=? AND project_id=?`)
      .get(runId, flowId, this.projectId);
    if (!r) throw new WorkflowInspectionError('not_found', 404);
    return r;
  }
  private summary(r: RunRow): InspectionRunSummary {
    // Unknown effects outrank a nominal success or failure. Q-07 may add recovery
    // evidence; F-21 never reconciles or changes any of these rows.
    const uncertain = this.db.query("SELECT 1 FROM workflow_effect WHERE run_id=? AND status IN ('unknown','dispatching') LIMIT 1").get(r.id);
    return { scopeId: this.projectId, flowId: r.flow_id, versionId: r.flow_version_id, runId: r.id,
      label: `Run ${r.id}`, status: uncertain ? 'uncertain' : status(r.status), createdAt: r.created, startedAt: r.start_time };
  }
  private version(flowId: string, versionId: string): Version | null {
    if (!inspectionId(versionId)) throw new WorkflowInspectionError('invalid_identity');
    // Size checks precede materializing/JSON parsing legacy blobs. Never select
    // sample data, source notes, connection credentials or editor metadata.
    const size = this.db.query<{ n: number }, [string, string]>(`SELECT length(CAST(trigger AS BLOB))+length(CAST(connection_ids AS BLOB)) AS n
      FROM flow_version WHERE id=? AND flow_id=?`).get(versionId, flowId);
    if (!size) return null;
    if (size.n > LIMIT.sourceBytes) throw new WorkflowInspectionError('source_too_large', 413);
    return this.db.query<Version, [string, string]>('SELECT id,flow_id,state,trigger,connection_ids,updated FROM flow_version WHERE id=? AND flow_id=?').get(versionId, flowId);
  }
  private nodes(v: Version | null): Record<string, unknown>[] | null {
    if (!v || v.state !== 'LOCKED') return null;
    const pending: unknown[] = [boundedJson(v.trigger)], result: Record<string, unknown>[] = [], names = new Set<string>();
    while (pending.length) {
      const node = pending.pop();
      if (!object(node) || !inspectionId(node.name) || names.has(node.name)) throw new WorkflowInspectionError('invalid_graph', 503);
      if (result.length >= LIMIT.nodes) throw new WorkflowInspectionError('graph_too_large', 413);
      names.add(node.name); result.push(node);
      for (const next of [node.nextAction, node.firstLoopAction, ...(Array.isArray(node.children) ? node.children : [])]) {
        if (next !== undefined && next !== null) pending.push(next);
      }
    }
    return result;
  }
  private boundedRows<T>(rows: T[]): T[] {
    if (rows.length > LIMIT.rows) throw new WorkflowInspectionError('inspection_capacity', 413);
    return rows;
  }
  private result<T>(value: T): T {
    if (Buffer.byteLength(JSON.stringify(value)) > LIMIT.responseBytes) throw new WorkflowInspectionError('response_too_large', 413);
    return value;
  }
  list(flowId: string, cursor: string | null = null) {
    this.flow(flowId);
    let before: RunRow | null = null;
    if (cursor !== null) before = this.run(flowId, cursor);
    const parameters: [string, string] | [string, string, number, string] = before
      ? [this.projectId, flowId, before.created, before.id] : [this.projectId, flowId];
    const rows = this.db.query<RunRow, typeof parameters>(`SELECT ${runColumns} FROM flow_run
      WHERE project_id=? AND flow_id=?${before ? ' AND (created,id) < (?,?)' : ''}
      ORDER BY created DESC, id DESC LIMIT 51`);
    // Match idx_brief_run_history for both the first page and a tuple seek.
    // An optional-cursor OR would prevent SQLite seeking to the requested page.
    const items = rows.all(...parameters);
    return ready({ items: items.slice(0, 50).map(r => this.summary(r)), nextCursor: items.length > 50 ? items[49]!.id : null, total: null });
  }
  selection(flowId: string, versionId: string, runId: string | null = null): InspectionSelection {
    this.flow(flowId);
    return this.db.transaction(() => {
      const r = runId === null ? null : this.run(flowId, runId);
      if (r && r.flow_version_id !== versionId) throw new WorkflowInspectionError('version_conflict', 409);
      const v = this.version(flowId, versionId);
      if (!v && !r) throw new WorkflowInspectionError('not_found', 404);
      const recordedVersion = r ? this.db.query<{ was_locked: number }, [string]>('SELECT was_locked FROM workflow_run_inspection_versions WHERE run_id=?').get(r.id) : null;
      const historical = !r || (recordedVersion ? recordedVersion.was_locked === 1 : !!v && v.updated < r.created);
      const nodes = this.nodes(historical ? v : null), context = this.context(flowId, versionId, r, v, nodes);
      const canvas = nodes ? ready({ nodes: nodes.map(n => {
        const settings = object(n.settings) ? n.settings : {};
        return { id: String(n.name), type: safeName(n.type, 'UNKNOWN'), title: `Step ${n.name}`,
          fields: [inspectionValue('Configured inputs', settings.input), ...(n.type === 'CODE' ? [inspectionValue('Code', settings.sourceCode)] : [])],
          edges: [n.nextAction, n.firstLoopAction, ...(Array.isArray(n.children) ? n.children : [])]
            .filter(object).map(x => safeName(x.name, 'unknown')) };
      }) }) : missing('Immutable version unavailable: this run may have used an editable draft. Current configuration was not substituted.');
      return this.result({ scopeId: this.projectId, flowId, versionId, runId, canvas, context,
        run: r ? this.detailRow(r, nodes, context) : null });
    })();
  }
  detail(flowId: string, runId: string): InspectionRunDetail {
    const r = this.run(flowId, runId);
    return this.selection(flowId, r.flow_version_id, runId).run!;
  }
  private context(flowId: string, versionId: string, r: RunRow | null, v: Version | null, nodes: Record<string, unknown>[] | null): InspectionContext {
    const rows: Record<ContextGroup, InspectionContextEntry[]> = { goal: [], memory: [], bindings: [], target: [], rules: [] };
    const add = (group: ContextGroup, kind: NonNullable<InspectionContextEntry['source']>['kind'], ref: unknown,
      value: string, availability: InspectionContextEntry['availability'] = 'available') => {
      if (!referenceId(ref)) return;
      if (rows[group].some(x => x.id === `${kind}-${opaque(ref)}`)) return;
      rows[group].push({ id: `${kind}-${opaque(ref)}`, label: `${kinds[group]} reference`, value, availability,
        source: availability === 'redacted' || availability === 'missing' ? null : { kind, id: ref } });
      if (rows[group].length > LIMIT.rows) throw new WorkflowInspectionError('context_capacity', 413);
    };
    // Vault goals/facts are daemon-wide, so expose them only in its canonical
    // project. No foreign project can follow a crafted ID into the local vault.
    if (this.projectId === DEFAULT_IDS.project) {
      const links = r
        ? this.db.query<{ goal_id: string }, [string, string, string]>('SELECT goal_id FROM commitment_work WHERE run_id=? AND workflow_id=? AND workflow_version_id=? AND goal_id IS NOT NULL LIMIT 201').all(r.id, flowId, versionId)
        : this.db.query<{ goal_id: string }, [string, string]>('SELECT goal_id FROM commitment_work WHERE workflow_id=? AND workflow_version_id=? AND goal_id IS NOT NULL LIMIT 201').all(flowId, versionId);
      for (const link of this.boundedRows(links)) add('goal', 'goal', link.goal_id,
        r ? 'Recorded work-item goal; execution does not verify progress.' : 'Configured work-item goal.',
        this.db.query('SELECT id FROM goals WHERE id=?').get(link.goal_id) ? 'available' : 'missing');
      if (!r && this.db.query("SELECT 1 FROM sqlite_master WHERE name='prepared_opportunities'").get()) {
        const specs = this.boundedRows(this.db.query<{ specification: string }, [string, string]>(
          'SELECT substr(specification,1,65537) AS specification FROM prepared_opportunities WHERE flow_id=? AND version_id=? LIMIT 201').all(flowId, versionId));
        for (const row of specs) {
          if (row.specification.length > 65536) throw new WorkflowInspectionError('context_capacity', 413);
          const spec = boundedJson(row.specification);
          if (!object(spec)) continue;
          if (object(spec.goal)) add('goal', 'goal', spec.goal.goalId, 'Configured prepared-workflow goal; execution does not verify progress.',
            inspectionId(spec.goal.goalId) && this.db.query('SELECT id FROM goals WHERE id=?').get(spec.goal.goalId) ? 'available' : 'missing');
          if (Array.isArray(spec.evidence)) for (const ref of this.boundedRows(spec.evidence)) {
            if (object(ref) && ref.kind === 'fact' && inspectionId(ref.id)) add('memory', 'fact', ref.id,
              'Configured preparation evidence; usage by a run is not implied.', this.factAvailability(ref.id));
          }
        }
      }
      if (r) {
        const memories = this.db.query<{ fact_id: string; stage: string; forgotten: number; present: number }, [string, string]>(`SELECT u.fact_id,u.stage,
          EXISTS(SELECT 1 FROM memory_forget_receipts f WHERE f.fact_id=u.fact_id) AS forgotten,
          EXISTS(SELECT 1 FROM facts f WHERE f.id=u.fact_id) AS present
          FROM memory_use_events u WHERE run_id=? AND workflow_id=? AND stage IN ('supplied','outcome_verified')
          ORDER BY recorded_at, use_id LIMIT 201`).all(r.id, flowId);
        for (const m of this.boundedRows(memories)) add('memory', 'fact', m.fact_id,
          'Recorded provider handoff; retained events only, not proof of model reliance.', m.forgotten ? 'removed' : m.present ? 'available' : 'missing');
      }
    }
    if (!r && nodes) {
      const connections = boundedJson(v!.connection_ids);
      if (Array.isArray(connections)) for (const id of this.boundedRows(connections)) this.connection(add, id);
      for (const n of nodes) {
        const settings = object(n.settings) ? n.settings : {}, input = object(settings.input) ? settings.input : {};
        if (n.type === 'ROUTER' || n.type === 'CODE') add('rules', 'step', n.name,
          n.type === 'CODE' ? 'Configured code step; code content is redacted. Permission remains governed by the existing workflow API.' : 'Configured routing rule.');
        if (this.projectId === DEFAULT_IDS.project && inspectionId(input.factId)) add('memory', 'fact', input.factId,
          'Explicit configured fact reference; usage is not implied.', this.factAvailability(input.factId));
        const target = input.sidecarId ?? input.target;
        const knownTarget = inspectionId(target) && this.projectId === DEFAULT_IDS.project && this.db.query('SELECT id FROM sidecars WHERE id=?').get(target);
        add('target', 'device', target, knownTarget ? 'Explicit configured target; current connection is not asserted.' : 'Configured target is missing or inaccessible.', knownTarget ? 'stale' : 'missing');
        const auth = input.auth;
        if (typeof auth === 'string') {
          const match = /^\{\{connections\.([A-Za-z0-9_:.-]{1,200})\}\}$/.exec(auth)
            ?? /^\{\{connections\['([A-Za-z0-9_:.-]{1,200})'\]\}\}$/.exec(auth);
          if (match) this.connection(add, match[1]);
          else rows.bindings.push({ id: `restricted-${n.name}`, label: 'Restricted source', value: 'Redacted', availability: 'redacted', source: null });
        }
      }
    }
    if (r) {
      const binding = this.db.query<{ record: string }, [string]>('SELECT substr(record,1,4000001) AS record FROM workflow_run_machine_binding WHERE run_id=?').get(r.id);
      const b = binding ? boundedJson(binding.record) : null;
      if (object(b) && b.runId === r.id) {
        if (b.sidecarId === null) add('target', 'device', 'local-host', 'Recorded local execution host.');
        else add('target', 'device', b.sidecarId, 'Recorded execution target; current connection is not asserted.');
      }
      for (const effect of this.effects(r)) {
        if (inspectionId(effect.approvalId)) add('rules', 'rule', effect.approvalId, 'Recorded approval reference; approval is not a verified result.');
        if (object(effect.target)) add('target', 'device', effect.target.sidecarId, 'Target recorded by the effect receipt.');
      }
    }
    const projected = {} as InspectionContext['groups'];
    for (const group of groups) {
      // Include restricted entries as well as typed references in the group cap.
      if (rows[group].length > LIMIT.rows) throw new WorkflowInspectionError('context_capacity', 413);
      projected[group] = rows[group].length ? ready(rows[group])
        : missing(r ? 'No retained evidence recorded for this context group; current configuration was not substituted.'
        : !nodes ? 'Immutable configured context is unavailable.' : 'No explicit configured reference is available.');
    }
    return { scopeId: this.projectId, flowId, versionId, basis: r ? 'recorded' : 'configured', runId: r?.id ?? null,
      runLabel: r ? `Run ${r.id}` : null, asOf: r?.updated ?? v?.updated ?? null, groups: projected };
  }
  private factAvailability(id: string): InspectionContextEntry['availability'] {
    if (this.db.query('SELECT 1 FROM memory_forget_receipts WHERE fact_id=?').get(id)) return 'removed';
    return this.db.query('SELECT id FROM facts WHERE id=?').get(id) ? 'available' : 'missing';
  }
  private connection(add: (g: ContextGroup, k: 'connection', id: unknown, text: string, availability?: InspectionContextEntry['availability']) => void, id: unknown) {
    if (!referenceId(id)) return;
    if (['jarvis:google', 'jarvis:telegram'].includes(id)) { add('bindings', 'connection', id, 'Configured native service reference; credential availability is not asserted.', 'stale'); return; }
    const row = this.db.query<{ id: string }, [string, string, string]>('SELECT id FROM app_connection WHERE project_id=? AND (id=? OR external_id=?) LIMIT 1').get(this.projectId, id, id);
    add('bindings', 'connection', row?.id ?? id, row ? 'Configured connection reference; no credentials included.' : 'Connection is missing or inaccessible.', row ? 'available' : 'missing');
  }
  private effects(r: RunRow): Record<string, unknown>[] {
    const budget = this.db.query<{ n: number; bytes: number }, [string]>('SELECT count(*) AS n, coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM workflow_effect WHERE run_id=?').get(r.id)!;
    if (budget.n > LIMIT.rows || budget.bytes > LIMIT.sourceBytes) throw new WorkflowInspectionError('inspection_capacity', 413);
    const rows = this.boundedRows(this.db.query<{ record: string }, [string]>(
      'SELECT substr(record,1,4000001) AS record FROM workflow_effect WHERE run_id=? ORDER BY rowid LIMIT 201').all(r.id));
    return rows.map(row => {
      const e = boundedJson(row.record);
      if (!object(e) || e.runId !== r.id || e.flowId !== r.flow_id || e.versionId !== r.flow_version_id || e.projectId !== this.projectId)
        throw new WorkflowInspectionError('receipt_identity_unavailable', 503);
      return e;
    });
  }
  private detailRow(r: RunRow, nodes: Record<string, unknown>[] | null, context: InspectionContext): InspectionRunDetail {
    const row = this.db.query<{ steps: string | null }, [string]>('SELECT substr(steps,1,4000001) AS steps FROM flow_run WHERE id=?').get(r.id)!;
    const steps = boundedJson(row.steps), entries: Array<[string, unknown, string]> = [];
    if (steps !== undefined && !object(steps)) throw new WorkflowInspectionError('record_unavailable', 503);
    const pending: Array<{ path: string; label: string; value: unknown }> = [{ path: '', label: '', value: steps }];
    while (pending.length) {
      const part = pending.pop()!;
      if (!object(part.value)) continue;
      for (const [name, raw] of Object.entries(part.value)) {
        // DefaultWorkerHandlers persists { output: StepOutput }. Loop children
        // and legacy writers can already contain StepOutput directly. Unwrap
        // only the storage envelope, never an existing step's application output.
        const step = object(raw) && Object.keys(raw).length === 1 && object(raw.output)
          && typeof raw.output.type === 'string' && typeof raw.output.status === 'string' ? raw.output : raw;
        const path = opaque(JSON.stringify([part.path, name]));
        const label = (part.label + safeName(name, 'unknown')).slice(0, 450);
        entries.push([label, step, path]); this.boundedRows(entries);
        if (object(step) && step.type === 'LOOP_ON_ITEMS' && object(step.output) && Array.isArray(step.output.iterations)) {
          if (step.output.iterations.length + pending.length > LIMIT.rows) throw new WorkflowInspectionError('inspection_capacity', 413);
          step.output.iterations.forEach((value, i) => pending.push({ path: opaque(JSON.stringify([path, i])), label: label + `-iteration-${i + 1}-`, value }));
        }
      }
    }
    const effects = this.effects(r).map((e, i) => ({ id: safeName(e.id, `receipt-${i}`), label: `Effect receipt ${i + 1}`,
      status: ['pending','dispatching','succeeded','failed','blocked','unknown'].includes(String(e.status)) ? e.status as InspectionRunDetail['effects'][number]['status'] : 'unknown' as const,
      description: 'Recorded effect status. Arguments, results and free text use conservative redaction.',
      fields: [inspectionValue('Arguments', e.arguments), inspectionValue('Result', e.result), inspectionValue('Outcome', e.outcome)] }));
    const waits = this.boundedRows(this.db.query<{ rowid: number; step_name: string; type: string; resumed_at: number | null }, [string, string]>(
      'SELECT rowid,step_name,type,resumed_at FROM waitpoint WHERE flow_run_id=? AND project_id=? ORDER BY rowid LIMIT 201').all(r.id, this.projectId))
      // Never expose the bearer waitpoint ID, even for authenticated inspection.
      .map((w) => ({ id: `wait-${w.rowid}`, stepName: safeName(w.step_name, 'unknown-step'), label: 'Recorded wait', status: w.resumed_at === null ? 'waiting' as const : 'resolved' as const }));
    const used = groups.flatMap(group => { const state = context.groups[group]; return state.status !== 'ready' ? [] : state.data.map(e => ({
      kind: kinds[group], id: e.source?.id ?? e.id, label: e.label,
      availability: e.availability === 'available' ? 'available' as const : e.availability === 'removed' || e.availability === 'missing' ? 'removed' as const : 'redacted' as const })); });
    return { ...this.summary(r), summary: 'Recorded execution evidence; success alone does not verify goal progress.',
      trigger: null, finishedAt: r.finish_time,
      steps: entries.map(([name, raw, path]) => { const s = object(raw) ? raw : {};
        return { id: `step-${path}`, title: `Step ${name}`, description: 'Recorded step input and output.',
          status: typeof s.status === 'string' ? status(s.status) : 'uncertain',
          fields: [inspectionValue('Input', s.input), inspectionValue('Output', s.output)] }; }),
      effects, waits, context: used,
      inspection: { status: 'partial', note: `Text values and field names are redacted. Context covers retained records only.${nodes ? '' : ' Immutable historical graph unavailable.'}${steps == null ? ' Step data was not recorded.' : ''}` } };
  }
  request(flowId: string, requestId: string): ManualInspectionRunResult {
    this.assertReady();
    if (!inspectionId(flowId) || !inspectionId(requestId)) throw new WorkflowInspectionError('invalid_identity');
    // The accepted receipt owns its scope even after a hard deletion removes
    // the flow and run. A read must neither lose that outcome nor enqueue work.
    const row = this.db.query<{ result: string }, [string, string, string]>(
      'SELECT result FROM brief_manual_run_requests WHERE project_id=? AND request_id=? AND flow_id=?').get(this.projectId, requestId, flowId);
    if (!row) throw new WorkflowInspectionError('not_found', 404);
    return JSON.parse(row.result);
  }
  start(flowId: string, raw: unknown): ManualInspectionRunResult {
    this.flow(flowId);
    if (!object(raw) || Object.keys(raw).some(k => !['brief', 'payload'].includes(k)) || !object(raw.brief)
      || Object.keys(raw.brief).some(k => !['requestId','scopeId','versionId'].includes(k))
      || !inspectionId(raw.brief.requestId) || !inspectionId(raw.brief.versionId) || raw.brief.scopeId !== this.projectId)
      throw new WorkflowInspectionError('invalid_manual_request');
    const { requestId, versionId } = raw.brief, payload = canonicalManualPayload(raw.payload);
    const digest = opaque(JSON.stringify([this.projectId, flowId, versionId, payload]));
    return this.db.transaction(() => {
      this.flow(flowId);
      const prior = this.db.query<{ digest: string; result: string }, [string, string]>(
        'SELECT digest,result FROM brief_manual_run_requests WHERE project_id=? AND request_id=?').get(this.projectId, requestId);
      if (prior) {
        if (prior.digest !== digest) throw new WorkflowInspectionError('request_conflict', 409);
        return JSON.parse(prior.result) as ManualInspectionRunResult;
      }
      const count = this.db.query<{ n: number }, []>('SELECT count(*) AS n FROM brief_manual_run_requests').get()!.n;
      if (count >= LIMIT.requests) throw new WorkflowInspectionError('request_capacity', 503);
      const version = this.version(flowId, versionId);
      if (!version || version.state !== 'LOCKED') throw new WorkflowInspectionError('immutable_version_required', 409);
      assertCodeStepsAllowed(flowId, versionId, 'run');
      assertVersionReady(flowId, versionId);
      const run = createFlowRun({ flowId, flowVersionId: versionId,
        environment: 'PRODUCTION', triggeredBy: 'brief_manual', startTime: Date.now() });
      enqueue({ jobType: 'RUN_FLOW', payload: { runId: run.id, payload: JSON.parse(payload) },
        flowRunId: run.id, flowId, flowVersionId: versionId, maxAttempts: 1 });
      const result: ManualInspectionRunResult = { status: 'accepted', requestId, run: this.summary(this.run(flowId, run.id)) };
      this.db.run('INSERT INTO brief_manual_run_requests VALUES (?,?,?,?,?,?)',
        [this.projectId, requestId, flowId, digest, JSON.stringify(result), Date.now()]);
      return result;
    }).immediate();
  }
}
