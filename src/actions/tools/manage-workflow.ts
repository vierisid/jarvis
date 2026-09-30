/**
 * Manage Workflow Tool — chat-driven workflow CRUD + run management.
 *
 * Replaces the legacy `manage_workflow` tool that was deleted alongside the
 * old engine. This version drives the new activepieces-based runtime through
 * its repos / queue directly (in-process; no HTTP round-trip).
 *
 * Actions:
 *   list                   flows, newest first, bounded by a character budget
 *                          ({ returned, total, truncated, flows })
 *   get                    detail view of a flow + its latest version
 *   run                    queue a flow run, optionally with a payload
 *   create                 create an empty flow with a manual trigger
 *   enable / disable       toggle flow status
 *   publish                lock the latest draft and set as published_version
 *   delete                 remove a flow
 *   list_runs              recent runs for a flow (or globally)
 *   get_run                run detail with step outputs
 *
 * Flow references accept either a display name (case-insensitive) or an id.
 * Runs are referenced strictly by id.
 */

import type { ToolDefinition } from "./registry.ts";
import type { TriggerManager } from "../../workflows/runner/triggers/manager.ts";
import type { PieceLookup } from "../../workflows/runtime/piece-catalog.ts";
import type { ComposerLlmClient } from "./workflow-composer.ts";
import { composePersistedFlow } from "./persisted-workflow-composer.ts";

/**
 * Minimal tool-registry shape the composer surfaces in its planner prompt.
 * Lists names + tool descriptions; doesn't drive execution. Kept inline
 * instead of importing the deleted legacy `PieceToolRegistry` type.
 */
export interface ComposerToolRegistry {
  listNames(category?: string): string[];
  /**
   * Optional richer listing: each tool with its parameter schema. When present
   * the composer surfaces required params to the LLM and validates them, so a
   * `jarvis-tool:invoke` step can't omit a tool's required param (e.g. `action`)
   * and 500 at runtime. Falls back to `listNames` when not provided.
   */
  listDetailed?(category?: string): ComposerToolSpec[];
}
import {
  createFlow,
  deleteFlow,
  getFlow,
  listFlows,
  parseFlowMetadata,
  updateFlowStatus,
  type FlowRow,
} from "../../workflows/db/repos/flow.ts";
import {
  createDraftVersion,
  getFlowVersion,
  getLatestDraft,
} from "../../workflows/db/repos/flow-version.ts";
import { publishFlowVersion } from "../../workflows/db/repos/flow-publication.ts";
import { assertVersionReady } from '../../workflows/db/repos/flow-readiness';
import { assertCodeStepsAllowed } from "../../workflows/db/repos/flow-code-steps.ts";
import {
  createFlowRun,
  getFlowRun,
  listRuns,
  type FlowRun,
} from "../../workflows/db/repos/flow-run.ts";
import { enqueue } from "../../workflows/db/repos/job-queue.ts";
import { RUN_FLOW } from "../../workflows/runner/handler.ts";
import {
  flowOsWarnings,
  osCheckContextFor,
  type ExecutionTarget,
} from "../../util/execution-environment.ts";
import type {
  ComposeDeps,
  ComposedFlow,
  ComposerLibraryEntry,
  ComposerSpecialistRole,
  ComposerToolSpec,
} from "./workflow-composer.ts";
import { forCard } from "../../util/card-text.ts";
import { wrapUntrusted } from "../../roles/untrusted.ts";

export interface ManageWorkflowDeps {
  /** When provided, a refresh is fired after status / publish / delete so cron+webhook+event subs reconcile. */
  triggerManager?: TriggerManager;
  /** Required for the `compose` action: lets the LLM build a draft flow from a description. */
  llm?: ComposerLlmClient;
  /** Required for the `compose` action: catalog of pieces the LLM can pick from. */
  pieceRegistry?: PieceLookup;
  /**
   * Optional. When provided, the composer surfaces the names of registered
   * Jarvis tools so the LLM can wire `jarvis-tool { toolName: '...' }` correctly
   * for asks like "send a Gmail" or "search the vault".
   */
  toolRegistry?: ComposerToolRegistry;
  /**
   * Optional. When provided, the composer lists the valid specialist sub-agent
   * roles in its prompt and rejects a `jarvis-agent:delegate` step whose `role`
   * isn't one of them. A thunk (not a snapshot) so it reflects specialists
   * discovered after this tool is constructed. See ComposeDeps.specialistRoles.
   */
  specialistRoles?: () => ComposerSpecialistRole[];
  /**
   * Optional. Compact index of the community piece library. When provided,
   * the composer's tool loop can search it and suggest installs (surfaced as
   * `suggestedInstalls` on a failed compose) instead of forcing a request
   * through the wrong piece when the right one just isn't installed yet.
   *
   * OMIT on a host-managed install: the whole catalog is already present, so
   * the only pieces this index could ever surface as "not installed" are the
   * ones whose metadata extraction failed on the HOST -- which the user
   * cannot install and cannot fix. Omitting it also drops the suggest-install
   * wording from this tool's description and from the composer's prompt.
   */
  library?: ComposerLibraryEntry[];
  /**
   * Optional. The machines a composed step can execute on -- the enrolled
   * sidecars plus the brain's own host. When provided, the composer knows
   * which OS it is writing commands for instead of guessing (the `notepad.exe`
   * composed for a Mac-only fleet), and rejects a step bound to an OS nothing
   * here runs. A thunk, not a snapshot: sidecars enroll, connect, and report
   * their OS long after this tool is constructed.
   */
  executionTargets?: () => ExecutionTarget[];
}

export function createManageWorkflowTool(deps: ManageWorkflowDeps = {}): ToolDefinition {
  // No library index => the composer has no search_library tool and can never
  // return suggestedInstalls, so the paragraph describing them is dropped
  // rather than left as advice the agent cannot act on. A host-managed
  // install is the case that matters: the daemon withholds the library there
  // because the whole catalog is already present and the install API is gone,
  // and "ask the user to install it from the Library page" would be a
  // dead-end instruction.
  const hasLibrary = (deps.library?.length ?? 0) > 0;
  return {
    name: "manage_workflow",
    description: [
      "Create, run, and manage the user's Jarvis workflows (automations).",
      "",
      "compose { name, description } is the PRIMARY action: use it whenever the user",
      "describes what an automation should DO (\"make a workflow that ...\", \"automate X",
      "every morning\"). It drafts a flow from plain English (LLM-backed). On",
      "{ ok: false, errors } read the errors, refine the description with concrete",
      "piece/tool names, and call compose again.",
      ...(hasLibrary
        ? [
            "A failure may also carry suggestedInstalls: community-library pieces that would",
            "make the request possible. Relay them (the user installs them from the",
            "dashboard's Library page) and offer to compose again after; do NOT retry",
            "compose unchanged.",
          ]
        : []),
      "Composed flows are DISABLED: publish once the user confirms, then run to test.",
      "create makes an EMPTY workflow with a manual trigger and REQUIRES empty: true.",
      "Use it only for an explicitly blank canvas, never for a workflow the user",
      "described -- that case is always compose.",
      "",
      "Other actions: list, get (full detail), run (queues a run, returns run_id),",
      "enable, disable, publish (locks the latest draft and enables it), delete",
      "(permanent), list_runs, get_run (full run detail with step outputs).",
      "",
      "A flow containing a CODE step runs arbitrary JavaScript with this machine's full",
      "privileges, so publish, enable and run are REFUSED for it until the user turns",
      "code steps on for that one flow. The error explains how; relay it and let the user",
      "decide. Do not retry, and do not try to route around it -- there is no tool action",
      "that grants the permission, by design.",
    ].join("\n"),
    category: "automation",
    parameters: {
      action: {
        type: "string",
        description: "What to do.",
        enum: ["compose", "create", "list", "get", "run", "enable", "disable", "publish", "delete", "list_runs", "get_run"],
        required: true,
      },
      flow: {
        type: "string",
        description: "Workflow display name (case-insensitive) or id. Required for get/run/enable/disable/publish/delete; optional filter for list_runs.",
        required: false,
      },
      name: {
        type: "string",
        description: "Short descriptive display name. Required for create and compose.",
        required: false,
      },
      payload: {
        type: "object",
        description: "Trigger payload for run, when the flow expects input data.",
        required: false,
      },
      run_id: {
        type: "string",
        description: "Run id for get_run; returned by run and list_runs.",
        required: false,
      },
      description: {
        type: "string",
        description:
          'What the workflow should do, for compose. Quote the user where possible, and include the trigger ' +
          '(schedule, webhook, manual) and any concrete services / actions (e.g. "send a Gmail to ...").',
        required: false,
      },
      limit: {
        type: "number",
        description: "Cap for list_runs (default 25).",
        required: false,
      },
      empty: {
        type: "boolean",
        description:
          "Confirms the user wants a blank canvas with no steps. Required by `create` when no `description` is given; " +
          "if the user described what the flow should DO, call `compose` instead. Defaults to false.",
        required: false,
      },
    },
    /**
     * Per-action Authority, because one category cannot be honest for eleven
     * actions.
     *
     * The TOOL_ACTION_MAP entry is the FLOOR (write_data) and covers the
     * ordinary mutating actions. This raises the two that reach further:
     * `run` queues a flow and is execute_command; `delete` removes one for
     * good and is delete_data, the same category manage_skills gives its own
     * delete. Reads return null and pay the floor only.
     *
     * `confirm: 'above_level'` is what keeps an honest category from becoming
     * a dead end: at the gate, a pure level shortfall on a category ABOVE the
     * floor the agent already clears is substituted for an approval card
     * rather than a refusal. Without it, `delete` (level 9) would simply be
     * denied for every shipped role.
     *
     * Kept total and dependency-free -- it switches on `params.action` and
     * nothing else. A gate that throws is caught at the call site and
     * escalated to confirm: 'always', so a DB read in here would turn a
     * transient error into a mandatory card.
     */
    authorityGate: (params) => {
      switch (String(params.action ?? "")) {
        case "run":
          return { actionCategory: "execute_command", confirm: "above_level",
            intent: `Run workflow: ${forCard(params.flow)}` };
        case "delete":
          return { actionCategory: "delete_data", confirm: "above_level",
            intent: `Permanently delete workflow: ${forCard(params.flow)}` };
        default:
          // list / get / list_runs / get_run are reads; compose / create /
          // enable / disable / publish are writes the floor already covers.
          //
          // `publish` and `enable` are the arguable ones: enabling registers
          // the flow's cron/webhook, so they ARM the same execution that
          // `run` is raised for. They stay at the floor because the exposure
          // is bounded twice over -- CODE steps are refused at publish,
          // enable AND run unless a human opted that flow in, and every
          // effect a flow dispatches is re-gated at the workflow effect
          // boundary, which refuses opaque tools outright. Raising them would
          // put an approval card in front of ordinary workflow authoring for
          // no authority gained.
          return null;
      }
    },
    execute: async (params) => {
      const action = String(params.action ?? "");
      switch (action) {
        case "list":
          return framedForModel(actList(), "the workflow list and its stored metadata");
        case "get":
          return framedForModel(
            actGet(requireFlowParam(params)),
            "a workflow definition and its captured sample data",
          );
        case "run":
          return JSON.stringify(actRun(requireFlowParam(params), params.payload as Record<string, unknown> | undefined));
        case "create": {
          // Two-step gate to keep small / local LLMs honest:
          //   - If `description` is passed, reroute to `compose` so the
          //     workflow gets built out with steps. The verb "create" in
          //     the user's message lexically matches this action name,
          //     so weak models pick it even when the user described what
          //     the flow should do.
          //   - Otherwise require an explicit `empty: true` flag. Forces
          //     the caller to confirm "I really want a blank canvas" and
          //     short-circuits the silent-empty-flow failure mode the
          //     user reported. The error message walks the agent toward
          //     the right next call.
          const name = requireString(params, "name");
          const description = typeof params["description"] === "string" ? params["description"].trim() : "";
          if (description.length > 0) {
            const composed = await actCompose(name, description, deps);
            // ACCEPTED COST of one block per action: `note` is repo-authored
            // guidance to the model, and framing the whole return puts it under
            // a preamble that says not to follow instructions inside the block.
            // A model that honours the frame discounts the nudge.
            //
            // Taken deliberately rather than worked around. The mechanism for
            // trusted text that must render OUTSIDE a block exists
            // (`withTrustedTrailer`), but `untrusted-import-guard.test.ts` pins
            // its callers to exactly one file on the argument that minting
            // repo-authored trust is a privilege, so reaching for it here needs
            // its own case -- and what is at stake is an advisory nudge, not a
            // control. The alternative, framing only the `composed` half, is
            // the branch-dependent framing #559 warns against.
            return framedForModel(
              {
                ...composed,
                routedFrom: "create",
                note: "Rerouted to `compose` because a description was provided. Future calls: use `compose` directly when the user describes what the workflow should do.",
              },
              "a composed workflow and the composer's text",
            );
          }
          const empty = params["empty"] === true;
          if (!empty) {
            throw new Error(
              "create: refusing to make an empty workflow without confirmation. " +
                "If the user described what the workflow should DO, call `compose` with that description. " +
                'If the user really wants a blank canvas to edit in the UI, retry with empty: true.',
            );
          }
          return framedForModel(actCreate(name), "a new workflow and its stored metadata");
        }
        case "enable":
          return framedForModel(
            actSetStatus(requireFlowParam(params), "ENABLED", deps),
            "a workflow's status and stored metadata",
          );
        case "disable":
          return framedForModel(
            actSetStatus(requireFlowParam(params), "DISABLED", deps),
            "a workflow's status and stored metadata",
          );
        case "publish":
          return framedForModel(
            actPublish(requireFlowParam(params), deps),
            "a published workflow and its warnings",
          );
        case "delete":
          return JSON.stringify(actDelete(requireFlowParam(params), deps));
        case "list_runs":
          return framedForModel(
            actListRuns(params.flow as string | undefined, asLimit(params.limit)),
            "workflow run history",
          );
        case "get_run":
          return framedForModel(
            actGetRun(requireString(params, "run_id")),
            "a workflow run's captured step output",
          );
        case "compose":
          return framedForModel(
            await actCompose(requireString(params, "name"), requireString(params, "description"), deps),
            "a composed workflow and the composer's text",
          );
        default:
          throw new Error(`unknown action "${action}"`);
      }
    },
  };
}

/* --------------------------------------------------- the model boundary */

/**
 * Cap for the JSON payload that goes INSIDE a framed block, applied here
 * rather than left to the dispatch.
 *
 * Every dispatch already caps a tool result at `MAX_TOOL_RESULT_CHARS` (6000,
 * declared in agents/orchestrator.ts and agents/sub-agent-runner.ts), and it
 * does that BEFORE `markUntrustedToolResult` runs -- which is exactly what keeps
 * `wrapUntrusted`'s "never partially framed" invariant true at that boundary:
 * the cap slices the payload, then the frame is drawn around the sliced text.
 *
 * Framing HERE inverts that order. This tool is not in `UNTRUSTED_TOOL_NAMES`
 * (see the taint note below), so the dispatch's framing step is a no-op for it
 * and the only thing left upstream is the cap -- which would now slice a string
 * that already carries the open delimiter and drop the close line off the end.
 * An unterminated block is worse than the bug this fixes: it tells the model
 * everything after it is data and never says where that stops.
 *
 * So the payload is capped here, low enough that the whole framed return
 * (preamble + open line + payload + truncation note + close line) stays well
 * inside 6000 and no upstream slice can reach the close delimiter.
 * `manage-workflow.test.ts` asserts the whole framed return stays within the
 * smaller of the two `MAX_TOOL_RESULT_CHARS` copies, and it READS both
 * constants out of the source rather than spelling 6000, so lowering or
 * renaming either one fails that test instead of silently shipping
 * unterminated blocks.
 *
 * KNOWN RESIDUAL, and it is a truncation hazard rather than a boundary one:
 * two consumers persist a 2000-char prefix of a tool result, which lands INSIDE
 * a ~4300-char framed return and keeps the open delimiter while dropping the
 * close.
 *
 *   - `authority/deferred-executor.ts` writes `result.slice(0, 2000)` to
 *     `approval_requests.execution_result`, and `manage_workflow`'s floor
 *     (`write_data`) is taint-governed, so a read taken on a tainted turn goes
 *     through the approval path and lands there.
 *   - `runtime/effect-boundary.ts` writes `canonicalJson({ effectId, result })
 *     .slice(0, 2000)` through the same `markExecuted`.
 *
 * What a dangling open delimiter costs is NOT the tail of its own payload --
 * nothing of that payload survives the cut. It is whatever the CONSUMER
 * concatenates afterwards: the receipt is replayed as a tool message
 * (agents/orchestrator.ts), and `daemon/commitment-executor.ts` joins
 * `execution_result` values into a commitment `result` that
 * `actions/tools/commitments.ts` renders into a MULTI-ITEM listing, unframed,
 * so one item's dangling open line disclaims the other items' text. That
 * commitment path truncates a SECOND time -- `results.join('\n').slice(0, 500)`
 * -- which makes a half block more likely there, not less.
 *
 * Be precise about what is new: the captured output in those rows is not, since
 * they carry it today with no frame at all. The dangling open line IS new, and
 * introduced here. What it costs is an integrity nuisance -- trusted text
 * downstream reads as data -- and never a boundary escape: no attacker text
 * lands outside a block, and a per-message nonce (#567) cannot be replayed into
 * closing a fresh one.
 *
 * #598 WIDENS that residual, and says so rather than inheriting it quietly.
 * Block overhead is ~267-327 characters at these labels, so a 2000-char prefix
 * holds a COMPLETE block only while the payload stays under ~1,700. For the
 * three #582 reads a half block was a large-payload edge case. For `list` it is
 * the ordinary case on any real install -- ~1,700 characters is about 8 flow
 * summaries.
 *
 * All NINE framed actions travel that path, reads included, so the taint floor
 * is not a discriminator between them: `manage_workflow`'s floor is
 * `write_data`, which is taint-governed, and `authorityGate` returns null for
 * the reads so they pay the floor -- which is #582's own point one paragraph
 * up, that a read taken on a tainted turn goes through the approval path and
 * lands in `execution_result`. What singles `list` out is only that its payload
 * is the one that routinely exceeds ~1,700 characters.
 *
 * Accepted, with the trade stated. The two ways out are bounding `list` under
 * ~1,650 -- which buys the model about 8 workflows out of its own inventory,
 * too high a price -- or fixing the two `slice(0, 2000)` call sites, which is
 * the issue the paragraph above already scopes and which has to argue for a
 * boundary locator in production code. Neither is worth blocking a boundary fix
 * on, because the cost of the half block is bounded to the integrity nuisance
 * described above and those same rows carry the same data unframed today.
 *
 * Two ways out, neither taken here, both wanting their own issue:
 *
 *   - Truncate without halving a block at the `slice` call sites. The helper
 *     would have to LOCATE an open line, which `untrusted-import-guard.test.ts`
 *     forbids in production code for good reason (#560), so it needs its own
 *     argument -- that it only ever deletes a suffix and never treats the
 *     located boundary as trustworthy.
 *   - Or drop `FRAMED_PAYLOAD_MAX_CHARS` below `2000 - overhead` (~1,650), so
 *     even the 2000-char prefix holds a complete block and no call site
 *     changes. Rejected because ~1,650 characters is too small for a 25-run
 *     listing, but it is the cheaper option if that trade ever flips.
 */
const FRAMED_PAYLOAD_MAX_CHARS = 4000;

/**
 * Render an action's result for the chat model, framed as data.
 *
 * #582 framed the three READ actions. #598 framed the six that carry
 * `summarizeFlow`, so NINE of the eleven actions come through here now; the
 * list of what does not is at the bottom of this comment and is load bearing.
 *
 * #582. `get_run`'s `steps`, `list_runs`' `failedStep` and the `sample_data`
 * riding inside the `FlowVersion` a plain `get` returns are all captured step
 * output: a page's text, an app window's on-screen fields, a failing skill's
 * error string. #581 decided with evidence that the frame does NOT belong at
 * the workflow adapter -- in a flow the dominant consumer of a step result is
 * code, so a frame there writes delimiters into files, every run, unattended,
 * and `safe-expression.ts` gives the flow author no way to strip them. It
 * belongs at each MODEL boundary instead, and these three are those boundaries:
 * this tool's return IS the text the chat model reads.
 *
 * #598 is the follow-up #582 filed against itself, and it is the more routine
 * exposure of the two. `summarizeFlow`'s `metadata` is a raw `JSON.parse` of a
 * column that `workflows/api/routes.ts` writes unvalidated and uncapped, so
 * whatever an API caller puts there arrived as trusted-looking tool output on
 * every `list` -- a far more frequent call than `get_run`. Its `name` is a
 * `displayName`, which is not simply operator-written either: two of its three
 * writers are the uncapped `POST /api/workflows` body and the composer LLM's own
 * `displayName` on `compose`. One block per action makes the distinction moot,
 * which is the point -- the whole JSON is inside the block however each field
 * was written.
 *
 * ONE BLOCK PER ACTION, wrapping the action's whole JSON, rather than
 * `wrapUntrusted` on each field. Per-field framing reads like the cheaper
 * option and is not:
 *
 *   1. `list_runs` returns up to `limit` runs (25 by default), each with its own
 *      `failedStep`. An empty block costs 229 characters of preamble and
 *      delimiters with a one-character source label, and 267 with the label
 *      this action actually passes, so 25 of them come to ~6,675 before a
 *      single character of payload -- past the 6000-char dispatch cap, which
 *      then slices the last block in half. There is no per-field budget that
 *      makes a 25-row listing work.
 *   2. This tool's return is a JSON document. A framed block used as a field
 *      VALUE is escaped by `JSON.stringify`, so the preamble and both
 *      delimiters lose their own lines and the model reads one long run of
 *      `\n`-escaped text. The nonce still holds, but the boundary stops being
 *      visible, which is the whole point of drawing it.
 *
 * `goals/rhythm.ts` is the precedent #582 cites and it does exactly this: one
 * block around `JSON.stringify(bundle)`, structural fields included. Framing
 * ids and statuses along with the captured output costs a preamble and
 * disclaims some of our own text; leaving the captured output unframed costs
 * the mitigation. It also subsumes the other outside-derived fields these three
 * actions carry, which is worth more than the precision: `triggeredBy` and
 * `environment` are unvalidated caller strings written by
 * `workflows/api/routes.ts`, and a `displayName` can carry page text into a flow
 * composed from a snapshot.
 *
 * Framing the whole JSON also subsumes, for free, the three boundaries #582
 * enumerated as lower value and deferred. They are fields of the same document,
 * so they cost no extra code and get no separate decision:
 *
 *   - `publish`'s `warnings`, which interpolate sidecar-self-reported machine
 *     names and step parameter values (`util/execution-environment.ts`).
 *   - `compose`'s `errors` and `rawResponse`, the composer LLM's own text
 *     (already capped at `RAW_RESPONSE_CAP`).
 *   - `compose`'s `suggestedInstalls`, which #582 did not enumerate at all:
 *     `displayName` comes from the community piece catalog -- third-party
 *     package metadata -- and `reason` is the composer LLM's.
 *
 * NOT FRAMED, enumerated on purpose -- this decision is only safe while the
 * list of model boundaries is complete, the same standard #581 set:
 *
 *   - `run` and `delete`, whose RETURNS are ids and literals this file
 *     produced: `{ run_id, status: "QUEUED", flow_id }` and `{ id, deleted }`.
 *     Neither reads a caller-written column and neither carries a
 *     `summarizeFlow`, so a frame there would spend ~290 characters of preamble
 *     disclaiming our own ids.
 *   - the THROW paths of `run`, `enable` and `publish`, which DO carry
 *     outside-derived text and are the one thing #598 leaves open.
 *     `assertVersionReady` / `assertFlowReady` raise a `WorkflowReadinessError`
 *     whose message interpolates `i.node`, a step name
 *     (`workflows/db/repos/flow-readiness.ts`), and `assertCodeStepsAllowed`
 *     raises `refusalMessage(flowId, intent, stepNames)`
 *     (`workflows/db/repos/flow-code-steps.ts`). Step names come from the
 *     composer LLM or from an uncapped, unvalidated
 *     `POST /api/workflows/:id/versions` body -- the same writer class as
 *     `metadata`. They reach the model unframed because the orchestrator routes
 *     a throw through `markUntrustedToolFailure`, which returns the text
 *     untouched when `isUntrustedSourceTool` is false, and it is false for this
 *     tool.
 *
 *     Deferred rather than fixed, for a reason of blast radius and not of cost.
 *     Framing a throw means catching it and returning the text, which turns a
 *     failure into a success result and changes what `registry.execute`
 *     promises its callers; a dozen `rejects.toThrow` assertions across
 *     `flow-code-steps.test.ts`, `workflow-readiness.test.ts` and
 *     `version-ownership.test.ts` encode that contract deliberately. The hook
 *     designed for exactly this, `markUntrustedToolFailure`, is inert here only
 *     because the tool is not in `UNTRUSTED_TOOL_NAMES` -- and putting it there
 *     is the one change #582 argued against, because it moves `outsideReach`
 *     off `fetch` and drags in `FRAMED_ACTORS` and the tool filter's I1 union
 *     repair. So this wants its own issue, with that trade as its subject.
 *
 * TAINT: NO, decided separately and against, the way #581 asks. These are reads
 * of stored data, and `isTaintSourceTool` keys on the tool NAME -- one name over
 * `list / get / run / create / enable / disable / publish / delete / list_runs /
 * get_run / compose` -- so there is no way to taint the reads without tainting
 * `publish` and `delete` too. #581's point about the gate applies as well: the
 * approval card reviews frozen ARGUMENTS before dispatch, so it never sees the
 * result that would have made it fire. And the frequency argument
 * `TAINT_EXEMPT_TOOLS` exists for lands hard here -- a workflow read is routine,
 * and a card on every one teaches the owner to approve without reading.
 *
 * Consequently NO `UNTRUSTED_TOOL_NAMES` change either, so `outsideReach`,
 * `FRAMED_ACTORS` and the tool filter's I1 union repair are untouched: none of
 * the knock-on effects that made #529 and #559 delicate.
 */
function framedForModel(payload: unknown, source: string): string {
  const json = JSON.stringify(payload);
  const capped = json.length > FRAMED_PAYLOAD_MAX_CHARS
    ? json.slice(0, FRAMED_PAYLOAD_MAX_CHARS) + `\n... (truncated, was ${json.length} chars)`
    : json;
  // Framed at READ time, and this file writes nothing back: `summarizeRun` and
  // `actGet` read, and the framed string is built after the read and returned.
  // That is what keeps a per-message nonce (#567) out of the run record and out
  // of the version's `sample_data`, where a stale one would be replayed as step
  // input forever.
  //
  // It does NOT mean no consumer stores one. Several do, benignly, and all are
  // outside this file -- the list below is what was found, not a proof of
  // exhaustiveness:
  //
  //   - the delegation effect record: a `jarvis-agent` step's sub-agent may
  //     call this tool (`runtime/service-backends.ts` refuses only OPAQUE and
  //     GATED names) and `runtime/effect-boundary.ts` saves the result for
  //     replay;
  //   - `tasks.paused_conversation`, which persists a task turn's tool results
  //     verbatim (`agents/conv/task-dispatcher.ts` documents that it replays
  //     framed content framed);
  //   - indirectly, `sample_data` after all: a sub-agent that QUOTES a framed
  //     block in its own answer puts a nonce in the step result, which
  //     `runner/handler.ts` then merges in. Nothing this file did, and the
  //     reason the claim above is about what THIS code writes.
  //
  // All of them replay ONE COMPLETE block with one nonce, so nothing is reused
  // for a different block and the payload's author never learns the nonce drawn
  // after it.
  return wrapUntrusted(capped, source);
}

/* ------------------------------------------------------------ resolution */

function resolveFlow(ref: string): FlowRow {
  const direct = getFlow(ref);
  if (direct) return direct;
  const target = ref.trim().toLowerCase();
  // Match against the display name on the latest published or draft version.
  for (const flow of listFlows(undefined, { limit: 1000 })) {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) continue;
    const version = getFlowVersion(versionId);
    if (version && version.displayName.toLowerCase() === target) return flow;
  }
  throw new Error(`workflow not found: ${ref}`);
}

function requireFlowParam(params: Record<string, unknown>): FlowRow {
  const ref = params.flow;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("'flow' parameter is required (display name or id)");
  }
  return resolveFlow(ref);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${key}' parameter is required and must be a non-empty string`);
  }
  return v;
}

function asLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 25;
  return Math.floor(raw);
}

/* --------------------------------------------------------------- actions */

/**
 * Cap for ONE flow's `metadata` on its way to the chat model, applied here and
 * deliberately nowhere else (#598).
 *
 * `flow.metadata` is a verbatim caller-controlled JSON document of unbounded
 * size: `POST /api/workflows` and `PATCH /api/workflows/:id` both cast the body
 * and pass `body.metadata` straight to `JSON.stringify`, with no type check, no
 * key whitelist and no size limit. #598 also caps it on the way IN, but a write
 * cap does nothing for a row that is already over it, so the read cap is what
 * keeps a legacy row out of the prompt -- and together with `FLOW_NAME_MAX_CHARS`
 * it is what bounds ONE row's contribution to a `list`, which is a different
 * property from bounding the listing (see `actList`). Capping only `metadata`
 * was not enough: `name` is caller-written too, and while it was uncapped the
 * listing had no bound at all.
 *
 * Capping HERE and not in the repo is what makes it safe. `summarizeFlow` has
 * no caller outside this file, so the shortened copy is seen by the chat prompt
 * alone. The API and the dashboard keep reading the full value through
 * `serializeFlow` (`workflows/api/routes.ts`), and so does the flow engine
 * through `workflows/sandbox-api/routes/flows.ts`. Nothing legitimate loses
 * access to a byte.
 *
 * Sized against the real population, not guessed. Every in-repo writer is
 * small: `actCompose` writes `{ compositionRecordId }` and
 * `awareness/suggestion-composer.ts` writes
 * `{ opportunityId, compositionId, feedbackId, compositionRecordId }` at ~190
 * characters, which is the largest. A cap of 128 or 256 would have replaced our
 * own provenance metadata with a marker on every awareness-composed flow, so
 * `manage-workflow.test.ts` pins that the 4-key object survives intact.
 *
 * 512 rather than the 1000 this started at, because the cap is also what sets
 * `actList`'s worst case: a row may cost roughly this plus the name cap plus the
 * structural fields, so at 1000 a hostile writer could hold a whole listing to
 * about three rows. 512 is still ~2.7x the largest real writer.
 */
const FLOW_METADATA_MAX_CHARS = 512;

/**
 * Cap for a flow's `name` on its way to the model.
 *
 * `name` is a `displayName`, and it is NOT simply operator-written -- which is
 * the half of #598 that is easy to wave through because a workflow name looks
 * benign. Three routes write it and none of them bounded it: `POST
 * /api/workflows` checked only that it was a non-empty string, `POST
 * /api/workflows/:id/versions` checked only truthiness, and `PATCH
 * /api/workflows/:id/versions/:versionId` passed it to `updateDraftVersion` with
 * no validation at all. `compose` sets it from the composer LLM's own
 * `displayName`. #598 now validates all three routes, but as with `metadata` a
 * write cap does nothing for a row already over it.
 *
 * This is load bearing for more than budget: without it `actList`'s first row
 * was unbounded, so a single 20,000-character `displayName` overran
 * `LIST_PAYLOAD_MAX_CHARS`, made the payload invalid JSON, and -- because the
 * counters used to be emitted after `flows` -- deleted the very
 * `truncated` / `total` fields that tell the model rows were withheld. A
 * version PATCH also bumps `flow.updated` through `touchFlow`, so one request
 * both sets the long name and moves the row to the head of `ORDER BY updated
 * DESC`. That made the suppression primitive silent again, at 4000 instead of
 * 6000. 200 characters is far above any real workflow name.
 *
 * Bounds a `list` ROW, and only that. `actGet` spreads `summarizeFlow` but also
 * returns `latestDraft` and `published`, whose own `displayName` is the full
 * uncapped string, so on `get` this cap is cosmetic and the payload is bounded
 * by `FRAMED_PAYLOAD_MAX_CHARS` exactly as it was under #582. Unchanged
 * behaviour, not a hole this opened.
 */
const FLOW_NAME_MAX_CHARS = 200;

function summarizeFlow(flow: FlowRow): Record<string, unknown> {
  const draft = getLatestDraft(flow.id);
  const published = flow.published_version_id ? getFlowVersion(flow.published_version_id) : null;
  const displayName = draft?.displayName ?? published?.displayName ?? flow.id;
  // Code units, which is the unit `FLOW_METADATA_MAX_CHARS` compares against and
  // the unit the write-side refusal reports, so the two halves of #598 cannot
  // disagree about a document's size. Named `chars` for that reason: a `bytes`
  // that was really a UTF-16 length would under-report a CJK or emoji document
  // by up to 3x.
  const metadataChars = flow.metadata?.length ?? 0;
  const omitMetadata = metadataChars > FLOW_METADATA_MAX_CHARS;
  const longName = displayName.length > FLOW_NAME_MAX_CHARS;
  return {
    id: flow.id,
    name: longName ? displayName.slice(0, FLOW_NAME_MAX_CHARS) : displayName,
    // Truncated rather than withheld, because a name is what the model resolves
    // a flow BY (`resolveFlow` matches on it) and an absent one would be
    // useless; the id beside it is always exact, so nothing depends on the
    // shortened copy.
    ...(longName ? { nameTruncated: { chars: displayName.length } } : {}),
    status: flow.status,
    publishedVersionId: flow.published_version_id,
    metadata: omitMetadata ? null : parseFlowMetadata(flow),
    // A SIBLING of `metadata`, never a key inside it. The writer controls that
    // object's contents, so any notice placed in there would be forgeable by a
    // caller whose metadata is small enough to pass the cap -- letting them show
    // the model a fake "withheld, see the API" line, or train it to disbelieve a
    // real one. The key set AROUND the value is ours. Worded as a fact rather
    // than an instruction, for the same reason.
    ...(omitMetadata ? { metadataOmitted: { chars: metadataChars } } : {}),
    updated: flow.updated,
  };
}

/**
 * How many rows `actList` will even look at. Unchanged from the `limit: 1000`
 * this function has always passed; the budget below is what actually decides
 * how many are returned.
 */
const LIST_SCAN_MAX_FLOWS = 1000;

/**
 * Character budget for the `flows` array, so `list` is bounded BY
 * CONSTRUCTION rather than by `framedForModel`'s slice (#598).
 *
 * This exists because framing `list` without it would have been a regression.
 * A `summarizeFlow` row measures ~144 characters with `metadata: null`, ~206
 * published with a `{compositionRecordId}`, and ~323 with the 4-key awareness
 * object, so `FRAMED_PAYLOAD_MAX_CHARS` would start slicing MID-OBJECT at
 * somewhere between 12 and 27 workflows -- handing the model a severed JSON
 * document on an ordinary install. Emitting whole rows until the budget is
 * spent keeps the payload parseable and means the truncation branch in
 * `framedForModel` never fires for this action at all.
 *
 * It also closes a LISTING-SUPPRESSION primitive, which is the sharper half.
 * `listFlows` is `ORDER BY updated DESC`, and both `updateFlowMetadata` and a
 * version write (through `touchFlow`) bump `updated`, so an API caller can push
 * their own rows to the head of the listing at will and shove legitimate flows
 * off the end. That is true today at the 6000-char dispatch cap and framing
 * would have tightened it to 4000. What defuses it is not the budget but
 * `truncated` / `total`: the model is TOLD rows were withheld instead of
 * silently seeing a short inventory. A row-count limit could not have done
 * this -- a per-row cost is what has to be bounded, and with a loose metadata
 * cap 25 rows can still be 10 KB.
 *
 * Both halves are needed, and the counters are emitted BEFORE `flows` for that
 * reason: `JSON.stringify` preserves insertion order, so counters placed after
 * the array are the first thing any truncation deletes -- which is exactly how
 * the first version of this failed review. With the array last, the worst a
 * future overrun can do is cut rows, and the count of what was withheld
 * survives.
 *
 * Set below `FRAMED_PAYLOAD_MAX_CHARS` with room for the object around the
 * array.
 */
const LIST_PAYLOAD_MAX_CHARS = 3600;

function actList(): Record<string, unknown> {
  const rows = listFlows(undefined, { limit: LIST_SCAN_MAX_FLOWS });
  const flows: Array<Record<string, unknown>> = [];
  let used = 0;
  for (const row of rows) {
    const summary = summarizeFlow(row);
    // Measured on the EMITTED serialization, not on the stored column, so the
    // budget is exact and does not depend on a round trip being length-stable.
    // +1 for the comma that will separate it from the previous element; the
    // first row is charged a comma it will not emit, which is conservative.
    const cost = JSON.stringify(summary).length + 1;
    // The first row is emitted whatever it costs, so one oversized flow cannot
    // make the listing empty. That exception is only sound because a row's cost
    // is now bounded at BOTH of its caller-written fields -- `metadata` by
    // `FLOW_METADATA_MAX_CHARS` and `name` by `FLOW_NAME_MAX_CHARS`. While
    // `name` was uncapped this was the hole that let one row overrun the budget
    // entirely.
    if (flows.length > 0 && used + cost > LIST_PAYLOAD_MAX_CHARS) break;
    flows.push(summary);
    used += cost;
  }
  return {
    returned: flows.length,
    // Accurate up to LIST_SCAN_MAX_FLOWS. Past that it reads as exactly the
    // scan limit, which understates -- the same bound this function has always
    // had, now at least visible to the caller.
    total: rows.length,
    truncated: flows.length < rows.length,
    flows,
  };
}

function actGet(flow: FlowRow): Record<string, unknown> {
  const summary = summarizeFlow(flow);
  const draft = getLatestDraft(flow.id);
  const published = flow.published_version_id ? getFlowVersion(flow.published_version_id) : null;
  return {
    ...summary,
    latestDraft: draft,
    published,
  };
}

function actRun(flow: FlowRow, payload?: Record<string, unknown>): Record<string, unknown> {
  const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
  if (!versionId) throw new Error("workflow has no draft or published version to run");
  // Same gate the HTTP `/run` route applies, for the same reason: this action
  // will happily run an UNPUBLISHED draft, so without it the publish refusal
  // would be one `run` call wide. The thrown message goes straight back to the
  // model as the tool result, so it relays the opt-in instruction to the user
  // instead of retrying.
  assertCodeStepsAllowed(flow.id, versionId, "run");
  assertVersionReady(flow.id, versionId);
  const run = createFlowRun({
    flowId: flow.id,
    flowVersionId: versionId,
    triggeredBy: "assistant:manage_workflow",
    startTime: Date.now(),
  });
  // The queue's shared RUN_FLOW policy enforces one attempt for chat too.
  enqueue({
    jobType: RUN_FLOW,
    payload: { runId: run.id, payload: payload ?? {} },
    flowRunId: run.id,
    flowId: flow.id,
    flowVersionId: versionId,
  });
  return { run_id: run.id, status: "QUEUED", flow_id: flow.id };
}

function actCreate(displayName: string): Record<string, unknown> {
  const flow = createFlow();
  createDraftVersion({
    flowId: flow.id,
    displayName,
    trigger: {
      name: "trigger",
      type: "EMPTY",
      displayName: "Manual",
      settings: {},
    },
  });
  return summarizeFlow(flow);
}

function actSetStatus(
  flow: FlowRow,
  status: "ENABLED" | "DISABLED",
  deps: ManageWorkflowDeps,
): Record<string, unknown> {
  updateFlowStatus(flow.id, status);
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
  const updated = getFlow(flow.id);
  return updated ? summarizeFlow(updated) : { error: "flow vanished after update" };
}

function actPublish(flow: FlowRow, deps: ManageWorkflowDeps): Record<string, unknown> {
  const target = getLatestDraft(flow.id);
  if (!target) {
    if (flow.published_version_id) {
      // Already published, nothing to do.
      return summarizeFlow(flow);
    }
    throw new Error("no draft version to publish");
  }
  // Publish is the last gate before a flow starts running for real, and it is
  // the ONLY one a hand-built flow passes through -- a flow drawn in the
  // visual editor never meets the composer's validation. Re-check OS fit here
  // so a `notepad.exe` step someone typed by hand is called out before it
  // starts failing on a schedule.
  //
  // Warnings, not a refusal: the draft may deliberately target a machine that
  // is not enrolled yet, and blocking someone's publish over a heuristic would
  // be worse than the mismatch it prevents.
  const warnings = publishOsWarnings(target.trigger, deps);
  const { flow: updated } = publishFlowVersion(flow.id, target.id);
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
  return warnings.length > 0
    ? { ...summarizeFlow(updated), warnings }
    : summarizeFlow(updated);
}

/**
 * OS-fit warnings for a version about to be published. Empty whenever the
 * check can't be trusted -- no machine inventory, or a machine whose OS was
 * never reported.
 */
function publishOsWarnings(trigger: unknown, deps: ManageWorkflowDeps): string[] {
  if (!deps.executionTargets) return [];
  const ctx = osCheckContextFor(deps.executionTargets());
  return ctx ? flowOsWarnings(trigger, ctx) : [];
}

function actDelete(flow: FlowRow, deps: ManageWorkflowDeps): Record<string, unknown> {
  deleteFlow(flow.id);
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
  return { id: flow.id, deleted: true };
}

const RAW_RESPONSE_CAP = 4096;

async function actCompose(
  name: string,
  description: string,
  deps: ManageWorkflowDeps,
): Promise<Record<string, unknown>> {
  if (!deps.llm) {
    throw new Error("compose: an LLM client is not configured for this build");
  }
  if (!deps.pieceRegistry) {
    throw new Error("compose: piece registry is not configured for this build");
  }

  // Reject up-front when a flow with the same display name already exists.
  // Auto-suffixing silently ("My Flow (2)") is more annoying than helpful;
  // the assistant can rename and call again.
  const collision = findFlowByDisplayName(name);
  if (collision) {
    return {
      ok: false,
      errors: [`a workflow named "${name}" already exists (id=${collision.id}); pick a different name`],
      rawResponse: null,
    };
  }

  const composeDeps: ComposeDeps = {
    llm: deps.llm,
    pieceRegistry: deps.pieceRegistry,
  };
  if (deps.toolRegistry) {
    // Prefer the richer schema listing so the composer can validate invoke
    // params; fall back to bare names when the registry doesn't supply it.
    const detailed = deps.toolRegistry.listDetailed?.();
    if (detailed && detailed.length > 0) {
      composeDeps.tools = detailed;
    } else {
      composeDeps.toolNames = deps.toolRegistry.listNames();
    }
  }
  if (deps.specialistRoles) {
    const roles = deps.specialistRoles();
    if (roles.length > 0) composeDeps.specialistRoles = roles;
  }
  if (deps.library && deps.library.length > 0) composeDeps.library = deps.library;
  if (deps.executionTargets) {
    const targets = deps.executionTargets();
    if (targets.length > 0) composeDeps.executionTargets = targets;
  }
  const result = await composePersistedFlow(composeDeps, { name, description });

  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      rawResponse: capRawResponse(result.rawResponse),
      compositionRecordId: result.compositionRecordId,
      ...(result.suggestedInstalls && result.suggestedInstalls.length > 0
        ? { suggestedInstalls: result.suggestedInstalls }
        : {}),
    };
  }

  // Persist as a fresh flow + draft version. The flow is created DISABLED;
  // the user must publish + enable explicitly.
  const flow = createFlow({ metadata: { compositionRecordId: result.compositionRecordId } });
  const flowName = result.flow.displayName.trim() || name;
  const version = createDraftVersion({
    flowId: flow.id,
    displayName: flowName,
    trigger: result.flow.trigger,
  });
  return {
    ok: true,
    flow: summarizeFlow(getFlow(flow.id) ?? flow),
    versionId: version.id,
    compositionRecordId: result.compositionRecordId,
  };
}

function findFlowByDisplayName(name: string): FlowRow | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  for (const flow of listFlows(undefined, { limit: 1000 })) {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) continue;
    const version = getFlowVersion(versionId);
    if (version && version.displayName.toLowerCase() === target) return flow;
  }
  return null;
}

function capRawResponse(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length <= RAW_RESPONSE_CAP) return raw;
  return raw.slice(0, RAW_RESPONSE_CAP) + `\n... (truncated, ${raw.length - RAW_RESPONSE_CAP} more chars)`;
}

/** Re-export for tests so they can inspect the parser output without going through the LLM. */
export type { ComposedFlow };

function actListRuns(flowRef: string | undefined, limit: number): Array<Record<string, unknown>> {
  const flow = flowRef ? resolveFlow(flowRef) : null;
  const opts: Parameters<typeof listRuns>[0] = { limit };
  if (flow) opts.flowId = flow.id;
  return listRuns(opts).map((r) => summarizeRun(r));
}

function actGetRun(runId: string): Record<string, unknown> {
  const run = getFlowRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  return summarizeRun(run, true);
}

function summarizeRun(run: FlowRun, includeSteps = false): Record<string, unknown> {
  return {
    id: run.id,
    flow_id: run.flowId,
    status: run.status,
    environment: run.environment,
    triggeredBy: run.triggeredBy,
    startTime: run.startTime,
    finishTime: run.finishTime,
    durationMs: run.startTime && run.finishTime ? run.finishTime - run.startTime : null,
    stepsCount: run.stepsCount,
    failedStep: run.failedStep,
    ...(includeSteps ? { steps: run.steps } : {}),
  };
}
