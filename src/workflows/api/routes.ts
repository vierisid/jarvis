/**
 * HTTP routes for the workflow runtime.
 *
 * Mounted under `/api/workflows/*` and `/api/webhooks/:flowId`. The previous
 * in-house engine that owned these paths was deleted in the Phase 6 cutover.
 *
 * Route map shape matches the rest of the daemon (`Record<string, { GET?, POST?, ... }>`)
 * so it can be spread into `createApiRoutes()` without touching its internals.
 *
 * Notes on what these routes do NOT do:
 *   - No handler-side authn/authz: Jarvis is single-tenant, the dashboard is
 *     CORS-bound to localhost, and the existing daemon routes have the same
 *     posture. Adding auth here would diverge from the rest.
 *     The one exception to "CORS-bound to localhost" is
 *     `POST /api/webhooks/waitpoints/:id`: `/api/webhooks/*` is a public-route
 *     exemption in the global gate and is meant to be reachable from the
 *     internet, so that handler carries its own ingress budgets and body cap
 *     (see the block comment above it) instead of relying on the posture
 *     above.
 *   - The `run` endpoint enqueues a job; it does not block on the engine.
 *     Engine spawning is a worker-side concern (Phase 2 follow-up).
 *
 * Each handler operates on the workflow DB initialized via `initWorkflowDb()`.
 * If the DB is not initialized, route handlers throw at first DB call; the
 * framework's catch-all returns 500. The daemon bootstrap must call
 * `initWorkflowDb(...)` before routes serve traffic.
 */

import { getWorkflowDb } from '../db';
import {
  createFlow,
  deleteFlow,
  flowCodeStepsEnabled,
  getFlow,
  listFlows,
  parseFlowMetadata,
  setFlowCodeStepsEnabled,
  updateFlowMetadata,
  updateFlowStatus,
  type FlowStatus,
} from "../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  getLatestDraft,
  listVersions,
  lockVersion,
  replaceSampleData,
  setSampleDataEntry,
  setSampleInputEntry,
  updateDraftVersion,
  type UpdateDraftVersionInput,
} from "../db/repos/flow-version";
import { publishFlowVersion } from "../db/repos/flow-publication";
import { assertVersionReady, versionReadiness, WorkflowReadinessError } from '../db/repos/flow-readiness';
import { assertCodeStepsAllowed, CodeStepsRefusedError } from "../db/repos/flow-code-steps";
import { FlowVersionRequestError, withOwnedFlowVersion } from "../db/repos/flow-version-ownership";
import {
  getFlowVersionUiMeta,
  uiMetaRefusal,
  upsertFlowVersionUiMeta,
  type FlowVersionUiMeta,
} from "../db/repos/flow-version-ui-meta";
import {
  createFlowRun,
  getFlowRun,
  listRuns,
  type FlowRunStatus,
  type RunEnvironment,
} from "../db/repos/flow-run";
import { countQueued, enqueue } from "../db/repos/job-queue";
import { cancelFlowRun } from "../db/repos/run-cancellation";
import { startWorkItemRun } from "../../goals/workflow-bridge";
import { WorkItemError } from "../../goals/work-items";
import {
  getWaitpoint,
  listWaitpointsByFlowRun,
  markWaitpointResumed,
} from "../db/repos/waitpoint";
import {
  deleteConnection,
  getConnection,
  listConnections,
  upsertConnection,
  type AppConnectionStatus,
  type AppConnectionType,
} from "../db/repos/app-connection";
import type { CredentialResolver } from "../credentials/adapter";
import { MAX_QUEUED_WEBHOOK_RUNS, type TriggerManager } from "../runner/triggers/manager";
import { KeyedRateLimiter } from "../runner/triggers/rate-limiter";
import type { PieceLookup } from "../runtime/piece-catalog";
import { CATALOG, findCatalogEntry } from "../pieces-library/catalog";
import { piecesManagedByHost } from "../pieces-library/shared";
import {
  installPiece,
  readManifest,
  uninstallPiece,
  type InstalledPiece,
} from "../pieces-library/installer";
import {
  flowOsWarnings,
  osCheckContextFor,
  type ExecutionTarget,
} from "../../util/execution-environment";

type RequestWithParams<P extends Record<string, string> = Record<string, string>> = Request & {
  params: P;
};

/** A request that may carry route params -- the daemon's Bun.serve attaches `params` for parameterized paths. */
type RouteRequest = Request & { params?: Record<string, string> };
type RouteHandler = (req: RouteRequest) => Promise<Response> | Response;

interface RouteMethods {
  GET?: RouteHandler;
  POST?: RouteHandler;
  PATCH?: RouteHandler;
  DELETE?: RouteHandler;
}

export type WorkflowRouteMap = Record<string, RouteMethods>;

/**
 * Per-step sample-data entry size cap, in bytes of serialized JSON. 256KB.
 * Big enough for typical fixtures (Gmail message, Notion page block).
 *
 * The second half of this comment used to read "and small enough that 100
 * entries still fit under SQLite's default 1MB TEXT limit". Both halves of that
 * were wrong and it is corrected rather than left, because #609 nearly derived
 * a request-body cap from it: `SQLITE_MAX_LENGTH` defaults to 1e9 and not 1MB,
 * and 100 x 256KB is 25.6MB either way. The cap is a PER-ENTRY bound on what
 * one fixture may cost. The map's TOTAL is bounded separately, by
 * `SAMPLE_DATA_MAP_MAX_BYTES` and `SAMPLE_DATA_MAP_MAX_ENTRIES` in
 * `db/repos/flow-version.ts` (#635) -- in the repo rather than here, because
 * that is where the read-modify-write they guard is atomic.
 *
 * KEEP IN SYNC with `SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES` in
 * `db/repos/flow-version.ts`, which is an independent copy of this number for
 * the auto-capture writer. Nothing enforces the equality, and
 * `SAMPLE_DATA_MAP_MAX_BYTES` states a hard 16x relationship to it.
 *
 * Despite the name this counts UTF-16 code units, not bytes: the check is
 * `JSON.stringify(output).length`. Left as it is because it is the unit the
 * refusal reports, and `SAMPLE_DATA_MAX_BODY_BYTES` below is derived from it
 * with that in mind.
 */
const SAMPLE_DATA_ENTRY_MAX_BYTES = 256 * 1024;

/**
 * Longest `stepName` the two sample routes will accept (#635).
 *
 * `stepName` arrives in the URL PATH and becomes a KEY in the version's
 * sample-data map, and nothing checked it: not its length, and not against the
 * graph. So the map's keys were an unbounded resource that no body cap can
 * reach -- a multi-kilobyte key rides in on a request with a two-byte body, and
 * 100 keys of 40 KB each is 4 MB of pure key text within every other cap here.
 *
 * 120 is the number `runtime/effect-boundary.ts` already uses for exactly this
 * value: an engine-supplied step name that is not validated on that path, cut
 * before it reaches a durable audit row. A node name that is LEGITIMATE has to
 * match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` for the flow to be runnable at all, so
 * real names are `step_1` and `send_email`.
 *
 * LENGTH ONLY, and not that identifier pattern, which was the other half of the
 * suggestion. Readiness is the one authority on whether a node name is legal,
 * and it reports a bad one as an issue rather than refusing the save -- so a
 * draft can hold a name this route would reject. Sample data is edited exactly
 * then, mid-rename, and refusing the write here would make this route a second
 * and stricter name validator than the one that decides runnability. The
 * resource problem is key SIZE; that is what this bounds.
 *
 * 413 and not 414 (URI Too Long), which is the literal match for an over-long
 * path segment: every other size refusal in this file answers 413
 * (`FLOW_DISPLAY_NAME_MAX_CHARS`, `metadataRejection`, `readWriteBody`), and
 * consistency inside one file is worth more here than the more precise code.
 */
const SAMPLE_DATA_STEP_NAME_MAX_CHARS = 120;

/**
 * Ingress budgets for `POST /api/webhooks/waitpoints/:id`, the one route in
 * this file that is deliberately internet-exposed (`/api/webhooks/*` is a
 * public-route exemption in the global gate). They mirror the sibling
 * trigger ingress in `runner/triggers/webhook.ts` on purpose: same window,
 * same numbers, same `KeyedRateLimiter`, so there is one set of ingress
 * budgets to reason about rather than two that drift apart.
 *
 * - PER_ID: one waitpoint's retry storm cannot crowd out other resumes.
 * - GLOBAL: a flood across many *valid* ids still cannot fill the queue.
 * - UNKNOWN_ID: the enumeration budget. Charged only when the id does not
 *   resolve, and deliberately separate from GLOBAL so a probe flood cannot
 *   lock out legitimate resumers -- the same split webhook.ts makes between
 *   its per-flow budget and its bad-signature budget.
 */
export const WAITPOINT_RESUME_PER_ID_PER_MINUTE = 60;
export const WAITPOINT_RESUME_GLOBAL_PER_MINUTE = 600;
export const WAITPOINT_RESUME_UNKNOWN_ID_PER_MINUTE = 30;
/**
 * Body cap for the resume payload. The body becomes the paused step's
 * resume input and is round-tripped through the job queue as JSON, so it is
 * the real per-request cost. Matches `WEBHOOK_MAX_BODY_BYTES`.
 */
export const WAITPOINT_RESUME_MAX_BODY_BYTES = 1_000_000;

/**
 * Ceiling on `POST /:id/run`'s `triggeredBy` label (#649). Every writer in the
 * codebase sets a short tag (`dashboard`, `editor:run`, `trigger:<kind>`); the
 * longest, `work_item:<id>:decision:<id>`, is well under 100. The column has no
 * limit of its own and the value is read back to the model, so the API is
 * where it gets one.
 */
export const RUN_TRIGGERED_BY_MAX_CHARS = 200;

function isRunEnvironment(value: unknown): value is RunEnvironment {
  return value === "PRODUCTION" || value === "TESTING";
}

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const err = (message: string, status = 400): Response =>
  ok({ error: message }, status);

/**
 * Ceiling on a flow's `metadata` document, in characters of serialized JSON
 * (#598).
 *
 * The column used to be a verbatim caller-controlled document of unbounded
 * size: both writers below cast the request body and passed `body.metadata`
 * straight through to `JSON.stringify`, with no type check, no key whitelist and
 * no size limit. `actions/tools/manage-workflow.ts` then read it back with a raw
 * `JSON.parse` and put it in chat tool output, which is what #598 was filed
 * about.
 *
 * 16 KB is a STORAGE bound, not a schema: it is ~85x the largest writer in the
 * repo (`awareness/suggestion-composer.ts`, four ids at ~190 characters) and no
 * shipped caller writes the field at all -- the dashboard POSTs
 * `{ displayName }`, PATCHes `{ status }`, and keeps its editor state in
 * `flow_version_ui_meta` behind its own routes. So this cannot break a client
 * that exists; what it stops is an unbounded column.
 *
 * It is deliberately NOT the only control. Rows written before it are left
 * exactly as they are -- there is no migration and no rewrite, and they are
 * still served here in full -- so what keeps a legacy oversized row out of the
 * prompt is the much tighter per-flow cap in `summarizeFlow`, which no consumer
 * outside the chat tool goes through.
 */
const FLOW_METADATA_MAX_CHARS = 16_384;

/**
 * Ceiling on a FLOW-LEVEL write request body, checked BEFORE it is parsed.
 *
 * Scope, stated because the name does not carry it: this fronts
 * `POST /api/workflows`, `PATCH /api/workflows/:id`, and the two flow-level
 * switches whose bodies are a single field, `/publish` (`{ versionId }`) and
 * `/code-steps` (`{ enabled }`) (#649). The connections routes borrow it too;
 * see there. The two version routes carry the bigger body -- the whole step
 * graph plus `uiMeta` -- and have their own, larger ceiling (`VERSION_WRITE_MAX_BODY_BYTES`), rather than being
 * squeezed through a limit sized for `{ displayName, metadata }`: a cap that is
 * generous for a flow row is a guess for a step graph, and breaking a large
 * flow's save in the visual editor would be a worse outcome than the exposure
 * it prevents.
 *
 * The metadata cap below can only run after `req.json()` has already
 * materialized the caller's object graph, and it then allocates a second
 * full-size string to measure it. That is the wrong side of an unguarded parse:
 * the daemon is one process serving this API, the dashboard and the agent
 * runtime, so an OOM here is a full-availability event. This is the same guard
 * `WAITPOINT_RESUME_MAX_BODY_BYTES` applies two routes up, for the same reason
 * and in the same shape.
 *
 * 256 KB is enormous for these two routes -- the largest legitimate body is
 * `{ displayName }` plus at most `FLOW_METADATA_MAX_CHARS` of metadata -- and it
 * is deliberately well above the metadata cap so an oversized `metadata` is
 * still refused by the specific, informative check rather than by this one.
 */
const FLOW_WRITE_MAX_BODY_BYTES = 262_144;

/**
 * Ceiling on a VERSION write request body -- `POST /api/workflows/:id/versions`
 * and `PATCH /api/workflows/:id/versions/:versionId` (#609).
 *
 * #598 capped the two flow-level routes and left these two on purpose, because
 * they carry the whole step graph and a flow-row-sized limit would be a guess
 * that could break a large flow's save. So this one is MEASURED, against each
 * construction the product can legitimately produce, and it is a PARSE-COST
 * bound: not a storage ceiling, because there is no 1 MB SQLite TEXT limit to
 * derive one from (see the note on `SAMPLE_DATA_ENTRY_MAX_BYTES`).
 *
 * WHAT RIDES IN THE BODY: `displayName` (already bounded at 512 by
 * `validDisplayName`, on both routes), `trigger` (the step graph), `uiMeta`, and
 * -- because the body is a cast rather than a schema -- whatever else
 * `updateDraftVersion` accepts, including `backupFiles`, a filename ->
 * file-CONTENT map that no shipped caller writes and that nothing else bounds.
 * `sample_data` does NOT: it has its own routes, its own per-entry cap, its own
 * body cap and its own map caps (#635).
 *
 * WHAT BOUNDS A LEGITIMATE GRAPH: 100 nodes. `runtime/workflow-readiness.ts`
 * raises a `LIMIT` issue past it and `assertVersionReady` gates publish, enable
 * and run on readiness -- so a graph above 100 nodes can be SAVED but can never
 * run, which makes 100 the ceiling on a legitimately runnable flow.
 *
 * WHAT DOES NOT: `uiMeta.orphans`. They are full `FlowStepNode`s that are not in
 * the `trigger` graph, so the 100-node walk never sees them, and the editor
 * sends each one with its whole `nextAction` subtree. Detaching a 99-node chain
 * on the canvas therefore produces a body of about TWICE the graph. That is the
 * term that decides this number, and the one an earlier draft of this comment
 * got wrong by attributing the doubling to `positions` (~40 characters a node,
 * which is negligible).
 *
 * MEASURED, as a whole request body including `uiMeta`:
 *
 *   100 PIECE nodes, composer-sized settings            45 KB
 *   100 PIECE nodes, 1 KB of input each                138 KB
 *   100 PIECE nodes, 4 KB of input each                435 KB
 *   100 PIECE nodes, 4 KB each + a full orphan twin    868 KB
 *   100 CODE nodes, 4 KB of source each                441 KB
 *   100 CODE nodes, 10 KB of source each              1.06 MB
 *   100 CODE nodes, 10 KB each + a full orphan twin   2.12 MB
 *   100 CODE nodes, 20 KB each + a full orphan twin   4.17 MB
 *
 * The measured POPULATION is one flow: 600 characters over 3 nodes, 200 a node,
 * with `flow_version_ui_meta` empty. n=1, so that is an anchor and the table
 * above is what the cap is actually sized against.
 *
 * WHY 4 MB AND NOT 1. A megabyte refuses the fifth row -- 100 code steps with
 * 10 KB of source each, which is ordinary hand-written JavaScript and not an
 * abuse -- and leaves the fourth row 13% of margin. `sourceCode` is
 * `{ packageJson, code }` stored inside the graph JSON and nothing caps it
 * anywhere (readiness only checks both are strings), so a code-bearing flow is
 * the realistic large case and a megabyte sits inside it. 4 MB clears the worst
 * realistic construction (row seven) by about 2x and refuses only row eight,
 * which is past anything authored in a browser editor.
 *
 * WHY A BIGGER NUMBER IS STILL A BOUND. What this guard exists to stop is an
 * UNBOUNDED body materializing a caller's object graph in the one process that
 * serves this API, the dashboard and the agent runtime. Measured on this
 * runtime, `JSON.parse` costs 0.6 ms at 1 MB, 2.5 ms at 4 MB and 5.1 ms at
 * 8 MB -- linear, and nothing like the cost of no limit at all. So the choice
 * between 1 MB and 4 MB does not trade availability for anything; it only
 * decides which legitimate flows are refused.
 *
 * NOT the same number as `WAITPOINT_RESUME_MAX_BODY_BYTES` (1 MB), and that is
 * deliberate rather than drift. The file's "one set of ingress budgets" argument
 * is for budgets that answer the same question, and these do not: a resume
 * payload is one step's input, while this is a whole step graph plus its editor
 * layout. Reusing the waitpoint's figure here would have been exactly the guess
 * #598 refused to make.
 *
 * ROWS ALREADY OVER IT are untouched -- no migration, and they are still served
 * in full, with the read-side caps in `actions/tools/manage-workflow.ts` keeping
 * an oversized one out of the prompt. But say the write half plainly: the editor
 * loads a draft and PATCHes it straight back, so a pre-existing draft above this
 * cap is readable and no longer SAVEABLE, and its author's only way out is to
 * shrink the graph. That is the failure mode #598 was worried about, which is
 * why the number is measured against the table above rather than chosen.
 */
export const VERSION_WRITE_MAX_BODY_BYTES = 4_000_000;

/**
 * Ceiling on a SAMPLE-DATA write body -- `PATCH .../sample-data/:stepName` and
 * `PATCH .../sample-input/:stepName` (#635).
 *
 * Both routes used to `req.json()` an unbounded body and only THEN apply
 * `SAMPLE_DATA_ENTRY_MAX_BYTES`, which is the "the cap can only run once the
 * caller's object graph is already materialized" problem `readWriteBody` exists
 * to avoid. #609 left them out because its subject was the two VERSION routes
 * and said a sample-data body deserves its own measurement rather than an
 * inherited number. This is that measurement.
 *
 * WHY NOT `FLOW_WRITE_MAX_BODY_BYTES` (262,144), which is the tempting reuse:
 * an existing test forbids it. `routes.test.ts`'s "PATCH rejects an output that
 * exceeds the per-entry size cap" sends a ~307 KB body and asserts 413 with the
 * route's OWN message, `/exceeds .* bytes/`. Any body cap at or below ~307,250
 * would answer that request with `readWriteBody`'s "too large" instead, so the
 * caller would be told its request was too big rather than that its FIXTURE
 * was -- which is the more useful of the two sentences and the one the test
 * pins. So this cap must sit above the per-entry cap by a real margin, not
 * beside it.
 *
 * DERIVED from the per-entry cap, since that is what decides whether a body is
 * legitimate; this one only decides parse cost. A legal payload is 262,144 code
 * units of `JSON.stringify(output)`. Three factors separate that from the
 * request body, measured on this runtime at the per-entry ceiling:
 *
 *   fixture                              serialized   compact body   pretty(2)
 *   Gmail message (few big strings)          260,249        260,260     260,609
 *   Notion blocks (many small objects)       260,377        260,388     468,324
 *   log dump (one big string)                263,124        263,135     263,155
 *
 *   - envelope: `{"output":` + `}` is +11 characters. Negligible.
 *   - PRETTY-PRINTING: up to 1.80x, on the many-small-objects shape. A script
 *     or `curl` caller pretty-prints; the editor sends compact.
 *   - MULTIBYTE: `readWriteBody`'s first check compares `content-length`, which
 *     is UTF-8 BYTES, against this number, while its second compares
 *     `text.length`, which is UTF-16 code units. A maximal BMP CJK payload
 *     measures 262,139 code units and 786,406 bytes: 3.00x. A cap that does not
 *     clear 3x the code-unit size refuses a legal CJK fixture at the declared-
 *     size check, before a byte is read.
 *
 * 262,144 x 1.80 x 3.00 = 1,415,577. Rounded up: 2,000,000, a 41% margin. That
 * product is itself an over-estimate -- ASCII structure and CJK content cannot
 * both be maximised in one document -- so it errs safe.
 *
 * WHAT IT STILL REFUSES, stated because the honest claim is narrower than "no
 * legal payload is refused". Pretty-printing is NOT bounded by 1.80x in
 * general: indentation grows with nesting depth and sample data has no nesting
 * cap of its own (the depth-64 bound in `runtime/workflow-readiness.ts` is on a
 * step graph's inputs, not on a fixture). A legal payload nested ~30 deep and
 * pretty-printed, or one escaped `\uXXXX` character by character (measured at
 * exactly 6.00x) and then pretty-printed, exceeds this. So the guarantee is:
 * no body a shipped client produces is refused, and no plausibly hand-written
 * one either. A body that needs 8x its payload in whitespace and escapes is
 * padding, and it is told the limit.
 *
 * PARSE COST on this runtime, so "a bigger number is still a bound" is shown
 * rather than asserted: 259 KB 0.07 ms, 518 KB 0.48 ms, 1 MB 0.95 ms,
 * 2 MB 1.88 ms, 4 MB 4.00 ms, 16.5 MB 17.50 ms. Linear, ~1.9 ms at the cap,
 * against no bound at all before this.
 *
 * NOT the version routes' 4,000,000, and the difference is the point: that one
 * is sized against a 100-node step graph plus its `uiMeta` orphan twins, and
 * this one against a single fixture with a 256 KB payload ceiling. Reusing it
 * would have been the guess #598 refused to make.
 */
const SAMPLE_DATA_MAX_BODY_BYTES = 2_000_000;

/**
 * Read and parse a write body, refusing an oversized one before it costs
 * anything to hold.
 *
 * Declared size first, so nothing is read off the socket for an obviously
 * oversized request; then the actual text, because a chunked body declares no
 * `content-length`. String length is compared against a BYTE cap on purpose:
 * a string's UTF-8 encoding is never shorter than its UTF-16 code-unit count,
 * so this never rejects a body that is within the byte cap, and an
 * all-multibyte body is bounded within a small factor above it. Copied from the
 * waitpoint ingress, including that reasoning.
 *
 * `maxBytes` is a parameter rather than a constant so the flow routes and the
 * version routes share one reader: the version body is four times the size and
 * answering "which guard fired" should not depend on which of two near-identical
 * readers a route happened to call. The refusal NAMES the limit, because the
 * likeliest legitimate way to hit it is a large CODE step and a bare "too large"
 * gives the author nothing to act on.
 *
 * `allowEmpty` is for the routes where an absent body IS the contract:
 * `/publish` with no body locks the latest draft, and `/run` with none is a
 * plain production run (#649). An empty or whitespace-only body then reads as
 * `{}` instead of "body must be valid JSON". It is decided on the TEXT, after
 * both size checks, not on `req.body === null` or `content-length`: an empty
 * chunked body has a non-null stream and no length, and the routes this
 * replaced already accepted whitespace. Off by default, so the routes that
 * require a body keep refusing an empty one.
 */
async function readWriteBody(
  req: Request,
  maxBytes: number,
  opts: { allowEmpty?: boolean } = {},
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const tooLarge = () => err(`request body too large; the limit is ${maxBytes} bytes`, 413);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: tooLarge() };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: err("failed to read request body") };
  }
  if (text.length > maxBytes) {
    return { error: tooLarge() };
  }
  if (opts.allowEmpty && !text.trim()) {
    return { body: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: err("body must be valid JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: err("body must be a JSON object") };
  }
  return { body: parsed as Record<string, unknown> };
}

/**
 * Ceiling on a version's `displayName`, which is what `manage_workflow`'s
 * `summarizeFlow` reports as a flow's `name` (#598).
 *
 * `name` is the half of #598 that is easy to wave through, because a workflow
 * name looks operator-written. It is not: this route family let a caller write
 * any string of any length, `compose` sets it from the composer LLM's own
 * output, and it reaches the chat model on nine actions. An uncapped one also
 * overran the tool's own listing budget -- see `FLOW_NAME_MAX_CHARS` in
 * `actions/tools/manage-workflow.ts`, which is the read-side bound that covers
 * rows written before this check existed.
 *
 * 512 here against a 200-character read cap on purpose: the API and the
 * dashboard may reasonably carry a longer name than the prompt wants to spend
 * tokens on, and the two caps answer different questions.
 */
const FLOW_DISPLAY_NAME_MAX_CHARS = 512;

/**
 * The caller's `displayName`, or the refusal. Same shape as
 * `readWriteBody`, and it returns the NARROWED string so a caller cannot
 * validate and then pass the unnarrowed value on.
 */
function validDisplayName(raw: unknown): { name: string } | { error: Response } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: err("displayName is required and must be a non-empty string") };
  }
  if (raw.length > FLOW_DISPLAY_NAME_MAX_CHARS) {
    return {
      error: err(
        `displayName is ${raw.length} characters; the limit is ${FLOW_DISPLAY_NAME_MAX_CHARS}`,
        413,
      ),
    };
  }
  return { name: raw };
}

/**
 * Why a caller's `metadata` is refused, or null when it is acceptable.
 *
 * The type check is not cosmetic: `body.metadata` was only ever CAST to
 * `Record<string, unknown> | null`, so a string, a number or an array all
 * reached the column and came back out of `parseFlowMetadata` as something that
 * is not an object, in a field every reader treats as one.
 *
 * The prototype-key rejection is DEFENCE IN DEPTH and is not claimed to be more
 * than that. `JSON.parse` defines `__proto__` as an ordinary own property
 * rather than invoking the setter, and all three readers nest the value and
 * re-serialize it rather than merging it, so such a key is inert in this repo
 * today. It stops being inert if a consumer ever `Object.assign`s it -- and one
 * consumer is outside this repo, since `workflows/sandbox-api/routes/flows.ts`
 * hands the value to the vendored activepieces engine. Only TOP-LEVEL keys are
 * refused, so this is a cheap narrowing of that surface and not a guarantee
 * about nested ones. No writer in the repo uses these keys.
 *
 * Returns the HTTP status with the message because the two rejections are
 * different answers: a wrong shape is the caller's bug (400), and an oversized
 * document is a policy limit (413, as every other size refusal in this file
 * returns).
 */
function metadataRejection(metadata: unknown): { message: string; status: number } | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { message: "metadata must be a JSON object or null", status: 400 };
  }
  for (const key of ["__proto__", "constructor", "prototype"]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      return { message: `metadata must not carry a ${key} key`, status: 400 };
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    // Catches a circular reference AND stack exhaustion from an extremely
    // deeply nested document, which `JSON.stringify` raises as a RangeError
    // where `JSON.parse` survives it. Either way the caller gets a 400 instead
    // of the handler throwing into a 500.
    return { message: "metadata must be JSON-serializable", status: 400 };
  }
  if (serialized.length > FLOW_METADATA_MAX_CHARS) {
    return {
      message: `metadata is ${serialized.length} characters; the limit is ${FLOW_METADATA_MAX_CHARS}`,
      status: 413,
    };
  }
  return null;
}

const trapErrors = async (fn: () => Promise<Response> | Response): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkflowReadinessError) return ok({ error: e.message, code: e.code, ...e.readiness }, e.status);
    if (e instanceof FlowVersionRequestError) return err(e.message, e.status);
    // A refused CODE step is a permission answer, not a bad request: the flow
    // is well-formed and the caller is told exactly which grant is missing.
    if (e instanceof CodeStepsRefusedError) return err(e.message, e.status);
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return err(msg, 404);
    return err(msg, 500);
  }
};

const isStatus = (v: unknown): v is FlowStatus => v === "ENABLED" || v === "DISABLED";

/** The three values `app_connection.status` may hold, for the PATCH check. */
const CONNECTION_STATUSES: readonly AppConnectionStatus[] = ["ACTIVE", "MISSING", "ERROR"];

/**
 * The refusal for a sample-data `stepName` this route will not use as a map
 * key, or null (#635). Returns the Response rather than throwing, the shape
 * `metadataRejection` uses.
 */
function sampleStepNameRefusal(stepName: string): Response | null {
  // The three names that are not a step name but a prototype slot. Refused for
  // the same reason `metadataRejection` refuses them in this file, and it is
  // the SAME authority rather than a stricter one: `runtime/workflow-readiness.ts`
  // already lists `connections`, `__proto__`, `prototype` and `constructor` as
  // reserved, so no legal graph has a node by these names.
  //
  // It also closes a silent no-op. `current[stepName] = output` on a
  // `JSON.parse` result invokes `Object.prototype.__proto__`'s SETTER rather
  // than creating an own property, so `PATCH .../sample-data/__proto__`
  // answered 200 having stored nothing -- and on an empty map it wrote the
  // column to NULL. Nothing was polluted (`JSON.stringify` walks own
  // enumerable keys only), but the caller was told its fixture was saved.
  if (["__proto__", "prototype", "constructor"].includes(stepName)) {
    return err(`stepName "${stepName}" is reserved`);
  }
  if (stepName.length <= SAMPLE_DATA_STEP_NAME_MAX_CHARS) return null;
  return err(
    `stepName is ${stepName.length} characters; the limit is ${SAMPLE_DATA_STEP_NAME_MAX_CHARS}`,
    413,
  );
}

export interface CreateWorkflowRoutesOptions {
  /**
   * Optional trigger manager. When provided, every flow status / version
   * change calls `triggerManager.refresh(flowId)` so cron/webhook/event
   * subscriptions reconcile to the current state. Without it, mutations are
   * still persisted but triggers won't fire (manual `/run` still works).
   */
  triggerManager?: TriggerManager;
  /**
   * Optional piece catalog. Either the legacy `JarvisPieceRegistry` (during
   * the F-K transition) or an engine-extracted `PieceCatalog`. When
   * provided, `GET /api/workflows/pieces` returns the list of pieces (and
   * their actions and triggers) so the dashboard editor can render a piece
   * picker. Without it, the catalog endpoint returns an empty list.
   */
  pieceRegistry?: PieceLookup;
  /**
   * Config-resolved ready-made pieces dir (workflows.pieces_dir, ${version}
   * expanded). `undefined` falls back to the env var; `null` = definitively
   * none. Same convention as `piecesManagedByHost`, which is the only thing
   * these routes do with it: SET means this install's pieces are host-managed
   * and the Library serves its managed shape.
   */
  sharedPiecesDir?: string | null;
  /**
   * Optional inventory of the machines a step can run on (sidecars + this
   * host, each with its OS). When provided, locking a version returns
   * `osWarnings` for steps whose command / executable / path cannot run on
   * any machine that could receive them.
   *
   * This is the editor's only OS check: a flow drawn by hand never passes
   * through the composer, which is where the same rules run for a composed
   * one. Advisory by design -- the lock still succeeds, because a draft may
   * legitimately target a machine that is not enrolled yet.
   */
  executionTargets?: () => ExecutionTarget[];
  /**
   * Optional credential resolver. When provided, the connections route can
   * report which `JarvisConnectionSource` adapters are registered (e.g.
   * `jarvis:google` is wired) so the dashboard's piece-side auth picker
   * can highlight reusable Jarvis-managed credentials. The repo-backed
   * `app_connection` rows work without it.
   */
  credentialResolver?: CredentialResolver;
  /**
   * Callback fired after a successful install/uninstall through the Library
   * routes. The daemon wires this to extract metadata for the new piece via
   * the engine and upsert it into the running `PieceCatalog`, so the flow
   * editor sees the piece immediately without a daemon restart.
   *
   * When omitted, install/uninstall still mutate `~/.jarvis/pieces/` and the
   * manifest, but the in-memory catalog won't reflect the change until next
   * daemon start (the reconciler picks it up at bootstrap).
   */
  onPieceLibraryChanged?: (event: {
    kind: "installed" | "uninstalled";
    piece: InstalledPiece;
  }) => Promise<void>;
  /**
   * Optional read-side accessor for `WorkflowEventBuffer.dropped()`. When
   * provided, the triggers list endpoint reports the buffer's overflow
   * counter so operators can see when on-event polling triggers might have
   * missed events past the 10k window.
   */
  getEventBufferDropped?: () => {
    count: number;
    lastDroppedAt: number;
    lastDroppedHeadId: number;
  };
  /**
   * Test seams for the public waitpoint-resume ingress. `now` drives the
   * rate-limit windows (so budget tests advance a fake clock instead of
   * sleeping) and `queueDepth` stands in for the job-queue backlog probe.
   * Production leaves both unset: `Date.now` and `countQueued()`.
   */
  waitpointResumeLimits?: {
    now?: () => number;
    queueDepth?: () => number;
  };
}

/**
 * In-process mutex for the Library routes. Two concurrent installs would
 * race on the shared `~/.jarvis/pieces/package.json` + bun-install
 * invocation; we serialize them at the route boundary. One daemon, one
 * writer.
 */
let libraryMutex: Promise<void> = Promise.resolve();
function withLibraryLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = libraryMutex.then(() => fn());
  libraryMutex = release.then(
    () => undefined,
    () => undefined,
  );
  return release;
}

/**
 * What the Library routes answer on a managed install. Says WHOSE decision it
 * is and that nothing is missing, because the only two ways a client reaches
 * a 403 here are a stale cached bundle and a hand-rolled request -- both of
 * which are read by a person trying to work out what broke.
 */
const MANAGED_MESSAGE =
  "pieces are managed by this install's host: the full catalog is already available, " +
  "and it cannot be installed to or uninstalled from here";

/** Build the workflow route map. Side-effect-free; spread into the daemon's main route table. */
export function createWorkflowRoutes(opts: CreateWorkflowRoutesOptions = {}): WorkflowRouteMap {
  // Resolved ONCE per route map rather than per request: the shared dir comes
  // from config the daemon read at boot and cannot change under a running
  // process, and one value means the GET's shape and the mutations' guard can
  // never disagree about which mode this install is in.
  const managed = piecesManagedByHost(opts.sharedPiecesDir);
  // OS-fit warnings for a version being locked -- the last point a
  // hand-drawn flow can be told its command will never run where it lands.
  // Empty whenever the verdict would be a guess (no inventory, or a machine
  // that never reported its OS).
  const lockOsWarnings = (trigger: unknown): string[] => {
    if (!opts.executionTargets) return [];
    const ctx = osCheckContextFor(opts.executionTargets());
    return ctx ? flowOsWarnings(trigger, ctx) : [];
  };
  // Ingress budgets for the public waitpoint-resume route. Held per route
  // map (not per module) so each `createWorkflowRoutes()` -- one per daemon,
  // one per test -- gets its own windows and nothing leaks between them.
  const resumeClock = opts.waitpointResumeLimits?.now ?? Date.now;
  const resumeQueueDepth = opts.waitpointResumeLimits?.queueDepth ?? countQueued;
  const resumePerId = new KeyedRateLimiter(60_000, WAITPOINT_RESUME_PER_ID_PER_MINUTE, resumeClock);
  const resumeGlobal = new KeyedRateLimiter(60_000, WAITPOINT_RESUME_GLOBAL_PER_MINUTE, resumeClock);
  const resumeUnknownId = new KeyedRateLimiter(
    60_000,
    WAITPOINT_RESUME_UNKNOWN_ID_PER_MINUTE,
    resumeClock,
  );
  const tooManyRequests = (limiter: KeyedRateLimiter, key: string): Response =>
    new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(limiter.retryAfterSeconds(key)),
      },
    });
  /**
   * Charge the per-id and global budgets for one resume attempt, or return
   * the 429 to send. Both are checked before either is charged, so a request
   * refused by the global budget does not silently eat the id's budget too.
   */
  const chargeResumeBudgets = (waitpointId: string): Response | null => {
    if (!resumePerId.check(waitpointId)) return tooManyRequests(resumePerId, waitpointId);
    if (!resumeGlobal.check("*")) return tooManyRequests(resumeGlobal, "*");
    resumePerId.record(waitpointId);
    resumeGlobal.record("*");
    return null;
  };
  const refreshTrigger = (flowId: string): void => {
    if (!opts.triggerManager) return;
    // Fire-and-forget: API responses must not block on engine round-trips
    // that ON_ENABLE may now perform. Catch + log so an enable failure
    // doesn't escape as an unhandled rejection.
    void opts.triggerManager.refresh(flowId).catch((e) => {
      console.warn(
        `[workflow-api] triggerManager.refresh(${flowId}) failed: ${(e as Error).message}`,
      );
    });
  };
  return {
    // ----------------------------------------------------- piece catalog
    "/api/workflows/pieces": {
      GET: () =>
        trapErrors(() => {
          if (!opts.pieceRegistry) return ok([]);
          const list = opts.pieceRegistry.list().map((p) => ({
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            // Piece-level auth declaration -- when present, the editor
            // renders a connection picker so the user picks an
            // existing connection instead of re-entering credentials.
            ...(p.auth ? { auth: p.auth } : {}),
            actions: Object.values(p.actions).map((a) => ({
              name: a.name,
              displayName: a.displayName,
              description: a.description,
              inputSchema: a.inputSchema ?? null,
              // Optional declared output sample (Jarvis extension to AP).
              // Surfaced to the dashboard so the variable picker can show
              // field-level rows for actions that have never been run yet.
              ...(a.outputSample !== undefined ? { outputSample: a.outputSample } : {}),
            })),
            triggers: p.triggers
              ? Object.values(p.triggers).map((t) => ({
                  name: t.name,
                  displayName: t.displayName,
                  description: t.description,
                  inputSchema: t.inputSchema ?? null,
                  // Triggers carry the upstream-native `sampleData`.
                  ...(t.sampleData !== undefined ? { sampleData: t.sampleData } : {}),
                  // And, for symmetry / future-proofing, the action-side
                  // `outputSample` if a trigger author chose to declare both.
                  ...(t.outputSample !== undefined ? { outputSample: t.outputSample } : {}),
                  // Dynamic-output triggers (jarvis-trigger:on_event):
                  // forward the per-input-value sample map so the editor's
                  // variable picker can resolve the right shape for the
                  // configured value (e.g. payload.content for clipboard,
                  // payload.snippet for email).
                  ...(t.dynamicSampleData !== undefined
                    ? { dynamicSampleData: t.dynamicSampleData }
                    : {}),
                }))
              : [],
          }));
          return ok(list);
        }),
    },

    // ------------------------------------------------------------- pieces library
    // The Library tab in the dashboard renders this list. It has two modes,
    // and `managed` (a host-owned shared catalog) picks between them.
    //
    // SELF-MANAGED -- each entry is a *curated* community piece the user can
    // opt into installing. Installed pieces are merged in with their resolved
    // version + install timestamp so the UI can show "Installed" / "Update
    // available" badges. Install / uninstall mutate `~/.jarvis/pieces/`
    // (manifest + bun install) and block until bun finishes -- a first
    // install of a single piece is typically 3-8s end to end, and the UI
    // shows a spinner for the wait. A `withLibraryLock` mutex serializes
    // concurrent requests so a second install can't race the first one's
    // bun-install.
    //
    // MANAGED -- the host installed the whole catalog once per version into a
    // read-only tree every tenant shares, so every entry is already usable
    // and install/uninstall are not the tenant's to make: both mutations are
    // refused, and the list carries no install state and no per-piece detail.
    // The refusal is the guarantee, not the hidden button: the tenant's own
    // `~/.jarvis/pieces` is still writable, so nothing but this guard stops a
    // hand-rolled POST from shadowing a shared piece with an unreviewed copy
    // and spending the tenant's disk quota doing it.
    "/api/workflows/pieces/library": {
      GET: () =>
        trapErrors(async () => {
          // MANAGED (a host owns the catalog): the whole catalog is already
          // installed in the shared tree, so there is no install state to
          // report and nothing the user could act on. Every entry is simply
          // available, and the per-piece specifics an install decision needed
          // -- resolved/vetted version, disk footprint, audit date, license,
          // upstream link -- are dropped from the PAYLOAD rather than merely
          // hidden by the client, so that no client can render them: not a
          // stale cached bundle, not a future one that forgets to check
          // `managed`, not curl.
          if (managed) {
            return ok({
              managed: true,
              entries: CATALOG.map((entry) => ({
                id: entry.id,
                // Kept because the Library's search matches on it -- users
                // type "activepieces" or a package name as readily as a
                // display name. It is not RENDERED on a managed row.
                npmPackage: entry.npmPackage,
                displayName: entry.displayName,
                description: entry.description,
                iconUrl: entry.iconUrl ?? null,
                tier: entry.tier,
              })),
            });
          }
          // Reaching here means NO shared tree is configured -- that is the
          // whole of what `managed` tests -- so every piece that exists on
          // this install got there through the manifest. There is no shared
          // baseline to merge in and no `source: "shared"` case: a
          // deployment either owns the catalog (above) or the user does.
          const manifest = await readManifest();
          const installedById = new Map(
            manifest.pieces.map((p) => [p.id, p]),
          );
          const entries = CATALOG.map((entry) => {
            const installed = installedById.get(entry.id) ?? null;
            return {
              id: entry.id,
              npmPackage: entry.npmPackage,
              versionRange: entry.versionRange,
              displayName: entry.displayName,
              description: entry.description,
              iconUrl: entry.iconUrl ?? null,
              vettedVersion: entry.vettedVersion,
              vettedAt: entry.vettedAt ?? null,
              sourceUrl: entry.sourceUrl,
              licenseSpdx: entry.licenseSpdx,
              estimatedSizeMb: entry.estimatedSizeMb ?? null,
              tier: entry.tier,
              installed: installed
                ? {
                    resolvedVersion: installed.resolvedVersion,
                    installedAt: installed.installedAt,
                    source: "user" as const,
                  }
                : null,
            };
          });
          return ok({ managed: false, entries });
        }),
    },

    "/api/workflows/pieces/library/:id/install": {
      POST: (req) =>
        trapErrors(async () => {
          if (managed) return err(MANAGED_MESSAGE, 403);
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const entry = findCatalogEntry(id);
          if (!entry) return err(`unknown piece id "${id}"`, 404);
          const result = await withLibraryLock(() => installPiece(id));
          if (opts.onPieceLibraryChanged) {
            try {
              await opts.onPieceLibraryChanged({
                kind: "installed",
                piece: result.piece,
              });
            } catch (e) {
              // Install on disk succeeded; catalog refresh failed. Surface
              // a partial-success marker so the UI can warn the user that
              // a daemon restart is needed for the piece to appear in the
              // flow editor's picker.
              return ok(
                {
                  installed: true,
                  catalogRefreshFailed: true,
                  catalogRefreshError: (e as Error).message,
                  piece: result.piece,
                },
                200,
              );
            }
          }
          return ok({ installed: true, piece: result.piece }, 200);
        }),
    },

    "/api/workflows/pieces/library/:id": {
      DELETE: (req) =>
        trapErrors(async () => {
          if (managed) return err(MANAGED_MESSAGE, 403);
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          // Check the manifest BEFORE the catalog. A piece can legitimately
          // be installed but not in the catalog -- we yank entries from the
          // catalog when security advisories drop, and users with the piece
          // already installed need to be able to uninstall. Failing the
          // request because the catalog forgot the piece would strand them.
          const manifest = await readManifest();
          const target = manifest.pieces.find((p) => p.id === id);
          if (!target) {
            // Neither installed nor (necessarily) in the catalog. Return a
            // 404 only when both are absent -- a soft "nothing to do" 200
            // for an idempotent uninstall of something that was never
            // installed would mask user typos.
            if (!findCatalogEntry(id)) {
              return err(`unknown piece id "${id}"`, 404);
            }
            // In-catalog but not installed: idempotent no-op.
            return ok({ uninstalled: true, alreadyAbsent: true });
          }
          await withLibraryLock(() => uninstallPiece(id));
          if (opts.onPieceLibraryChanged) {
            try {
              await opts.onPieceLibraryChanged({
                kind: "uninstalled",
                piece: target,
              });
            } catch {
              // Catalog cleanup failure isn't fatal -- the piece is gone
              // from disk; on next daemon restart it falls out of the
              // catalog naturally.
            }
          }
          return ok({ uninstalled: true });
        }),
    },

    // ------------------------------------------------------------- trigger subs (admin)
    // Snapshot of TriggerManager's active subscriptions. Each entry carries
    // the kind (cron/webhook/event/engine) and an optional `warning` set when
    // the subscription is partially active (e.g. engine returned webhook
    // listeners but route routing is half-set-up). The dashboard's run-history
    // panel surfaces these so users can see which flows are misconfigured
    // even though their status reads ENABLED.
    "/api/workflows/triggers": {
      GET: () =>
        trapErrors(() => {
          if (!opts.triggerManager) return ok([]);
          return ok(opts.triggerManager.list());
        }),
    },

    // Event-buffer overflow signal for the `jarvis-trigger:on_event`
    // polling path. Returns the buffer's running drop counter so operators
    // can see when events may have been evicted past the capacity/age
    // window between two polls. `count > 0` is a warning condition; the
    // dashboard renders a banner. Returns nulls when the daemon hasn't
    // wired the read accessor.
    "/api/workflows/events/buffer-stats": {
      GET: () =>
        trapErrors(() => {
          if (!opts.getEventBufferDropped) {
            return ok({ count: 0, lastDroppedAt: 0, lastDroppedHeadId: 0 });
          }
          return ok(opts.getEventBufferDropped());
        }),
    },

    // ------------------------------------------------------------- connections
    // CRUD over `app_connection` rows + a list of registered Jarvis
    // connection sources. Connection `value` is encrypted at rest
    // (AES-256-GCM via `app-connection` repo) and never returned to the
    // client -- only the metadata (id, externalId, type, displayName,
    // pieceName, etc.) ships out so the dashboard can show what's wired.
    "/api/workflows/connections": {
      GET: () =>
        trapErrors(() => {
          const list = listConnections().map((c) => ({
            id: c.id,
            externalId: c.externalId,
            displayName: c.displayName,
            type: c.type,
            scope: c.scope,
            status: c.status,
            pieceName: c.pieceName,
            pieceVersion: c.pieceVersion,
            ownerId: c.ownerId,
            preSelectForNewProjects: c.preSelectForNewProjects,
            created: c.created,
            updated: c.updated,
            // value intentionally omitted -- secrets stay server-side.
          }));
          const sources = (opts.credentialResolver?.list() ?? []).map((s) => ({
            id: s.id,
          }));
          return ok({ connections: list, jarvisSources: sources });
        }),
      POST: (req) =>
        trapErrors(async () => {
          // Bounded before the parse (#635). Not named by the issue, folded in
          // because it is the same class and strictly worse: unlike the sample
          // routes this one had no post-parse cap of ANY kind, and `value` is
          // `JSON.stringify`'d, encrypted and stored.
          //
          // `FLOW_WRITE_MAX_BODY_BYTES` rather than a measured number of its
          // own, which is the one reuse in this file that answers the same
          // question the budget was sized for: a small structured row. The
          // largest realistic `value` is a Google service-account JSON key
          // (~2.3 KB) or a PEM key and chain (~3-10 KB), so 256 KB is over 25x
          // the largest real one and a measured figure here would be false
          // precision.
          //
          // This also fixes a 500. A bare `req.json()` threw a `SyntaxError` on
          // a malformed body, whose message matches none of `trapErrors`'
          // patterns, so the caller got a 500 carrying the JSON parser's text.
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            externalId?: string;
            displayName?: string;
            type?: AppConnectionType;
            pieceName?: string;
            pieceVersion?: string;
            value?: Record<string, unknown>;
          };
          if (!body.externalId || typeof body.externalId !== "string") {
            return err("externalId is required");
          }
          if (!body.displayName || typeof body.displayName !== "string") {
            return err("displayName is required");
          }
          if (!body.type) return err("type is required");
          if (!body.pieceName || typeof body.pieceName !== "string") {
            return err("pieceName is required");
          }
          if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
            return err("value must be an object");
          }
          // Soft schema check per type. Catches the common mistake of saving
          // an OAUTH2 connection with no `access_token` (the piece would
          // later fail with a confusing "auth missing" at run time).
          const schemaError = validateConnectionValueShape(body.type, body.value);
          if (schemaError) return err(schemaError);
          const conn = upsertConnection({
            externalId: body.externalId,
            displayName: body.displayName,
            type: body.type,
            pieceName: body.pieceName,
            pieceVersion: body.pieceVersion ?? "0.0.0",
            value: body.value,
          });
          return ok(
            {
              id: conn.id,
              externalId: conn.externalId,
              displayName: conn.displayName,
              type: conn.type,
              pieceName: conn.pieceName,
              status: conn.status,
              created: conn.created,
            },
            201,
          );
        }),
    },

    "/api/workflows/connections/:id": {
      DELETE: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const existing = getConnection(id);
          if (!existing) return err("connection not found", 404);
          deleteConnection(id);
          return ok({ id, deleted: true });
        }),
      // Update an existing connection in place. Used to rotate OAuth tokens
      // / API keys without the delete-then-recreate gap (during which any
      // in-flight run resolving the externalId would 404). Body accepts a
      // partial: `displayName`, `value` (full replacement), `status`. The
      // encrypted-at-rest layer wraps the updated `value` automatically.
      PATCH: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const existing = getConnection(id);
          if (!existing) return err("connection not found", 404);
          // Bounded before the parse, same budget and same reasoning as the
          // POST above (#635). The `.catch(() => ({}))` it replaces turned a
          // malformed body into a silent 200 no-op; it is a 400 now.
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            displayName?: string;
            value?: Record<string, unknown>;
            status?: unknown;
          };
          // Checked rather than cast. `value` and `displayName` either side of
          // it are both validated and this one was not, so a bogus status
          // reached SQLite -- where `app_connection`'s own
          // `CHECK(status IN ('ACTIVE','MISSING','ERROR'))` refused it and
          // `trapErrors` turned the constraint violation into a 500 carrying
          // SQLite's text. So nothing bad was ever STORED; what this fixes is
          // the answer, from a 500 to a 400 that names the three values.
          if (body.status !== undefined && !CONNECTION_STATUSES.includes(body.status as AppConnectionStatus)) {
            return err(`status must be ${CONNECTION_STATUSES.join("|")} if provided`);
          }
          const status = body.status as AppConnectionStatus | undefined;
          if (
            body.value !== undefined &&
            (body.value === null || typeof body.value !== "object" || Array.isArray(body.value))
          ) {
            return err("value must be an object if provided");
          }
          if (
            body.displayName !== undefined &&
            (typeof body.displayName !== "string" || body.displayName.length === 0)
          ) {
            return err("displayName must be a non-empty string if provided");
          }
          // Apply the same per-type schema check POST runs. Type can't change
          // via PATCH (rotation, not re-creation), so we use existing.type.
          // Without this, a rotation could save an OAUTH2 connection with no
          // access_token that POST would have rejected.
          if (body.value !== undefined) {
            const schemaError = validateConnectionValueShape(existing.type, body.value);
            if (schemaError) return err(schemaError);
          }
          const merged = upsertConnection({
            externalId: existing.externalId,
            displayName: body.displayName ?? existing.displayName,
            type: existing.type,
            pieceName: existing.pieceName,
            pieceVersion: existing.pieceVersion,
            value: body.value ?? existing.value,
            ...(status ? { status } : {}),
          });
          return ok({
            id: merged.id,
            externalId: merged.externalId,
            displayName: merged.displayName,
            type: merged.type,
            pieceName: merged.pieceName,
            status: merged.status,
            updated: merged.updated,
          });
        }),
    },

    // ------------------------------------------------------------- waitpoint resume
    // Public webhook URL for resuming a paused flow. The `resumeUrl` minted
    // by `POST /v1/waitpoints` (called by piece actions via
    // `context.run.createWaitpoint`) routes here. Hits enqueue
    // RUN_FLOW(executionType=RESUME) with the request body as resumePayload;
    // the engine wakes the paused run from the persisted execution state.
    //
    // Idempotent: a second hit with the same waitpoint id returns 410, so
    // a flaky external service that retries doesn't re-fire the run.
    //
    // Status guard: only `PAUSED` runs can be resumed. A waitpoint whose run
    // subsequently FAILED / TIMEOUT / STOPPED is unrecoverable -- returning
    // 409 here surfaces that to the resumer instead of letting the engine
    // reject the operation obscurely.
    //
    // Ingress guards, in the order they run. This route is unauthenticated by
    // design (an external caller resuming a waitpoint is the intended use),
    // so the waitpoint id is the only credential -- see the bearer-capability
    // note in `db/repos/waitpoint.ts`. What stands behind it:
    //   1. backlog cap    -> 503, before any budget is spent, so a sender
    //                        retrying into a full queue keeps getting the
    //                        503 and its Retry-After rather than flipping
    //                        to 429.
    //   2. unknown id     -> charged to its own enumeration budget, then 404.
    //   3. known id       -> charged to the per-id + global budgets.
    //   4. body cap       -> 413, declared size first (no read at all), then
    //                        the actual size for bodies that declare none.
    //
    // On the response codes being distinct (404 / 403 / 410 / 409): only the
    // 404 is reachable without already holding a valid waitpoint id, so the
    // set is not an oracle an enumerator can use -- telling 410 from 409
    // requires the capability that the enumeration is trying to find. The
    // enumeration budget is what makes guessing expensive; collapsing 410 and
    // 409 would only blind the legitimate resumer, who needs to tell "already
    // resumed, nothing to do" from "this run is dead, stop retrying".
    "/api/webhooks/waitpoints/:id": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          let queued = 0;
          try {
            queued = resumeQueueDepth();
          } catch {
            // A probe failure must not close the ingress.
          }
          if (queued >= MAX_QUEUED_WEBHOOK_RUNS) {
            return new Response(JSON.stringify({ error: "Service busy, retry later" }), {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "30" },
            });
          }
          const wp = getWaitpoint(id);
          if (!wp) {
            // Enumeration budget, kept apart from the budgets a real resume
            // draws on: a probe flood burns this one out and gets 429s while
            // legitimate resumes keep their full allowance.
            if (!resumeUnknownId.allow("*")) return tooManyRequests(resumeUnknownId, "*");
            return err("waitpoint not found", 404);
          }
          const limited = chargeResumeBudgets(id);
          if (limited) return limited;
          // Declared body size, checked before the row is touched further and
          // before anything is read off the socket.
          const declared = Number(req.headers.get("content-length") ?? "0");
          if (Number.isFinite(declared) && declared > WAITPOINT_RESUME_MAX_BODY_BYTES) {
            return err("resume payload too large", 413);
          }
          const ownedEffect = getWorkflowDb().query('SELECT id FROM workflow_effect WHERE waitpoint_id=?').get(id);
          if (ownedEffect) return err('This waitpoint is owned by Authority; resolve its approval request', 403);
          if (wp.resumedAt !== null) return err("waitpoint already resumed", 410);
          const run = getFlowRun(wp.flowRunId);
          if (!run) return err("waitpoint references a missing run", 410);
          if (run.status !== "PAUSED") {
            return err(
              `waitpoint cannot be resumed: run status is ${run.status} (expected PAUSED)`,
              409,
            );
          }
          // Body is the resumePayload delivered to the paused step. Read as
          // text so the actual size can be capped (a chunked body declares no
          // content-length), then parsed. Empty and non-JSON bodies stay
          // tolerated -- some webhook senders POST form-encoded or nothing at
          // all -- and fall back to {}. A body that IS valid JSON but is not
          // an object is refused rather than silently replaced with {}:
          // resuming a step with a payload the sender never sent is worse
          // than telling the sender its payload was the wrong shape.
          let rawBody: string;
          try {
            rawBody = await req.text();
          } catch {
            return err("failed to read request body");
          }
          // String length, like the sibling ingress. A string's UTF-8 encoding
          // is never shorter than its UTF-16 code-unit count, so this never
          // rejects a body that is actually within the byte cap; an
          // all-multibyte body is bounded within a small factor above it.
          if (rawBody.length > WAITPOINT_RESUME_MAX_BODY_BYTES) {
            return err("resume payload too large", 413);
          }
          let resumePayload: Record<string, unknown> = {};
          if (rawBody.trim()) {
            let parsed: unknown;
            let isJson = true;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              isJson = false;
            }
            if (isJson) {
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return err("resume payload must be a JSON object");
              }
              resumePayload = parsed as Record<string, unknown>;
            }
          }
          // Reading a request body yields; cancellation may have won meanwhile.
          if (getFlowRun(wp.flowRunId)?.status !== "PAUSED") return err("run is no longer paused", 409);
          if (!markWaitpointResumed(id)) return err("waitpoint already resumed", 410);
          enqueue({
            jobType: "RUN_FLOW",
            payload: {
              runId: wp.flowRunId,
              executionType: "RESUME",
              resumePayload,
            },
            flowRunId: wp.flowRunId,
            // RESUME jobs especially shouldn't retry: re-resuming an
            // already-resumed waitpoint would walk past it with stale
            // payload state. One shot per webhook hit.
            maxAttempts: 1,
          });
          return ok({ runId: wp.flowRunId, waitpointId: id, resumed: true }, 202);
        }),
    },

    // Read-only upgrade audit using the same inventory and compiler as activation.
    "/api/workflows/readiness": {
      GET: (req) => trapErrors(() => {
        const params = new URL(req.url).searchParams;
        const { limit, offset } = clampPage(params, 100);
        const flows = listFlows(undefined, { status: 'ENABLED', limit, offset });
        return ok({ items: flows.map(flow => {
          const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
          return { flowId: flow.id, versionId, readiness: versionId ? versionReadiness(flow.id, versionId) : {
            ready: false, runtimeChecks: [], issues: [{ node: 'trigger', path: 'graph', code: 'VERSION', message: 'No executable version' }],
          } };
        }), nextOffset: flows.length === limit ? offset + limit : null });
      }),
    },

    // ------------------------------------------------------------------ flows
    "/api/workflows": {
      GET: (req) =>
        trapErrors(() => {
          const params = new URL(req.url).searchParams;
          const status = params.get("status");
          // Clamped the way the `/readiness` sibling twelve lines up clamps,
          // and for a reason #598 made concrete: `serializeFlow` emits each
          // row's FULL metadata, including rows written before the cap existed
          // and deliberately never migrated. An unclamped `limit` let one
          // authenticated request pull every one of them at once.
          const { limit, offset } = clampPage(params, 100);
          const opts: { status?: FlowStatus; limit: number; offset: number } = { limit, offset };
          if (status !== null) {
            if (!isStatus(status)) return err(`status must be ENABLED|DISABLED`, 400);
            opts.status = status;
          }
          const flows = listFlows(undefined, opts);
          return ok(flows.map(serializeFlow));
        }),
      POST: (req) =>
        trapErrors(async () => {
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            displayName?: string;
            externalId?: string;
            metadata?: Record<string, unknown> | null;
          };
          const named = validDisplayName(body.displayName);
          if ("error" in named) return named.error;
          const rejected = metadataRejection(body.metadata);
          if (rejected) return err(rejected.message, rejected.status);
          // `externalId` is deliberately NOT validated here. #598's subject is
          // the `flow` columns that reach the chat model through
          // `summarizeFlow`, and `externalId` is not one of them -- it is
          // guarded by `uq_flow_external` instead. Looked at and left, so the
          // enumeration above is a decision rather than an oversight.
          const flow = createFlow({
            externalId: body.externalId,
            metadata: body.metadata ?? null,
          });
          const version = createDraftVersion({
            flowId: flow.id,
            displayName: named.name,
            // Seed an EMPTY (manual) trigger so the visual editor has a valid
            // FlowStepNode to render on a freshly created flow. Without this
            // the trigger defaults to `{}`, which the editor can't traverse
            // and the engine can't run. Users morph to PIECE_TRIGGER inside
            // the editor when they pick a real trigger.
            trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" },
          });
          return ok({ flow: serializeFlow(flow), version }, 201);
        }),
    },

    "/api/workflows/:id": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const flow = getFlow(id);
          if (!flow) return err("flow not found", 404);
          const draft = getLatestDraft(id);
          const published = flow.published_version_id
            ? getFlowVersion(flow.published_version_id)
            : null;
          // Sidecar layout / orphan list for whichever version the editor
          // will mount (draft preferred, falls back to published). The
          // editor calls this once on open so it can lay out nodes at the
          // positions the user left them.
          const editableId = draft?.id ?? published?.id ?? null;
          const uiMeta = editableId ? getFlowVersionUiMeta(editableId) : null;
          return ok({
            flow: serializeFlow(flow),
            latestDraft: draft,
            published,
            uiMeta,
          });
        }),
      PATCH: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            status?: FlowStatus;
            metadata?: Record<string, unknown> | null;
          };
          // BOTH fields are validated before EITHER is written. They used to be
          // checked one at a time as they were applied, so a request carrying a
          // good `status` and a bad `metadata` changed the status and then
          // failed -- a partial write the caller was never told about.
          if (body.status !== undefined && !isStatus(body.status)) {
            return err("status must be ENABLED|DISABLED");
          }
          const rejected = metadataRejection(body.metadata);
          if (rejected) return err(rejected.message, rejected.status);
          if (body.status !== undefined) updateFlowStatus(id, body.status);
          if (body.metadata !== undefined) updateFlowMetadata(id, body.metadata);
          if (body.status !== undefined) refreshTrigger(id);
          const flow = getFlow(id);
          return flow ? ok(serializeFlow(flow)) : err("flow not found", 404);
        }),
      DELETE: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          deleteFlow(id);
          refreshTrigger(id);
          return ok({ ok: true });
        }),
    },

    // ----------------------------------------------------------------- versions
    "/api/workflows/:id/versions": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          if (!getFlow(id)) return err("flow not found", 404);
          return ok(listVersions(id));
        }),
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          // Bounded BEFORE the parse (#609). This body carries the whole step
          // graph plus `uiMeta`, so an unguarded `req.json()` materialized a
          // caller's object graph of any size in the one process that serves
          // this API, the dashboard and the agent runtime.
          const read = await readWriteBody(req, VERSION_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            displayName?: string;
            trigger?: Record<string, unknown>;
            uiMeta?: FlowVersionUiMeta;
          };
          if (!getFlow(id)) return err("flow not found", 404);
          // Used to be a bare truthiness check, so a non-string of any length
          // reached the column that becomes a flow's model-facing `name` (#598).
          const named = validDisplayName(body.displayName);
          if ("error" in named) return named.error;
          // `uiMeta` is checked BEFORE the insert, not after (#632). There is
          // no transaction around the two writes below, so a malformed `uiMeta`
          // checked inside `upsertFlowVersionUiMeta` would have created the
          // draft row and then answered 400 -- and a new draft becomes the
          // LATEST draft, which is the version an ENABLED flow with nothing
          // published actually runs. A refused request must not promote a live
          // draft. Same rule as `displayName` above.
          if (body.uiMeta) {
            const refusal = uiMetaRefusal(body.uiMeta);
            if (refusal) return err(refusal.message, refusal.status);
          }
          const version = createDraftVersion({
            flowId: id,
            displayName: named.name,
            trigger: body.trigger,
          });
          if (body.uiMeta) upsertFlowVersionUiMeta(version.id, body.uiMeta);
          return ok(version, 201);
        }),
    },

    "/api/workflows/:id/versions/:versionId": {
      GET: (req) =>
        trapErrors(() => {
          const { id, versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          return ok(withOwnedFlowVersion(id, versionId, () => ({
            ...getFlowVersion(versionId)!, uiMeta: getFlowVersionUiMeta(versionId),
          })));
        }),
      PATCH: (req) =>
        trapErrors(async () => {
          const { id, versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          // Bounded before the parse, same reason as the POST above (#609). This
          // is the route the visual editor saves through, so it is the one that
          // carries a real graph on every keystroke-driven save.
          const read = await readWriteBody(req, VERSION_WRITE_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as {
            displayName?: string;
            trigger?: Record<string, unknown>;
            connectionIds?: unknown;
            agentIds?: unknown;
            uiMeta?: FlowVersionUiMeta;
          };
          // PICKED, never spread (#632). This used to be
          // `const { uiMeta, ...versionPatch } = body` on a body that is a CAST
          // and not a schema, so every remaining key went to
          // `updateDraftVersion` -- which accepted `updatedBy` (an attribution
          // column, letting a caller claim someone else edited the draft),
          // `backupFiles` (a filename -> file-CONTENT map no shipped caller
          // writes) and `notes`. All three are gone from
          // `UpdateDraftVersionInput` and from its UPDATE as well, so this
          // allowlist is the second of two controls rather than the only one.
          //
          // `valid` is deliberately NOT forwarded even though the repo still
          // accepts it: the UPDATE always recomputes it from `graphReadiness`,
          // so forwarding it would advertise a writable field that is not one.
          //
          // BEHAVIOUR CHANGE, stated because it is not only a tightening: the
          // three dropped fields are IGNORED rather than refused, so a client
          // still sending one keeps working -- but `connectionIds`, `agentIds`
          // and `uiMeta` now answer 400 for a shape that used to be stored and
          // then silently misread. No shipped caller sends those shapes
          // (`ui/src/v2/rooms/workflows/useWorkflowEditor.ts` sends exactly
          // `displayName`, `trigger` and `uiMeta`).
          const versionPatch: UpdateDraftVersionInput = {};
          if (body.trigger !== undefined) versionPatch.trigger = body.trigger;
          // Checked rather than cast, for the reason #598 gave for `metadata`:
          // these are `JSON.stringify`'d straight into columns that
          // `rowToFlowVersion` hands back TYPED as `string[]`, so a bare cast
          // is a claim the whole read side believes.
          for (const [key, raw] of [["connectionIds", body.connectionIds], ["agentIds", body.agentIds]] as const) {
            if (raw === undefined) continue;
            if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
              return err(`${key} must be an array of strings if provided`);
            }
            versionPatch[key] = raw as string[];
          }
          // `displayName` is OPTIONAL on a patch, so it is validated only when
          // present -- but it used to reach `updateDraftVersion` with no
          // validation at all, which made this the loosest of the three writers
          // of a flow's model-facing `name` (#598). Checked before the
          // transaction, so a bad name cannot half-apply a patch.
          const uiMeta = body.uiMeta;
          if (body.displayName !== undefined) {
            const named = validDisplayName(body.displayName);
            if ("error" in named) return named.error;
            // The NARROWED value goes on, so this cannot validate one string
            // and forward another. Identical today because the validator
            // transforms nothing; the point is that it stays true if it ever
            // does.
            versionPatch.displayName = named.name;
          }
          const v = withOwnedFlowVersion(id, versionId, () => {
            const updated = updateDraftVersion(versionId, versionPatch);
            // The content and its editor layout must commit together.
            if (uiMeta) upsertFlowVersionUiMeta(versionId, uiMeta);
            return updated;
          });
          return ok(v);
        }),
    },

    "/api/workflows/:id/versions/:versionId/readiness": {
      GET: (req) => trapErrors(() => {
        const { id, versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
        return ok(versionReadiness(id, versionId));
      }),
    },

    "/api/workflows/:id/versions/:versionId/lock": {
      POST: (req) =>
        trapErrors(() => {
          const { id, versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          // Lock mutates the same row state DRAFT -> LOCKED, so the sidecar
          // (keyed on versionId) already follows. No copy needed; mentioned
          // here so future readers know that's by design.
          const locked = withOwnedFlowVersion(id, versionId, () => { assertVersionReady(id, versionId); return lockVersion(versionId); });
          const osWarnings = lockOsWarnings(locked.trigger);
          return ok(osWarnings.length > 0 ? { ...locked, osWarnings } : locked);
        }),
    },

    // ------------------------------------------------- per-version sample data
    // The version's `sampleData` map (stepName -> output) feeds the engine's
    // "test from here" path so a step's preceding outputs resolve without
    // re-running the chain. Editable per-step via this PATCH; the entire map
    // can be cleared via the DELETE below.
    //
    // DRAFT-only: locked versions are immutable to user edits. The repo
    // enforces; the route just surfaces errors with a clear message.
    "/api/workflows/:id/versions/:versionId/sample-data/:stepName": {
      PATCH: (req) =>
        trapErrors(async () => {
          const { id, versionId, stepName } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const badName = sampleStepNameRefusal(stepName);
          if (badName) return badName;
          // Bounded BEFORE the parse (#635). The per-entry cap below can only
          // run once `req.json()` has already materialized the caller's object
          // graph, in the one process that serves this API, the dashboard and
          // the agent runtime -- which is exactly what `readWriteBody` exists
          // to avoid.
          //
          // BEHAVIOUR CHANGE. The `.catch(() => ({}))` this replaces meant a
          // malformed or ABSENT body became `{}`, so `output` fell to `null`
          // and the step's entry was silently CLEARED with a 200. A body that
          // parsed to a non-object (`[1,2,3]`) did the same, and `null` or `5`
          // threw a TypeError that `trapErrors` turned into a 500. All four are
          // a 400 now. Sending `{}` still clears, which is the documented way
          // (`output: undefined` is the same as null) and what every shipped
          // caller and the existing test do -- but a request that said nothing
          // no longer deletes data.
          const read = await readWriteBody(req, SAMPLE_DATA_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as { output?: unknown };
          // `output: null` clears the entry; `output: undefined` (missing
          // key) is the same as null. Anything else stores as the entry.
          const output = body.output === undefined ? null : body.output;
          // Soft cap: each step's serialized sample output. Prevents a typo
          // (or a pasted log dump) from bloating flow_version.sample_data
          // into multi-MB JSON we'd parse on every read. 256KB per entry is
          // enough for realistic test payloads (e.g., a Gmail message body)
          // and small enough to keep DB reads fast.
          if (output !== null) {
            const serialized = JSON.stringify(output);
            if (serialized.length > SAMPLE_DATA_ENTRY_MAX_BYTES) {
              return err(
                `sample output for "${stepName}" exceeds ${SAMPLE_DATA_ENTRY_MAX_BYTES} bytes (got ${serialized.length}); store large fixtures elsewhere and reference them by id`,
                413,
              );
            }
          }
          const v = withOwnedFlowVersion(id, versionId, () => setSampleDataEntry(versionId, stepName, output));
          return ok({ versionId: v.id, sampleData: v.sampleData });
        }),
      DELETE: (req) =>
        trapErrors(() => {
          // Clear ALL sample-data entries on this version, for the editor's
          // "reset all" action. Not sugar over the per-step PATCH -- it
          // replaces the whole map rather than one key -- and it ignores
          // `stepName` entirely, which is why no name check runs here: no key
          // is written.
          const { id, versionId } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const v = withOwnedFlowVersion(id, versionId, () => replaceSampleData(versionId, null));
          return ok({ versionId: v.id, sampleData: v.sampleData });
        }),
    },

    // Per-step sample INPUT (override applied during test-from-here runs).
    // Mirror of sample-data above but writes to the `sample_input`
    // column. Same DRAFT-only semantic and per-entry size cap.
    "/api/workflows/:id/versions/:versionId/sample-input/:stepName": {
      PATCH: (req) =>
        trapErrors(async () => {
          const { id, versionId, stepName } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const badName = sampleStepNameRefusal(stepName);
          if (badName) return badName;
          // Bounded before the parse, same cap and same behaviour change as
          // the sample-data PATCH above (#635).
          const read = await readWriteBody(req, SAMPLE_DATA_MAX_BODY_BYTES);
          if ("error" in read) return read.error;
          const body = read.body as { input?: unknown };
          // `input: null` clears; `input: undefined` (missing) same as null.
          // Anything else is stored; must be a plain object since it
          // replaces the step's `settings.input` shape at runtime.
          const input = body.input === undefined ? null : body.input;
          if (input !== null) {
            if (typeof input !== "object" || Array.isArray(input)) {
              return err(
                `sample input for "${stepName}" must be a JSON object (replaces settings.input at test time)`,
                400,
              );
            }
            const serialized = JSON.stringify(input);
            if (serialized.length > SAMPLE_DATA_ENTRY_MAX_BYTES) {
              return err(
                `sample input for "${stepName}" exceeds ${SAMPLE_DATA_ENTRY_MAX_BYTES} bytes (got ${serialized.length})`,
                413,
              );
            }
          }
          const v = withOwnedFlowVersion(id, versionId, () => setSampleInputEntry(
            versionId,
            stepName,
            input as Record<string, unknown> | null,
          ));
          return ok({ versionId: v.id, sampleInput: v.sampleInput });
        }),
    },

    // The per-flow CODE-step opt-in. Its own route, taking nothing but the
    // boolean: the permission is never a field on a body that also carries
    // other changes, so no generic flow update can grant or drop it by
    // accident, and granting it is always a deliberate, separate act.
    //
    // Deliberately NOT exposed through `manage_workflow`. The threat the gate
    // exists for is an untrusted LLM-authored FlowVersion, and a tool action
    // that let the model grant itself the permission would be the gate
    // granting its own exception.
    "/api/workflows/:id/code-steps": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          if (!getFlow(id)) return err("flow not found", 404);
          // An empty body is let through so it gets the `enabled` message
          // below, which says what to send, rather than a bare JSON error.
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES, { allowEmpty: true });
          if ("error" in read) return read.error;
          const body = read.body as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") {
            return err('enabled must be a boolean ({"enabled": true} permits CODE steps for this flow)', 400);
          }
          // Revoking does NOT stop a run already in flight or unpublish the
          // version; it takes the permission away from the next publish,
          // enable or run, which is the same authoring-time boundary the
          // grant itself lives on.
          return ok(serializeFlow(setFlowCodeStepsEnabled(id, body.enabled, "user")));
        }),
    },

    "/api/workflows/:id/publish": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          // Default semantic: lock the latest draft and set it as published.
          // Body can override with `{ versionId }` for explicit selection.
          const read = await readWriteBody(req, FLOW_WRITE_MAX_BODY_BYTES, { allowEmpty: true });
          if ("error" in read) return read.error;
          const body = read.body as { versionId?: unknown };
          if (body.versionId !== undefined && (typeof body.versionId !== "string" || !body.versionId.trim())) {
            return err("versionId must be a non-empty string", 400);
          }
          const { flow, version } = publishFlowVersion(id, body.versionId);
          refreshTrigger(id);
          return ok({ flow: serializeFlow(flow), version });
        }),
    },

    // -------------------------------------------------------------------- runs
    "/api/workflows/:id/run": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const flow = getFlow(id);
          if (!flow) return err("flow not found", 404);
          // `payload` is one run's trigger input, JSON.stringify'd into
          // `workflow_job.payload`, so this body was unbounded STORAGE, not
          // just parse cost (#649). It is the same kind of thing a resume
          // payload is, so it gets the same cap rather than the flow-write one
          // sized for `{ displayName, metadata }`.
          //
          // A body that is not JSON used to fall back to `{}` and start a
          // production run with an empty payload. It is now a 400: running
          // with input the caller did not send is worse than saying so.
          const read = await readWriteBody(req, WAITPOINT_RESUME_MAX_BODY_BYTES, { allowEmpty: true });
          if ("error" in read) return read.error;
          const body = read.body as {
            environment?: unknown;
            triggeredBy?: unknown;
            stepNameToTest?: string;
            payload?: Record<string, unknown>;
            workItemId?: string;
          };
          // Linked work runs on the version and input frozen by its decision,
          // so no other field may accompany it.
          if (body.workItemId !== undefined) {
            if (typeof body.workItemId !== "string" || !body.workItemId) return err("workItemId must be a non-empty string", 400);
            if (Object.keys(body).some((key) => key !== "workItemId")) {
              return err("Linked work uses its accepted version and input; only workItemId is allowed", 400);
            }
            try { return ok(startWorkItemRun(body.workItemId, id), 202); }
            catch (e) { if (e instanceof WorkItemError) return err(e.message, e.status); throw e; }
          }
          // Both were cast and written straight to `flow_run`. A bad
          // `environment` then failed the column's CHECK as a 500, and
          // `triggeredBy` of any size went on to `workflow_effect.provenance`
          // and back to the model through `manage_workflow`'s run summaries.
          if (body.environment !== undefined && !isRunEnvironment(body.environment)) {
            return err("environment must be PRODUCTION or TESTING", 400);
          }
          if (
            body.triggeredBy !== undefined
            && (typeof body.triggeredBy !== "string" || body.triggeredBy.length > RUN_TRIGGERED_BY_MAX_CHARS)
          ) {
            return err(`triggeredBy must be a string of at most ${RUN_TRIGGERED_BY_MAX_CHARS} characters`, 400);
          }
          // Version selection:
          //   - Test-from-here (stepNameToTest set): prefer DRAFT. The user
          //     is iterating on step definitions + sample data in the editor,
          //     which mutates the draft; running the published version would
          //     test stale state.
          //   - Production runs: prefer PUBLISHED. Drafts are explicitly
          //     unverified; the trigger manager only fires production runs
          //     against published flows.
          const draftId = getLatestDraft(id)?.id ?? null;
          const versionId = body.stepNameToTest
            ? (draftId ?? flow.published_version_id ?? null)
            : (flow.published_version_id ?? draftId ?? null);
          if (!versionId) return err("flow has no published or draft version", 400);
          // Defence in depth, not the primary gate. Publish already refuses a
          // CODE step this flow was not opted into, so no PUBLISHED flow can
          // reach here without the grant and no working automation starts
          // failing. What this catches is the direct-run shortcut: an
          // unpublished draft asked to run once, which is still an authoring
          // moment with someone reading the reply.
          assertCodeStepsAllowed(id, versionId, "run");
          // For test-from-here runs, fetch the version's persisted sampleData
          // so the engine can populate preceding steps' outputs without
          // re-running them. The map is shared by all runs of this version --
          // editing it via the version PATCH route updates it for the next
          // test. Production runs (no stepNameToTest) ignore sampleData
          // entirely.
          let sampleData: Record<string, unknown> | undefined;
          let sampleInputOverride: Record<string, unknown> | undefined;
          if (body.stepNameToTest) {
            const ver = getFlowVersion(versionId);
            if (ver?.sampleData) sampleData = ver.sampleData;
            // Per-step sample input override: forwarded as a SINGLE
            // {stepName -> input} entry, not the whole map -- the engine
            // executor only applies the override for the step under
            // test, never for other steps even if they have an entry.
            // Keeping the wire payload narrow means a copy-paste error
            // in one step's sample input can't bleed into a different
            // step's test run.
            const override = ver?.sampleInput?.[body.stepNameToTest];
            if (override && typeof override === "object" && !Array.isArray(override)) {
              sampleInputOverride = { [body.stepNameToTest]: override as Record<string, unknown> };
            }
          }
          assertVersionReady(id, versionId, body.stepNameToTest ? {
            stepName: body.stepNameToTest,
            inputOverride: sampleInputOverride?.[body.stepNameToTest] as Record<string, unknown> | undefined,
          } : undefined);
          const run = createFlowRun({
            flowId: id,
            flowVersionId: versionId,
            environment: body.environment ?? "PRODUCTION",
            triggeredBy: body.triggeredBy,
            stepNameToTest: body.stepNameToTest,
            startTime: Date.now(),
          });
          enqueue({
            jobType: "RUN_FLOW",
            payload: {
              runId: run.id,
              payload: body.payload ?? {},
              ...(body.stepNameToTest ? { stepNameToTest: body.stepNameToTest } : {}),
              ...(sampleData ? { sampleData } : {}),
              ...(sampleInputOverride ? { sampleInputOverride } : {}),
            },
            flowRunId: run.id,
            flowId: id,
            flowVersionId: versionId,
            // No auto-retry: flow code with side effects (notify, send
            // email, hit API) would duplicate on retry. The user gets a
            // clear FAILED status and clicks Run again if they want.
            maxAttempts: 1,
          });
          return ok(run, 202);
        }),
    },

    "/api/workflows/:id/runs": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const params = new URL(req.url).searchParams;
          const status = params.get("status") as FlowRunStatus | null;
          // Clamped the way the two listings above clamp (#609). #598 clamped
          // the listing it touched and left this one as a separate subject, and
          // it is the more expensive of the two to leave open: `listRuns` has no
          // bound of its own, and `rowToRun` parses each row's `steps` blob --
          // the whole captured output of every step -- and then runs two more
          // queries per row for its machine binding and cancellation. So
          // `limit=1e9` was an unbounded N+1, not one large SELECT. Before the
          // clamp a negative `limit` reached SQLite verbatim as well, where
          // `LIMIT -1` means no limit at all.
          //
          // Paging past the ceiling works -- `offset` has no upper bound -- and
          // it is now STABLE: `listRuns` orders by `created DESC, rowid DESC`
          // (#636), where it used to order by `created DESC` alone, a
          // millisecond timestamp with no tiebreak, so two runs created in the
          // same millisecond could be skipped or repeated across a page
          // boundary.
          //
          // This response is still a bare ARRAY with no `nextOffset`, unlike
          // the `/readiness` sibling, so a client has to page by incrementing
          // `offset` until it gets a short page. Deliberately left: adding it
          // means `ok({ items, nextOffset })`, and `ui/`'s two consumers
          // (`useWorkflowsData.ts`, `useFlowRuns.ts`) read this as an array.
          // Filed as its own change, with the response shape as its subject.
          const { limit, offset } = clampPage(params, 50);
          const opts: { flowId: string; status?: FlowRunStatus; limit: number; offset: number } = {
            flowId: id,
            limit,
            offset,
          };
          if (status) opts.status = status;
          return ok(listRuns(opts));
        }),
    },

    "/api/workflow-runs/:runId/effects": {
      GET: (req) => trapErrors(async () => {
        const { runId } = (req as RequestWithParams<{ runId: string }>).params;
        if (!getFlowRun(runId)) return err('run not found', 404);
        const { listWorkflowEffects } = await import('../db/repos/workflow-effect');
        return ok({ runId, effects: listWorkflowEffects(runId) });
      }),
    },

    "/api/workflow-runs/:runId": {
      GET: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          return run ? ok(run) : err("run not found", 404);
        }),
    },

    // Webhook ingress. Path is /api/webhooks/:flowId.
    "/api/webhooks/:flowId": {
      POST: (req) =>
        trapErrors(async () => {
          if (!opts.triggerManager) return err("webhooks are not enabled in this build", 503);
          const { flowId } = (req as RequestWithParams<{ flowId: string }>).params;
          return opts.triggerManager.webhookManager().handleRequest(flowId, req);
        }),
      // Allow GET too -- some providers (Slack, GitHub URL verification) probe
      // with GET first. The webhook manager treats any method the same.
      GET: (req) =>
        trapErrors(async () => {
          if (!opts.triggerManager) return err("webhooks are not enabled in this build", 503);
          const { flowId } = (req as RequestWithParams<{ flowId: string }>).params;
          return opts.triggerManager.webhookManager().handleRequest(flowId, req);
        }),
    },

    "/api/workflow-runs/:runId/cancel": {
      POST: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          if (!run) return err("run not found", 404);
          // Acknowledgement closes the durable dispatch fence. It does not
          // claim that an already-dispatched remote effect was rolled back.
          return ok({ ok: true, ...cancelFlowRun(run.id) });
        }),
    },

    // Active waitpoints for a flow run. Used by the dashboard's paused-run
    // callout so it can surface real resume URLs ("POST to
    // /api/webhooks/waitpoints/<id>") instead of pointing at the steps JSON.
    "/api/workflow-runs/:runId/waitpoints": {
      GET: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          if (!run) return err("run not found", 404);
          const waitpoints = listWaitpointsByFlowRun(runId, /* resumed */ false).map((wp) => ({
            id: wp.id,
            stepName: wp.stepName,
            type: wp.type,
            resumeDateTime: wp.resumeDateTime,
            created: wp.created,
            resumeUrl: `/api/webhooks/waitpoints/${wp.id}`,
          }));
          return ok({ runId, waitpoints });
        }),
    },
  };
}

/**
 * Surface representation of a flow row for the API. Parses metadata JSON and
 * presents booleans where the row uses 0/1.
 *
 * `displayName` is inlined from the flow's latest version (published if
 * available, otherwise latest draft) so list-view clients (the workflows
 * room, the flow_ref picker in the editor) don't have to do a per-flow
 * follow-up fetch just to render a name. The lookup is two indexed SELECTs
 * per flow; the GET /api/workflows handler caps at 100 by default, so the
 * extra round-trip is in the low milliseconds even on cold cache.
 */
function serializeFlow(row: ReturnType<typeof getFlow> | NonNullable<ReturnType<typeof getFlow>>) {
  if (!row) return null;
  const versionId = row.published_version_id ?? getLatestDraft(row.id)?.id ?? null;
  const version = versionId ? getFlowVersion(versionId) : null;
  return {
    id: row.id,
    externalId: row.external_id,
    projectId: row.project_id,
    status: row.status,
    publishedVersionId: row.published_version_id,
    displayName: version?.displayName ?? null,
    metadata: parseFlowMetadata(row),
    // Surfaced so the dashboard can show that this flow may run CODE and,
    // when `grantedBy` is `upgrade`, that the permission was inherited from a
    // flow that already ran one rather than chosen. A grant nobody can see is
    // not much better than no gate at all.
    codeSteps: {
      enabled: flowCodeStepsEnabled(row),
      grantedBy: row.code_steps_grant,
      grantedAt: row.code_steps_granted_at,
    },
    created: row.created,
    updated: row.updated,
  };
}

function numParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ceiling every listing in this file clamps its `limit` to.
 *
 * `actions/tools/manage-workflow.ts` clamps `list_runs` to the same number so a
 * model and an HTTP caller cannot ask for different amounts of work. It keeps
 * its own copy rather than importing this one: that tool has no business
 * importing the route module, and nothing enforces the equality -- so if this
 * moves, move `LIST_RUNS_MAX_LIMIT` with it.
 */
const LISTING_MAX_LIMIT = 100;

/**
 * A listing's `limit` and `offset`, clamped. Three listings were doing this
 * inline with the same expression and a different default, which is three
 * chances for them to drift apart (#609 found the third had not been done at
 * all). `Math.trunc` is what absorbs a fractional, negative or `NaN` parameter
 * before it reaches SQLite, where `LIMIT -1` means no limit.
 */
function clampPage(params: URLSearchParams, defaultLimit: number): { limit: number; offset: number } {
  return {
    limit: Math.max(1, Math.min(LISTING_MAX_LIMIT, Math.trunc(numParam(params.get("limit")) ?? defaultLimit))),
    offset: Math.max(0, Math.trunc(numParam(params.get("offset")) ?? 0)),
  };
}

/**
 * Soft validation: connection `value` must contain the fields a piece will
 * read for the given `type`. Returns an error message string on mismatch,
 * or null if the shape looks plausible. Catches user mistakes at the API
 * boundary instead of at flow-run time.
 *
 * `CUSTOM_AUTH` is intentionally permissive (per-piece schema; the engine
 * validates against the piece's auth.props at run time).
 */
function validateConnectionValueShape(
  type: AppConnectionType,
  value: Record<string, unknown>,
): string | null {
  const has = (key: string): boolean =>
    typeof value[key] === "string" && (value[key] as string).length > 0;
  switch (type) {
    case "OAUTH2":
    case "PLATFORM_OAUTH2":
    case "CLOUD_OAUTH2":
      if (!has("access_token")) return `${type}: value.access_token is required`;
      return null;
    case "BASIC_AUTH":
      if (!has("username") || !has("password"))
        return "BASIC_AUTH: value.username + value.password are required";
      return null;
    case "SECRET_TEXT":
      // Engine reads either `secret` or `value` depending on the piece;
      // accept both. Reject obvious empties.
      if (!has("secret") && !has("value"))
        return "SECRET_TEXT: value.secret (or value.value) is required";
      return null;
    case "CUSTOM_AUTH":
    case "NO_AUTH":
      return null;
    default:
      return null;
  }
}
