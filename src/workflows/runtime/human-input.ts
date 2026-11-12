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
import { ActionOutcomeError } from '../../actions/action-outcome';
import { HUMAN_INPUT_LIMIT_CODE, HUMAN_INPUT_REJECTED_CODE, HUMAN_INPUT_PENDING_LIMIT, HUMAN_INPUT_PIECE, HUMAN_INPUT_UNAVAILABLE_CODE, answerErrors, isHumanInputStep, formFields, humanRequestDismissable, type HumanRequest } from './human-input-contract';

type Row = { id: string; project_id: string; flow_id: string; fingerprint: string; record: string; status: HumanRequest['status']; deadline: number; closed_at: number | null };
const row = (id: string) => getWorkflowDb().query<Row, [string]>('SELECT * FROM workflow_human_request WHERE id=?').get(id);
const unpack = (r: Row): HumanRequest => {
  const { closedAt: _stored, ...record } = JSON.parse(r.record);
  return { ...record, status: r.status, ...(r.closed_at === null ? {} : { closedAt: r.closed_at }) };
};
/** Instance of a request: a shared form reopened after it closed counts up. */
const generationOf = (request: { generation?: number }) => request.generation ?? 0;
/** Old clients may answer an original request, never a reopened instance. */
function matchesGeneration(request: HumanRequest, expected: unknown): boolean {
  return expected === generationOf(request) || (expected === undefined && generationOf(request) === 0);
}
const staleResponse = (request: HumanRequest) => ({ status: 409,
  error: 'This request was reopened. Your response belongs to an earlier request and was not accepted. Review the current request.', request });
/** SQL: the current instance of request row `h` (records from before generations are 0). */
const CURRENT_GENERATION = `COALESCE(json_extract(h.record,'$.generation'),0)`;
/**
 * Closed requests: closed_at is NULL exactly while a request is pending (a reopen
 * clears it). Stated this way, idx_human_closed (project_id,closed_at,id) returns
 * the Recent list and each history page in order, without sorting the history.
 */
const CLOSED = `closed_at IS NOT NULL`;
const HISTORY_PAGE = 20;
/**
 * Close time is stamped only on the pending -> closed transition, in SQL from
 * the row's stored status, so a later write to a closed row (a dismissal, or a
 * legacy row from before the column) never moves it. Expiry closes at the deadline.
 */
function save(request: HumanRequest, now: number) {
  const { closedAt: _closedAt, ...stored } = request;
  getWorkflowDb().run(`UPDATE workflow_human_request SET status=?1,record=?2,
    closed_at=CASE WHEN status='pending' AND ?1!='pending' THEN (CASE WHEN ?1='expired' THEN MIN(deadline,?3) ELSE ?3 END) ELSE closed_at END
    WHERE id=?4`, [request.status, JSON.stringify(stored), now, request.id]);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name} is required (maximum ${max} characters)`);
  return value;
}
/**
 * Only the actual pinned input/approval step may create or consume a request.
 * `unavailable` is why nothing on this Jarvis could answer a new request
 * (Needs you is off, #1266): a step that would create one is refused, typed.
 * A request that already exists is still read, so an answered one is used.
 */
export async function requestHumanInput(input: Record<string, unknown>, ctx: WorkflowEffectContext, now = Date.now(),
  opts: { unavailable?: string | null } = {}) {
  const run = getFlowRun(ctx.runId), version = run && getFlowVersion(run.flowVersionId);
  const node = version && walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName);
  const piece = node?.settings?.pieceName, action = node?.settings?.actionName;
  const legacy = piece === '@activepieces/piece-approval';
  if (!isHumanInputStep(piece, action)) throw Error('Not a human input step');
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
      } else if (input.requestId) throw Error('Approval request not found. The request ID must come from a "Create approval links" step in this run.');
    }
    const fingerprint = digest({ config, graph: resolved.versionDigest });
    if (existing && JSON.parse(existing.record).graphDigest !== resolved.versionDigest) throw Error('Workflow graph changed since this request was created');
    if (existing && existing.fingerprint !== fingerprint && !linkedApproval) throw Error('Occurrence key already used with different input configuration');
    // A shared form that expired or was cancelled before this run asked is asked
    // again for this run; a run that already waited on it keeps that outcome.
    const reopen = !!existing && config.shared && ['expired', 'cancelled'].includes(existing.status)
      && !db.query('SELECT 1 FROM workflow_human_wait WHERE request_id=? AND run_id=?').get(id, ctx.runId);
    if (!existing || reopen) {
      // A reopened form is a new instance: earlier waits keep the outcome they had.
      const previous = existing ? unpack(existing) : null;
      const instance = previous ? { generation: generationOf(previous) + 1, reopenedFrom: previous.status } : {};
      // Typed refusals, so the failed run reads as what it is (run-failure.ts), not as an internal error to run again.
      if (opts.unavailable) throw new ActionOutcomeError({ status: 'blocked', code: HUMAN_INPUT_UNAVAILABLE_CODE, effect: 'not_started', message: opts.unavailable });
      // Only requests someone can still answer count: not one past its
      // deadline or whose runs all ended, which the next sweep closes.
      const pending = db.query<{ count: number }, [string, number]>(`SELECT COUNT(*) AS count FROM workflow_human_request h
        WHERE h.flow_id=? AND h.status='pending' AND h.deadline > ? AND EXISTS (${LIVE_RUN} AND ${INSTANCE_RUN})`).get(run!.flowId, now)!.count;
      if (pending >= HUMAN_INPUT_PENDING_LIMIT) throw new ActionOutcomeError({ status: 'blocked', code: HUMAN_INPUT_LIMIT_CODE, effect: 'not_started',
        message: `This workflow already has ${pending} requests waiting for an answer in Needs you (the limit is ${HUMAN_INPUT_PENDING_LIMIT}). Answer, reject or cancel some of them in Needs you, or stop runs that are waiting on them, then run it again.` });
      const request: HumanRequest = { id, ...config, kind, workflowName: resolved.version.displayName, flowId: run!.flowId,
        runId: ctx.runId, created: now, deadline: now + timeoutHours * 3600000, status: 'pending', answers: null, ...instance };
      db.run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,record=excluded.record,deadline=excluded.deadline,status=excluded.status,closed_at=NULL`,
        [id, ctx.projectId, run!.flowId, fingerprint, JSON.stringify({ ...request, graphDigest: resolved.versionDigest, pathKey }), request.deadline, request.status]);
      existing = row(id)!;
    }
    const request = unpack(existing);
    // This run waited on an earlier instance that closed before it resumed (for
    // example under an emergency hold): it keeps that outcome, never the new answer.
    const earlier = db.query('SELECT 1 FROM workflow_human_wait WHERE request_id=? AND run_id=? AND generation<?').get(id, ctx.runId, generationOf(request));
    if (earlier && !db.query('SELECT 1 FROM workflow_human_wait WHERE request_id=? AND run_id=? AND generation=?').get(id, ctx.runId, generationOf(request)))
      throw Error(`Human request ${request.reopenedFrom ?? 'expired'}`);
    if (request.status === 'pending' && now >= request.deadline) { request.status = 'expired'; save(request, now); }
    if (linksOnly) return { requestId: id, approvalLink: `/?brief=1#/brief/needs-you?inputId=${id}`, disapprovalLink: `/?brief=1#/brief/needs-you?inputId=${id}` };
    // Wait for Approval stops the run when the approval is not given (rejected,
    // cancelled or expired), like the input piece's approval: nothing after a
    // refusal may run unless the author opted in. `continueOnReject` keeps the
    // old contract: the step returns `{ approved: false }` and the flow branches on it.
    // The opt-in is read from the pinned version as the author saved it (a ticked
    // box is literally `true`), never from the resolved input: an expression that
    // trigger data or an earlier step sets, or the request body, cannot turn a
    // refusal into a continue.
    if (request.status !== 'pending' && legacy) {
      const continueOnReject = node?.settings?.input?.continueOnReject === true;
      if (request.status === 'approved' || continueOnReject) return { approved: request.status === 'approved' };
      const expired = request.status === 'expired';
      throw new ActionOutcomeError({ status: 'blocked', code: expired ? 'APPROVAL_EXPIRED' : 'APPROVAL_DENIED', effect: 'not_started',
        message: expired ? 'The approval was not answered in time, so the workflow stopped at this step.'
          : `The approval was ${request.status === 'cancelled' ? 'cancelled' : 'rejected'} in Needs you, so the workflow stopped at this step.` });
    }
    if (request.status !== 'pending') {
      // No denied/expired request can accidentally fall through into a write.
      if (request.status === 'rejected') throw new ActionOutcomeError({ status: 'blocked', code: HUMAN_INPUT_REJECTED_CODE, effect: 'not_started', message: 'Human request rejected' });
      if (request.status !== 'submitted' && request.status !== 'approved') throw Error(`Human request ${request.status}`);
      return { requestId: id, status: request.status, approved: request.status === 'approved', answers: request.answers ?? {} };
    }
    const prior = db.query<{ waitpoint_id: string }, [string, string, string, number]>(`SELECT w.waitpoint_id FROM workflow_human_wait w JOIN waitpoint p ON p.id=w.waitpoint_id
      WHERE w.request_id=? AND w.run_id=? AND p.step_name=? AND p.resumed_at IS NULL AND w.generation=?`).get(id, ctx.runId, ctx.stepName!, generationOf(request));
    const waitpointId = prior?.waitpoint_id ?? createWaitpoint({ flowRunId: ctx.runId, projectId: ctx.projectId, stepName: ctx.stepName!, type: 'MANUAL' }).id;
    db.run('INSERT OR IGNORE INTO workflow_human_wait (request_id,run_id,waitpoint_id,generation) VALUES (?,?,?,?)', [id, ctx.runId, waitpointId, generationOf(request)]);
    return { requestId: id, waitpointId };
  }).immediate();
}

/** Runs of the current instance of request row `h`: the one that created it and any that waited on it. */
const INSTANCE_RUN = `(r.id=json_extract(h.record,'$.runId') OR r.id IN (SELECT w.run_id FROM workflow_human_wait w
  WHERE w.request_id=h.id AND w.generation=${CURRENT_GENERATION}))`;
/**
 * Closed requests whose outcome still needs the user until dismissed (see
 * humanRequestNeedsAttention): they stay listed however many requests close later.
 */
const UNDISMISSED_OUTCOME = `h.status IN ('submitted','approved','cancelled') AND json_extract(h.record,'$.dismissedAt') IS NULL
  AND (json_extract(h.record,'$.closureReason')='workflow_changed' OR (h.status!='cancelled' AND (
    NOT EXISTS (SELECT 1 FROM flow_run r WHERE ${INSTANCE_RUN})
    OR EXISTS (SELECT 1 FROM flow_run r WHERE ${INSTANCE_RUN} AND r.status NOT IN ('QUEUED','RUNNING','PAUSED','SUCCEEDED','STOPPED')))))`;
/** Persistent terminal results and pending requests are scoped to the signed-in workspace. */
export function listHumanInputs(projectId: string, now = Date.now()): HumanRequest[] {
  expireHumanInputs(now);
  return getWorkflowDb().query<Row, [string]>(`SELECT * FROM workflow_human_request h WHERE h.project_id=?1 AND (h.status='pending' OR h.id IN
    (SELECT id FROM workflow_human_request WHERE project_id=?1 AND ${CLOSED} ORDER BY closed_at DESC,id DESC LIMIT ${HISTORY_PAGE})
    OR (${UNDISMISSED_OUTCOME})) ORDER BY h.deadline,h.id`).all(projectId).map(record => withRunOutcomes(unpack(record)));
}
/** Authenticated deep links and local draft recovery are not limited by the recent page. */
export function getHumanInput(projectId: string, id: string, now = Date.now()): HumanRequest | null {
  expireHumanInputs(now);
  const record = row(id);
  return record?.project_id === projectId ? withRunOutcomes(unpack(record)) : null;
}
/**
 * Keyset page of closed requests, newest close first: new responses cannot
 * shift older pages or duplicate records. The first page is the Recent list's
 * closed part, so its cursor comes from `historyPage` without outcomes.
 */
function historyPage(projectId: string, cursor: string | null | undefined): { rows: Row[]; nextCursor: string | null } {
  let before: [number, string] | null = null;
  if (cursor) {
    let value: unknown; try { value = JSON.parse(cursor); } catch { throw Error('Invalid history cursor'); }
    if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0])
      || typeof value[1] !== 'string' || value[1].length > 200) throw Error('Invalid history cursor');
    before = value as [number, string];
  }
  const rows = getWorkflowDb().query<Row, [string, number | null, string | null]>(`SELECT * FROM workflow_human_request
    WHERE project_id=?1 AND ${CLOSED} AND (?2 IS NULL OR (closed_at,id)<(?2,?3))
    ORDER BY closed_at DESC,id DESC LIMIT ${HISTORY_PAGE + 1}`).all(projectId, before?.[0] ?? null, before?.[1] ?? null);
  const page = rows.slice(0, HISTORY_PAGE), last = page.at(-1);
  return { rows: page, nextCursor: rows.length > HISTORY_PAGE && last ? JSON.stringify([last.closed_at, last.id]) : null };
}
export function humanInputHistory(projectId: string, cursor?: string | null) {
  const { rows, nextCursor } = historyPage(projectId, cursor);
  return { requests: rows.map(record => withRunOutcomes(unpack(record))), nextCursor };
}
/** Cursor past the Recent list's closed requests: ids and close times only, through idx_human_closed. */
export function humanInputHistoryCursor(projectId: string): string | null {
  const rows = getWorkflowDb().query<{ id: string; closed_at: number }, [string]>(`SELECT id,closed_at FROM workflow_human_request
    WHERE project_id=?1 AND ${CLOSED} ORDER BY closed_at DESC,id DESC LIMIT ${HISTORY_PAGE + 1}`).all(projectId);
  const last = rows[HISTORY_PAGE - 1];
  return rows.length > HISTORY_PAGE && last ? JSON.stringify([last.closed_at, last.id]) : null;
}
export function resolveHumanInput(projectId: string, id: string, input: Record<string, unknown>, now = Date.now()) {
  expireHumanInputs(now);
  const db = getWorkflowDb();
  const result = db.transaction(() => {
    const record = row(id);
    if (!record || record.project_id !== projectId) return { status: 404, error: 'Request not found' };
    const current = unpack(record);
    if (!matchesGeneration(current, input.generation)) return staleResponse(current);
    const decision = input.decision, kind = current.kind;
    const status = decision === 'submit' && kind === 'input' ? 'submitted'
      : decision === 'approve' && kind === 'approval' ? 'approved'
      : decision === 'reject' && kind === 'approval' ? 'rejected' : decision === 'cancel' ? 'cancelled' : null;
    if (!status) return { status: 400, error: 'Invalid response for this request' };
    // Only a valid answer checks the draft: an edit that is reverted before
    // anyone answers lets the run continue, and a cancel needs no graph check.
    if (status !== 'cancelled') withdrawChangedRequest(record, now);
    const request = unpack(row(id)!);
    const answers = status === 'submitted' ? input.answers : null;
    if (request.status !== 'pending') {
      if (request.status === status && digest(request.answers) === digest(answers)) return { status: 200, request };
      return { status: 409, error: request.closureReason === 'workflow_changed'
        ? 'The workflow changed while this request was waiting. Your answer was not accepted.' : `This request is ${request.status}`, request };
    }
    const errors = status === 'submitted' ? answerErrors(request.fields, answers) : {};
    if (Object.keys(errors).length) return { status: 422, error: 'Check the highlighted answers', errors };
    request.status = status; request.answers = answers as Record<string, unknown> | null; save(request, now);
    return { status: 200, request: unpack(row(id)!) };
  }).immediate();
  resumeHumanInputs(now);
  return result;
}
/** A run that can still be continued: not finished and not stopped by turning its workflow off. */
const LIVE_RUN = `SELECT 1 FROM flow_run r JOIN flow f ON f.id=r.flow_id WHERE r.status IN ('RUNNING','PAUSED','QUEUED')
  AND NOT (f.disabled_at IS NOT NULL AND r.created <= f.disabled_at)`;
/**
 * Close what can no longer be answered. Reads only through the pending index and
 * writes only rows that change, so the dashboard's polling stays cheap. Draft
 * edits are not checked here: that happens only when an answer arrives. A request
 * is cancelled only when no run that asked it (its own run, or any run waiting on
 * a shared form) can still continue: stopping one run never closes another's.
 */
function expireHumanInputs(now: number) {
  const db = getWorkflowDb();
  const closing = db.query<Row & { next: 'expired' | 'cancelled' }, [number]>(`SELECT h.*, CASE WHEN NOT EXISTS (${LIVE_RUN}
      AND ${INSTANCE_RUN}) THEN 'cancelled' WHEN h.deadline <= ?1 THEN 'expired' END AS next
    FROM workflow_human_request h WHERE h.status='pending' AND next IS NOT NULL`).all(now);
  for (const record of closing) save({ ...unpack(record), status: record.next }, now);
}
/** Durable polling also covers a response received before the worker parks. */
export function resumeHumanInputs(now = Date.now()): number {
  expireHumanInputs(now);
  if (emergencyHold()) return 0;
  let count = 0;
  const db = getWorkflowDb();
  const waits = db.query<{ run_id: string; waitpoint_id: string }, []>(`SELECT w.run_id,w.waitpoint_id FROM workflow_human_wait w
    JOIN workflow_human_request h ON h.id=w.request_id JOIN waitpoint p ON p.id=w.waitpoint_id
    WHERE (h.status!='pending' OR w.generation<${CURRENT_GENERATION}) AND p.resumed_at IS NULL`).all();
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

/**
 * Derive current run state without exposing step outputs or error arguments.
 * Only runs that asked this instance count: a shared form reopened after it
 * expired or was cancelled does not report the earlier runs' outcomes.
 */
function withRunOutcomes(request: HumanRequest): HumanRequest {
  const rows = getWorkflowDb().query<{ id: string; flow_version_id: string; status: string }, [string, string, number]>(`
    SELECT DISTINCT r.id,r.flow_version_id,r.status FROM flow_run r
    WHERE r.id=?1 OR r.id IN (SELECT run_id FROM workflow_human_wait WHERE request_id=?2 AND generation=?3)
    ORDER BY r.created,r.id`).all(request.runId, request.id, generationOf(request));
  return { ...request, runs: rows.length ? rows.map(r => ({ runId: r.id, versionId: r.flow_version_id, status: r.status }))
    : [{ runId: request.runId, versionId: '', status: 'UNAVAILABLE' }] };
}
/**
 * Acknowledge a closed request whose outcome needed attention (a failed run, a
 * withdrawn form). It then stops counting in Needs you; the record is kept.
 */
export function dismissHumanInput(projectId: string, id: string, now = Date.now(), generation?: unknown) {
  const db = getWorkflowDb();
  return db.transaction(() => {
    const record = row(id);
    if (!record || record.project_id !== projectId) return { status: 404, error: 'Request not found' };
    const request = withRunOutcomes(unpack(record));
    if (!matchesGeneration(request, generation)) return staleResponse(request);
    if (request.dismissedAt) return { status: 200, request };
    if (!humanRequestDismissable(request)) return { status: 409, error: request.status === 'pending' ? 'This request is still waiting for a response' : 'This request has nothing to dismiss yet', request };
    const { runs: _runs, ...stored } = request;
    const dismissed = { ...stored, dismissedAt: now }; save(dismissed, now);
    return { status: 200, request: { ...dismissed, runs: request.runs } };
  }).immediate();
}
/** A stale draft cannot consume an answer the worker will refuse to resume. */
function withdrawChangedRequest(record: Row, now: number): void {
  if (record.status !== 'pending') return;
  const request = unpack(record), graph = JSON.parse(record.record).graphDigest;
  const live = getWorkflowDb().query<{ flow_version_id: string }, [string, string, number]>(`
    SELECT r.flow_version_id FROM flow_run r JOIN flow f ON f.id=r.flow_id
    WHERE r.status IN ('RUNNING','PAUSED','QUEUED')
    AND NOT (f.disabled_at IS NOT NULL AND r.created <= f.disabled_at)
    AND (r.id=? OR r.id IN (SELECT run_id FROM workflow_human_wait WHERE request_id=? AND generation=?))`).all(request.runId, request.id, generationOf(request));
  if (live.length && live.every(r => {
    const version = getFlowVersion(r.flow_version_id);
    return !version || digest(version.trigger) !== graph;
  })) save({ ...request, status: 'cancelled', closureReason: 'workflow_changed' }, now);
}
