# W8 evidence, 29 September 2026

**These are controlled harness results. No hosted model quality or real-user usefulness claim is supported by them.**

| Run | Automatic task checks | Executed scenarios | Planning policies |
| --- | ---: | ---: | --- |
| [Natural harness](natural/report.json) | 18/18 | 26/26 | baseline and deterministic-first |
| [Injected malformed first response](repair/report.json) | 16/16 | 26/26 | baseline and deterministic-first |
| [W3 integration](w3-integration/report.json) | 9/9 | 13/13 | deterministic-first |
| [Hosted baseline](hosted-not-run/report.json) | Not run | Not run | planned comparison |

The natural run includes explicit unsupported-fax abstention under each policy. The repair condition excludes abstention and records original and injected responses separately. W3 integration uses PR #566 at `1e161523` in a separate checkout; its catalog artifact confirms the real readiness validator was enabled. The main-branch runs record that W3 is absent.

Each directory contains its raw manifest, frozen task set and report. Completed runs also contain the extracted catalog and `rows.jsonl`, including full composer requests/responses, validation candidates, execution receipts and timing. Engine databases/logs are retained locally under the `/tmp/jarvis-w8-natural-final`, `/tmp/jarvis-w8-repair-final` and `/tmp/jarvis-w8-w3-metadata-fixed` run directories, rather than checked into Git. Reports were copied without editing.

All automatic successes retain `humanIntentCorrect: null`, `supervision: null` and unknown hosted cost. Millisecond timings here measure a controlled fixture provider and must not be quoted as hosted latency. No HTTP model requests were made. The hosted attempt exits with `not_run` because its profile/access is absent.

Additional verification: **190 focused tests passed**, including the real composer/engine/outer-worker regression, deliberate wrong-destination detection, durable provenance across restart, metadata mutation during repair, legacy registries with executable handlers, request-budget enforcement, provider-internal retry accounting, absent usage, review record validation and existing chat/opportunity composition paths. TypeScript, the daemon bundle and all four standalone repository guards passed. A full repository test suite had not been rerun at this initial checkpoint; see the final pre-push results below.

See [the runner contract and instructions](../../workflow-quality-evaluation.md). This evidence verifies the machinery. The live Terra baseline and timed human review remain outstanding.

The [pre-fix W3 checkpoint](w3-before-metadata-fix/report.json) is retained separately for traceability and excluded from the table above. Its simulated effects passed, but a later artifact check found that the provenance snapshot had dropped W3's `requireAuth` metadata. A new regression failed before the fix and passed after it. The final W3 run preserves that field and every row's catalog fingerprint matches the extracted catalog. Natural/repair artifacts were captured before this compatibility correction; their catalog fingerprints already match. Their measured task outcomes did not depend on the additional W3 field.

Review follow-up (R1/R2): **197 focused tests and TypeScript passed** after separating rejected candidates from actual repair calls and recording unstaged source deletions in versioned fingerprints. Regression cases cover immediate truncation, truncation after discovery, successful and failed repair calls, multiple submissions in one response, legacy rows, empty/deleted/absent files, untracked edits and unrelated read errors. The CLI also produced a valid plan manifest in a temporary Git repository with an unstaged deletion. No hosted requests were made.

The saved runs above predate the explicit `repairOfCandidate` call marker and fingerprint version 2. Their raw files and reports remain unchanged. Their historical repair totals inferred attempts from failure presence; new review reports leave those attempt/success counts null when the old rows cannot establish call ordering. The new accounting does not change their task or effect-check results.

Review follow-up (R3): review fingerprints now use the exact redacted row written to disk. The actual CLI regression reproduced the mismatch before the fix and now accepts the generated review while rejecting an edited saved row. It uses a synthetic key and intercepts all provider requests. **198 focused tests and TypeScript passed**; earlier raw artifacts remain unchanged.

Pre-push checks caught an environment-inheritance violation in the Git source inventory helper. Both provenance Git calls now use Jarvis's shared sanitized environment, with a regression for inherited repository overrides. The affected suite plus the subprocess-environment guard passed **343 tests**, and TypeScript passed.

Final pre-push full suite: **6,606 passed, 81 skipped, 8 failed** across 369 files (805.89 seconds). All W8 tests passed. The failures match the earlier W3 full-run failure list: one packaging timeout, one Git fixture, five Chromium startup cases and one process-reaper assertion. The Git fixture and Chromium failures have clean-main reproductions; the reaper failure was also reproduced freshly on clean main at `6c5a2b17`. The packaging standalone guard passed through its built-in Bun fallback. The focused W8/adjacent suite and subprocess guard passed all 343 tests, TypeScript passed, and the four standalone repository guards passed. This is not a clean full-suite result. No hosted model call or human timing measurement was added.
