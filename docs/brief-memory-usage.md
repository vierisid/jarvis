# F18: recorded memory use

F18 records canonical fact IDs and revisions selected by recall and supplied to a model provider. It adds no memory truth rules and does not infer that an answer relied on a supplied fact.

Branch `brief/f-18` is stacked on corrected F17 `42e54d637f2b4c0e955bae4bd6183b1373bd7442`, targeting `brief/f-17`, as requested by the owner. Main inspected: `2281a8235d4987af202e3b99f7ea514ac7ed4ff8`. The pinned audit is `69211511c95355776c6c319c01e1df5acd3b8f1e`. Its facts source is unchanged on main and the stack. The WebSocket source has later approval-delivery changes on main and scoped chat changes on the F stack. F18 instruments the existing retrieval and provider handoffs below AgentService, leaving WebSocket ownership intact. No other open F18 PR existed at the start.

## What the record means

- `selected`: a current canonical fact reached the bounded packing candidates. It may still be omitted because its group, alias dependency, fact count or text does not fit.
- `supplied`: the packer's included IDs were handed to an actual model-provider adapter in a system message. It is not an acknowledgement from a remote model, proof of reliance, or proof of a successful answer. A provider failure after handoff retains this stage.
- `outcome_verified`: a distinct reserved evidence stage. F18 does not create it automatically, and the automatic writer rejects promotion to it. A future producer needs an explicit fact-to-outcome verifier; a successful answer, JSON contract or workflow run is insufficient.

The packer emits structured selected/included manifests when it appends whole qualified facts. The provider hook checks that the same complete packed block is still in the outgoing system messages, including the role builder's delimiter-neutralized form. It never discovers fact IDs by parsing text. A discarded block, explicit workflow system override, or a copy in a user message cannot manufacture supply.

Canonical assertion/evidence revisions are SHA-256 digests of the subject name, canonical fact fields, evidence and qualification. They exclude the use ledger and are distinct from F17's aggregate stream-item revision. Changing usage cannot change the captured source revision. Records carry purpose, time, fact ID, source revision and either the exact conversation/turn/request or workflow/run plus a stable step/execution-path digest. Repeated provider attempts and effect replays preserve one record per identity, revision and stage; existing rows and timestamps are not updated.

## Runtime coverage and gates

`JARVIS_BRIEF_MEMORY_USAGE=1` explicitly enables instrumentation and the `memoryUsage` capability. It is off by default. Production registers the same ledger instance with the capability registry and F17 stream reader. `JARVIS_BRIEF_MEMORY_STREAM=1` is additionally required for F17 list/detail/history routes. Enabling usage does not enable the Brief chat transport, UI, or any workflow.

Instrumented paths are canonical Brief conversation recall, including classic and router-first AgentService turns and their scoped model calls, and governed workflow `jarvis-ask` calls that use the Jarvis prompt builder. Existing Authority and cancellation checks still own dispatch. Workflow capture starts inside the approved effect, after its checkpoint; pending approval and explicit system overrides do not retrieve memory. Concurrent executions carry independent capture state. A conversation must belong to this daemon's workspace and still be running; a workflow must still belong to its running canonical run.

Unscoped legacy channels, realtime voice, external provider calls, profile/goal context, tool-return memory and older calls are not retroactively attributed. `coverage.paths` declares the instrumented paths. `coverage.completeness` is `recorded_events_only`: an empty list means no retained records, not proof that no other path ever used memory. Disabling instrumentation can create gaps. Consumers must retain this qualification rather than present an all-time usage count.

Immediately before provider handoff, the ledger rechecks every included canonical revision and recall eligibility in one transaction. Correction, deletion, expiry or cancellation during preparation refuses that stale handoff. A later turn rebuilds context through existing recall. Once a handoff occurred, later correction or deletion preserves its old ID and revision as history; it does not make the old fact eligible for future recall. Provider/database failure is unavailable, never fabricated zero usage.

## Read API and retention

`GET /api/brief/memory-usage?conversationId=<id>` or `?runId=<id>` returns retained events for exactly one target, behind existing panel authentication and `Cache-Control: no-store`. Unknown, duplicate, ambiguous, blank or oversized parameters return 400. Missing provider is 501, disabled/unavailable provider is 503. A supported zero-record query returns `empty` with coverage. There is no write or promotion endpoint.

Each summary exposes only IDs, source revision, purpose, stage, time, target identity and current fact state. Deleted facts appear as `factState: missing`; superseded facts retain that status. No fact value, prompt, evidence quote, source URL, token or arbitrary provider metadata is copied into the ledger or response. The additive tables intentionally have no cascading fact/conversation/run foreign keys, so deletion cannot rewrite retained history.

Default bounds are 90 days and 50,000 event rows across all targets. Reads exclude expired events. Startup and each append prune expired/excess rows, oldest first; an idle database can retain expired physical rows until that cleanup, but reads never expose them. Existing SQLite space is reused; this PR does not vacuum or rewrite the database file. Coverage carries the start time and a conservative retention watermark. A target summary above 1,000 events returns unavailable instead of truncating silently. Per-execution transient packing is capped at 32 captures; each recall remains within the existing six-subject, 18-included-fact and 12,000-character bounds. Transient prompt blocks are never persisted by this ledger.

F17 receives the same synchronous ledger reads inside its fact-read transaction, plus usage coverage on pages and details. Its exact Used in filter still excludes selected-only events. Existing pagination detects changed retained use records through its revision checks. Forget/suppression semantics beyond preserving these content-free historical references remain F19.

## Verification

Run in WSL from the dedicated worktree:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-18
bun test src/vault/memory-usage.test.ts src/daemon/agent-service-memory.test.ts src/daemon/api-brief-memory-usage.test.ts src/workflows/runtime/memory-usage.test.ts
```

The fixtures use temporary SQLite databases, real chat transport and AgentService, the governed workflow route/effect boundary, real provider dispatch with scripted in-process models, and an authenticated Unix socket. No live model, email, desktop effect or deployment is required. Evidence and final counts are in `docs/brief-delivery/F-18.json` and `docs/brief-delivery/evidence/F-18/`.

Deliberate unsafe variants must fail: count omitted candidates as supplied, remove event deduplication, or allow stale revisions through handoff. Original source bytes are restored before fresh verification. Existing recall, provider retry/cancellation, workflow authority/effect, memory stream and affected Brief tests are run separately, along with TypeScript and normal commit hooks.

## Rollback

Unset `JARVIS_BRIEF_MEMORY_USAGE` and restart. Capture and usage reads stop, and F17 memory-stream activation fails its dependency gate. Additive tables and retained records remain compatible with older code; no schema rollback or data deletion is needed. Re-enabling starts recording only new observed handoffs and does not fill gaps. No UI is changed or released by this PR. All PRs remain unmerged; F19 is not implemented here.
