# Capture transitions

`ContextTracker.processCapture` is the canonical producer of awareness
`context_changed` events. It resolves the incoming capture's window metadata,
compares it with the last captured snapshot, builds transition/session events,
and only then replaces that snapshot. `AwarenessService` passes capture metadata
into this operation without first calling `updateWindowInfo`.

- Native `app_name` takes precedence over application-name inference from a
  window title. Older title-only captures retain that inference fallback.
- Explicit sidecar `context_changed` messages are metadata hints. They never
  mutate a processed capture or independently emit an awareness transition.
  Live context therefore describes the last processed capture, even while a
  newer window hint is waiting for a capture.
- Hints are scoped to their sidecar and timestamp. A capture can use a hint to
  fill missing metadata only if its supplied fields agree. The capture consumes
  older hints even when they conflict; future hints wait. Late hints at or before
  that sidecar's last capture are ignored.
- Capture fields take precedence over hint fields. Compatible partial hints can
  fill missing fields; any remaining gaps use the same sidecar's last captured
  window only when all resolved fields agree with it. A title-only hint therefore
  cannot replace a known native app with its window title. Conflicting app/window
  fields are never combined with the previous snapshot.
- Repeated observations of the current app/window emit no additional transition.
  Returning to a previous app remains a new transition. A title-only change is
  significant but is not an application switch for cloud escalation.
- Session-end events retain the ended session ID/apps before the tracker clears
  them. Delayed image analysis retains its own capture's predecessor.

The daemon already excludes raw awareness sidecar events from its separate
observer route when AwarenessService is present, so the canonical event alone
reaches awareness subscribers and the workflow event bus. This change does not
add a second event route or alter the sidecar protocol.

This contract concerns captures in their processing order. It does not recover
window changes between captures or introduce a durable event replay protocol.
The existing service still has one current activity/session stream; only metadata
hints and fallback window information are scoped by sidecar here.

## Ended sessions

`ContextTracker.endCurrentSession` is the only producer of `session_ended`.
It snapshots the nonempty session ID and app list before clearing either,
persists the app list and end timestamp together, and returns a frozen event,
frozen payload and frozen app array. Closing again returns null. The event keeps
the C2 v1 wire shape; older null identities remain decodable but unattributed.
App/window changes and returns after the existing five-minute capture gap use
this same close operation before creating a new session. The closing timestamp
is bounded by the latest observation accepted into that session (including its
start), then used for both the event and stored end time. Late captures and a
skewed clock at shutdown cannot shorten observed work or produce a negative
duration. Source capture timestamps and processing order remain unchanged;
each new session starts its own bound.

The service delivers the end event before asynchronous capture enrichment, so
later suggestion or vision failures cannot discard it. A listener failure does
not prevent summary inference. Summary work uses the ended ID and a copied app
list, suppresses concurrent work for that ID in this service, and skips a summary
already stored in the database. Completed summaries survive service recreation;
failed attempts release the in-flight claim. A later stored summary is not
overwritten by a delayed result. These are activity summaries, not verified goal
outcomes or changes to goal scores.

The native `idle_detected` event means an unchanged window, not confirmed user
absence. Repeated idle hints do not close sessions or create summaries. A later
capture may cross the existing capture-gap boundary and close once. Shutdown
also emits one final snapshot but does not start new model work.

This does not add a durable event queue or guarantee exactly-once model calls
across process crashes or multiple service processes. Existing session persistence
remains best effort if the database is unavailable during close.

## Verification

`bun test src/awareness/capture-transitions.test.ts` exercises serialized sidecar
payloads through the public service handler and real database/suggestion paths.
It covers both explicit-event arrival orders, duplicates, real return transitions,
native/legacy identity, stale/future/conflicting/cross-sidecar and partial hints,
title-only changes, session identity and an image fetch delayed across another
capture. No live screen capture or hosted LLM call is used.
`bun test src/awareness/session-end.test.ts` covers immutable snapshots, same-app
idle returns, repeated closes and idle messages, callback mutation/failure,
failed enrichment, shutdown, concurrent/completed summary replay, and delayed
captures/clock skew preserving session durations and summary eligibility. The tests
use serialized sidecar events, real session rows and a synthetic summarizer.
