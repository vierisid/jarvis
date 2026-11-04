import { getWorkflowDb } from '../db';
import { getFlowRun } from '../db/repos/flow-run';
import { getFlowVersion } from '../db/repos/flow-version';
import { createWaitpoint, getWaitpoint } from '../db/repos/waitpoint';
import { stopTurnedOffRun, turnedOffReason } from '../db/repos/flow-turn-off';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import { assertRunNotCanceled } from './cancellation';
import { claimContinuation } from './continuation';
import { emergencyHold } from './emergency-hold';
import { HUMAN_INPUT_PIECE, answerErrors, formFields, type HumanRequest } from './human-input-contract';

type Row = { id: string; project_id: string; flow_id: string; fingerprint: string; record: string; status: HumanRequest['status']; deadline: number };
const row = (id: string) => getWorkflowDb().query<Row, [string]>('SELECT * FROM workflow_human_request WHERE id=?').get(id);
const unpack = (r: Row): HumanRequest => ({ ...JSON.parse(r.record), status: r.status });
function save(request: HumanRequest) {
  getWorkflowDb().run('UPDATE workflow_human_request SET status=?,record=? WHERE id=?', [request.status, JSON.stringify(request), request.id]);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name} is required (maximum ${max} characters)`);
  return value;
}
/** Only the actual pinned input/approval step may create or consume a request. */
export async function requestHumanInput(input: Record<string, unknown>, ctx: WorkflowEffectContext, now = Date.now()) {
  const run = getFlowRun(ctx.runId), version = run && getFlowVersion(run.flowVersionId);
  const node = version && walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName);
  const piece = node?.settings?.pieceName, action = node?.settings?.actionName;
  const legacy = piece === '@activepieces/piece-approval';
  if (!(piece === HUMAN_INPUT_PIECE && ['request_input', 'request_approval'].includes(String(action)))
    && !(legacy && ['create_approval_links', 'wait_for_approval'].includes(String(action)))) throw Error('Not a human input step');
  const resolved = resolveEffectContext(ctx, String(piece), String(action));
  assertRunNotCanceled(ctx.runId);
  if (turnedOffReason(ctx.runId)) throw Error('Workflow was turned off');
  const kind = action === 'request_input' ? 'input' : 'approval';
  const linksOnly = legacy && action === 'create_approval_links';
  const config = {
    kind, title: text(input.title ?? (legacy ? 'Approve workflow step' : undefined), 'Title', 200),
    prompt: text((legacy && input.prompt === '' ? undefined : input.prompt) ?? (legacy ? `Review ${resolved.version.displayName}: ${node?.displayName ?? ctx.stepName}` : undefined), 'Question', 10000),
    fields: kind === 'input' ? formFields(input.fields) : [],
    requestKey: text(input.requestKey ?? (legacy ? `${ctx.runId}:${ctx.stepName}` : undefined), 'Stable occurrence key', 500),
    timeoutHours: input.timeoutHours ?? 48,
    // A request belongs to one run: its own retries reuse it, a later run asks
    // again. Only a form step that opts in shares one answer across runs with
    // the same key (a duplicate trigger for the same occurrence). Approvals never do.
    shared: kind === 'input' && input.shareAcrossRuns === true,
  };
  if (typeof config.timeoutHours !== 'number' || !Number.isFinite(config.timeoutHours) || config.timeoutHours <= 0 || config.timeoutHours > 720) throw Error('Response deadline must be between 0 and 720 hours');
  const timeoutHours = config.timeoutHours;
  const db = getWorkflowDb(), pathKey = JSON.stringify(ctx.executionPath ?? []);
  return db.transaction(() => {
    let id = digest(['human-input-v1', ctx.projectId, run!.flowId, ctx.stepName, ctx.executionPath, config.requestKey, config.shared ? 'shared' : ctx.runId]);
    let existing = row(id);
    let linkedApproval = false;
    // Legacy links may be created before the waiting action. They only open the
    // authenticated form; neither link is a bearer approval or performs a GET mutation.
    // Both lookups stay inside this loop iteration (execution path): a decision
    // given for one iteration never answers the next.
    if (legacy && action === 'wait_for_approval') {
      const candidates = db.query<Row, [string, string, string, string]>(`SELECT h.* FROM workflow_human_request h
        WHERE project_id=? AND flow_id=? AND json_extract(record,'$.runId')=? AND json_extract(record,'$.pathKey')=?
        AND NOT EXISTS (SELECT 1 FROM workflow_human_wait w WHERE w.request_id=h.id)`).all(ctx.projectId, run!.flowId, ctx.runId, pathKey);
      const bound = db.query<Row, [string, string, string]>(`SELECT h.* FROM workflow_human_request h JOIN workflow_human_wait w ON w.request_id=h.id JOIN waitpoint p ON p.id=w.waitpoint_id
        WHERE w.run_id=? AND p.step_name=? AND json_extract(h.record,'$.pathKey')=? ORDER BY p.created DESC LIMIT 1`).get(ctx.runId, ctx.stepName!, pathKey);
      const linked = bound ?? (typeof input.requestId === 'string' && input.requestId ? row(input.requestId) : candidates.length === 1 ? candidates[0] : null);
      if (!bound && !input.requestId && candidates.length > 1) throw Error('Choose the approval request ID returned by Create Approval Links');
      if (linked) {
        const value = unpack(linked);
        if (linked.project_id !== ctx.projectId || linked.flow_id !== run!.flowId || value.runId !== ctx.runId || value.kind !== 'approval') throw Error('Approval request does not belong to this run');
        id = linked.id; existing = linked; linkedApproval = true;
      } else if (input.requestId) throw Error('Approval request not found');
    }
    const fingerprint = digest({ config, graph: resolved.versionDigest });
    if (existing && JSON.parse(existing.record).graphDigest !== resolved.versionDigest) throw Error('Workflow graph changed since this request was created');
    if (existing && existing.fingerprint !== fingerprint && !linkedApproval) throw Error('Occurrence key already used with different input configuration');
    // A shared form that expired or was cancelled before this run asked is asked
    // again for this run; a run that already waited on it keeps that outcome.
    const reopen = !!existing && config.shared && ['expired', 'cancelled'].includes(existing.status)
      && !db.query('SELECT 1 FROM workflow_human_wait WHERE request_id=? AND run_id=?').get(id, ctx.runId);
    if (!existing || reopen) {
      const pending = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM workflow_human_request WHERE flow_id=? AND status='pending'").get(run!.flowId)!.count;
      if (pending >= 20) throw Error('This workflow already has 20 unanswered requests. Respond or cancel them before creating more.');
      const request: HumanRequest = { id, ...config, kind, workflowName: resolved.version.displayName, flowId: run!.flowId,
        runId: ctx.runId, created: now, deadline: now + timeoutHours * 3600000, status: 'pending', answers: null };
      db.run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,record=excluded.record,deadline=excluded.deadline,status=excluded.status`,
        [id, ctx.projectId, run!.flowId, fingerprint, JSON.stringify({ ...request, graphDigest: resolved.versionDigest, pathKey }), request.deadline, request.status]);
      existing = row(id)!;
    }
    const request = unpack(existing);
    if (request.status === 'pending' && now >= request.deadline) { request.status = 'expired'; save(request); }
    if (linksOnly) return { requestId: id, approvalLink: `/?brief=1#/brief/needs-you?inputId=${id}`, disapprovalLink: `/?brief=1#/brief/needs-you?inputId=${id}` };
    // The legacy Wait for Approval kept its old contract: it never failed the
    // run, it returned `{ approved }` and let the flow branch on it.
    if (request.status !== 'pending' && legacy) return { approved: request.status === 'approved' };
    if (request.status !== 'pending') {
      // No denied/expired request can accidentally fall through into a write.
      if (request.status !== 'submitted' && request.status !== 'approved') throw Error(`Human request ${request.status}`);
      return { requestId: id, status: request.status, approved: request.status === 'approved', answers: request.answers ?? {} };
    }
    const prior = db.query<{ waitpoint_id: string }, [string, string, string]>(`SELECT w.waitpoint_id FROM workflow_human_wait w JOIN waitpoint p ON p.id=w.waitpoint_id
      WHERE w.request_id=? AND w.run_id=? AND p.step_name=? AND p.resumed_at IS NULL`).get(id, ctx.runId, ctx.stepName!);
    const waitpointId = prior?.waitpoint_id ?? createWaitpoint({ flowRunId: ctx.runId, projectId: ctx.projectId, stepName: ctx.stepName!, type: 'MANUAL' }).id;
    db.run('INSERT OR IGNORE INTO workflow_human_wait (request_id,run_id,waitpoint_id) VALUES (?,?,?)', [id, ctx.runId, waitpointId]);
    return { requestId: id, waitpointId };
  }).immediate();
}

/** Persistent terminal results and pending requests are scoped to the signed-in workspace. */
export function listHumanInputs(projectId: string, now = Date.now()): HumanRequest[] {
  expireHumanInputs(now);
  return getWorkflowDb().query<Row, [string, string]>(`SELECT * FROM workflow_human_request WHERE project_id=? AND (status='pending' OR id IN
    (SELECT id FROM workflow_human_request WHERE project_id=? AND status!='pending' ORDER BY deadline DESC LIMIT 20)) ORDER BY deadline,id`).all(projectId, projectId).map(record => withRunOutcomes(unpack(record)));
}
export function resolveHumanInput(projectId: string, id: string, input: Record<string, unknown>, now = Date.now()) {
  expireHumanInputs(now);
  const db = getWorkflowDb();
  const result = db.transaction(() => {
    const record = row(id);
    if (!record || record.project_id !== projectId) return { status: 404, error: 'Request not found' };
    withdrawChangedRequest(record);
    const request = unpack(row(id)!);
    const decision = input.decision;
    const status = decision === 'submit' && request.kind === 'input' ? 'submitted'
      : decision === 'approve' && request.kind === 'approval' ? 'approved'
      : decision === 'reject' && request.kind === 'approval' ? 'rejected' : decision === 'cancel' ? 'cancelled' : null;
    if (!status) return { status: 400, error: 'Invalid response for this request' };
    const answers = status === 'submitted' ? input.answers : null;
    if (request.status !== 'pending') {
      if (request.status === status && digest(request.answers) === digest(answers)) return { status: 200, request };
      return { status: 409, error: `This request is ${request.status}`, request };
    }
    const errors = status === 'submitted' ? answerErrors(request.fields, answers) : {};
    if (Object.keys(errors).length) return { status: 422, error: 'Check the highlighted answers', errors };
    request.status = status; request.answers = answers as Record<string, unknown> | null; save(request);
    return { status: 200, request };
  }).immediate();
  resumeHumanInputs(now);
  return result;
}
/** A run that can still be continued: not finished and not stopped by turning its workflow off. */
const LIVE_RUN = `SELECT 1 FROM flow_run r JOIN flow f ON f.id=r.flow_id WHERE r.status IN ('RUNNING','PAUSED','QUEUED')
  AND NOT (f.disabled_at IS NOT NULL AND r.created <= f.disabled_at)`;
/**
 * Close what can no longer be answered. Reads only through the pending index and
 * writes only rows that change, so the dashboard's polling stays cheap. A request
 * is cancelled only when no run that asked it (its own run, or any run waiting on
 * a shared form) can still continue: stopping one run never closes another's.
 */
function expireHumanInputs(now: number) {
  const db = getWorkflowDb();
  const closing = db.query<Row & { next: 'expired' | 'cancelled' }, [number]>(`SELECT h.*, CASE WHEN NOT EXISTS (${LIVE_RUN}
      AND (r.id=json_extract(h.record,'$.runId') OR r.id IN (SELECT w.run_id FROM workflow_human_wait w WHERE w.request_id=h.id)))
    THEN 'cancelled' WHEN h.deadline <= ?1 THEN 'expired' END AS next
    FROM workflow_human_request h WHERE h.status='pending' AND next IS NOT NULL`).all(now);
  for (const record of closing) save({ ...unpack(record), status: record.next });
  for (const record of db.query<Row, []>("SELECT * FROM workflow_human_request WHERE status='pending'").all()) withdrawChangedRequest(record);
}
/** Durable polling also covers a response received before the worker parks. */
export function resumeHumanInputs(now = Date.now()): number {
  expireHumanInputs(now);
  if (emergencyHold()) return 0;
  let count = 0;
  const db = getWorkflowDb();
  const waits = db.query<{ run_id: string; waitpoint_id: string }, []>(`SELECT w.run_id,w.waitpoint_id FROM workflow_human_wait w
    JOIN workflow_human_request h ON h.id=w.request_id JOIN waitpoint p ON p.id=w.waitpoint_id
    WHERE h.status!='pending' AND p.resumed_at IS NULL`).all();
  for (const w of waits) {
    const run = getFlowRun(w.run_id);
    if (run?.status !== 'PAUSED') continue;
    if (turnedOffReason(run.id)) { stopTurnedOffRun(run.flowId, run.id); continue; }
    if (db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(run.id)) continue;
    const waitpoint = getWaitpoint(w.waitpoint_id);
    if (waitpoint && claimContinuation({ runId: run.id, waitpoint, kind: 'approval', resumePayload: {}, now }) === 'resumed') count++;
  }
  return count;
}

/** Derive current run state without exposing step outputs or error arguments. */
function withRunOutcomes(request: HumanRequest): HumanRequest {
  const rows = getWorkflowDb().query<{ id: string; flow_version_id: string; status: string }, [string, string]>(`
    SELECT DISTINCT r.id,r.flow_version_id,r.status FROM flow_run r
    WHERE r.id=? OR r.id IN (SELECT run_id FROM workflow_human_wait WHERE request_id=?)
    ORDER BY r.created,r.id`).all(request.runId, request.id);
  return { ...request, runs: rows.length ? rows.map(r => ({ runId: r.id, versionId: r.flow_version_id, status: r.status }))
    : [{ runId: request.runId, versionId: '', status: 'UNAVAILABLE' }] };
}
/** A stale draft cannot consume an answer the worker will refuse to resume. */
function withdrawChangedRequest(record: Row): void {
  if (record.status !== 'pending') return;
  const request = unpack(record), graph = JSON.parse(record.record).graphDigest;
  const live = getWorkflowDb().query<{ flow_version_id: string }, [string, string]>(`
    SELECT r.flow_version_id FROM flow_run r JOIN flow f ON f.id=r.flow_id
    WHERE r.status IN ('RUNNING','PAUSED','QUEUED')
    AND NOT (f.disabled_at IS NOT NULL AND r.created <= f.disabled_at)
    AND (r.id=? OR r.id IN (SELECT run_id FROM workflow_human_wait WHERE request_id=?))`).all(request.runId, request.id);
  if (live.length && live.every(r => {
    const version = getFlowVersion(r.flow_version_id);
    return !version || digest(version.trigger) !== graph;
  })) save({ ...request, status: 'cancelled', closureReason: 'workflow_changed' });
}
