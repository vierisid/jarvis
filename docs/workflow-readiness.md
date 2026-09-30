# Workflow readiness

Composition and activation use `compileWorkflow`. Publication, enable, live
draft edits, version attachment, API locking and run admission recheck the
persisted graph. Trigger registration also checks existing enabled records at
startup. Incomplete disabled drafts can still be saved. A submitted `valid`
flag cannot mark a broken graph ready.

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

`GET /api/workflows/readiness?limit=100&offset=0` audits enabled workflows using
the live inventory. It returns `items` with `flowId`, `versionId`, and `readiness`,
plus `nextOffset` (null on the last page). Inspect both issues and runtime checks.
This is read-only; it does not execute workflows or resolve secrets. See
[upgrade guidance](workflow-readiness-upgrade.md) before deploying stricter runtime checks.
