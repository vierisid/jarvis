# Workflow quality evaluation (W8)

The composer now records versioned planning inputs, and this runner measures generated workflows through Jarvis. **Hosted Terra quality is still unmeasured in this checkout.** The saved results are controlled harness checks, not a model baseline.

## Product change

Production composition retains the immutable W2 specification and adds `provenance`: prompt version, planning policy, and SHA-256 fingerprints of the catalog and environment contracts. Catalog/tool/role/target/library metadata is copied once before composition, so a refresh cannot silently change a repair's inputs. The specification and provenance survive restart in the existing composition journal. No database migration is needed.

`deterministic-first-v1` is the default planning policy in both prompt paths. It asks for typed actions, templates, conditions, loops and transformations before adding AI. AI remains appropriate for interpretation and summarization. This is a planning instruction, not a guarantee that every output obeys it. `baseline-v1` retains the previous prompt for measured comparisons.

The existing high-tier route remains unchanged. Terra is the owner's intended composer across confirmed plans. The hosted proxy resolves `uj-high`; a client alias alone does not prove which model answered.

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
- W3 is detected and its real preflight is used when present. The catalog artifact records this. W8 does not copy W3's compiler into main.

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

For a hosted baseline, supply a versioned profile that describes an **existing authorized Jarvis hosted account**. The runner uses the same hosted provider implementation as Jarvis; it does not call a different model vendor directly.

```json
{
  "id": "owner-confirmed-plan",
  "version": "deployment-revision",
  "baseUrl": "https://YOUR_JARVIS_HOSTED_PROXY",
  "apiKeyEnv": "JARVIS_EVAL_API_KEY",
  "intendedModel": "OWNER_CONFIRMED_TERRA_MODEL_ID",
  "routingEvidence": "Reference to the deployed plan-to-model mapping"
}
```

The credential belongs in the named environment variable, not the file. Missing profile/access produces a `not_run` report and exit code 2. The repository does not contain credentials.

```bash
bun run eval:workflows --mode hosted --profile /path/profile.json \
  --split heldout --repeats 3 --max-requests 100 --out /tmp/w8-hosted
```

Run each deployed plan/profile into a separate directory. Both policies run by default; select one with `--policy baseline-v1` or `--policy deterministic-first-v1`. Natural and `malformed-first` conditions remain separate. The injected condition replaces the first model response, records both the actual and injected responses, and excludes abstention tasks. It measures controlled recovery, not the natural error rate.

The request limit counts **actual HTTP POSTs**, including provider-internal recovery and manager retries. W9's total composition deadline/cancellation still applies per task. This request limit is not a dollar cap. Budget exhaustion leaves remaining tasks explicitly unrun.

Do not tune prompts against held-out failures and then describe the same set as an untouched holdout. Freeze a new version before the next comparison. Repeat the hosted baseline after W2/W9/W3 or prompt/catalog/profile changes; compare only matched inputs. W2 and W9 are already on this branch's main base.

## Evidence and reporting

- `manifest.json`: code HEAD plus a source fingerprint (including uncommitted evaluation code), file inventory, task-set hash, hosted profile, aliases, limits and scheduled tasks. `sourceFingerprintVersion: 2` hashes a framed inventory of paths, content hashes and deletion markers. `deletedSourcePaths` records tracked files missing from the working tree; an empty file and a deletion have different fingerprints. Other read errors still fail the run. Older manifests use the previous fingerprint format and should not be compared directly.
- `taskset.json` and `catalog.json`: exact task and catalog snapshots, engine bundle hash and W3 availability.
- `events.jsonl`: incremental task/call/transport/candidate events. An interrupted run retains this log and its composition journal; it must not be presented as completed.
- `rows.jsonl`: raw requests and responses, injected faults, candidates and validation errors, composition latency, HTTP status, requested/reported models, raw token counts, execution receipts and per-assertion results.
- `evaluation.sqlite` and `runtime/`: isolated composition, queue/run records and engine logs.
- `report.json`: completion and unrun counts, with separate groups for split, measurement kind, policy and condition. Failed tasks stay in the denominator.
- `review-template.json`: links each row to the fingerprint of its exact persisted, redacted JSON for subsequent human review. Redacted provider errors remain reviewable, and changes to the saved row still invalidate the review.

Repair metrics count tasks, not individual calls. `repairs.needed` counts tasks with rejected candidates or an injected fault. `repairs.attempted` counts only tasks where a later composer call actually started with a failed candidate to repair. Each call records `repairOfCandidate`, the zero-based candidate index, or null for an initial/discovery call. A truncated response with no subsequent call is not a repair attempt. A provider failure during a repair call is an attempted, unsuccessful repair. Structural/intent repair successes use only the attempted tasks.

Older raw rows omit that call marker. When their failed candidates cannot be classified, `repairs.unmeasured` counts those tasks and the aggregate attempted/success counts are null. Re-importing old results never guesses attempts from failure presence or total call count; existing raw rows and saved reports remain unchanged.

Model routing is recorded per HTTP attempt. A reported opaque alias gives `intendedModelVerified: null`; a different model is explicitly false. Do not label those rows a verified Terra baseline.

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

These numbers illustrate the schema, not Terra pricing. Cached input is removed from ordinary input before costing. Missing usage on a failed call cannot turn into zero cost. This is an estimate, not an invoice.

For human review, read the original request, candidates, final graph and execution assertions. Fill selected template entries with reviewer identity, `intentCorrect`, actual review/correction time in milliseconds, number of graph edits, and notes. Record the correction required; do not infer zero effort from automatic success. The correction count is reviewer-reported, not an instrumented editor measurement.

```bash
bun run eval:workflows --mode review --results /tmp/w8-hosted/rows.jsonl \
  --reviews /path/completed-reviews.json --out /tmp/w8-reviewed
```

The importer rejects unknown/duplicate row IDs, changed row hashes and invalid measurements. Reviewed results are separate files; raw observations remain immutable. A corrected workflow needs a new execution run before claiming its effects are verified.

## Current evidence

See [the saved raw harness results](evaluations/w8-2026-09-29/README.md). They establish that the runner executes, repairs, records and detects errors in the supported fixtures. **No live hosted baseline or timed human review has been performed.** Live intent correctness, model repair quality, hosted latency/cost and correction effort remain unmeasured.
