# Awareness activity to Goals

The daemon sends the complete awareness envelope to
`recordGoalAwarenessActivity`. `src/awareness/activity-events.ts` defines the
payload fields once for both producer types and runtime decoding. The tracker
emits `schemaVersion: 1` on the two events consumed by Goals.

| Event | Required data | Matching input |
| --- | --- | --- |
| `context_changed` | `fromApp`, `toApp`, `fromWindow`, `toWindow` (strings) | Destination app and window only |
| `session_ended` | `sessionId` (string or legacy null), `apps` (string array) | Apps, only when session identity is nonempty |

Both envelopes require a finite, nonnegative numeric timestamp. Unversioned
producer envelopes with those same fields normalize to v1. Unknown versions,
malformed payloads, unrelated event types and bare payload objects are ignored.
Extra summary/OCR/body fields are not searched. Departed windows do not count as current activity.

Matching still uses the existing keyword heuristic and active-goal threshold.
A match is a possible activity association, not proof that work was completed.
The stored `auto_detected` note identifies the app, event type, observed timestamp
and matching terms. It keeps the current score as both before/after and changes
no goal status, health, hours or score. Review evidence classifies the note as
activity and refuses to use it alone to justify a score increase.

The existing 30-minute per-goal suppression reads persisted activity records,
regardless of newer manual notes. It survives a database reopen. It is a throttle,
not an exactly-once event ledger across arbitrary replay or multiple writers.
No database migration or new dependency is required.

## Verification

`src/goals/awareness-bridge.test.ts` serializes actual
`ContextTracker.processCapture` output before passing it through the same bridge
entry point as the daemon. The older goal integration tests also use tracker
output instead of separately invented input fields. Coverage includes destination
attribution, inactive/unrelated goals, invalid payloads/versions, unversioned
compatibility, durable throttling and the activity-versus-outcome boundary.

`src/goals/awareness-capture.integration.test.ts` exercises native serialized
sidecar captures through `AwarenessService.handleSidecarEvent` and the goal
bridge. It covers explicit hints arriving before/after a capture and a real
ended-session event. It checks one attributed note, native app identity,
unchanged goal fields and no verified outcome. These tests use synthetic screen
payloads and no hosted model or live desktop.

```bash
bun test src/goals src/awareness src/sidecar/event-types.test.ts src/workflows/runtime/event-types.test.ts
bunx tsc --noEmit
```
