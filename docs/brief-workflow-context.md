# Workflow context and run inspection (F-21)

F-21 supplies the authenticated backend contract for the D-19 Runs and D-20
Context views. It does not register those rooms in production, enable Brief, or
certify a deployment. It reads the existing workflow, run, effect, wait, work-item
and memory-use repositories. No recovery action or goal-progress write is added.

`workflowContext` requires its exact registered provider, the current database,
and `JARVIS_BRIEF_WORKFLOW_CONTEXT=1`. The flag defaults off. F-01 is the compile
prerequisite; this card introduces no additional enable-after capability.

## Selection and reads

All new readers are inside the existing panel-authenticated API boundary, return
JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and use
the provider's server-owned project. Foreign and absent identities both return
404. Extra/duplicate query keys are rejected. Each selection is read within one
SQLite snapshot.

| Route | Result |
| --- | --- |
| `GET /api/brief/workflows/:flowId/inspection?versionId=…[&runId=…]` | `{status:"ready",data:{scopeId,flowId,versionId,runId,canvas,context,run}}` |
| `GET /api/brief/workflows/:flowId/runs[?cursor=...]` | D-19 `{status:"ready",data:{items,nextCursor,total:null}}`, at most 50 summaries. The one Brief run-history reader (#1100) |
| `GET /api/brief/workflows/:flowId/runs/:runId` | D-19 `{status:"ready",data:RunDetail}` |
| `GET /api/brief/workflows/:flowId/run-requests/:requestId` | Original accepted manual-run receipt; 404 if none |

`versionId` is mandatory for selection. With `runId`, it must equal that run's
recorded version; disagreement is 409. There is no fallback to the current
published version. Canvas uses that version's sanitized nodes and edges; the
run section uses actual retained step input/output, nested loop iterations,
effect receipts and waits. Inspection unwraps the real worker's
`{output: StepOutput}` storage envelope before projecting inputs, outputs, status
and nested iterations; existing unwrapped records remain supported.
Unknown/dispatching effects make the run summary
`uncertain`, even if the run row says succeeded, and so does a stop acknowledged
while a call was in flight (the same rule D-19's history reader applies). A run
that ended badly carries Q-19's typed `failure` (category, effect, headline,
outcome, next steps, code; the raw detail is withheld) and its `summary` is that
headline and outcome. A run stopped by its lifecycle names the reason first, so
one stopped because its workflow was turned off or removed reads "Workflow
turned off." A terminal run also carries Q-07's read-only `recovery` state
(`unknown`, `blocked` or `recoverable`, never a replay). This is a read
projection, not effect reconciliation or a permission to replay.

Every run summary, detail and recorded context carries one short label,
`Run <last 6 characters of the run ID>` (`Test run ...` for a test run). The full
ID is always `runId`; D-19 and D-20 show it as the label's title and in the
inspection. D-19 reads history only through this keyset reader (#1100); the
offset-paged `/api/workflows/:id/runs` stays the classic dashboard's.

Only LOCKED graphs are projected as immutable. New runs record whether their
version was locked at acceptance via a small additive SQLite trigger. This
record survives later publication of an originally editable draft. For legacy
runs without that record, a version must be LOCKED with its last update strictly
before run creation. Otherwise graph inspection is explicitly unavailable while
actual run evidence remains readable. Old mutable graphs are never reconstructed
from today's configuration. The trigger does not change execution or snapshot
credentials; it stores only run identity and a boolean.

## Context provenance

Context has the D-20 `configured` or `recorded` basis and exact selection identity.
Each group is either ready with entries or explicitly unavailable, never a claim
of complete usage inferred from an empty query.

| Group | Configured sources | Recorded sources |
| --- | --- | --- |
| Goal | Work-item links and prepared specifications naming the selected version | Exact work-item/run link |
| Memory | Explicit `factId` inputs and prepared fact evidence | F-18 `supplied` / `outcome_verified` events for that run and flow |
| Connections | Version connection IDs and exact connection templates in graph auth fields | Q-05 per-run connection bindings (identity only; a refused binding reads stale) |
| Target | Explicit graph `sidecarId` / `target` references | Captured run machine binding and effect target references |
| Rules | Routing and code-step references | Retained approval references |

The configured basis also shows Q-05 pin drift (#1100): a connection the
version names that now resolves to another identity than the one a person
accepted when enabling or publishing reads `stale`, and so does the pinned
computer when enabling this version would choose another one. That computer
entry appears only when the computer inventory could be read and the version
has a computer step, and an explicit target naming the same computer takes
precedence. Drift that cannot be read is not shown and never fails the read. Drift names
kinds and IDs only, never a credential, grant or computer name; enabling or
publishing again is how a person accepts it.

Configured references are not proof of use. Recorded memory means retained
provider handoff, not proof of model reliance or complete lifetime coverage.
Forgotten/missing sources remain labeled. Vault goal/fact joins are restricted
to the daemon's canonical project. Connections are looked up by identity only;
the reader never decrypts credential values. Native `jarvis:` references are
labeled unverified. Historical target references do not assert a current device
connection. Missing policy snapshots, raw code, source labels, and broader
unrecorded context are not fabricated.

## Redaction and bounds

The arbitrary piece-output schema cannot prove an innocuous text field is free
of credentials. This initial contract therefore redacts **all string values and
field names**, as well as entire credential/header/session/resume subtrees.
Numbers, booleans, null and bounded structure remain visible. Partial redaction
uses explicit placeholders in the safe value; whole-string redaction also sets
D-19's `redacted` flag. This intentionally limits text inspection until a
reviewed schema can safely expose more. Free-form titles, errors, code, effect
arguments/results, and source prose never bypass this policy. Typed reference
IDs and fixed human-readable descriptions are separate from arbitrary payloads.

Waitpoint IDs authorize resumption and are withheld. Inspection returns a stable
row-based display identity without a resume URL or capability. All output is
plain text/JSON; consumers must use text rendering, never HTML injection.

Limits: 4 MB per source blob / aggregate receipt records, 200 recorded steps,
receipts, waits or context entries, 100 graph nodes, 512 KB per complete selection,
8,000 characters per field, depth 8 / 256 values per field, and at most 32 entries
per nested object/array. Small-field truncation is explicitly labeled; collection
or response overflow is 413, never silent pagination or a false complete result.
Run history uses a `(created,id)` keyset and does not hydrate step blobs.
Its `(project_id,flow_id,created DESC,id DESC)` index and tuple cursor predicate
avoid scanning unrelated workflows or sorting accumulated history on each page.
Context-group caps include restricted auth entries alongside connection references.

## Explicit, idempotent manual Run

Use the existing authenticated execution endpoint:

```http
POST /api/workflows/:flowId/run
Content-Type: application/json

{"brief":{"scopeId":"jrv_proj_default","versionId":"LOCKED_VERSION_ID","requestId":"DURABLE_CLIENT_REQUEST_ID"},"payload":{}}
```

`payload` is a required JSON object, including an explicitly chosen `{}`. Only
`brief` and `payload` are accepted for this mode; environment, preview fields and
work-item commands cannot be mixed into it. Input is capped at 65,536 UTF-8 bytes,
depth 16 and 4,096 values. The existing streaming 1 MB request guard from merged
PR #666 still runs before parsing. #662 was closed without merge and is not the
source of those guards. Legacy clients keep their existing optional-body API.

The selected version must be owned and LOCKED. Existing readiness, code permission
and F-20 removal gates still apply. Run creation, its `RUN_FLOW` job with
`maxAttempts:1`, and the accepted request receipt commit in one transaction.
Identical retries (including reordered object keys) return the original run ID.
Changing the flow, version or payload for a request ID is 409. There are at most
10,000 durable request receipts per database; new requests then fail explicitly.
No receipt eviction or history deletion can free an accepted identity for replay.

Success returns `{status:"accepted",requestId,run:RunSummary}` with HTTP 202. This
is the original acceptance snapshot, not current run status. Fetch run detail to
refresh it. D-19's host must gather input, persist the request ID and exact payload
before dispatch, retain one command owner across Canvas/Runs/Context, and recover
uncertain HTTP outcomes through the read-only request route. D-19's
`briefRunsPort(...).reconcile` is that read, behind the Runs and Context
`Check result` action (#1093). An accepted receipt unlocks Run. A missing one
unlocks Run too (#1093, owner decision), but only for a person's next explicit
Run; it is never retried or replaced automatically, and the view says that a
request still in transit could yet start. A 404 is true only when read: a
request still in transit can commit later, and nothing fences it yet. A missing receipt
must not by itself create a new request ID or retry execution; only a person's
next explicit Run does, with a fresh identity.

Accepted receipts remain readable after the existing hard-delete endpoint removes
a workflow and after daemon restart. Recovery checks the receipt's stored project,
flow and request identity without requiring a surviving flow row. The same
authentication, capability and readiness gates apply; lookup does not enqueue work.

## Integration and rollback

The Brief mode of `/run` sits behind the same checks as every other start: the
flow is resolved in the caller's project before and after the body is read
(#729), and Pause or Kill refuses it (Q-08). The provider's project must equal
the caller's, or the flow reads as not found.

Q-07 owns reconciliation/recovery writes and Q-19 the failure wording. F-21 reads
both projections and adds no recovery state machine of its own.

`src/brief/workflow-context-consumers.test.ts` runs this projection through the
D-19 Runs and D-20 Context validators as they are in `ui/`, and type-checks it
against their models. The host maps selection.context
to the context port and the run routes to the run port. Authenticated production
host binding, shared durable UI command ownership, source navigation, and release
verification still need integration before activation. The graph is an inspection
projection, not an editable replacement for the existing editor.

Rollback: unset `JARVIS_BRIEF_WORKFLOW_CONTEXT` and restart to disable these routes
and Brief manual starts. Retain the additive request ledger and version-evidence
table/trigger; never delete idempotency receipts or downgrade to a build that
silently interprets a Brief request as a legacy unkeyed run. Existing accepted
runs continue through the normal worker. No live activation or deployment was
performed, and F-22 is outside this change.

Quick verification:

```sh
bun test --timeout 15000 src/brief/workflow-context.test.ts src/brief/workflow-context-consumers.test.ts src/daemon/api-brief-workflow-context.test.ts src/workflows/adapters/untrusted-reach.test.ts
bunx tsc --noEmit
```

The tests use isolated fixture SQLite databases, an isolated Unix socket, and a
fake executor. They do not send emails, make payments, call paid models, or alter
goal progress.
