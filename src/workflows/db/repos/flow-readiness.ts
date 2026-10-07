import { getWorkflowDb } from '../index';
import { compileWorkflow, type ReadinessContext, type WorkflowReadiness } from '../../runtime/workflow-readiness';
import { assertFlowVersionOwnership } from './flow-version-ownership';
import { workflowReadinessServices } from './readiness-services';
import { bindingPinIssues } from './binding-pins';

export { configureWorkflowReadiness, type ReadinessServices } from './readiness-services';

/**
 * How readiness treats the binding pins a person accepted when enabling the
 * flow (Q-05, repos/binding-pins.ts). Admission compares against them. The
 * paths where a person enables or publishes ARE that acceptance, so they skip
 * the comparison and write new pins instead.
 */
export interface BindingPinMode { acceptBindings?: boolean }

/**
 * How many issues the thrown MESSAGE names before it summarizes (#633).
 *
 * The in-repo pattern for exactly this is `flow-code-steps.ts`'s
 * `MAX_NAMED_STEPS = 6`. 10 rather than 6 because the full list survives
 * untouched on `this.readiness`, which `workflows/api/routes.ts` spreads into
 * the 422 body -- so this string is a summary for a log, a thrown message and a
 * notification, not the only copy. 10 is enough to see a pattern.
 *
 * The omission note can never say more than 90, because `compileWorkflow`'s
 * `issue()` already clamps `issues` at 100 entries however wide the graph is.
 */
const MAX_MESSAGE_ISSUES = 10;

/**
 * Per-field cuts for one issue in that message (#633).
 *
 * The filed title -- "bounded by graph breadth, not by the 100-node limit" --
 * is wrong about the mechanism: `issue()` in `runtime/workflow-readiness.ts`
 * does clamp the issue COUNT at 100. What was unbounded is each issue's
 * CONTENT. `node` is `raw.name` kept verbatim, `path` is built up as
 * `${path}.${key}` from caller-supplied JSON keys, and some messages
 * interpolate a reference name or the expression evaluator's error. So a single
 * issue could carry ~4 MB, which is what `VERSION_WRITE_MAX_BODY_BYTES` allows
 * into the graph in the first place. Capping the list without capping the
 * fields would have fixed nothing.
 *
 * `node` at 120: the number `runtime/effect-boundary.ts` already uses for an
 * unvalidated step name on its way into a durable row. A node name that is
 * LEGITIMATE must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` for the flow to run at
 * all, so real ones are `step_1` and `send_email`.
 *
 * `path` and `message` at 512. These are defence-in-depth numbers and NOT
 * claims to admit every legitimate value: a path's length is not bounded by the
 * depth-64 cap, because that bounds the number of SEGMENTS while each segment
 * is an unbounded caller-supplied key. 512 is simply generous -- the longest
 * fixed message in `workflow-readiness.ts` is about 110 characters.
 *
 * Worst case 10 x (120 + 512 + 512 + 6) plus the note, so ~11.5 KB against the
 * ~4 MB one issue could reach before.
 *
 * DEFENCE IN DEPTH, deliberately, and sized for it: #608 already caps this
 * where a model reads it (`markUntrustedToolFailure` cuts then frames) and
 * #609 bounds the request body that writes the names. This is the source.
 */
const MAX_ISSUE_NODE_CHARS = 120;
const MAX_ISSUE_PATH_CHARS = 512;
const MAX_ISSUE_MESSAGE_CHARS = 512;

const cut = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}...` : value;

/** One issue as the message renders it, with each field bounded. */
function issueLine(issue: { node: string; path: string; message: string }): string {
  return `${cut(issue.node, MAX_ISSUE_NODE_CHARS)} (${cut(issue.path, MAX_ISSUE_PATH_CHARS)}): `
    + cut(issue.message, MAX_ISSUE_MESSAGE_CHARS);
}

export class WorkflowReadinessError extends Error {
  readonly code = 'WORKFLOW_NOT_READY';
  readonly status = 422;
  constructor(readonly readiness: WorkflowReadiness) {
    // `this.readiness` keeps every issue, untouched: the 422 body carries the
    // structured list and that is what a client should read. Only the MESSAGE
    // is bounded. Note the `'; '` join is not a parseable separator and never
    // was -- `workflow-readiness.ts`'s "Piece catalog is unavailable; readiness
    // cannot be verified" contains one -- so nothing may try to split it back.
    const shown = readiness.issues.slice(0, MAX_MESSAGE_ISSUES).map(issueLine).join('; ');
    const omitted = readiness.issues.length - Math.min(readiness.issues.length, MAX_MESSAGE_ISSUES);
    super(omitted > 0 ? `${shown}; and ${omitted} more issue${omitted > 1 ? 's' : ''}` : shown);
    this.name = 'WorkflowReadinessError';
  }
}

function contextFor(flowId: string, ancestors: string[] = [], cache = new Map<string, WorkflowReadiness>(), budget = { remaining: 100 }): ReadinessContext {
  const db = getWorkflowDb();
  const configured = workflowReadinessServices();
  const flow = db.query<{ project_id: string }, [string]>('SELECT project_id FROM flow WHERE id = ?').get(flowId);
  if (!flow) throw new Error('flow not found');
  return {
    pieces: configured?.pieces,
    tool: configured?.tool,
    roles: configured?.roles,
    connection(externalId, pieceName) {
      if (externalId.startsWith('jarvis:')) {
        const source = configured?.credentials?.list().find(candidate => candidate.canResolve(externalId));
        if (!source) return 'Managed connection source is unavailable';
        // A source that can say it holds no credential to hand out (not
        // connected, or revoked by the provider) is not ready to run.
        return source.identity && source.identity(externalId) === null
          ? 'Managed connection is not connected or was revoked; reconnect it' : null;
      }
      // Metadata only. Preflight never decrypts credentials or refreshes a
      // token inside publication's transaction. Match the engine's piece-less
      // request, then check the chosen piece, rather than selecting a first row.
      const matches = db.query<{ piece_name: string; status: string }, [string, string]>(
        'SELECT piece_name, status FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 2',
      ).all(flow.project_id, externalId);
      if (matches.length !== 1) return matches.length ? 'Connection external ID is ambiguous in this project' : 'Connection is missing in this project';
      if (matches[0]!.piece_name !== pieceName) return 'Connection belongs to a different piece';
      return matches[0]!.status === 'ACTIVE' ? null : 'Connection is not active';
    },
    workflow(id) {
      if (id === flowId || ancestors.includes(id)) return 'Workflow binding would form a recursive cycle';
      if (ancestors.length >= 16) return 'Nested workflow validation exceeds 16 levels';
      const cached = cache.get(id);
      if (cached) return cached.ready ? null : 'Target workflow is not ready';
      if (--budget.remaining < 0) return 'Nested workflow validation exceeds 100 targets';
      const target = db.query<{ id: string }, [string, string]>(
        'SELECT id FROM flow WHERE id = ? AND project_id = ?',
      ).get(id, flow.project_id);
      if (!target) return 'Select an existing workflow ID in this project';
      const version = db.query<{ trigger: string }, [string]>(
        `SELECT v.trigger FROM flow f JOIN flow_version v ON v.flow_id = f.id AND v.id =
          COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1))
          WHERE f.id = ?`,
      ).get(id);
      if (!version) return 'Target workflow has no executable version';
      let trigger: unknown;
      try { trigger = JSON.parse(version.trigger); } catch { return 'Target workflow graph is unreadable'; }
      const readiness = compileWorkflow(trigger, contextFor(id, [...ancestors, flowId], cache, budget));
      cache.set(id, readiness);
      const first = readiness.issues[0];
      // Bounded with the same cuts the thrown message uses (#633), because this
      // is where the amplification lived: the string returned here becomes a
      // WORKFLOW_BINDING issue's `message` in the CALLER's readiness, and
      // `workflow()` recurses up to 16 levels, each level embedding the level
      // below's first issue. Unbounded, one `readiness.issues[].message` -- in
      // the 422 BODY, not just in `Error.message` -- could carry 16 flows'
      // worth of verbatim stored graph text.
      //
      // It SATURATES rather than accumulating, which is the honest description:
      // level k's ~1.2 KB return value is itself cut to 512 when it becomes
      // level k-1's `first.message`, so the whole chain stays around 1.2 KB
      // whatever the depth. The cost is that detail from below the first level
      // or two of nesting is dropped from the string -- the nested flow's own
      // `/readiness` is where that detail lives.
      return first ? `Target workflow is not ready: ${issueLine(first)}` : null;
    },
  };
}

export function graphReadiness(flowId: string, trigger: unknown): WorkflowReadiness {
  return compileWorkflow(trigger, contextFor(flowId));
}
export function versionReadiness(flowId: string, versionId: string, preview?: ReadinessContext['preview'], mode: BindingPinMode = {}): WorkflowReadiness {
  assertFlowVersionOwnership(flowId, versionId);
  const row = getWorkflowDb().query<{ trigger: string }, [string]>('SELECT trigger FROM flow_version WHERE id = ?').get(versionId)!;
  let trigger: unknown;
  try { trigger = JSON.parse(row.trigger); } catch { trigger = null; }
  const result = compileWorkflow(trigger, { ...contextFor(flowId), preview });
  if (mode.acceptBindings) return result;
  // A binding that changed since a person enabled the flow is a blocker, never
  // a silent switch to whatever now answers to the same name.
  const stale = bindingPinIssues(flowId, versionId, trigger);
  return stale.length ? { ...result, ready: false, issues: [...result.issues, ...stale] } : result;
}
export function assertVersionReady(flowId: string, versionId: string, preview?: ReadinessContext['preview'], mode: BindingPinMode = {}): void {
  const result = versionReadiness(flowId, versionId, preview, mode);
  if (!result.ready) throw new WorkflowReadinessError(result);
}
export function assertFlowReady(flowId: string, mode: BindingPinMode = {}): void {
  const row = getWorkflowDb().query<{ version_id: string | null }, [string]>(
    `SELECT COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1)) AS version_id FROM flow f WHERE id = ?`,
  ).get(flowId);
  if (!row) throw new Error('flow not found');
  if (!row.version_id) throw new WorkflowReadinessError({ ready: false, runtimeChecks: [], issues: [{ node: 'trigger', path: 'graph', code: 'VERSION', message: 'Create a workflow version before enabling it' }] });
  assertVersionReady(flowId, row.version_id, undefined, mode);
}
export function assertLiveDraftReady(flowId: string, trigger: unknown): void {
  const row = getWorkflowDb().query<{ status: string; published_version_id: string | null }, [string]>(
    'SELECT status, published_version_id FROM flow WHERE id = ?',
  ).get(flowId);
  if (row?.status !== 'ENABLED' || row.published_version_id) return;
  const result = graphReadiness(flowId, trigger);
  if (!result.ready) throw new WorkflowReadinessError(result);
}
