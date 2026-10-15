# Workflow quality evaluation

The composer records versioned planning inputs, and this runner measures generated workflows through Jarvis. Smoke runs are controlled harness checks, not a model baseline; hosted model quality is only measured by a hosted run.

## Product change

Production composition retains the immutable job specification and adds `provenance`: prompt version, planning policy, and SHA-256 fingerprints of the catalog and environment contracts. Catalog/tool/role/target/library metadata is copied once before composition, so a refresh cannot silently change a repair's inputs. The specification and provenance survive restart in the existing composition journal. No database migration is needed.

`baseline-v1` is the production default: the existing prompt, unchanged. `deterministic-first-v1` adds an instruction, in both prompt paths, to prefer typed actions, templates, conditions, loops and transformations before adding AI, and to report a blocker when required information is missing. It is only used when a caller selects it (the evaluation does) until a hosted comparison supports making it the default.

The existing high-tier route remains unchanged. The hosted proxy resolves `uj-high` to the model a plan routes to; a client alias alone does not prove which model answered.

## Supported evaluation envelope

The versioned sets contain **9 development tasks** and **12 held-out tasks**. They cover fixed reminders, webhook copying, thresholds and routing, empty/nonempty loops, regex transformations, event payloads, Ask output wiring, destinations, negative constraints and explicit abstention when required capabilities are unavailable.

Only the original specification and a catalog of the real notify, regex, Ask and event-trigger pieces reach the model. Expected effects, test payloads and grading assertions are not supplied to the model. The controlled provider contains development fixtures only.

Accepted graphs run through `composePersistedFlow -> createComposerLlmClient -> LLMManager`, then the real engine, queue handler and outer worker. Each CLI run uses a fresh database and log directory. Notification delivery and Ask replies are simulated. No workflow is published or enabled, no saved connections are used, and the runner does not send real notifications.

Unsupported pieces, raw code and credential-bearing actions are rejected before execution. Expected notification messages, destinations and multiplicity are compared with actual fake-provider receipts. Unexpected AI calls fail checks. Missing effects and failed runs remain failures.

Limits:

- These are synthetic supported jobs, not evidence of real-user usefulness or all workflow capabilities.
- Schedule checks compare the explicitly requested cron encoding; event checks compare subscription identity. The runner injects trigger payloads, so it does not certify clock or event-bus delivery.
- Simulated Ask replies test input/output wiring, not summary quality.
- An explicit `report_blocked` counts as abstention. Whether its explanation is useful remains a human judgment. Provider and validation failures cannot count as abstention.
- Passing automatic assertions is separate from human intent correctness. Untested inputs can still expose errors.
- This is not a live integration, arbitrary-code isolation or Authority certification.
- The workflow readiness preflight (`flow-readiness.ts`) is used when present. The catalog artifact records whether it was.

## Run

Use Bun from the repository root. Each `--out` must be a **new directory whose parent already exists**. Existing results are never overwritten.

```bash
# No provider or engine execution; freeze the intended held-out run.
bun run eval:workflows --mode plan --out /tmp/w8-plan

# Verify the harness through the real worker, with both planning policies.
bun run eval:workflows --mode smoke --split development --out /tmp/w8-smoke

# Separate controlled malformed-first-response recovery condition.
bun run eval:workflows --mode smoke --split development \
  --condition malformed-first --out /tmp/w8-repair
```

For a hosted baseline, supply a versioned profile that describes an **existing authorized Jarvis hosted account**. The runner uses the same hosted provider implementation as Jarvis; it does not call a different model vendor directly. Keys are per account and a plan resolves through the key's team, so each plan needs its own evaluation account and profile file.

```json
{
  "id": "starter",
  "version": "2026-10-05",
  "baseUrl": "https://YOUR_JARVIS_HOSTED_PROXY",
  "apiKeyEnv": "JARVIS_EVAL_API_KEY",
  "intendedModel": "UPSTREAM_MODEL_OF_THE_HIGH_SLOT",
  "routingEvidence": "Where the admin export below came from",
  "admin": {
    "exportedAt": "2026-10-05T12:00:00Z",
    "exportedBy": "Admin name",
    "plan": { "key": "starter", "name": "Starter" },
    "profileKey": "base",
    "proxyFallbacks": [],
    "profiles": ["...GET /api/llm/profiles, unmodified..."],
    "models": ["...GET /api/llm/models, unmodified..."]
  }
}
```

A hosted run also needs a spend authorization, approved by someone who can authorize the cost:

```json
{
  "schemaVersion": 1,
  "approvedBy": "Name",
  "approvedAt": "2026-10-05",
  "validUntil": "2026-10-12",
  "profileId": "starter",
  "splits": ["development", "heldout"],
  "maxRequests": 300,
  "maxTokens": 3000000
}
```

The credential belongs in the named environment variable, not either file. The repository does not contain credentials.

```bash
bun run eval:workflows --mode hosted --profile /path/profile.json \
  --authorization /path/spend.json --split heldout --repeats 3 --out /tmp/w8-hosted
```

Run each deployed plan/profile into a separate directory. Both policies run by default; select one with `--policy baseline-v1` or `--policy deterministic-first-v1`. Natural and `malformed-first` conditions remain separate. The injected condition replaces the first model response, records both the actual and injected responses, and excludes abstention tasks. It measures controlled recovery, not the natural error rate.

Run development smoke first, then the frozen held-out run. Do not tune prompts against held-out failures and then describe the same set as an untouched holdout. Freeze a new version before the next comparison. Repeat the hosted baseline after composer, readiness, prompt, catalog or profile changes; compare only matched inputs.

## Hosted run gates

A hosted run spends money and claims to measure a deployed plan, so it does not start unless each condition below holds. A missing condition produces a `not_run` report listing every reason, and exit code 2. Malformed files are errors, exit code 1.

- **Spend authorization.** Required for every hosted run. It must name this profile and split, and the run must start inside its dates. `maxRequests` counts **actual HTTP POSTs**, including provider-internal recovery and manager retries; `--max-requests` may lower it, never raise it. `maxTokens` counts input, cached input and output as the provider reports them. Both are checked before each request, so a request already in flight can exceed the token limit by its own size. A successful response that reports no usage stops the run, because spend can no longer be counted. A stop leaves the remaining tasks explicitly unrun. These are request and token limits, not an invoice or a dollar cap.
- **Admin evidence (held-out only).** `admin` is the unmodified control-plane export. The runner resolves plan, profile, `high` slot and upstream model from it and refuses a profile whose `intendedModel` differs. Hosting stores no profile revision, so the revision is a SHA-256 fingerprint of the resolved profile: every slot's model, reasoning effort, pricing and update time, plus the declared proxy fallbacks. Re-slotting the profile changes it; editing an unrelated profile does not. Proxy fallbacks must be listed, even as `[]`.
- **Frozen rubric (held-out only).** `src/workflows/evaluation/rubric/workflow-release-v1.json` holds the release thresholds from the implementation roadmap. It ships as `proposed`. Freezing sets `status: "frozen"` with the date and approvers, and requires agreed per-plan budgets (requests and tokens per task, p95 composition time). A rubric dated after the run started is refused. A changed threshold is a new rubric id, not an edit. Every manifest pins the rubric and its hash, so a result cannot be re-judged against a different one.

Every hosted request is pinned to `uj-high`. The hosted provider rewrites proxy errors before the model manager sees them, which today keeps the manager from failing over to the provider default (`uj-medium`). The pin makes that a guarantee rather than a side effect of error wording: a request for any other alias is refused before it is sent, recorded on the row, and the run stops. A refused row is never counted as a measurement of the profile.

What these gates do not do: they do not verify which upstream model answered each request (a response may report only the opaque alias; the proxy spend log is the authority for routing), they do not make an estimate an invoice, and they do not certify anything beyond the synthetic task set.

## Evidence and reporting

- `manifest.json`: code HEAD plus a source fingerprint (including uncommitted evaluation code), file inventory, task-set hash, the rubric and its hash, hosted profile, resolved admin evidence and its revision, spend authorization, aliases, limits, scheduled tasks, the exact command arguments and the Bun version. `sourceFingerprintVersion: 2` hashes a framed inventory of paths, content hashes and deletion markers. `deletedSourcePaths` records tracked files missing from the working tree; an empty file and a deletion have different fingerprints. Other read errors still fail the run. Older manifests use the previous fingerprint format and should not be compared directly.
- `taskset.json` and `catalog.json`: exact task and catalog snapshots, engine bundle hash and whether the readiness preflight was available.
- `events.jsonl`: incremental task/call/transport/candidate events. An interrupted run retains this log and its composition journal; it must not be presented as completed.
- `rows.jsonl`: raw requests and responses, injected faults, candidates and validation errors, composition latency, HTTP status, requested/reported models, raw token counts, execution receipts and per-assertion results. Each row also records the profile id and revision, any refused requests, and fingerprints of the system prompt and tool definitions it sent.
- `evaluation.sqlite` and `runtime/`: isolated composition, queue/run records and engine logs.
- `report.json`: completion and unrun counts, refused requests, and separate groups for split, measurement kind, policy, condition and profile. Each group's `measures` count every scheduled task, so unrun, refused, failed and timed-out work stays in the denominator.
- `review-template.json`: links each row to the fingerprint of its exact persisted, redacted JSON for subsequent human review. Redacted provider errors remain reviewable, and changes to the saved row still invalidate the review.

Repair metrics count tasks, not individual calls. `repairs.needed` counts tasks with rejected candidates or an injected fault. `repairs.attempted` counts only tasks where a later composer call actually started with a failed candidate to repair. Each call records `repairOfCandidate`, the zero-based candidate index, or null for an initial/discovery call. A truncated response with no subsequent call is not a repair attempt. A provider failure during a repair call is an attempted, unsuccessful repair. Structural/intent repair successes use only the attempted tasks.

Older raw rows omit that call marker. When their failed candidates cannot be classified, `repairs.unmeasured` counts those tasks and the aggregate attempted/success counts are null. Re-importing old results never guesses attempts from failure presence or total call count; existing raw rows and saved reports remain unchanged.

Model routing is recorded per HTTP attempt. A reported opaque alias gives `intendedModelVerified: null`; a different model is explicitly false. Do not label those rows a verified baseline for the intended model.

Cost is null unless every attempted request has complete usage, every reported model matches the declared model, and the profile includes dated rates:

```json
{
  "rates": {
    "source": "Reference to the applicable price schedule",
    "asOf": "YYYY-MM-DD",
    "inputUsdPerMillion": 1,
    "cachedInputUsdPerMillion": 0.1,
    "outputUsdPerMillion": 2
  }
}
```

These numbers illustrate the schema, not real pricing. Cached input is removed from ordinary input before costing. Missing usage on a failed call cannot turn into zero cost. This is an estimate, not an invoice.

For human review, read the original request, candidates, final graph and execution assertions. Fill selected template entries with reviewer identity, `intentCorrect`, actual review/correction time in milliseconds, number of graph edits, and notes. Record the correction required; do not infer zero effort from automatic success. The correction count is reviewer-reported, not an instrumented editor measurement.

```bash
bun run eval:workflows --mode review --results /tmp/w8-hosted/rows.jsonl \
  --reviews /path/completed-reviews.json --out /tmp/w8-reviewed
```

The importer rejects unknown/duplicate row IDs, changed row hashes and invalid measurements. Reviewed results are separate files; raw observations remain immutable. When the results file sits in its run directory, the review output also carries that run's manifest and task set, so it can feed a baseline. A corrected workflow needs a new execution run before claiming its effects are verified.

## Measures

Every completed row has exactly one disposition, taken from structured fields (refusal records, explicit blocks, error codes), never from message wording: `passed`, `checks_failed`, `missed_abstention`, `false_abstention`, `composition_failed`, `composition_timeout`, `provider_error`, `routing_fallback`, `budget_stopped` or `harness_error`. Scheduled work that never ran is `not_run`. Only `passed` counts as success.

Rates carry their counts and a 95% Wilson interval, and a rate without a denominator is null, never zero. Supported jobs report a valid graph, intent correct on the **first candidate** (the first submitted graph was accepted) and **after the bounded repair loop**, both automatically and with human review; a task counts as correct under review only if its automatic checks pass and the reviewer agrees. Abstention tasks report correct abstentions and missed ones, and false abstentions on supported jobs are counted separately. Unexpected effects count simulated notifications beyond what a scenario expects (extra, duplicate or misdirected) and unrequested AI calls; a missing effect is a failure but not an unauthorized one. Composition time, requests and tokens per task, and review edits and time report p50, p90, p95 and the maximum. With repeats, task-level rates count a task only when every scheduled repeat succeeded.

## Baseline report

```bash
bun run eval:workflows --mode baseline --runs /tmp/w8-reviewed,/tmp/w8-plus-reviewed --out /tmp/w8-baseline
```

`--runs` takes run directories or reviewed directories. The report is sanitized for sharing: aggregates and identities only, with no job text, prompts, responses, graphs, error text, URLs, pricing or reviewer notes. It is **refused** (exit 1) for smoke, plan or development runs, rows that are not hosted measurements, a missing or unpinned frozen rubric, missing admin evidence or authorization, runs on different rubrics or task sets, and two runs of the same profile. Hosted held-out runs that did not start make it **not_run** (exit 2), with their reasons.

Natural-condition groups are judged against the frozen rubric: sample size, first-candidate and after-repair intent, unexpected effects, missed abstentions, median edits and correction time, and the per-plan budgets. Each verdict is `met`, `not_met`, `insufficient_sample`, `incomplete_review`, `not_measured`, `not_agreed` or `unknown_usage`. A small sample cannot pass a threshold, though it can fail one when even its upper bound is below the minimum. The overall verdict is `meets_rubric` only when everything is met. Injected-fault groups are reported without verdicts.

Results are written only to the `--out` directory; do not commit run output. Summarize a run in the PR or discussion that uses it.
