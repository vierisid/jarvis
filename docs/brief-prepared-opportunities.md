# F-09: prepared opportunities

F-09 turns a confirmed recurring opportunity into one durable, disabled workflow snapshot before approval. The snapshot retains observation references, the confirmed job and expected output, an active goal and rationale, a composition journal, and the exact locked flow/version. It never publishes, enables or runs that workflow. F-10 owns acceptance and activation.

## Activation and dependencies

Q-13 (`prepared-qualification.ts`, `prepared-dry-run.ts`) is an activation dependency, not an import prerequisite. The fixed local adapter loads those two files only when present; it neither searches plugins nor accepts a caller-selected path. The dry runner reuses the daemon's engine bundle and the digest the engine bootstrap verified for it; without that digest the adapter is unavailable.

`JARVIS_BRIEF_PREPARED_OPPORTUNITIES=1` opts in. The default is off. The daemon must also have a configured composer, a working workflow database and existing engine bundle, and Q-13 qualification/dry-run services. Missing services leave `preparedOpportunities` supported but unavailable, with writes refused. Restart after integrating the dependency. No flag was enabled by this change.

Preparation calls the configured composer, so enabling it permits bounded background model work. That work always runs with the `background` origin and no inherited admission class, even when a Brief request queued it, and a worker starts a job only while the shared background budget (Q-20) admits new background work. It uses existing installed catalog data and connection readiness. It never installs pieces, grants credentials, sends messages or invokes a workflow effect.

## Lifecycle

- `preparing`: queued or holding a durable lease. One source identity has one proposal ID.
- `blocked`: missing confirmation/goal, interrupted or invalid composition, unavailable setup, failed sample, or Q-13 review requirement. `blockers` explains the missing setup.
- `ready`: current Q-13 qualification, exact source/version digest and current workflow readiness all agree. Only this state has `canApprove: true`, which expresses eligibility, not an activation command.
- `stale`: source, goal, bindings, authority or version no longer matches the qualified snapshot. The old version remains retained.
- `dismissed` and `accepted`: separate terminal states from legacy suggestion feedback. F-09 implements dismissal; the accepted field is reserved for F-10's durable activation receipt.

The worker checks current ownership before attaching a draft and again before storing qualification. Dismissal, shutdown, lease expiry and late model replies cannot attach a second workflow or return a new ready proposal. Explicit retry uses the displayed revision, archives the previous snapshot and retains its disabled workflow. It never edits that reviewed version in place. A shared durable reservation covers both prepared and legacy composition, including entry, retry, lease claim and draft attachment. Prepared ownership rejects legacy acceptance with HTTP 409; legacy ownership blocks preparation. A setup-only prepared blocker reserves nothing, so legacy acceptance/retry remains available. Reservations survive restart and feature disablement. For pre-reservation databases with conflicting records, the earliest eligible retained request wins deterministically; losing workers cannot infer or attach another draft. Already-existing historical flows are preserved, not deleted.

Leases and ownership use a shared helper with the legacy suggestion composer; the legacy composer keeps its own queue, per-job and daily bounds. Limits are one running prepared job per database, 3 attempts per rolling 24 hours, 2 preparation attempts per proposal, 2 bounded composition/repair attempts within each preparation, 20 queued/running proposals, and 120 seconds per preparation including qualification. Polling is every 15 seconds, discovering at most 10 sources per tick. Failed/interrupted work requires explicit retry. A storage failure withdraws capability readiness until lease recovery succeeds.

The proposal links its composition journal in the same transaction that creates the journal, before inference starts. Failure, timeout, dismissal, shutdown and attachment rollback retain that link; retry archives it with the previous revision. Public blockers contain application-authored messages only. Raw provider diagnostics and malformed model responses remain in the journal, including when reading rows saved by an older release.

Deleted flows and versions return `workflow_missing` or `workflow_version_missing`, with a retry/dismiss recovery message. A genuine missing Q-13 service remains `qualification_unavailable`.

## Preview provenance

The adapter records `illustrative_template` or `sandbox_sample`. Q-13 alone determines whether the preview and effects support Ready. Simulated effects are labelled simulated and have no real run ID; F-09 never claims verified output or successful delivery. The public read model carries provenance and bindings, not raw sample outputs or credential values.

The daemon's initial synthetic fixture is deliberately empty (`prepared-empty-v1`). Pure supported graphs can qualify. Model, context or tool steps needing fixture data block with the actual sample failure; unsupported graphs retain illustrative provenance and Q-13's review requirements. Trusted integration code can supply a fixture factory through `createPreparedQualityAdapter`; HTTP requests cannot supply qualifications, sample results, accounts or workflow graphs. Arbitrary changes to the confirmed job/outcome add an unverified constraint and require review.

## Authenticated API

Existing panel authentication protects every route. All responses use `Cache-Control: no-store`.

| Method and path | Request/result |
| --- | --- |
| GET `/api/brief/prepared-opportunities?limit=20&cursor=0` | Page of typed snapshots; limit 1–50, numeric cursor |
| POST `/api/brief/prepared-opportunities` | `{ "opportunityId": "..." }`; ensure one proposal, return 202 |
| GET `/api/brief/prepared-opportunities/:id` | Current rechecked snapshot |
| POST `/api/brief/prepared-opportunities/:id/dismiss` | `{ "revision": "..." }`; terminal dismissal |
| POST `/api/brief/prepared-opportunities/:id/retry` | `{ "revision": "..." }`; explicit bounded retry, return 202 |

Unknown fields, oversized request streams and stale revision tokens are rejected. There is no approve endpoint in F-09. Legacy feedback is not changed by preparation, retry or dismissal.

## Verify

From this worktree, without real models or account access:

```sh
bun test src/awareness/prepared-opportunities.test.ts src/awareness/prepared-quality-adapter.test.ts src/awareness/suggestion-feedback.test.ts src/daemon/api-brief-composition.test.ts src/sidecar/capability-predicate.test.ts
bunx tsc --noEmit
```

These tests exercise duplicate processing, restart, dismissal during both composition and qualification, stale goals/versions/bindings, bounded cost, timeout, storage failure, rollback of partial attachment, strict requests and real panel authentication. Review regressions also cover both composer entry orders, old mixed queues and late attachment, private diagnostics, early journal linking and deleted flows/versions. They assert disabled/unpublished flows and absence of real workflow jobs/runs.

Run the real engine/qualification check:

```sh
JARVIS_TEST_PREPARED_Q13=1 bun test src/awareness/prepared-opportunities.test.ts src/awareness/prepared-quality-adapter.test.ts
```

It builds/reuses local engine and piece caches, runs with isolated fixture data and simulated services, qualifies an exact disabled notification workflow, blocks a missing model reply, and verifies that no workflow run remains. The ordinary suite skips this integration check unless the variable is set.

For a manual integrated check, confirm a retained opportunity's job and active goal through the existing opportunity feedback path, start an isolated daemon with the flag, and read the authenticated endpoints above. Repeated POSTs must return the same proposal ID. Disconnect a required account or revise its goal and read again: `canApprove` must become false. Dismiss with the current revision while work is pending: its eventual state must remain dismissed. Try accepting the same prepared source through the legacy route: expect HTTP 409 and no second draft. Delete a prepared workflow in the isolated database and read the proposal again: expect `workflow_missing`, not a Q-13 outage. Inspect the returned flow in Workflows: disabled, unpublished, locked version, no live run.

This is backend/API work. There is no new visible UI to screenshot; the dashboard line consumes the typed read model later.

## Rollback

Unset the flag and restart. Retain the additive `prepared_opportunities`, `prepared_opportunity_attempts`, `prepared_opportunity_history` and `opportunity_composition_owners` tables, composition records and disabled workflows. Do not delete or replay them. No existing table is destructively migrated. Older code ignores these tables; do not treat a historical qualification as authority to enable a workflow after a downgrade.
