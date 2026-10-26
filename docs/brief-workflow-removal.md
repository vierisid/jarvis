# F20: reversible workflow removal

F20 adds a durable Remove/Undo service over the existing workflow engine. It is off by default behind `JARVIS_BRIEF_WORKFLOW_REMOVAL=1` and the exact registered `workflowRemoval` provider. No UI cutover is included.

## Behavior

Remove atomically hides the workflow from active lists, sets activation to `DISABLED`, advances its trigger generation, and records a receipt and immutable command outcome. Flow, selected version, run, queue and effect identities remain intact. Both the Brief collection and legacy `listFlows` exclude active tombstones. Direct workflow and run reads remain available for history and work already accepted.

Undo is available for **30 seconds**, measured by the server. It restores the same flow and selected version to its original stable list slot, always `DISABLED` (Paused). Newly created flows keep their new slots. Only a later explicit Enable command can turn it on, through existing readiness and CODE permission checks. For unpublished workflows, removal pins the selected draft durably. Bookkeeping from older accepted runs cannot switch that draft during removal or after Undo. Reads, readiness/CODE permission checks and trigger dispatch share the same selector. An explicit authoring edit, a new draft or publication ends the pin. DRAFT/LOCKED and published-version semantics remain unchanged.

Remove turns the workflow off with Q-06 semantics, whatever its activation was: it stamps `disabled_at`, so its QUEUED runs and runs waiting on a timer or approval (PAUSED) are stopped with the turned-off reason, and nothing created before the removal can start or continue later. A RUNNING run is not interrupted; if it pauses, it does not continue. Stopping a run also stops its required child runs (Q-10). Stopping is done eagerly by registration reconciliation and enforced durably by every continuation path, so a crash in between still stops them. Remove does not undo external effects or erase history. Undo never revives a stopped run, and never queues or replays one. The removed projection lists the IDs and statuses of nonterminal runs; normal run inspection retains completed evidence.

SQLite triggers refuse new runs, re-enabling and authoring changes while removed, including writes through legacy routes or another database connection. Flows and versions with removal history cannot be hard-deleted by the legacy paths, even after Undo: the legacy `DELETE /api/workflows/:id` and `manage_workflow` delete refuse such a flow with `workflow_history_retained` before stopping any of its runs. Expiry removes Undo availability; it does not purge anything by itself. Only a person's purge (below) deletes such a flow. There is no post-expiry restore endpoint.

Trigger callbacks, engine registration and delayed polling results carry a durable removal generation. A result from before removal cannot enqueue after Remove/Undo/re-enable. Webhook requests capture their registration and generation before reading the body or checking HMAC. If that registration is replaced while the request waits, it returns HTTP 409 without dispatch; fresh requests use the new registration. The final eligibility check, run creation and queue insertion share a write transaction. Registration reconciliation is durable and retried after restart, including with the feature flag off. Local delivery is fenced immediately; external unsubscribe is best effort under the existing trigger manager. `registration: reconciled` means local refresh settled, not a certified remote unsubscribe.

## Authenticated API

All routes use the daemon's existing authentication boundary and return `Cache-Control: no-store`. The project scope is configured by the server, not taken from a client-selected tenant. Unexpected query parameters are rejected.

- `GET /api/brief/workflows`: authoritative complete ordered collection in `data.items`; `data.removals` contains active receipts, the original revision, expiry, stable position, retained item and nonterminal runs. `data.slots` preserves positions through reload. `data.scope` describes running-work behavior.
- `POST /api/brief/workflows/commands`: accepts one command and atomically records its accepted or rejected outcome. Maximum body is 4096 bytes, valid UTF-8 JSON with only known fields.
- `POST /api/brief/workflows/purges`: a person's purge of one workflow (#1096). Same body limits and request-id rules as `/commands`.
- `GET /api/brief/workflows/requests/:requestId`: read-only recovery of the exact original outcome, for commands and purges. It never resubmits a command or replays a run.

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

## Purge

A purge hard-deletes a workflow that has removal history. It applies to a restored workflow, or to a removed one whose Undo has expired. A removed workflow inside its Undo window answers `undo_available`; a workflow never removed answers `not_removed` (the ordinary delete serves it). The body names the current item exactly as the list shows it (from `data.items`, or `data.removals[].item` for a removed one):

```json
{
  "scopeId": "project-id-from-snapshot",
  "flowId": "flow-id-from-snapshot",
  "versionId": "version-id-from-snapshot-or-null",
  "expectedRevision": "64-character-revision-from-snapshot",
  "requestId": "unique-client-request-id"
}
```

It is a person's path only. The route needs a live dashboard panel session even when `auth.insecure_open_access` is on (it answers 403 `session_required` without one), a JSON content type (415 otherwise) and passes the cross-site write guard. Neither `manage_workflow` nor any agent tool calls it. The receipt names the enrolled device whose session sent it. One limit is not this route's: anything that runs scripts in the dashboard's own origin carries that session. The site-builder preview runs agent-built site code in that origin today, so such code can call this route, like every other dashboard route, while the person has the preview open. A stale revision or version answers `revision_conflict`. Refusals are durable outcomes like any other command, and a retry with the same request id returns the original outcome.

Nothing is stopped until the purge is accepted. Acceptance records a purge receipt (flow, generation, who, when) and turns the workflow off, so a run it had queued can never start even if the daemon stops before the next step. Then its queued, running and waiting runs are stopped with the deleted reason (Q-06), including waiting DEFER steps and required child runs. Their workflow cards are closed and dropped from the dashboard, as are the cards of runs that ended before they parked. One transaction then deletes the flow, its versions, runs, effects, waitpoints, trigger events, step files, jobs, its FLOW-scoped piece store entries and its removal receipts. The receipt gets its counts. After it commits, the engine's execution-state backups (`workflow-logs/<runId>.bin`) and the disk copies of its step files (`workflow-files/<flowId>/`) are removed; the receipt keeps the run ids until that succeeds, and recovery retries it. Command outcomes (including earlier Remove outcomes, which carry the workflow's name), the trigger delivery ledger, recovery receipts, manual-run request receipts and approval records (with their bounded step arguments) stay as the audit trail. Deleted rows can remain in SQLite free pages and the WAL until they are overwritten.

If the delete does not commit, the purge stays accepted: no run of that workflow can start, it cannot be turned on, and Remove, activation and a second purge answer `purge_pending`. Recovery finishes it on the next pass or boot, and only for a purge whose accepted outcome is recorded. A run still executing in this process when the purge stops it is told to stop, but an effect it had already dispatched can finish after its records are gone; the trigger ledger and approval records keep what happened.

The removal receipts carry a foreign key to the flow, so they must go before it, and the flow and version fences key on them. The receipts are therefore fenced themselves: a trigger refuses their delete unless the purge's own transaction has set its grant, and the grant is cleared before that transaction commits; another refuses moving them to another flow at all. Purge receipts cannot be deleted, and a completed one cannot be changed. These fences stop legacy code paths and ordinary writes from another connection; like every SQLite trigger they do not stop a writer that sets out to defeat them (it could drop the trigger).

## Limits and recovery

The complete snapshot supports 1000 workflows including removed ones, 1000 nonterminal runs per removed workflow and 16 MiB of serialized projection data. It fails explicitly with 503 beyond a limit; it never presents a partial page as the whole collection. The database stores up to 10000 ordinary command outcomes (purges count as ordinary) and 10000 removal receipts. Each receipt also reserves one successful Undo outcome, so valid, unexpired Undo remains available even when Remove consumes the last ordinary command slot. Total command outcomes are bounded by 20000. Invalid or reused receipts cannot consume reserved capacity. Replays of existing commands remain available at capacity. A refused ordinary command rolls back all attempted mutations. No record is silently evicted.

Stable slots are backfilled once from existing workflow order and created transactionally for new workflows. Additive schema installation preserves old rows, adds the draft pin and shared selection view, and backfills the selected draft from active receipts created by the earlier F20 schema. The removal tables and database fences remain installed when the capability is disabled. Runtime recovery processes up to 100 pending flows per scan, skips work already being reconciled, and retries every five seconds. A restarted/replaced runtime can retry a stalled predecessor.

## D21 and Q06 integration

The API projection and command results match D21's management port. A rejected result also carries a stable `code`, which D21's validator ignores. Like the other Brief reads, `GET /api/brief/workflows` answers `{ state, data, asOf }`; the host adapter maps it to D21's `BriefReadState` and passes `data.scopeId` and `data.items` as the list. There is no browser or live host integration test yet.

D21's host adapter must bind these routes, persist pending request identity, and hydrate durable removals/positions before enabling its production controls. Receipt expiry is server-authoritative. Keep controls gated until that integration is tested. Trigger admission is Q-06's: the removal check and the removal generation sit in the trigger manager's single admission check, so every live delivery (schedule, webhook, event, engine poll) is refused and recorded once a workflow is removed, and a delivery captured under an older registration is refused after Undo and re-enable.

## Verify locally

```bash
bun test src/brief/workflow-removal.test.ts src/brief/workflow-purge.test.ts src/workflows/runner/triggers/workflow-removal.test.ts src/daemon/api-brief-workflow-removal.test.ts src/workflows/adapters/untrusted-reach.test.ts
```

These tests use isolated temporary SQLite files and local scripted runtimes. No production workflows, provider calls or external effects are needed.

## Rollback

A purge accepted but not finished when the binary is rolled back stays pending: the older binary never finishes it, and its fences keep that workflow from running or being turned on. Finish pending purges (restart the current binary) before rolling back.

Unset `JARVIS_BRIEF_WORKFLOW_REMOVAL` and restart to disable new Brief commands. Keep the additive tables, draft pin and shared selection view, list filtering, database fences and generation checks. A pre-F20 binary can misrepresent removed rows and lacks generation checks; do not roll back those protections after removal has been used. There is no destructive down migration.
