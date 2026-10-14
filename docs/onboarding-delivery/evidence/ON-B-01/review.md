### Overview

Direct review using the PR reviewer skill of PR #1050, base
`1c2737a60d5580abea7d2feb9f2e845fdd491924`, implementation head
`84ea7303bd4857ad14f010eb4cb69659fc7f3b79`. Read the complete source/test/doc diff,
current settings/profile services, onboarding status/gate/reset paths, repository
checks and F-26/D-33 delivery context. The implementation matches ON-B-01: an
injected, unregistered journey provider with additive SQLite persistence and no
shared registration/UI edits. This is an implementer review, not an independent
review or a submitted GitHub approval; CI was pending at this review snapshot.

### What's good

- SQLite immediate transactions cover initialization, revision checks and retry
  receipts together, verified with separate database connections and processes.
- Navigation cannot submit provider acknowledgements. Authenticated actor/project
  scope is injected per operation; request scope fields and foreign identities fail.
- Tutorial replay retains completed setup, profile/connection settings and pending
  job/draft references. Result acknowledgement during replay updates the return step.
- Future records and failed reads are not rewritten as incomplete. Legacy flags
  remain byte-for-byte intact and separate from the additive journey row.

### Issues

No remaining blocking findings in the reviewed revision. Three implementation-pass
findings were corrected before the committed head:

1. **Major / Correctness:** a bodyless transition could take the read path and
   initialize a journey. `index.ts:182` now distinguishes read/navigation/internal
   lanes explicitly; the mutation-without-body regression verifies no row is written.
2. **Major / Correctness:** starting tutorial replay after job acceptance but before
   its acknowledgement could reject the job because the tutorial state was reset.
   `index.ts:150` permits an acknowledgement from the retained Activation return
   step. The delayed-job and result-during-replay tests preserve the same job/result.
3. **Major / Backward Compatibility:** the initial interview projection used null,
   outside the contract's frozen vocabulary. `index.ts:60` now uses the nonterminal
   `connecting` value, never claims a ready session and reads all six v1 values.
   The fresh-journey regression asserts that literal value. All 147 regressions,
   TypeScript and UI build pass on both the original base and newer main `a02343c6`.

The initial subprocess fixture also used an incomplete SQLite open flag set. It
now specifies read/write without create and the real process-race test passes.
Both correctness regressions were also proven in the isolated verification
worktree: removing the two fixes produced exactly those two failures (25 pass,
2 fail); restoring the committed implementation produced 29 pass, 0 fail. See
`regression-red.log` and `regression-green.log`. No fault injection was committed
to the delivery branch.

### Blocking vs. non-blocking

- **Blocking (must fix before merge):** none found in the code review. Required
  current-head CI remains a separate merge check.
- **Non-blocking:** production host integration and candidate release evidence are
  activation prerequisites owned by later cards, explicitly recorded as blocked.

### Suggestions / Improvements

ON-B-11 should bind acknowledgements to individual trusted provider ports, derive
scope from authenticated server context, and coordinate legacy/new writes across
cutover and rollback. ON-U-10 should invalidate cached state on auth changes and
treat BroadcastChannel payloads as invalidations. These are documented integration
requirements, not a reason to import or implement those unmerged modules here.

### Test coverage assessment

**Adequate with gaps.** The independent base-plus-card worktree ran 147 tests,
including 29 journey tests covering durable identity, legacy migration, stale and
duplicate requests, cross-scope rejection, transaction rollback, future fields,
restart and scoped replay. Existing hosted setup and legacy UI tests also pass;
actual reverting of the module passes 118 legacy regressions plus TypeScript/UI
build. Real provider, browser/native and full production host evidence is absent
by scope, so this review does not certify activation or the entire product.

### Final recommendation

**Approve with comments.** The isolated additive provider is suitable for merge
after current-head required CI passes; keep it unregistered/default-off pending the
explicit integration and release gates.
