# F-07: workflow composition jobs

F-07 supplies the authenticated API and durable service that turns a natural-language prompt into a populated, disabled draft. It uses the existing high-tier composer, composition journal and canonical draft repositories. This PR follows the owner's unmerged stack on F-06 (`23979f3bebab09a68c140aad3cb1843865fef150`).

There is no production UI change. D-16 owns the workflow prompt presentation and should consume this API. The old WorkflowsRoom creation handler is not rewired here. F-08 connection/library ingredient selection is not implemented; extra request fields are rejected instead of silently ignored.

## Activation and API

The daemon registers `workflowComposition`, disabled by default. Opt in with `JARVIS_BRIEF_WORKFLOW_COMPOSITION=1` at daemon startup. Readiness also requires the actual configured composer and open workflow database. No conversation or attachment flag is required. This PR does not activate a running daemon.

All routes use the existing panel-session authentication and CORS adapter, with `Cache-Control: no-store`. Check `/api/brief/capabilities` before exposing the action. Missing/mismatched providers return 501; a disabled or unavailable provider returns 503.

| Method and path | Result |
| --- | --- |
| `POST /api/brief/workflow-compositions` | `{requestId, prompt, name?}` becomes `{job, created}`; 202 for a new queued job, 200 for an exact replay. |
| `GET /api/brief/workflow-compositions/:id` | Current job receipt. Unknown or other-project IDs return 404. |
| `GET /api/brief/workflow-compositions?requestId=KEY` | Exact request recovery as `{jobs: []}` or `{jobs: [job]}`. Without the query, returns the latest 100 jobs. |
| `POST /api/brief/workflow-compositions/:id/cancel` | Cancels queued/running work. Repeated cancellation and cancellation after completion preserve the terminal receipt. |

The client must create and persist a request ID before submission. Reuse it with exactly the same prompt and name after an uncertain response; a changed specification with the same key returns 409. Do not create a new key merely because a POST timed out. Recover by request ID, then poll the returned job ID.

The request ID allows 1–128 ASCII letters, digits, underscores and hyphens. Prompts must contain non-whitespace text and fit in 16,384 UTF-8 bytes. Names are optional, nonblank, and at most 160 UTF-16 code units; omission uses `New workflow`. Admitted wording, including whitespace, is preserved. The actual request stream is capped at 100,000 bytes regardless of Content-Length. At most 32 queued/running jobs are admitted per project; queue saturation returns 429 without saving a new job, so the same key can be retried later.

## Lifecycle and guarantees

`queued` becomes `running`, then `draft_ready`, `blocked`, `failed` or `cancelled`. A receipt includes the original `specification`, `progress.checkedCandidates`, the canonical `compositionId` when one has been created, and either `workflow: {flowId, versionId}` or a useful `blocker`. Candidate count is validation progress, not a percentage or promise of completion. Raw responses, parse excerpts and provider diagnostics stay in the existing journal. A model's explicit blocker reason is bounded to six details of 500 characters and must be rendered as plain text.

The job is committed before any model call. Journal creation and its job link commit together before provider work. The validated canonical flow, its draft version and the job's result IDs commit in one short transaction. A result-write failure therefore cannot leave a hidden orphan draft. Composition uses the existing high-tier model client, baseline planning policy, catalog snapshot/provenance, repair loop, cancellation and three-minute composition budget. A 190-second worker watchdog also releases the queue if a provider ignores cancellation.

A successful result creates a populated `DRAFT` on a `DISABLED` flow with no published version. It never publishes, enables, schedules or executes the workflow. These IDs are a creation receipt, not a claim about the workflow's current state after later edits. Activation still uses the existing readiness and execution gates. Composition validates structure and supported operations; it does not prove semantic fidelity to every free-text instruction. A candidate with no piece action is a blocker asking for action, destination and timing. This includes a lone trigger and empty loop/router structures; actions nested inside a loop or branch count as populated.

Cancellation persists its terminal outcome before aborting the active provider request. Late results cannot attach a draft. Graceful shutdown and startup recovery record unfinished work as `failed` with `interrupted`, retaining the prompt and any composition ID. Completed results survive restart with the same flow/version IDs. Recovery does not automatically call the model or resume an uncertain attempt. To intentionally try again after a terminal failure/blocker/cancellation, submit the saved or revised specification with a **new** request ID. Reusing the old key always retrieves its existing outcome.

The worker is owned by one daemon for one vault. Constructing a replacement marks that project's unfinished jobs interrupted; this is not a distributed multi-worker lease service. If storage becomes unwritable during shutdown, the worker still aborts and fences late results; startup recovery settles its last durable checkpoint when writes are available again. Rows and prompts are retained without automatic expiry so old keys cannot create duplicate drafts. Future retention/deletion policy must preserve an idempotency tombstone if job details are removed.

## Quick verification

From WSL, run:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-07
bun test src/brief/composition.test.ts src/daemon/api-brief-composition.test.ts src/actions/tools/persisted-workflow-composer.test.ts
```

These fixtures use temporary on-disk databases, the actual authenticated HTTP server and fake model responses. They do not require a model account or activate a real daemon. They check one job/draft across queued, running, completed and restarted retries; exact prompt preservation through repair; blocked/invalid results; cancellation and uncooperative providers; timeout; project isolation; bounded admission; atomic rollback; retained activation gates; and legacy journal compatibility.

For a D-16 integration host with the flag deliberately enabled, POST a prompt such as `On manual trigger, draft a short report in the dashboard. Never send email or delete files.` with a stable request ID. Poll until terminal. Repeat the identical POST and confirm the same IDs; inspect the canonical draft's actions and disabled state. Submit an underspecified prompt and inspect the blocker. Cancel a pending composition and verify no draft appears when its provider later returns. This integration exercise calls the configured model; it was not used for fixture verification.

Verification commands, counts, four rejected unsafe mutations and logs are recorded in `docs/brief-delivery/F-07.json` and `docs/brief-delivery/evidence/F-07/`. Exact pushed-head CI is recorded in the PR description.

## Rollback

Remove `JARVIS_BRIEF_WORKFLOW_COMPOSITION=1` and disable its future presentation. Stop the service through normal daemon shutdown so unfinished jobs retain interrupted outcomes. Keep additive job rows, original prompts, canonical composition journals and any already-created drafts. Do not delete user records or replay accepted jobs. The older chat/opportunity composition paths remain available.
