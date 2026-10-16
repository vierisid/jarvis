# ON-B-13 functional verification

This opt-in CLI owns no production route, registry entry, capability flag or
release toggle. It can land without other onboarding cards. Discovery retains
all **43 required cases** when a provider, UI host or test file is absent.

Use the repository's pinned Bun version and a new output directory **outside**
the checkout. Evidence is private and can contain interview text or workflow
graphs; do not commit staging artifacts. The output's existing parent and source
root are resolved through symlinks before creation; aliases into the checkout
are rejected, including ignored directories. Existing output directories are
never reused.

```sh
bun test src/onboarding-next/verification
bun src/onboarding-next/verification/cli.ts run --out /tmp/onboarding-candidate
bun src/onboarding-next/verification/cli.ts verify --out /tmp/onboarding-candidate
```

Open `index.html` for the cases, observations, logs and database snapshots.
`report.json` is the portable evidence index; `verdict.json` is the initial
verification result. Run `verify` again after adding or changing evidence;
the saved verdict does not authorize anything. Exit 0 means complete evidence,
1 means valid but blocked, and 2 means invalid/stale evidence. Even exit 0 is
only an input for the release owner; deployment needs its separate approval.

The report records exact backend, frontend and sidecar source commits and the
backend tree. By default all three commits are the clean checkout HEAD. For a
split candidate supply `--frontend SHA --sidecar SHA` to **both** commands;
verification also accepts `--frontend-root PATH` pointing to the clean matching
frontend checkout. These are source identities, not proof of deployed versions.
Manual environment evidence must independently establish the deployed tuple.
Dirty source, stale SHA, missing cases, skipped suites, changed artifacts and
incomplete owner decisions never yield release-ready.

## What runs locally

Each provider scenario runs in an isolated subprocess and fresh SQLite database.
It uses the actual B01/B07/B08/B09/B10 providers, persisted workflow composer,
workflow schema and readiness code. The five full paths additionally exercise
B02/B03/B04/B05/B06 through actual B11 in-process HTTP routes. The harness's
synthetic release authorization exists only in that isolated route fixture.
It is never injected into the daemon.

The matrix includes:

- Meeting follow-up, investor update and competitor brief with satisfied and
  missing prerequisites. Missing prerequisites save no draft or job.
- Duplicate and changed submissions, lost acceptance, crash before/after save,
  cancellation before/after save, model failure, timeout, unsupported nodes,
  foreign ownership, deleted result and completion revalidation.
- Hosted, configured self-hosted, Google/interview skip, tour replay and Explore
  first, with persisted progress checked after database reopen at each phase.
- Existing owner suites for setup/permissions, Google callbacks, interview
  reconnect/save, tour/two-tab recovery, worker fencing/timeouts, runtime
  compatibility/revocation, diagnostics and UI transport/resume compatibility.

Inference, Google grant observation, setup services, identity and room readiness
are deterministic leaf fixtures. No real Google authorization occurs. Fetch and
WebSocket attempts fail and are counted in scenario processes. Assertions inspect
the exact saved graph, one-or-zero disabled unpublished flows, no workflow runs,
stable identities and truthful recovery. `saved.sqlite` is a standalone SQLite
snapshot exported before process exit; the working `fixture.sqlite` WAL files
are not accepted as evidence. Suite passes are labelled mocked too: passing a
permission test does not establish a native permission grant.

Replay a successful full path and a lost-worker path with separate directories:

```sh
bun src/onboarding-next/verification/cli.ts run --out /tmp/onboarding-hosted-replay --case journey/hosted
bun src/onboarding-next/verification/cli.ts run --out /tmp/onboarding-crash-replay --case recovery/crash-after-save
```

The first is blocked until its providers are present. All other required rows
remain blocked during a single-case replay. Inspect `case.observation.json`
and `saved.sqlite` under the case folder: `flow.status` must be `DISABLED`,
`published_version_id` null, and `flow_run` empty. Replay never reuses a live DB.

## Complete the candidate evidence

The CLI deliberately does not execute paid models, real OAuth, native actions or
production. Before any separately authorized staging run, establish the supported
profile IDs/versions, configured sandbox, exact deployed tuple and spend budget.
Capture observations for all six `models/*` rows and all five `staging/*` rows.
Failed/blocked/not-run rows remain in the report with their reason. Manual
observations are attestations by the named owners; hashes prove integrity and
binding, not the truth or authorship of arbitrary supplied files.

Artifact references everywhere are `{path, sha256}` with a relative contained
regular file and SHA-256 bytes digest. Symlinks/traversal are rejected. Each
passed row has exactly one `*.observation.json` plus its supporting artifacts:

```ts
{
  schemaVersion: 1, candidate, caseId, kind, observedAt, environment,
  checks: requiredCase.checks.map(id => ({ id, passed: true })),
  details: { /* concrete steps, observed recovery, graph IDs and safety evidence */ },
  artifacts: [/* logs, DB, screenshots, provider receipts, deployed version proof */],
  profiles: [/* real-provider only: {id, version, startedAt, outcome: 'passed', spendUsd} */]
}
```

All supporting references must also occur in the row's `evidence`. `kind` must
match the fixed matrix: `mocked`, `manual` or `real-provider`. Real-provider rows
must cover every supported profile and retain the actual semantic/graph checks;
deterministic graphs cannot substitute for this evidence.

Set `report.staging = {profiles, registry, spendApproval}`. The registry artifact
contains `{candidate, profiles, environment, verifiedBy}` from the authoritative
staging configuration. Spend approval contains
`{candidate, profiles, approved: true, approvedBy, approvedAt, budgetUsd}`.
Each profile's `startedAt` must record its first paid attempt for that case,
including retries covered by `spendUsd`. It is bound to the candidate by the
hashed observation. Approval must be at or before every profile's `startedAt`,
which must be at or before `observedAt`; a later observation cannot establish
prior spend authorization. Missing/invalid execution timestamps fail validation.
The sum of recorded spend across all model cases/profiles must fit the approved
budget. Missing or changed profile versions, failed profiles and incomplete
coverage invalidate acceptance.

Copy U11's actual `report.json` and referenced artifacts into a contained folder
and set `report.visual` to that report's hash reference. B13 invokes the U11
verifier from the exact clean frontend checkout; fixture scope, incomplete visual
cases and stale/missing artifacts cannot pass. U11's **absent** B13 gate is the
only deferred dependency in the joint decision, avoiding a circular requirement.
A present but malformed/stale B13 gate still fails. All other U11 gates must pass.

The ON-U-10, ON-B-11, D, F, Q and release-owner receipts use:

```ts
{
  schemaVersion: 1, owner, candidate, approved: true, approvedBy, approvedAt,
  observations, artifacts: [/* original owner decision evidence */],
  evidenceDigest: evidenceDigest(report),
  ownersDigest: ownersDigest(report) // required only for release-owner
}
```

Use the exported digest helpers from `report.ts`. Add each receipt to
`report.gates` as `{owner, receipt}`. All owners approve the same functional,
visual, profile and spend evidence digest; the release owner additionally
approves the exact five preceding owner receipts. An updated observation or
owner decision invalidates prior approval. Re-run `verify` against the same
source tuple after collecting the final owner decision. Never synthesize owner
approvals to make a report green.

## Isolation and rollback

Only local allowlisted provider manifests and source entries are discovered.
There are no static imports from optional onboarding siblings or neighboring
worktrees. The verifier can compile with absent modules; unavailable cases stay
blocked. Combined-candidate verification belongs in an ephemeral integration
checkout, not a stack of sibling changes in this PR.

Stop the runner/remove this verification directory to roll back the tooling.
For a release rollback, the assembly owners keep the new journey disabled and
retain the legacy handler. Preserve all additive records and created drafts;
never delete a user's draft, profile or authorization as a verification rollback.
