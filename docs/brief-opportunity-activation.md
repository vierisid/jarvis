# F-10: approve a prepared opportunity

F-10 adds the decision after F-09 preparation. Approval publishes and enables the exact locked workflow version that was reviewed, records one durable receipt, and reconciles its trigger registration. It does not recompose the graph, choose the latest draft, invoke a manual run, or claim the expected business outcome happened. Dismissal is a separate terminal decision.

## Dependencies and activation

This PR is stacked on corrected F-09 (`8614e886`). F-01 is the roadmap compile prerequisite; F-09 is the enable prerequisite and in turn requires Q-13. The Q-13 implementation remains optional and is not copied into this branch.

Both flags must be exactly `1`:

```sh
JARVIS_BRIEF_PREPARED_OPPORTUNITIES=1
JARVIS_BRIEF_OPPORTUNITY_ACTIVATION=1
```

The default is off. Capability readiness also requires the current shared workflow database, a ready prepared-opportunity provider, and the trigger manager configured after daemon startup. Enabling F-09 permits its bounded background composition work. This change did not set either flag on a running daemon.

## Authenticated API

All routes use the existing panel authentication gate and `Cache-Control: no-store`.

| Method and path | Purpose |
| --- | --- |
| POST `/api/brief/opportunity-actions/:id/approve` | Approve the displayed proposal revision |
| POST `/api/brief/opportunity-actions/:id/dismiss` | Dismiss that proposal without publishing |
| GET `/api/brief/opportunity-actions/:id` | Recover its receipt after a lost response or reload |

The path ID is the F-09 `proposalId`. Each POST accepts only:

```json
{ "revision": "the-displayed-revision", "idempotencyKey": "one-stable-client-request-id" }
```

Keep the same key when retrying an uncertain request. Requests have a 2 KiB streaming limit and strict UTF-8, JSON and field validation. Caller-supplied workflow IDs, graphs, bindings, sample results and qualifications are rejected.

A POST returns `{ "created": true, "receipt": { ... } }`; an exact repeat returns `created: false` with the original receipt ID. The receipt contains the decision, pinned workflow identity and digest, registration status, current activation status, decision/update timestamps, and a nullable `nextProposalId` navigation hint. GET returns the receipt directly. It never exposes captured sample contents or raw provider errors.

HTTP 202 means the approval is saved but registration is pending. HTTP 200 may mean registered, blocked, or dismissed; always read `receipt.registration.state`. HTTP 409 means a stale or conflicting decision; 422 means the workflow is no longer ready. Disabled/unready capability returns 503; an absent provider returns 501. Invalid bodies return 400 or 413, and missing proposals/receipts return 404.

## Transaction and recovery

Before a new approval, F-09 synchronously rechecks the source, goal, exact version, accounts, targets and Q-13 qualification. The workflow must still be disabled and unpublished. Existing publication services recheck workflow readiness and CODE grants. Publication, acceptance, the receipt and the request key commit in one SQLite transaction. If receipt persistence fails, the publication rolls back too.

There is one terminal decision per proposal. Every additional key used for the same decision remains bound to it. A key cannot later approve another proposal, another revision, or a dismissal. A newer unrelated draft does not change the pinned version. Receipt replay never republishes or re-enables a paused, deleted or subsequently republished workflow.

Registration is a recoverable second phase. The receipt starts pending, a durable 30-second lease owns the attempt, and a five-second worker reconciles it. Startup re-observes previously registered receipts against the new runtime. An interrupted lease can be reclaimed after expiry. Late workers cannot overwrite another owner's result. Existing manager serialization and persisted engine registration state avoid duplicate local subscriptions and unnecessary remote enable hooks.

A resolved `refresh()` is not sufficient evidence of registration: the receipt checks the actual exact-version subscription and current readiness. Manual-only workflows need no subscription and count as registered without creating a run. A silent refusal or partial cron failure stays blocked. Working webhook delivery is preserved when local cron registration fails; an explicit same-key retry can repair cron from cached engine state. Known failures do not start an unbounded refresh loop. Pending work takes priority, in-flight local work is excluded from subsequent batches, and blocked observations rotate so old failures cannot starve new approvals. Existing manager backoff can finish registration, and the receipt observes that recovery.

A blocked receipt retains the approved version. Inspect the workflow's setup and retry the original request after repair. If the workflow was paused or changed, use its existing workflow controls deliberately; replaying approval will not undo that later decision. `nextProposalId` is only a hint to a currently approvable proposal and must be fetched and rechecked before another decision.

Dismissal writes its own receipt, fences in-flight preparation from attaching a result, and leaves retained workflows disabled. The earlier F-09 revision-only dismissal endpoint remains compatible; F-10 can attach a dismissal receipt to an already dismissed matching revision. Approval and dismissal cannot both settle the same proposal.

Activation is not blanket Authority permission. A later triggered or explicitly requested run still passes current readiness, emergency controls, Authority and effect approval. A registration receipt is not proof of a completed run or delivered business output. Exactly-once local publication does not promise exactly-once behavior from a remote provider if its enable hook has an uncertain external result.

## Verify without live accounts

From the worktree, run:

```sh
bun test src/brief/opportunity-activation.test.ts src/workflows/runner/triggers/manager.test.ts src/daemon/api-brief-composition.test.ts
bun node_modules/typescript/bin/tsc --noEmit
```

Tests use isolated databases and synthetic model/trigger responses. They check double approval with one or several request keys, exact-version publication with a newer draft present, changed prerequisites, transaction rollback, process recovery, silent and partial registration failures, dismissal, and replay after pause/delete/republish. They assert no incidental workflow runs or jobs. A separate synthetic later notification must ask Authority for approval and deliver nothing.

With Q-13 integrated, also run:

```sh
JARVIS_TEST_PREPARED_Q13=1 bun test src/brief/opportunity-activation.test.ts src/awareness/prepared-opportunities.test.ts src/awareness/prepared-quality-adapter.test.ts
```

This uses the real engine and qualifier with simulated services and isolated fixtures. It prepares, qualifies and activates the same locked notification version without a real workflow run. The delivery receipt records the dependency commit and local evidence. No paid model calls, account connections or live delivery are needed.

For an integrated manual check, use a disposable daemon/database with Q-13 and both flags. Prepare a confirmed opportunity through F-09, fetch its ready proposal and save its ID/revision. POST approval with a new stable key, then GET its receipt until registered or blocked. Repeat the same POST: the receipt ID and published version must match, and there must be one workflow. A manual-only fixture must have zero runs. Pause that workflow with the existing controls and repeat approval: it must stay paused. In a fresh fixture, disconnect a required account or change the goal before approving: approval must be refused without publication. Dismiss another ready proposal and check that it stays disabled and the returned next ID, if present, can be loaded.

There is no visible UI change to screenshot. F-11/dashboard presentation is separate.

## Rollback

Unset the activation flag and restart to disable these actions. Keep both additive action tables, their request-key mappings, F-09 records and workflows. Previously approved workflows remain enabled and use the normal trigger manager even when Brief actions are off. To stop a particular activated workflow, explicitly pause it using existing workflow controls. Do not delete receipts, replay decisions, or silently re-enable workflows during rollback.
