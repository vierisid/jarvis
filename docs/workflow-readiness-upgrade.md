# Upgrading workflow readiness and missing-value checks

This release changes execution of already published workflows as well as new
drafts. Publication, enablement and run admission refuse invalid graphs. An
expression that evaluates to undefined now fails the step before dispatch;
previously it silently became an empty string, including inside larger text.
Existing versions and business data are not automatically rewritten.

Before rollout, audit enabled workflows through the running Jarvis API with
`GET /api/workflows/readiness?limit=100&offset=0`, following `nextOffset` until null.
The response retains stable flow/version IDs, node-level issues and runtime checks.
The audit needs the real catalog and connection inventory configured by daemon
startup. It reads connection metadata only and never refreshes credentials.
A ready report does not prove optional data will exist on a future trigger.
Review its runtime checks and test representative missing-data payloads.

Graphs now refused include invalid schedules, unknown/forward/sibling references,
missing required inputs, missing/ambiguous/wrong-piece connections, invalid child
workflow bindings and supplied/required DYNAMIC inputs without a saved supported
property schema. Reopen dynamic fields in the editor to resolve and save their
schema; do not mark the graph valid to bypass the check. Sunday accepts both 0
and 7, including ranges and steps. Loop-body outputs remain local to the loop.
Router branch outputs can be merged in the continuation with `{{a.out ?? b.out}}`.

For optional text, replace `{{trigger.body.note}}` with an explicit job-appropriate
fallback such as `{{trigger.body.note ?? "No note"}}`. Use a meaningful fallback
for required text; `?? ""` still fails a required input. Never default a missing
recipient, connection, destination or business decision to invented data. Route
to an explicit missing-data outcome or collect the required input instead.
Presence predicates EXISTS/DOES_NOT_EXIST and router short-circuiting support
intentional absence checks. Both composer paths and every repair receive this
guidance; prompt provenance advances from `w8-1` to `w8-2`.

A live trigger refusal is visible as a FAILED run with a readiness report and
no dispatched actions. The next fire rechecks, and polling refusals happen
before consuming events. An enabled graph refused at startup/refresh records a
FAILED registration run and sends a desktop notification when a sidecar is
connected. Identical registration refusals are suppressed within that manager
lifetime, and registration retries use bounded backoff. After repairing bindings
or publishing a corrected draft, refresh/re-enable the flow or restart the daemon.
Failure history remains available even if no desktop was connected.

Deploy the focused commits in order. Reverting the strict-resolution commit
restores the prior empty-string behavior while retaining static readiness gates;
reverting the gate commit removes preflight admission and its refusal records.
Neither rollback repairs invalid workflows, reverses committed remote effects,
nor changes existing saved versions. Do not assume older silent failures were
successful runs.
