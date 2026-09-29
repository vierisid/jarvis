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
Values whose shape depends on runtime data appear in runtimeChecks with their
node, path and enforcing guard. These are not proofs of future input availability.
The subsequent runtime-validation commit installs strict missing-value checks.
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
before their RUN hook, so refusal does not consume events. Subscriptions remain
active and the next fire rechecks readiness. Startup/refresh refusals create a
FAILED registration run and notify the connected desktop; identical registration
refusals are deduplicated per manager lifetime. Registration retries use the
existing bounded backoff. A repair followed by refresh or restart rechecks the
current graph. Flow enablement and existing published versions are not rewritten.

`GET /api/workflows/readiness?limit=100&offset=0` audits enabled workflows using
the live inventory. It returns `items` with `flowId`, `versionId`, and `readiness`,
plus `nextOffset` (null on the last page). Inspect both issues and runtime checks.
This is read-only; it does not execute workflows or resolve secrets.
