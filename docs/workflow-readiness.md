# Workflow readiness

Composition and activation use `compileWorkflow`. Publication, enable, live
draft edits, version attachment, API locking and run admission recheck the
persisted graph. Trigger registration also checks existing enabled records at
startup. Incomplete disabled drafts can still be saved. A submitted `valid`
flag cannot mark a broken graph ready.

Run admission also compares the connections and computer a flow was enabled
against with what they resolve to now. A replaced credential, a connection
deleted and created again, a reconnected Google account or a computer no longer
enrolled is a `BINDING_STALE` issue until a person enables or publishes the
flow again, which pins the current bindings; saving a draft does not. In chat,
that acceptance needs a person's approval. See
`docs/workflow-binding-pins.md`.

Single-step previews validate the selected node using its saved sample input
override. Other unfinished nodes retain identity/scope checks but do not need
activation-ready inputs or bindings. Whole-workflow runs and publication still
validate every node. Preview inputs keep the existing provenance and Authority
checks at dispatch.

`GET /api/workflows/:id/versions/:versionId/readiness` returns:

```json
{
  "ready": false,
  "issues": [{
    "node": "trigger",
    "path": "settings.input.cron_expression",
    "code": "CRON",
    "message": "Invalid cron field: ..."
  }],
  "runtimeChecks": []
}
```

Rejected activation returns HTTP 422 with `code: "WORKFLOW_NOT_READY"`, a
readable `error`, and this same report. Wrong-parent versions retain the
ownership contract's 4xx response. Publication validates before locking or
changing the published pointer, inside the existing immediate transaction.
Readiness reads connection metadata only; it never refreshes credentials or
calls a model inside that transaction.

The compiler checks node identity and supported types, bounded graph shape,
lexical reference scope, expression syntax, known input types and choices,
router conditions, cron syntax/ranges, authenticated connection bindings,
tool identities/parameters, specialist roles and nested workflow bindings.
Native trigger `setSchedule`, preflight and the daemon scheduler use the same
parser, including Sunday 7 and the bounded `@every` interval extension.
Connection IDs must be unique within the flow's project and match the piece.
The editor's connection IDs are opaque: `my-gmail`, numeric IDs and managed
`jarvis:` IDs are parsed as bindings before ordinary workflow expressions.
Nested workflows must resolve by stable ID to a ready version without cycles.
Required or supplied dynamic properties need a saved property schema. Preflight
validates known nested values against it, and the engine receives the same schema
for action and trigger execution. Missing schemas, unknown property types and
unresolved nested dynamic schemas block activation. The daemon supplies the live catalog, tool and role inventories.
An unavailable inventory is an error for nodes that require it.

References may use earlier outputs, the trigger, and the containing loop's
item/index. Router branch outputs are available in the router's continuation as
runtime-dependent values, for example `{{a.out ?? b.out}}`. Sibling branches
remain isolated. Loop-body outputs do not escape their loop. Output samples are examples, not authoritative schemas.
Values whose shape depends on runtime data appear in `runtimeChecks`, with a
node, path and enforcing guard. Piece input validation runs before dispatch;
missing references fail before interpolation can turn them into ordinary text.
Optional data needs an explicit fallback, for example
`{{trigger.optionalNote ?? "No note"}}`. Loop items must resolve to an array.
Router `EXISTS` / `DOES_NOT_EXIST` predicates intentionally inspect absence;
their complete expression operands receive a null fallback during execution.
Router conditions resolve in order: an AND group stops at its first false
condition, and OR groups stop at their first match. Skipped operands are neither
resolved nor included in the recorded router input; the saved graph is unchanged.
First-match routers also stop before resolving any later branch. All-match
routers evaluate each branch; unvisited branches retain empty condition lists. Other router
operators still reject missing values when evaluated, as do ordinary action inputs.
A condition's operator must be one the engine implements. "Starts with" has two accepted
spellings that mean the same test: `TEXT_START_WITH`, the engine's value, which the dashboard
saves, and `TEXT_STARTS_WITH`, its enum key, which composed workflows write. Readiness rejects
any other operator, and the engine fails the step on one it does not implement instead of
treating the condition as met.
Known JSON, object and array inputs are checked before activation, using their
source property type and the engine's supported conversions. Catalog schema v8
retains ordinary ARRAY row contracts. Required fields, known types and nested
rows are checked for both row arrays and the engine's column-map representation;
runtime-dependent values keep their dispatch checks. A required collection
must be present, but an empty array is valid; required does not imply a minimum
length. Runtime-dependent values and file inputs retain their explicit runtime
checks. Supplied dynamic schemas validate nested required fields and types after
resolution, before a piece can call its provider.
Connections are re-resolved at runtime, including managed sources, whose token
availability can change after activation. Nested runs and tools validate again
at their existing dispatch boundaries.

Readiness does not grant Authority approval, prove business intent, guarantee
provider availability, or prove arbitrary CODE behavior. Existing Authority,
CODE opt-in, required-effect outcomes, cancellation and machine/session binding
remain execution gates. A ready graph can still report blocked or failed when
those runtime conditions are not met.

Tests cover both composer paths, API/chat activation parity, atomic publication,
live draft edits, startup rejection, connection identity and scope, and actual
engine execution stopping before the backend on unresolved/empty inputs.

Live trigger readiness refusals create a finished FAILED run containing the
structured readiness report, without enqueuing work. Polling triggers check
before their RUN hook. If readiness changes during an in-flight poll, the
returned items have already been consumed by the trigger; each failed run keeps
its input in `steps["<readiness>"].output.recovery` with `payload`, `executeTrigger`
and `requiresDecision: true`. This record survives restart and permits inspection
and an explicit recovery decision; it never schedules a retry. Subscriptions remain
active and the next fire rechecks readiness. Startup/refresh refusals create a
FAILED registration run and notify the connected desktop; identical registration
refusals are deduplicated per manager lifetime. Registration retries use the
existing bounded backoff. A repair followed by refresh or restart rechecks the
current graph. Flow enablement and existing published versions are not rewritten.

A live refusal notifies the connected desktop too (#1080), once per new refusal:
the next tick or delivery refused the same way adds its failed run (or its
counted blocked row) but no second notice. A notice that reached no connected
computer is not counted, so the next repeat tells it. A run refused while it
executes because of what it is bound to (`WORKFLOW_MACHINE_OFFLINE`,
`WORKFLOW_FACT_STALE`, `WORKFLOW_FACT_AMBIGUOUS`) notifies once per workflow,
code and subject (the computer the refused step was bound to, or the step
whose reviewed recipient no longer holds) until a later run shows that subject
working (a step that succeeded on that computer, or that step succeeding with
its reviewed recipients) or the workflow is enabled or published again. A run
that took another branch, or let the refused step fail and went on, clears
nothing. `WORKFLOW_MACHINE_REPLACED` and `WORKFLOW_MACHINE_UNAVAILABLE` are not
among them: they are raised while a step's target is first resolved, before
its effect record exists, so no run carries them as a code; a pinned computer
no longer enrolled is refused before the run starts (`BINDING_STALE` above).
The notice's title names the workflow. That memory is per daemon
lifetime, so a restart may notify once more. Single-step test runs neither
notify nor count. `GET /api/workflows` gives each enabled workflow a `blocked`
field (`code`, `kind`, `message`, `runId`, `at`) when the most recently created
of its ended runs (test runs aside) was one of these refusals and the workflow
was not enabled or published again since. The Workflows room shows it on the
row, "Blocked" for a readiness refusal and "Last run refused" for a runtime
one, and the badge opens that run.

`GET /api/workflows/readiness?limit=100&offset=0` audits enabled workflows using
the live inventory. It returns `items` with `flowId`, `versionId`, and `readiness`,
plus `nextOffset` (null on the last page). Inspect both issues and runtime checks.
This is read-only; it does not execute workflows or resolve secrets. See
[upgrade guidance](workflow-readiness-upgrade.md) before deploying stricter runtime checks.
