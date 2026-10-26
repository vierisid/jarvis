# ON-B-06: durable tour navigation

Default-off `tour.v1`, requiring injected `journey.v1`. No daemon registration,
new table, legacy handler replacement or production sample data. The generated
runtime catalog is produced by the existing B11 generator.

The twelve stable IDs mirror U05/U06: Today, Workflows, Opportunities, Needs you,
Goals, Memory, Connected workspace, Authority, Profile, Settings, Billing and
Pebble. The source is the approved onboarding contour checkpoint
`2410205462365531104`, room nodes `1097:16634` through `1097:39626`, and Pebble
`1097:42287`/`1097:44821`. This card reuses those views; it changes no visual design.

## Durable contract

`createTourProvider({ enabled, authorize, journeyFor, roomStatus })` is inert until
an explicit `request(context, command, signal)` call. The server derives scope
from live authentication. `journeyFor` must return B01 bound to that same scope,
authorized vault and live request; never forward client scope or expose its
acknowledgement port. B11 maps only `tour.command` to this request method.
Its observational runtime probe must check real bindings without calling read,
initializing a journey, or writing anything.

Commands are `read`, `replay`, and `navigate`. Mutations carry `sessionId` (the
journey ID), `revision`, and a stable `requestId`; navigation also has `from`,
`action` (`back`, `next`, `skip`, `finish`) and optional exact adjacent `to`.
Finish is only valid on Pebble. Back and Skip remain available when a room is
missing; forward navigation requires a ready current room. Unknown new progress
is unsupported, never silently reset. A capability probe failure is unavailable.

B01 is the only durable store. Next/Back acknowledge a canonical room ID;
Skip/Finish acknowledge different terminal tour states. Atomic revisions and
receipts reject stale tabs and changed retries, and recover an acknowledgement
lost after commit. A retry returns current progress, including a newer peer
replay. Tour completion leaves Activation pending; it never invokes Explore,
creates a workflow, grants authority or writes accounts/connections.

Known legacy hints are projected on read, without a migration write: `brief:v1:`
room IDs retain their room; `context` maps to Memory, `apps` to Connected workspace,
and `talk` to Pebble. Unknown old hints begin at Today. The next deliberate
navigation writes the canonical ID. Completed/dismissed tours stay inactive;
only explicit replay resets their position. B01 preserves completion, facts,
connections, draft/job identities and the replay return destination.

## UI and room isolation

Import `createTourViewAdapter` directly from `view-adapter.ts` in a browser host.
It structurally implements U10's adapter; share its instance across the tour and
Pebble bindings. It validates scope/revision, preserves retry IDs, and translates
the existing U05/U06 intents. B06's model, including a projected legacy position,
is authoritative for choosing the room or Pebble view. An already completed tour
must advance to Activation without showing its rooms; explicit replay remains
visible even for a completed user. U10 owns those host decisions.

The adapter takes trusted, verified D room renderers and the existing Pebble
Surface. Supply only read-only/fixture-bound renderers with no provider startup,
portals into live rooms, send/upload callbacks or mutation handlers. The isolation
labels are contracts, not a JavaScript security boundary. `available()` must
reflect actual renderer readiness; a manifest or a hardcoded true is insufficient
in a production binding. Missing dependencies retain legacy onboarding.

`createTourSandbox` is a local presentation overlay. It captures the original room,
selection, theme, sidebar and conversation identity/open state without calling any
live setter. Account-menu rooms are local projections. Only the demonstration's
Pebble open state changes, and leaving/replaying clears that local state. Keep the
real workspace/conversation mounted underneath; do not key their instances on tour
steps or restore a stale copy over newer user work. Existing drafts remain owned
by the real conversation. No fake room data ships in this provider.

## Verification and activation

Quick check: `bun test src/onboarding-next/tour`. Tests reload at Memory and every
other step, walk the actual U05/U06 controls through the actual D06 Pebble layout,
close/reopen its retained surface, and finish at Activation. Other room contents
are inert test fixtures; this is not certification of all live D room adapters.
Real B01 persistence uses temporary SQLite; runtime tests use B11 with synthetic
unrelated capabilities/release approval. Optional integration tests skip when the
relevant sibling source is physically absent; standalone contract tests still run.

Enable only after B11 production binding, U10/U05/U06, verified effect-free D room
adapters and the combined release gate. Native/WebView, real accounts and complete
D/F/Q release evidence are not supplied by these tests. Rollback omits/disables
this provider and its bindings, regenerates the catalog, and retains B01 and all
user/draft records. The legacy handler remains available; no destructive migration.
