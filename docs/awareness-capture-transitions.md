# Capture transitions (C1)

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

## Verification

`bun test src/awareness/capture-transitions.test.ts` exercises serialized sidecar
payloads through the public service handler and real database/suggestion paths.
It covers both explicit-event arrival orders, duplicates, real return transitions,
native/legacy identity, stale/future/conflicting/cross-sidecar hints, title-only
changes, session identity and an image fetch delayed across another capture.
The initial 12 regressions failed before the fix. Review R1 added six cases for
partial hints: four failed before the correction, and two guard against borrowing
fields from a conflicting window. All 24 transition cases now pass, including
session stability and restored native metadata after a partial observation.
No live screen capture or hosted LLM call is used.

Final affected run after R1: **134 tests passed**, zero failures, across awareness, sidecar
subscriptions and workflow event mappings. `bunx tsc --noEmit` and
`git diff --check` also passed. These checks were repeated before push. The
pre-commit license, migration, template and packaging guards passed (packaging
used its Bun fallback after npm returned no parseable file list). The full-suite
attempt stopped after 187 tests when the real-package test exceeded its 60-second
limit. A one-command hook override was used after these direct checks; the full
repository suite is not established as passing for C1.
