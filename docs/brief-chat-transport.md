# F-03: Conversation-scoped chat transport

F-03 adds an opt-in backend protocol for independent chat turns. It is stacked on
F-02.1 (`brief/f-02-1`, `1a130247`), which supplies the canonical conversation
repository and its CORS correction. Keep the dependency PRs and this PR unmerged
until the staged integration is approved.

Before this change, dashboard chat used shared primary-agent history and broadcast
stream events. The new protocol loads history for an explicit conversation,
persists its turn and output, delivers events only to subscribers, and cancels an
exact conversation/turn/request tuple. Existing dashboard clients retain the
legacy protocol. There is no new screen or client cutover in this PR.

## Activation

Both startup settings must equal `1`:

```sh
JARVIS_BRIEF_CONVERSATIONS=1
JARVIS_BRIEF_CHAT_TRANSPORT=1
```

The authenticated `/api/brief/capabilities` response must report `conversations`
and `chatTransport` enabled. The latter also requires an initialized vault and a
running agent that is not draining. Missing registration is unsupported; disabled
or unavailable providers refuse new sends without writing a user message. A
previously admitted client can still cancel while the agent drains.

Neither setting has been enabled on a user daemon. Use the fixtures below to
verify behavior without a model account, paid requests or live user data.

## Protocol for the future client

All frames use the existing authenticated `/ws` connection and outer shape
`{ type, payload, id?, timestamp }`. The server owns workspace identity. Clients
cannot select it. Conversation IDs must refer to an existing owned conversation
created or adopted by F-02. IDs accept 1–128 ASCII letters, digits, `_` or `-`.

| Client type | Payload |
| --- | --- |
| `brief_chat_send` | `{ conversationId, turnId, requestId, text, speak?: boolean }` |
| `brief_chat_cancel` | `{ conversationId, turnId, requestId }` |
| `brief_chat_subscribe` | `{ conversationId, afterSequence?: number }` |
| `brief_chat_unsubscribe` | `{ conversationId }` |

Allocate new turn and request UUIDs once per intentional send. Retry an uncertain
send with the **same IDs, text and speech setting**. Exact retries return an ack
with `duplicate: true` and the existing state, without executing again. Changed
input under the same IDs is a conflict. Subscribe to reconcile uncertain output;
a duplicate ack does not rebroadcast historical deltas.

`brief_chat_send` subscribes that socket to the conversation. Explicitly
unsubscribe when a tab should stop receiving events; subscribing to another
conversation does not implicitly unsubscribe an earlier one. A connection may
subscribe to at most 50 conversations. Opting in keeps it outside legacy chat
mirroring until it disconnects, even after unsubscribing from all conversations.
Use a fresh connection to return to legacy mode. Do not mix legacy chat/voice
commands with the scoped protocol on an opted-in connection.

| Server type | Meaning |
| --- | --- |
| `brief_chat_ack` | Accepted/reconciled IDs, durable state and current conversation sequence; unsubscribe acknowledges the conversation only |
| `brief_chat_event` | `BriefChatEvent`: conversation/turn/request IDs, stable `eventId`, sequence and typed payload |
| `brief_chat_sync` | Current messages and turn metadata, ordered event replay page and cursors |
| `brief_chat_audio` | Conversation/turn/request IDs, sequence and `phase: start/chunk/end`; chunks have base64 `data`, end has `cancelled` |
| `brief_chat_error` | Pre-admission rejection with valid supplied routing IDs, safe code and message |

Event payloads cover the canonical user message, assistant text deltas, queued
and running state, generic progress, canonical approval ID/status, and one terminal
state (`completed`, `cancelled`, or `failed`). Accepted failures are durable
terminal events with a safe error object. Rejected requests do not create a turn
or consume an event sequence. Never render raw model errors, tool arguments or
hidden reasoning as progress.

The server assigns increasing sequences **per conversation**, including transient
audio. Gaps are valid. Do not require contiguous numbers. Event IDs and sequence
cursors allow idempotent replay; receiving an event again is not another terminal
transition. Ignore already-applied durable event IDs.

## Reconnect and persistence

Disconnecting removes subscriptions but leaves accepted work running. On reconnect,
subscribe with the last durable event cursor. A sync response contains:

- `sequence`: current conversation high-water mark.
- `events`: up to 500 events, with a roughly 1 MiB payload budget (at least one
  event if any remain).
- `nextSequence`, `hasMore`, `subscribed`: keep subscribing from `nextSequence`
  while `hasMore` is true. Live subscription starts with the final replay page so
  unread replay cannot be overtaken by new events on that socket.
- `messages`: the latest ten canonical messages and the F-02 older-history cursor.
- `turns`: the latest 50 turns with IDs, states, message IDs and creation times.
  User input is not duplicated in this metadata.

Messages are the authoritative snapshot **as of `sequence`**. Replace/reconcile
local rows by canonical message ID. Do not append replay deltas at or below that
snapshot sequence to those same snapshot messages again. Alternatively, replay
events against a prior local snapshot from its saved cursor. The client must
choose one consistent reconciliation approach. Use the F-02 history endpoint for
older message pages; no UI implementation is included here.

Acceptance atomically stores the turn, one canonical user message, and initial
events. Each text chunk updates one canonical assistant row and records its delta
in the same SQLite transaction. A cancelled/failed response retains partial text.
Subsequent history contains only that conversation's user and assistant messages.

Restart marks interrupted queued/running turns failed exactly once, retains their
messages and approval associations, and never automatically retries effects.
Cancelling an already terminal turn acknowledges its original state. It cannot
cancel a newer turn. Closing a tab through F-02 does not delete or cancel a turn.

## Execution and compatibility

Production uses the existing resource limiter with concurrency **one** for scoped
generations, at most 32 pending turns, and one pending turn per conversation.
Cancelled queued work is removed from the limiter immediately, including its
retained input and controller; it does not wait for the active turn to finish.
Interleaved tests inject concurrency two to prove routing and context isolation;
this does not enable concurrent production generation. Classic mode receives
explicit history and a conversation-specific tool exposure ledger. Router mode
receives explicit history, a conversation compaction key and scoped task context.
Neither path repurposes shared primary-agent history for scoped turns.

Cancellation reaches model calls and the current delegated task. It checks before
tool dispatch and rejects late stream/audio chunks. Effects already performed are
not undone; outstanding canonical approvals retain their IDs and are resolved by
the existing authority API. Approval updates use their persisted originating turn,
independent of whichever tab is currently active.
Specialist `delegate_task` calls inherit the turn's abort signal through execution
scope and pass it to their model provider. A cancelled specialist releases the
generation slot even when the provider ignores the signal; late results are fenced.

Speech is opt-in per send, requires an available TTS provider at admission, and is
sent only to the originating socket while subscribed. Audio uses the existing
provider's encoded bytes, carried as base64 JSON; it is not binary broadcast.
Synthesis starts after the full text response, so this first version has more
speech latency than the legacy sentence pipeline. Audio is never persisted or
replayed. Cancel emits an immediate audio end; a provider may take time to release
its iterator, but its late chunks are discarded. Reconnecting does not resume audio.
Unsubscribing, disconnecting or pausing live delivery to catch up replay permanently
ends that turn's audio delivery. An active stream receives its end frame before
unsubscription. Returning to the conversation resumes text/events only; audio never
restarts midway or starts later for a turn whose speech delivery was ended.

Legacy clients keep their existing stream/status shapes and mirroring. Their text,
progress and thinking/cancellation events exclude opted-in sockets. General system
notifications remain outside this chat protocol. Attachments, draft/unread UI,
legacy voice input migration and proactive-speech policy belong to later cards.

## Verification

From this branch in WSL:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-03
/home/vierisid/.bun/bin/bun test \
  src/vault/chat-turns.test.ts \
  src/brief/chat-transport.test.ts \
  src/daemon/agent-service-conversation.test.ts \
  src/daemon/ws-service-conversation.test.ts \
  src/actions/execution-scope.test.ts \
  src/util/concurrency.test.ts
```

Expected: **30 passed, 0 failed**. These use isolated SQLite databases, a real
authenticated WebSocket listener on a dynamically allocated fixture port, and fake
model/TTS providers. They cover interleaving, tab switching, one-turn cancellation,
delayed audio, duplicate sends, stale cancellation, disk restart, reconnect,
ownership, queue limits, approval identity, both model paths and legacy mirroring.
Review regressions additionally cover actual specialist cancellation, speech
subscription changes, 64 queued cancellations, nested signals and limiter handoff.
No visible UI changed, so no screenshot is applicable.

The review-fix affected run passed 843 tests with one platform skip, including
workflow cancellation/authority and specialist paths. TypeScript passed. The four
new transport/delegation regression cases first failed against the reviewed head
and now pass. Commands and results are in
`brief-delivery/evidence/F-03/review-fixes.json`; the original checks remain in
`brief-delivery/evidence/F-03/`. Three unsafe
mutations failed the routing, history-isolation and terminal-idempotency tests;
the restored implementation passes. These results do not certify real hosted
model quality or live microphone playback.

## Integration and rollback

Initial main check: `2d2d6f34831897ae14a77f84022e4c7938fec6f3`. Refreshed main:
`98ad1e70884b665008e1255ee15aa79c82e23dca`. PR #716 merged during implementation;
its approval label helpers are separate from these routing edits. The actual base
remains F-02.1, following the owner's instruction to stage unmerged dependencies.
Rebase/retarget the stack after the foundation merges, preserving main's label
changes and rerunning the affected checks.

To roll back, unset `JARVIS_BRIEF_CHAT_TRANSPORT` and restart. Keep all additive
tables, event IDs and canonical history. Old code can still write legacy messages.
Do not drop tables, clear messages or replay accepted effects. New clients should
respect the capability response and reopen a legacy connection when falling back.

See `brief-delivery/F-03.json` for the exact receipt and evidence paths.
