# F20: reversible workflow removal

F20 adds a durable Remove/Undo service over the existing workflow engine. It is off by default behind `JARVIS_BRIEF_WORKFLOW_REMOVAL=1` and the exact registered `workflowRemoval` provider. This branch is stacked on corrected F19; no UI cutover or deployment is included.

## Behavior

Remove atomically hides the workflow from active lists, sets activation to `DISABLED`, advances its trigger generation, and records a receipt and immutable command outcome. Flow, selected version, run, queue and effect identities remain intact. Both the Brief collection and legacy `listFlows` exclude active tombstones. Direct workflow and run reads remain available for history and work already accepted.

Undo is available for **30 seconds**, measured by the server. It restores the same flow and selected version to its original stable list slot, always `DISABLED` (Paused). Newly created flows keep their new slots. Only a later explicit Enable command can turn it on, through existing readiness and CODE permission checks. DRAFT/LOCKED and published-version semantics remain unchanged.

Previously accepted QUEUED, RUNNING and PAUSED runs continue under their existing authority, cancellation and effect rules. Remove is not cancellation. It does not undo external effects or erase history. Undo never queues or replays a run. The removed projection lists the IDs and statuses of accepted nonterminal runs; normal run inspection retains completed evidence.

SQLite triggers refuse new runs, re-enabling and authoring changes while removed, including writes through legacy routes or another database connection. Flows and versions with removal history cannot be hard-deleted, even after Undo. Expiry removes Undo availability; it does not purge anything. There is no purge or post-expiry restore endpoint in this PR.

Trigger callbacks, engine registration and delayed polling results carry a durable removal generation. A result from before removal cannot enqueue after Remove/Undo/re-enable. The final eligibility check, run creation and queue insertion share a write transaction. Registration reconciliation is durable and retried after restart, including with the feature flag off. Local delivery is fenced immediately; external unsubscribe is best effort under the existing trigger manager. `registration: reconciled` means local refresh settled, not a certified remote unsubscribe.

## Authenticated API

All routes use the daemon's existing authentication boundary and return `Cache-Control: no-store`. The project scope is configured by the server, not taken from a client-selected tenant. Unexpected query parameters are rejected.

- `GET /api/brief/workflows`: authoritative complete ordered collection in `data.items`; `data.removals` contains active receipts, the original revision, expiry, stable position, retained item and nonterminal runs. `data.slots` preserves positions through reload. `data.scope` describes running-work behavior.
- `POST /api/brief/workflows/commands`: accepts one command and atomically records its accepted or rejected outcome. Maximum body is 4096 bytes, valid UTF-8 JSON with only known fields.
- `GET /api/brief/workflows/requests/:requestId`: read-only recovery of the exact original outcome. It never resubmits a command or replays a run.

The list supplies the real values for this Remove command:

```json
{
  "scopeId": "project-id-from-snapshot",
  "flowId": "flow-id-from-snapshot",
  "versionId": "version-id-from-snapshot-or-null",
  "expectedRevision": "64-character-revision-from-snapshot",
  "requestId": "unique-client-request-id",
  "action": "remove"
}
```

Persist the request identity before dispatch. A retry with the exact same identity and payload returns the original result. Reusing its ID for a different command returns HTTP 409 `request_conflict`. A lost response should be recovered by GET, followed by a fresh list read. An old accepted result is an immutable historical receipt, not proof of the current workflow state.

For Undo, use `action: restore`, a **new** request ID, the receipt's `receiptId`, and the original flow/version/revision. Reload recovery obtains these values from `data.removals`. Exact expiry, stale revision/version or a receipt from an earlier removal produces a durable rejected result. Accepted Undo returns the paused item and its new revision. For explicit Enable, send a new `activation` command with that current revision and `activation: ENABLED`.

Domain conflicts and readiness failures return HTTP 200 with `status: rejected`, a stable code and safe message. Malformed input returns 400, foreign or missing identity 404, mismatched request reuse 409, oversized body 413, absent/mismatched provider 501 and unavailable/disabled/capacity-exceeded service 503. Do not interpret transport failures as a rejected mutation.

## Limits and recovery

The complete snapshot supports 1000 workflows including removed ones, 1000 nonterminal runs per removed workflow and 16 MiB of serialized projection data. It fails explicitly with 503 beyond a limit; it never presents a partial page as the whole collection. The database stores up to 10000 command outcomes and 10000 removal receipts. Replays of existing commands remain available at capacity. No record is silently evicted.

Stable slots are backfilled once from existing workflow order and created transactionally for new workflows. Additive schema installation preserves old rows. The removal tables and database fences remain installed when the capability is disabled. Runtime recovery processes up to 100 pending flows per scan, skips work already being reconciled, and retries every five seconds. A restarted/replaced runtime can retry a stalled predecessor.

## D21 and Q06 integration

The API projection and command results match D21's management port. A fixture probe used the actual D21 validators at `3131564517fe5dd4a9bd136abe688b45b0bf4337` for list, Remove, request recovery, paused Undo, explicit Enable and stale rejection. This is contract evidence, not a browser or live host integration test.

D21's host adapter must bind these routes, persist pending request identity, and hydrate durable removals/positions before enabling its production controls. Receipt expiry is server-authoritative. Keep controls gated until that integration is tested. Q06 also changes trigger/continuation behavior; its work has not been imported or overwritten. Resolve shared manager/flow changes in the integration branch and rerun both suites before release.

## Verify locally

From this worktree in WSL, with Bun on PATH:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-20
export PATH="$HOME/.bun/bin:$PATH"
bun test src/brief/workflow-removal.test.ts src/workflows/runner/triggers/workflow-removal.test.ts src/daemon/api-brief-workflow-removal.test.ts
```

The tests use isolated temporary SQLite files and local scripted runtimes. They exercise Remove, reload, reverse-order Undo, expiry, identity conflicts, storage rollback, legacy-write fences, real Worker completion without replay, delayed engine/cron races, restart recovery, capability checks and authenticated Unix-socket HTTP. No production workflows, provider calls or external effects are needed. Full commands and verdict-only evidence are in `docs/brief-delivery/F-20.json`.

## Rollback

Unset `JARVIS_BRIEF_WORKFLOW_REMOVAL` and restart to disable new Brief commands. Keep the additive tables, list filtering, database fences and generation checks. Existing accepted work still follows its own cancellation/authority lifecycle. A pre-F20 binary can misrepresent removed rows and lacks generation checks; do not roll back those protections after removal has been used. There is no destructive down migration.

F21 is not part of this PR.
