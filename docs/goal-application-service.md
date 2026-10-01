# Goal application writes and recovery (C9)

Dashboard writes previously changed Vault rows without the events, immediate health
recalculation or completion memory provided by chat's GoalService. All production
goal writers now use `getGoalApplication()` for the current Vault connection.
`GoalService` retains scheduling and delegates mutations to that application service.
Proposal confirmation reuses the C5 validation from PR #599.

## Write contract

- API create/edit/delete/reorder, chat tools, proposal confirmation, checked Today
  results, awareness activity and daily rhythms share the application boundary.
- C5 validates proposal structure, hierarchy, deadlines and timezone semantics.
  Score, status and health commands also validate runtime values. Scores must be
  finite numbers from 0 to 1; public writes reject out-of-range values rather than
  silently clamping them. A manual API score accepts only source `user`.
- Score history, the new score, derived health and their events commit together.
  A checked Today result includes its progress receipt in that same transaction.
  Reorder and proposal batches either commit completely or write nothing.
- A repeated status assignment is a no-op. Terminal transitions store an immutable
  goal snapshot for completion memory. Reopening clears `completed_at`; a later
  terminal transition creates a separate historical completion record.
- Awareness remains an activity note with an unchanged score. C4 review bundles,
  rejected score proposals and check-ins persist through the application service.
  There is still no verified measurement-to-score mapping: evening reviews cannot
  change scores, even when they reference valid IDs or qualitative outcomes.
- Low-level Vault helpers remain storage primitives for tests and internal
  implementation. New application callers must use the application service.
  A surrounding SQLite transaction must use `application.transaction(...)` to
  deliver immediately after commit. Raw outer transactions still retain committed
  events for the recovery worker and never broadcast before commit.

## Durable delivery

The additive `goal_events` table records a stable UUID, ordered sequence, event
payload and optional completion snapshot inside the mutation transaction.
An event insert failure rolls back the mutation. Delivery happens after commit;
a delivery error never turns a successful goal write into an HTTP failure.

Completion memory and the daemon's synchronous WebSocket broadcast callback have
separate acknowledgements. Completion facts, the entity identified by goal ID and
completion event ID, and the memory acknowledgement commit in one transaction.
A partial memory write rolls back and remains pending. Same-title goals and
separate completion episodes cannot overwrite each other's completion memory.
Each episode is an `event` entity named `Goal <outcome>: <title>`, so conversation
extraction and name-based fact lookups never resolve to it instead of the goal's
`concept`, and conversation extraction never attaches facts to a completion record.
The saved snapshot permits recovery even after the goal has been edited or deleted.
Tag lists retain the existing joined `goal_tags` fact when they fit the 4,000-character
fact limit. Larger accepted lists become individual `goal_tag` facts, each within
the goal validator's 512-character tag bound. This preserves all tag values and
lets pending snapshots recover without changing the goal or truncating its tags.

The daemon retries at startup, after successful application transactions and every
30 seconds, including when autonomous goal rhythms are disabled. Each pass handles
at most 100 pending records per consumer. A flush after an application transaction
only attempts completion records that have never failed; a record that failed is
retried by the 30 second worker, so it cannot slow or spam every later goal write.
Failed completion records do not starve later records. Broadcasts preserve event
order and stop at a failed callback, retrying from that event on the next flush.
Delivery diagnostics retain a bounded error in the outbox and log only event IDs.

Broadcast delivery is at least once to the daemon callback. A crash between the
callback and its acknowledgement may replay the same `eventId`; the dashboard
suppresses duplicate IDs in its recent event buffer. A successful broadcast is
not a browser acknowledgement. Current UI state still comes from its data fetches.
Durable consumers can resume from an ordered cursor with the authenticated API:

```http
GET /api/goals/events?after=0&limit=100
```

The response is `{ events, nextCursor }`. Events include `eventId`, `sequence` and
`completionMemory` (`not_required`, `pending`, or `recorded`). `after` must be a
nonnegative safe integer; `limit` is 1 through 100. Omitted values default to 0 and
100; a blank value is rejected. Save the cursor only after
processing a record, and deduplicate side effects by event ID. This endpoint is a
replay contract; it does not automatically make new external consumers idempotent.

## Rollout and limits

Schema initialization adds the outbox without changing existing rows. Previously
missed events or completion memories are not inferred or backfilled. Existing
completion facts are retained. A code rollback can leave the new table in place;
an older binary ignores it, but cannot deliver pending C9 events until upgraded
again. The worker prunes events once they are fully delivered and 180 days old,
up to 1,000 per pass. Pending broadcasts and pending completion memories are never
pruned. A replay consumer offline longer than the retention window must resync
from the goal data endpoints; sequences are never reused.

Tests exercise the real dashboard handlers and chat tool, C4/C5 integration,
checked-result rollback, SQLite failure injection, file-backed restart recovery,
independent delivery failure and replay after a lost acknowledgement. These are
local integration tests; they do not establish delivery to an offline browser.
