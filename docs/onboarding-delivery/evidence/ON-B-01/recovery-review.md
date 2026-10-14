### Overview

Re-review of ON-B-01 / PR #1050 after the two recovery findings, using the PR
reviewer skill. Reviewed source head `b6cde5b5e661af5fe0194f4af1e6d20b1e4dacab`
against shared base `1c2737a60d5580abea7d2feb9f2e845fdd491924`, including the full
module, tests, documentation and the change from previous PR head `e7a5e668`.
The same source tree `7eed2b835adf4b93064f97dff6c0062bf531689f` was independently
applied to latest main `5024ea7455a5613be0514475be32c0dee6de0edd` without siblings.
This is direct implementer review, not independent approval or a submitted GitHub
review; final-head CI was pending when this receipt was written.

### What's good

- Reservation and Explore use the same atomic revision check. A reserved request
  survives refresh/restart and blocks navigation until its accepted job or fenced
  terminal outcome is reconciled.
- Recovery retains terminal request/job identities, rejects stale or reused
  identities, and updates only the return location during tutorial replay.
- The internal port requires matching identities and refuses nonterminal outcomes
  or recovery over a saved draft. Old v1 records remain readable and recoverable.
- No UI, registration, workflow execution, engine, OAuth or profile-store changes.

### Issues

No remaining blocking code findings after re-review. Both requested findings are
resolved within the journey provider:

1. R1, terminal build dead end: `build_finished_without_draft` restores Activation
   after trusted failed/cancelled reconciliation while retaining identity history.
   Regression cases cover both outcomes, retry, Explore, stale events, old v1
   records, restart, tutorial replay and refusal to discard a committed draft.
2. R2, delayed acceptance versus Explore: `reserve_build` commits before acceptance,
   and `build_started` must match that reservation. Tests cover Explore winning,
   reservation winning, two competing reservations, lost replies and restart.

The handshake also explicitly distinguishes an old receipt from a live reservation:
retries return current state, so ON-B-08 must inspect that state and enforce its own
durable request-key fence. A regression proves an old receipt does not reopen a
released journey. A null-job release requires a durable rejection/cancellation,
not an empty lookup that could race delayed acceptance.

### Blocking vs. non-blocking

- Blocking before merge: no remaining code findings; inspect required final-head CI.
- Non-blocking for this optional module: ON-B-08/10/11 must implement and prove the
  documented acceptance, cancellation fence and durable-result handshake before
  activation. ON-U-10 and candidate-bound release evidence remain required.

### Suggestions / Improvements

Carry the named recovery cases into ON-B-08/10/11 integration tests. In particular,
prove that a terminal acknowledgement fences late acceptance/work and checks the
durable result association. This PR's synthetic acknowledgements do not certify
those future services.

### Test coverage assessment

**Adequate with gaps.** Fresh checks passed 41 journey tests (660 assertions) and
159 focused/legacy onboarding tests (1,063 assertions). Three initial regression
cases failed on the previous source, then passed with the fixes; twelve new cases
are included overall. The clean latest-main-plus-PR candidate passed the same
159 tests, TypeScript and UI build; reversing the complete PR patch restored the
exact main tree and passed 118 legacy tests, TypeScript and UI build. SQLite,
restart and transaction evidence is real; job acceptance, terminal outcomes and
no-draft/fencing evidence are synthetic, with production integration still gated.

### Final recommendation

**Approve with comments.** Both findings are fixed for the isolated provider;
retain default-off/unregistered status and require the documented production
handshake and release evidence before activation.
