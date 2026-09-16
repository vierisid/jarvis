# Workflow version ownership and atomic publication

N1. Branch `fix/workflow-version-ownership`, based on freshly pulled main
`07fecdc8`.

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
transaction. A version edit and its editor metadata now commit together.

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

## Verification

The final 44-case regression file produced 30 failures on unchanged main in
an isolated checkout. It covers all six nested read/write operations, unknown
identities, malformed foreign version content, invalid publication bodies,
explicit draft/locked selection, scoped latest selection and the lower-level
setter. Snapshots compare complete flow, version and editor metadata rows.

Synthetic SQLite failures during attachment, enabling and editor metadata
writing prove rollback. The chat publication case checks the same rollback,
and a body-read test deletes the version before the handler resumes to ensure
ownership is checked after the asynchronous boundary. Valid operations and
existing publication warnings remain covered by the surrounding suites.

- 329 tests passed across API, DB, chat, trigger, sandbox and goal work-item
  suites, including all 44 new cases.
- TypeScript, daemon build and all four repository guards passed. The build
  includes the flock asset; packaging used Bun's packer (2 required paths,
  2,530 files).
- Full-repository testing and the aggregate commit hook were not rerun because
  of the previously recorded timeout limitations. The local commit uses a
  per-command hook override after these explicit checks.

## Integration and limits

At branch creation, open PRs were #476 (native lookup), #473 (encryption),
#475 (small-model interface), #381 (command deck/wake) and #280 (project docs).
None touches this fix's routes or flow/version repositories. Main now includes
#469 (structural runtime) and #474 (governed pieces). No sibling commits were
merged into this branch.

W3 activation/preflight work should reuse this publication boundary. This fix
does not add connector validation, cross-tenant authorization, remote-trigger
rollback or a migration for previously corrupted publication pointers. Tests
use synthetic local records and effects; no deployed workflows were inspected
or executed.
