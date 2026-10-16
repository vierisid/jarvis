# ON-B-10: recover the exact saved draft

`createDraftResultProvider` is inert and default-off. Its sole public operation is
`read(context, input)`, bound by B11 to `POST /api/onboarding-next/v1/result/read`.
The existing v1 envelope is `{schemaVersion:1,input:{schemaVersion:1,jobId}}`.
A request-key lookup uses `requestId` instead of `jobId`, including refresh before
acceptance returned. Neither is authority: every call resolves the current server
actor/project, live access, service generation and vault again across awaits.
The optional manifest requires `build-job.v1`; absent bindings are unavailable.

## Result and navigation contract

The reader follows B08's exact request/digest to B09's scoped durable receipt. It
loads that flow, version and validated composition in one SQLite read transaction,
checks their association, and verifies the flow is disabled, unpublished and
still has that editable draft. It never selects a different flow or replacement
version. The title and graph come from the same persisted version, and readiness
uses the existing current workflow readiness service. No model, run, publish,
enable, token refresh, connection grant, workflow write or deletion is possible
through this provider.

- `saved` means a durable authorized disabled draft, even if the job still reports
  working/failed/cancelled after a lost reply. `outcome` and `cancellation` retain
  the job's observations. They are not rewritten to success.
- `pending` includes uncertain absence. `no_draft` requires B08's fenced terminal
  absence, or its durable no-job cancellation receipt. A missing read or timeout
  is unavailable. An accepted job's cached success alone cannot produce a result.
- `reference` matches U08's verified draft reference. Full `readiness` contains
  current blockers and runtime checks; `missingBindings` identifies binding/input
  blockers. A saved draft need not be runnable. There is no run-success claim.
- `selectedNodeId` is an existing unique node name in this exact graph, or null.
  Unknown, removed or ambiguous selections never open another node's inspector.
  `contentRevision` hashes the actual version/title/graph. A caller can pin it in
  `expected` to reject an edited graph with `result_changed`.
- `recovery` is a stable `result.read` operation/input descriptor. Persist this
  lookup for onboarding refresh; it pins job, composition, flow and version, but
  allows a fresh read of later edits to the same draft. `workflow` is the existing
  Brief `workflow` room route with both flow and version selection. U10/U09 own
  browser URL persistence and the supplied canvas/inspector renderer. No route
  switch, invented screen or live registration is installed here.
- Reading can repair only a matching B01 `draft_saved` acknowledgement. A lost
  progress acknowledgement does not hide the draft. `journey.sync` and
  `continuation` make that distinction explicit. `continuation`, when present,
  is an explicit `journey.transition`/`finish` command with the current revision
  and stable receipt ID. B01 revalidates the exact draft inside the completion
  transaction, including after asynchronous authorization; a stale descriptor
  cannot finish a deleted, replaced, inaccessible or activated result. U09 sends
  it only on Continue/Explore dashboard. Opening
  or reopening a result never finishes onboarding. B01 handles conflicts and
  replay; refresh before retrying a stale transition. Earlier Explore first
  remains B01/B07's activation action and cannot bypass a reserved build.

Deletion, ownership/receipt mismatch, replaced or locked version, publication,
enablement, malformed graphs and incomplete results fail closed with fixed safe
reasons. The caller retains its recovery descriptor and offers refresh or ordinary
Workflows navigation; it must not silently substitute a latest flow/version.
`activation_changed` does not mean the saved workflow was deleted: later manual
activation belongs to the ordinary workflow detail route.

## Host services and gates

Inject `authorize`, `servicesFor`, `access`, the real B08 `read` adapter and
`createSqliteResultReader` for the **same current workflow database**. Bind B01's
current `read`/internal `acknowledge` to support progress synchronization. Its acknowledgement
must recheck authorization and commit revision/receipt atomically. Replace the
service generation and ports on account/vault changes. Never expose internal
acknowledgement as a generic client mutation. Observational waits are bounded;
mutations are not raced against a timer. Reader construction performs no I/O and
creates no tables. B09 owns receipt provisioning and B08 owns jobs and fencing.

For continuation, bind `createDraftCompletionGuard({ reader, readJob })` as B01's
`validateFinish`. `readJob(scope, jobId)` must synchronously call the authoritative
B08 **store** `result(scope, jobId)`, not its async provider/HTTP operation. Use
`createSettingsJourneyPersistence` on that same database handle: it supplies the
transaction resource, and the guard refuses a different handle or a read outside
the transaction. The guard rechecks current job scope/request/digest and the
exact saved receipt, graph and disabled draft before the completion write.
B01 advertises `canFinishDraft`; B10 offers no continuation without that binding,
and direct new finish commands fail closed too. Retry of an already committed
finish returns its durable receipt without reapplying or undoing completion.
Recreate these bindings when switching vaults. None are registered here.

B11 production bindings remain explicit and absent here; source discovery does
not enable the journey. U09, D18/19/20 canvas bindings and the exact U11/B13/D/F/Q
release evidence are required for a live reveal. Tests using deterministic model
responses, synthetic assembly closure and isolated SQLite are not live-provider,
native, browser-rendering or release evidence.

Readiness keeps exact node and property identities, including long IDs that share
a prefix; only display messages are truncated. The person-facing projection excludes captured outputs, private version columns,
composition prompt/response, receipts and credentials. Persisted graph inputs are
user/model-authored data, not instructions to a future model consumer. The reader
is documented in the workflow data-reader inventory with projection regressions.

## Verification and rollback

```
bun test src/onboarding-next/result src/workflows/adapters/untrusted-reach.test.ts
bun run check:onboarding-runtime
bunx tsc --noEmit
bun run build:ui
```

Optional tests exercise real B01/B07/B08/B09 when present and skip explicitly
otherwise. The base suite uses real SQLite/workflow/readiness code, with a local
B09 receipt fixture and build/service doubles. The route test uses B11's actual
HTTP handler with a synthetic released closure and explicit test binder. The U08
and Brief route test is structural compatibility, not a rendered D18 inspector.

Safe verification: use an isolated fixture database, read a completed job through
`read`, select `draft`, repeat its `recovery.input`, explicitly finish through B01,
and reopen the same `workflow` selection. Confirm zero run rows, disabled status
and null published version. A staging URL requires the host's verified bindings
and release gate; this card does not supply a public preview.

Rollback disables/removes this provider and regenerates the runtime catalog.
Retain all journey, job, cancellation and draft records and the legacy handlers.
No data migration or destructive rollback is needed.
