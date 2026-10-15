# Confirmed interview profile writes (ON-B-05)

`interview-profile.v1` is an optional internal provider, default-off and with no
startup effects, route or production registration. Its manifest has no provider
dependencies. The existing canonical profile and interviewer remain authoritative.

## Host binding

Inject `createStagedInterviewer({ llmForScope })` as B04's interviewer and
`createInterviewProfileProvider({ enabled: true, store })` as its profile port.
`createCanonicalInterviewProfileStore({ owner, database })` adapts the existing
single-owner vault. The owner and database must come from authenticated server
configuration. It rejects another scope or a database different from the one the
canonical writer uses. It never opens a database or creates a table.

The model adapter runs the current interviewer prompt, themes, tool loop and turn
cap on a cloned checkpoint. It stages facts and wrap, propagates cancellation,
and leaves acknowledged counts unchanged. Malformed fact calls are rejected before
the legacy handler can filter their entries, including mixed batches and a wrap
in the same response. Theme/text validation also runs before B04 checkpoints the
turn, so retry can regenerate it without publishing partial facts or completion.
The two additive shared service changes form the **staged-interview compatibility patch**: an exported
pure preparation path and the canonical writer's opt-in `deferCompletion` option.
Existing `runInterviewTurn` and one-argument profile writes retain their behavior.

B11 alone owns daemon/API registration, live authorization, eligibility, journey
acknowledgement and session retention/Forget binding. Supply those before enabling
the new interview. There is no client-accessible fact/wrap endpoint. B04 supplies
its current lease/auth guard and abort signal on every commit. Construction and
manifest discovery alone do not make the new journey available.

## Persistence and acknowledgement

All requested facts, wrap and a versioned receipt commit in **one synchronous
SQLite transaction** in the canonical vault. A failure at any point rolls back
that attempt; earlier successful turns remain saved. Wrap happens only after
required fact writes and read-back succeed. A normal fact save leaves a new
profile's `completed_at` null. Existing completion and wizard answers are retained.

Facts use the writer's case-insensitive `(theme, summary)` identity, with a scoped
opaque ID. Input is trimmed, themes use the existing nine-value vocabulary, and
batches are bounded to 128 facts, 120 characters per summary and 4,000 per quote.
Duplicates already in the canonical profile are acknowledged without rewriting
their timestamp/quote. B04 unions confirmed IDs, so retransmission and duplicate
facts do not increase its saved count. No placeholder is added for an unknown or
skipped topic. Empty early wrap is allowed and saves no invented facts.

Receipts in `settings` use `onboarding-next.interview-profile.v1.<hash>` keys and
contain only a request digest and opaque confirmed IDs. A stable B04 `attemptId`
reconciles the same receipt after lost acknowledgement or process restart. Reusing
it with different session/turn/request/facts/wrap conflicts. Receipts never replay
effects. If a previously acknowledged fact or completion has since disappeared,
replay fails with `profile_changed` instead of restoring old profile content.
Corrupt/future profile and receipt records remain intact and fail closed.

The canonical interview writer is append/deduplicate, not semantic replacement.
A different summary (including a model-extracted correction) is a different
canonical entry; this adapter neither guesses which earlier statement to delete
nor overwrites structured wizard corrections. Explicit correction/Forget retains
its existing owner. Before activation, B11 must fence/remove pending session work
when Forget runs and coordinate receipt/session retention. Receipt replay checks
alone cannot certify a complete Forget lifecycle.

The store port requires atomic synchronous canonical writes. An asynchronous or
remote writer cannot satisfy it. There is no exactly-once model inference claim:
a crash before preparation is saved may repeat inference, while committed effects
and their durable receipt cannot be separated.

## Verification and rollback

Run the safe fixture command:

```sh
bun test src/onboarding-next/interview-profile
```

The session integration fixture (when B04 is physically present) uses its real
session provider, the current interviewer with a scripted model, a temporary
SQLite vault and the real profile writer. The quick-check case injects a failure
after the final fact write, verifies an error with no completed profile, reopens
the database and retries to one saved fact and one completion without inference.
Other cases cover loss of acknowledgement, skip races, duplicate/corrected input,
unknown routines, invalid facts, corruption and cancellation. Scripted responses
prove protocol/persistence behavior, not model extraction quality or resistance
to every prompt injection. Only profile tools are available; discussed goals,
tools and approval preferences create no goals, connections, workflows or rules.

Omit/disable this provider to retain the legacy path. Preserve canonical profile,
session and receipt records; no destructive rollback migration is needed.
Production wiring, real-model evaluation and combined release approval remain
separate prerequisites. No model evaluation, external account or live-user write
is performed by these tests.
