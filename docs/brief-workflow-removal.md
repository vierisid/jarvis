# F20: reversible workflow removal

F20 adds a durable Remove/Undo service over the existing workflow engine. It is off by default behind `JARVIS_BRIEF_WORKFLOW_REMOVAL=1` and the exact registered `workflowRemoval` provider. No UI cutover is included.

## Behavior

Remove atomically hides the workflow from active lists, sets activation to `DISABLED`, advances its trigger generation, and records a receipt and immutable command outcome. Flow, selected version, run, queue and effect identities remain intact. Both the Brief collection and legacy `listFlows` exclude active tombstones. Direct workflow and run reads remain available for history and work already accepted.

Undo is available for **30 seconds**, measured by the server. It restores the same flow and selected version to its original stable list slot, always `DISABLED` (Paused). Newly created flows keep their new slots. Only a later explicit Enable command can turn it on, through existing readiness and CODE permission checks. For unpublished workflows, removal pins the selected draft durably. Bookkeeping from older accepted runs cannot switch that draft during removal or after Undo. Reads, readiness/CODE permission checks and trigger dispatch share the same selector. An explicit authoring edit, a new draft or publication ends the pin. DRAFT/LOCKED and published-version semantics remain unchanged.

Remove turns the workflow off with Q-06 semantics, whatever its activation was: it stamps `disabled_at`, so its QUEUED runs and runs waiting on a timer or approval (PAUSED) are stopped with the turned-off reason, and nothing created before the removal can start or continue later. A RUNNING run is not interrupted; if it pauses, it does not continue. Stopping a run also stops its required child runs (Q-10). Stopping is done eagerly by registration reconciliation and enforced durably by every continuation path, so a crash in between still stops them. Remove does not undo external effects or erase history. Undo never revives a stopped run, and never queues or replays one. The removed projection lists the IDs and statuses of nonterminal runs; normal run inspection retains completed evidence.

SQLite triggers refuse new runs, re-enabling and authoring changes while removed, including writes through legacy routes or another database connection. Flows and versions with removal history cannot be hard-deleted, even after Undo. Expiry removes Undo availability; it does not purge anything. There is no purge or post-expiry restore endpoint in this PR.

Trigger callbacks, engine registration and delayed polling results carry a durable removal generation. A result from before removal cannot enqueue after Remove/Undo/re-enable. Webhook requests capture their registration and generation before reading the body or checking HMAC. If that registration is replaced while the request waits, it returns HTTP 409 without dispatch; fresh requests use the new registration. The final eligibility check, run creation and queue insertion share a write transaction. Registration reconciliation is durable and retried after restart, including with the feature flag off. Local delivery is fenced immediately; external unsubscribe is best effort under the existing trigger manager. `registration: reconciled` means local refresh settled, not a certified remote unsubscribe.

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

The complete snapshot supports 1000 workflows including removed ones, 1000 nonterminal runs per removed workflow and 16 MiB of serialized projection data. It fails explicitly with 503 beyond a limit; it never presents a partial page as the whole collection. The database stores up to 10000 ordinary command outcomes and 10000 removal receipts. Each receipt also reserves one successful Undo outcome, so valid, unexpired Undo remains available even when Remove consumes the last ordinary command slot. Total command outcomes are bounded by 20000. Invalid or reused receipts cannot consume reserved capacity. Replays of existing commands remain available at capacity. A refused ordinary command rolls back all attempted mutations. No record is silently evicted.

Stable slots are backfilled once from existing workflow order and created transactionally for new workflows. Additive schema installation preserves old rows, adds the draft pin and shared selection view, and backfills the selected draft from active receipts created by the earlier F20 schema. The removal tables and database fences remain installed when the capability is disabled. Runtime recovery processes up to 100 pending flows per scan, skips work already being reconciled, and retries every five seconds. A restarted/replaced runtime can retry a stalled predecessor.

## D21 and Q06 integration

The API projection and command results match D21's management port. A rejected result also carries a stable `code`, which D21's validator ignores. Like the other Brief reads, `GET /api/brief/workflows` answers `{ state, data, asOf }`; the host adapter maps it to D21's `BriefReadState` and passes `data.scopeId` and `data.items` as the list. There is no browser or live host integration test yet.

D21's host adapter must bind these routes, persist pending request identity, and hydrate durable removals/positions before enabling its production controls. Receipt expiry is server-authoritative. Keep controls gated until that integration is tested. Trigger admission is Q-06's: the removal check and the removal generation sit in the trigger manager's single admission check, so every live delivery (schedule, webhook, event, engine poll) is refused and recorded once a workflow is removed, and a delivery captured under an older registration is refused after Undo and re-enable.

## Verify locally

```bash
bun test src/brief/workflow-removal.test.ts src/workflows/runner/triggers/workflow-removal.test.ts src/daemon/api-brief-workflow-removal.test.ts src/workflows/adapters/untrusted-reach.test.ts
```

These tests use isolated temporary SQLite files and local scripted runtimes. No production workflows, provider calls or external effects are needed.

## Rollback

Unset `JARVIS_BRIEF_WORKFLOW_REMOVAL` and restart to disable new Brief commands. Keep the additive tables, draft pin and shared selection view, list filtering, database fences and generation checks. A pre-F20 binary can misrepresent removed rows and lacks generation checks; do not roll back those protections after removal has been used. There is no destructive down migration.
