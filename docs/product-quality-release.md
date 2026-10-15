# Q-22 product quality gate

Q22 audits the integrated candidate's reviewed evidence. The shipped scorecard is **blocked**. Local source tests, open PRs and CI success do not certify the assembled product. This command never enables capabilities, performs deployment, calls a model or runs a live connector.

## Reproduce the source audit

Use the checkout's pinned Bun (1.4.2 at delivery), install its frozen lockfile, then:

```sh
bun scripts/check-product-quality.ts --out /tmp/q22-audit --source-probes
bun test src/quality-release scripts/check-product-quality.test.ts
```

An unconfigured checkout exits **2**, with a sanitized JSON scorecard, Markdown support matrix and a private template `record.json`. Exit **0** means every required reviewed gate passed for the named candidate/profiles/jobs; it is never deployment approval. Exit **1** refuses invalid input, arguments or I/O. Consumers must check the exit status and candidate rather than reusing an older output directory. Use a new output directory outside the repository. A dirty checkout cannot pass.

The source probe suite uses fresh temporary SQLite databases, a stub model and an in-memory effect counter. It joins capture/recognition to accepted disabled composition, corrected memory through prompt construction and the next stub reply, goal work through its persisted result check, and approval through exactly one persisted synthetic effect. It also tests expiry, restart and interrupted work. It does **not** exercise F09 prepared qualification, F10 activation, F15 measured outcome aggregation, a hosted model or a real connector. Its result stays outside release-matrix counts.

## Required release matrix

Each declared profile has 18 deterministic journey cells: three journeys crossed with normal, offline, reconnect, restart, expiry and mixed-version conditions. Both local and hosted deployments must be represented; list every materially different deployed profile explicitly. Missing rows become `not_run`. `unsupported`, `blocked`, `failed` and `not_run` never become green, and every profile with incomplete evidence has an empty `supportedJobs` list. Declared jobs stay visible separately. Profile IDs and job IDs are sanitized aliases, not account names.

| Journey | Required trace | Owning prerequisites |
| --- | --- | --- |
| observation-prepared-enabled-result | Source episode, goal linkage, prepared immutable version/readiness/bindings, explicit enable decision, governed execution and persisted result | F09/F10/F12/F13, Q04–Q14/Q19/Q21 |
| goal-next-step-checked-outcome | Goal, accepted recommendation, exact work/run identity, qualified result check, attributable outcome | F15/F16, Q17/Q18 |
| memory-correction-next-reply | Explicit correction, durable supersession/forgetting, current retrieval, next reply retaining qualification | Q15/Q16/Q21 |

Use sandbox accounts/effects. An offline case must show a truthful blocker; reconnect must preserve identity without duplicate dispatch; restart must preserve receipts and uncertainty; expiry must refuse stale authority/bindings; mixed versions must give truthful capability responses. Every successful deterministic receipt reports all five safety counters, all zero: unauthorized effects, duplicate effects, false verified outcomes, cross-chat leaks and invented critical inputs. Report actual failures to their owning card; Q22 does not repair unrelated product semantics.

All six named F cards and Q01–Q21 require integration evidence. A merged component is not by itself a passed integrated journey. The CLI verifies each `integratedHead` is an ancestor of its checked-out candidate. Use the actual integration/merge revision for squash merges. Review must verify that the receipt identifies the correct card implementation.

## Evidence interchange and review

`src/quality-release/contract.ts` defines the versioned input. This is a read-only interchange seam for the integrated release runner and measurement owners; the CLI does not invent results or execute arbitrary adapter code. Production integration runners must produce the complete journeys above. A standalone main checkout lacks their assembled providers and emits `not_run` cells.

```sh
bun scripts/check-product-quality.ts \
  --record /private/release/record.json \
  --artifacts /private/release/artifacts \
  --out /tmp/q22-reviewed-audit
```

Each artifact is `<sha256>.json`, where the hash uses the canonical `hash()` exported by `validation.ts`: object keys sorted recursively, arrays preserved. A positive result row's artifact has `{ "identity": ..., "summary": ... }`. `identity` is its proof without `artifact` and `reviewed`; `summary` is the entire result row without `proof`. Additional raw evidence can be retained in that artifact or referenced by its review package. Changing a summary, candidate, runtime, job set, timestamp or artifact bytes invalidates it. A reviewed flag without matching bytes cannot pass. Imported records and raw artifacts are not copied to the output directory.

The proof pins the full candidate SHA, start/end times, evidence kind and `runtimeHash = profileHash(profile)`. That hash covers profile ID, deployment kind, brain/hosting/sidecar revisions, schema, model alias, resolved profile revision, policy, prompt/catalog/environment hashes and the declared job list. For card integration receipts only, use `hash({ candidate })`. A hosted profile requires the exact hosting revision; an unresolved model/profile cannot pass. A fixture identity cannot be reused for a deployed model. Evidence kind is `deterministic`, `heldout` or `live_sandbox`; none substitutes for another. Future-dated or unreviewed evidence is refused.

Hashes check integrity, **not authorship or truth**. Evidence review must establish provenance, real execution of the named trace, unique scheduled tasks, sample independence, model routing, blinded opportunity review, correct task dispositions, permission to run any paid evaluation, and the genuine owner approvals. Positive test fixtures demonstrate the protocol only and are not release evidence. No cryptographic attestation service is claimed.

## Frozen thresholds and per-profile quality

The checked-in `scripts/product-quality/q01-proposed-rubric.json` is an unmodified snapshot from Q01 PR #725 at `cfe6453b81b86056964d67e849a9025c3cbe73e3`, path `src/workflows/evaluation/rubric/workflow-release-v1.json`. It remains **proposed**. Q22 adds a proposed supplement for opportunity usefulness/negative proposals, qualified recall and invented inputs because Q01's existing artifact only encodes workflow thresholds. Both artifacts need owner approval and freezing **before** evaluating the holdout. Q22 does not approve or change either owner's thresholds.

The record's freeze time must be at or after both artifact freezes and before every quality measurement starts. Both artifact hashes are pinned together by `hash({ q01: q01Hash, supplement: supplementHash })`. The rubric validator requires at least the roadmap's targets and positive agreed per-profile (or `*`) budgets; stricter samples/thresholds are honored. Changing thresholds requires new rubric identity and an untouched evaluation, not relabeling existing results.

The 11 quality cells per profile cover first composition, bounded repair, useful proposals, false proposals on negatives, qualified recall, grounding, median corrections/time, requests, tokens and latency. Import reviewed aggregates from the owning evaluation; retain their raw task rows privately. Every quality cell includes zeroed safety counters and rejects missed abstentions, and reports scheduled/measured counts, supported/negative task counts and all task dispositions. Task dispositions sum to scheduled work; unrun/unsupported tasks cannot vanish. At least 40 distinct supported and 20 negative tasks are required, or the stricter frozen sample. Repeat aggregation remains `all` per task as in Q01. Rates use the relevant supported/negative denominator, and include 95% Wilson intervals. Usefulness's supported cohort must be the shown proposals under blinded review; report eligible routines missed explicitly. Distributions include p50/p90/p95/max and timeouts; unknown usage or incomplete review cannot be reported as measured.

The gate recomputes numeric acceptance, including Q01's point-estimate versus lower-bound decision, from aggregates; `verdict: met` alone is insufficient. Human effort is measured on supported jobs only, excluding provider waits: correction-count and correction-time distributions must have `count === supportedTasks`. Negative cases remain in scheduled/measured totals but never dilute correction medians. Request, token and latency distributions must cover all measured tasks (`count === measured`), including negatives. Budget columns use per-task maxima and p95 composition latency. Missing, unknown or too-small evidence stays blocked, and measured failures stay failed.

Live connector checks have their own disposition and proof. An observed live failure blocks release. Unrun optional live checks remain explicitly unrun. They require separate authorization and never inherit a pass from the deterministic suite. The support matrix certifies only the listed sandbox journey/quality envelope, not arbitrary connectors or provider reliability. D33 still needs reviewed **live** candidate-bound Q22 evidence and separate deployment approval; this CLI's source scorecard must not be relabeled as that evidence. F28 activation and D32 visual/manual verification remain separate gates.

## Rollback

Revert the Q22 commits or stop invoking the audit. No schema migration, provider registration, runtime default or production data changes. Keep historical scorecards with their candidate identities. Never replay effects as rollback.
