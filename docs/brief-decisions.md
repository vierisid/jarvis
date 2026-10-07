# Shared decision queue (F-12)

F-12 provides one authenticated, default-off projection for Today, Needs you and run detail. It retains unresolved work from earlier days and reads canonical approvals, commitment work and workflow effect receipts. It adds no execution engine and no room/layout changes.

## Activation and rollback

Set `JARVIS_BRIEF_DECISIONS=1` in an integration daemon's environment and restart. The exact value `1` enables `decisions` independently of other Brief flags. Confirm `decisions.enabled` at `GET /api/brief/capabilities`. The constructor runs after the shared vault and workflow schemas initialize. Missing, disabled, mismatched or replaced providers fail closed.

Rollback: unset the flag and restart. Keep the additive placement/clock tables and source records. Existing legacy writers, approvals, receipts and work history remain authoritative. This PR does not enable a production daemon or merge any branch.

## API

All responses use `Cache-Control: no-store` and the existing daemon session gate.

| Request | Meaning |
| --- | --- |
| `GET /api/brief/decisions?limit=30` | Shared unresolved queue, with no current-day cutoff. Returns `{state:"ready",asOf,data:{items,nextCursor}}`, including an empty `items` array when there are no decisions. |
| `GET /api/brief/decisions?runId=ID&limit=30` | Same identities and projections restricted to one canonical run. |
| `GET /api/brief/decisions/:id` | Current decision by stable ID, including terminal records after they leave the queue. Use after a lost action response. |
| `POST /api/brief/decisions/:id/placement` | `{revision,position}` persists an integer queue position from -1000000 to 1000000. Lower values come first; zero restores default placement. |
| `POST /api/brief/decisions/:id/resolve` | `{revision,action,reason?,note?}` dispatches only an advertised action through the existing canonical writer. |

URL-encode IDs as a single path segment, for example `encodeURIComponent("approval:" + approvalId)`. Unknown/duplicate query fields, malformed cursors, overlarge bodies and unsupported actions are rejected. Responses cap pages at 100 and effect references at 50. `relatedTruncated` reports additional effects; aggregate status still includes them all. Tool arguments and raw effect results are not returned.

Stable IDs are `approval:<approvalId>`, `work:<commitmentId>` and `effect:<effectId>`. An effect with a present approval resolves to that approval's ID, including through effect-ID lookup. The global queue emits that approval once, and suppresses the linked work wrapper while unresolved effects need attention. Run detail can use the same read with `runId`; no screen should invent another approval identity. A work item's acceptance and a later permission grant remain separate decisions.

The projection extends `BriefDecision` with typed `refs`, `state`, `kind`, `title`, `createdAt`, `placement`, `supportedActions` and `relatedTruncated`. `approval`, `workStatus`, `workflow` and `run` preserve their separate canonical facts. Render the projected `state` as the decision's attention state: an unknown effect can coexist with a run marked `SUCCEEDED` or a legacy user check marked `verified`.

## Actions and reconciliation

| supportedActions value | Existing writer | Result |
| --- | --- | --- |
| `accept_intent`, `reject_intent` | `decideWorkItem` | Requires `reason`. Freezes the work proposal; does not grant permission, start a run or verify a result. |
| `approve_permission`, `reject_permission` | `applyApprovalDecision` | Decides permission. Existing execution ownership controls continuation: deferred calls may execute; inline/workflow requests remain owned by their caller/scheduler. |
| `execute_once` | `applyExecutionResolution` | Only a reconciled, not-started, non-workflow approval with an executable tool. Uses the existing durable execution claim. |
| `close_without_running` | `applyExecutionResolution` | Closes reconciled not-started/unknown non-workflow approval. Optional `note`, at most 500 characters. This is not a successful effect. |
| `inspect` | Read only | Never submit as a resolution. Follow the typed source/run references for existing blocker, execution and result-check workflows. |

Legacy `actions` retains permission `approve`/`reject` and `inspect` only. New clients should use `supportedActions`; accepting an intent must never be rendered as granting permission.

Every mutation carries the exact server `revision`. The revision is rechecked atomically with the canonical decision/claim. External dispatch starts only after the approval/claim is committed. Existing CAS writers prevent duplicate execution across Brief and legacy surfaces. On a stale revision, get the same decision again. On timeout/network loss/503, get by ID before offering another action; do not assume either success or failure and do not automatically repeat the POST. If permission changed but execution is still in flight, continue reading that ID for its receipt.

Blocked, failed and unknown receipts remain inspectable attention items. Unknown effects never advertise replay, and closing an approval never manufactures a success receipt. A legacy `executed` approval without a qualified receipt is shown as `unknown`. Verified result checks continue through the existing work-result workflow, separate from this queue's intent/permission actions.

Rejecting a workflow permission resolves the approval as `denied`, but does not resolve the linked workflow blocker. The existing scheduler resumes the workflow to record a `blocked` effect without dispatching it. That receipt intentionally remains in the queue with `approval.status: "denied"`, attention `state: "blocked"` and only `inspect`, including after restart. Follow its run reference for investigation; this queue has no workflow-receipt dismissal or replay action. A rejected permission without an unresolved workflow effect leaves the queue and remains available by ID.

## Ordering and pagination

Order is `(persisted position, source creation time, stable decision ID)`. Cursors are opaque, scoped to the run filter and tied to a durable queue generation. SQLite selects at most `limit + 1` identities per page; it does not load the full work/history list into application memory. Projections read their current source records in the same database snapshot.

Any source or placement write invalidates an unfinished traversal. A stale cursor returns `409` with `code: "queue_changed"`; discard the old pages and start from the first page. This explicit refresh policy avoids mixing snapshots or silently skipping/repeating cards after insertions, status changes, deletions or reordering. It also means a busy running workflow can require a refresh while paging. Cursor scope errors return 400. A cursor survives restart when its source generation has not changed.

## Quick verification

From the F-12 worktree in WSL:

```sh
bun install --frozen-lockfile
bun test src/brief/decisions.test.ts src/daemon/api-brief-decisions.test.ts src/workflows/adapters/untrusted-reach.test.ts
```

The tests use temporary databases, synthetic tools and a Unix socket. They do not call real providers or send real messages. They exercise:

1. Three-day-old proposed work, persisted placement and restart rehydration.
2. Intent acceptance without dispatch, separate permission execution, lost-response lookup and duplicate-click fencing.
3. Approval/effect/run identity deduplication and blocked/unknown effects overriding misleading run/work success.
4. 205 equal-time decisions over three bounded pages, plus explicit refresh after concurrent source/placement changes.
5. Real authenticated HTTP reads/writes, encoded IDs, disabled/missing providers, stale revisions and malformed bodies.
6. A second database connection observing the durable claim before the fake tool starts.
7. Hostile workflow steps, failure messages, samples, inputs and effect results stay outside decision responses for all three source kinds.
8. Workflow rejection through the real authority boundary and scheduler, no dispatch, one blocked receipt, restart and unsupported replay/close attempts.

For a live integration check, enable the flag only on a disposable daemon, authenticate through its usual dashboard session, read the same queue from both rooms, accept a synthetic work item and reload it by ID. Expect `ready`, never `verified`. Re-submit its previous revision and expect 409. With a synthetic approval linked to a run effect, global/run/effect lookup must return the same `approval:` identity. After an unknown effect receipt, expect `unknown` and inspect-only actions even if that run says `SUCCEEDED`.

UI binding belongs to the D track. No screenshot is provided because F-12 changes the provider and API rather than the rendered rooms. F-13 recommendations and F-14 editing are not implemented here.
