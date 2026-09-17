# Workflow version ownership and atomic publication

## Contract

Every request under `/api/workflows/:id/versions/:versionId` must identify a
version belonging to that flow. A missing parent, missing version or
wrong-parent version returns 404 without reading the version content or
changing either flow. The same guard covers editor metadata, locks, sample
outputs, sample-output clearing and sample inputs. Nested version listing and
creation also return 404 for a missing parent.

The shared `assertFlowVersionOwnership` checks the relation in SQLite before
JSON parsing. `withOwnedFlowVersion` keeps that check and its synchronous
operation in one transaction. Request bodies are consumed before entering the
transaction, so the check always runs after the asynchronous boundary and sees
the state the write will act on. A version edit and its editor metadata now
commit together.

`publishFlowVersion(flowId, versionId?)` is the shared HTTP/chat publication
boundary. It uses an immediate SQLite transaction to select the version, check
ownership, lock the draft, attach it to the flow and enable the flow. Any
failure rolls all database changes back. Trigger refresh happens only after
commit; registration of remote triggers is not part of this transaction.

Publication accepts an empty body or `{}` to select the latest owned draft.
An explicit non-empty string `versionId` can select an owned draft or already
locked version. Missing or wrong-parent explicit IDs return 404. No latest
draft returns 400. Malformed JSON, non-object bodies and invalid explicit IDs
return 400 rather than falling back to the latest draft.

The lower-level `setPublishedVersion` also rejects missing or unowned version
IDs. Clearing with `null` remains supported. It retains its attachment-only
role; production publication callers use `publishFlowVersion` to lock and
enable atomically. Chat retains its existing already-published/no-draft no-op
and advisory OS warnings.

## Invariants this protects

`flow.published_version_id` is always null, or a version whose `flow_id` is
that flow. The repository setter, not just the route, is what holds this.

A LOCKED version's content stays immutable: `updateDraftVersion`,
`setSampleDataEntry`, `setSampleInputEntry`, `replaceSampleData` and
`mergeRunOutputsIntoSampleData` all refuse a LOCKED row, and re-publishing an
already locked version mutates the flow row rather than the version. Only
`setEngineTriggerState` writes to a locked row, and only the daemon-owned
`engine_listeners` / `engine_schedule` columns.

Both invariants are load-bearing for two existing consumers. Today work items
require the referenced version to belong to the selected flow and to be LOCKED
(`docs/TODAY_WORK_ITEMS.md`), and re-check both inside the run transaction.
Authority pins an approved effect to the run's version and digest
(`docs/superpowers/specs/2026-09-15-workflow-authority-design.md`). Reaching
`lockVersion` or `setPublishedVersion` through another flow's route let an
unreviewed draft be promoted to LOCKED, or a foreign version be spliced in as
a flow's published version, either of which would make those checks describe
something the user never approved.

## Verification

`src/workflows/api/version-ownership.test.ts` covers all six nested
read/write operations against a wrong parent, a missing parent and an unknown
version; malformed foreign version content, to show the relation is checked
before the row is parsed; invalid and malformed publication bodies; explicit
draft and explicit locked selection; latest-draft selection scoped to the
owning flow; and the lower-level setter. Assertions snapshot the complete
flow, version and editor metadata rows, so a rejected request has to leave the
database byte-identical.

Rollback is shown with synthetic `RAISE(ABORT)` triggers on attachment, on
enabling and on the editor metadata write, for both the HTTP and the chat
publication entry point. One case deletes the version while the handler is
awaiting its request body, to pin the ordering rule above.

`src/workflows/db/repos/repos.test.ts` covers the setter against a real owned
version, and keeps its existing missing-flow case. The unowned, missing and
`null`-clearing cases for the setter live with the rest of the new coverage.

## Limits

This fix does not add connector validation, cross-tenant authorization,
remote-trigger rollback, or a migration for publication pointers already
corrupted by the previous behavior. W3 activation/preflight work should reuse
this publication boundary rather than re-deriving it.
