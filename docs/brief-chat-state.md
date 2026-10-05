# Conversation client state, F-04

F-04 supplies the store and React adapter for D-12 through D-15. Each conversation
has its own messages, turn state, activity, approval references, draft, attachment
references, scroll position and unread answer IDs. The ordinary dashboard and
Brief foundation entry are not switched over in this PR. There is no visual change.

## Verify it

From the dedicated WSL worktree:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-04
/home/vierisid/.bun/bin/bun test ui/src/brief/chat src/brief/registrations/chat-state.test.ts
```

The focused fixtures cover ten add/close cycles, all surviving drafts and histories,
adjacent selection, a blank last-close state, reopening, reordered/duplicate events,
delayed history, reconnect pagination, uncertain sends, workspace isolation,
storage failure, failed metadata writes and old-server fallback. React tests mount
the actual provider in StrictMode, change rooms/themes ten times, and count socket
instances. A real HTTP/WebSocket fixture uses the F-02 routes, F-03 transport,
temporary SQLite, an OS-assigned local port and a deterministic fake model. It
checks two separate histories, reconnect, reopen, reload and exactly two executions.
No live daemon, account, model, paid service or user database is used.

Expected: **35 focused tests pass**. Review regressions cover a missed answer split
across replay pages outside the latest-ten snapshot, a cached running turn outside
the latest fifty turns, history loaded before subscription, two windows sharing
storage, legacy draft recovery, and generation/restart errors. Seven cases fail
on the original F-04 commit and pass with the review fixes. See the retained
`docs/brief-delivery/evidence/F-04/review-{red,green,affected}.log` files.

## Integration contract

Mount `BriefConversationProvider` exactly once under the existing authenticated,
onboarded workspace host, above room switches and chat presentation:

```tsx
<BriefConversationProvider enabled={releaseAllowsChatState} chatVisible={chatOpen}>
  <WorkspaceRooms />
  <ConversationPanel />
</BriefConversationProvider>
```

Both children use `useBriefConversation()`. Do not also mount `useLiveThread()` or
another `useWebSocket()` in that host. The provider owns the single existing socket
hook; all consumers share context. Changing rooms, theme or chat visibility does
not reconnect it. A deliberately supplied fixture client is captured on first
mount; use a new provider host for a different authenticated workspace owner.

The adapter returns `status`, `state`, `current`, `messages`, existing v2 `items`,
`isConnected`, `isResponding`, `send`, `stopResponse`, room event feeds and `client`.
Only offer tab actions in `status.mode === 'scoped'`. Loading, unavailable and
disabled are distinct from an empty list. `legacy` uses the current single-chat
history, sender and cancellation path. The fallback is exercised through the
actual hook, not a placeholder boolean. `client.start()` retries discovery.

Operations:

- Await `client.add()`, `select(id)`, `close(id)` and `reopen(id)`. Writes are
  serialized in invocation order. Their pending count and errors are exposed in
  `status`. A failed write reconciles server metadata while retaining local drafts
  and history. Closing the selected chat chooses the right neighbor, otherwise the
  left. Closing the final tab selects null and never creates or deletes history.
- `client.store.setDraft(id, text)`, `setAttachments(id, refs)` and
  `setScroll(id, { top, atBottom })` always take an explicit ID. Restore scroll from
  `current.scroll` after the selected conversation is rendered. There is no global
  composer buffer to move accidentally between tabs.
- `client.loadOlder(id)` fills older messages by canonical ID. Loading/error/cursor
  state belongs to that same chat. Late REST pages cannot overwrite streamed rows
  or change selection. Failed history stays retryable. Scoped send/sync errors
  live in that conversation's `error`, so a late failure in A cannot become B's error.
- Terminal failures retain their safe `{ code, message }` on the affected turn.
  `current.error` exposes the latest failed turn, including after replay/restart;
  starting another send dismisses that banner without deleting the turn's error.
  Failed/cancelled partial answers carry `failed`/`cancelled` in `items`, rather
  than `done`. Presentation owners can render `item.error` or `current.error`.
- `send(text)` captures the active ID at invocation. An uncertain send retains its
  exact conversation/turn/request IDs and text for reconnect; accepted sends are
  reconciled without another execution. An unchanged matching draft clears only
  after canonical acceptance. A newly edited draft is retained. `stopResponse()`
  targets the selected chat's active or awaiting-acknowledgment turn.
- `chatVisible` combines with browser visibility to mark only the viewed chat read.
  Hidden/background chat deltas increment unread once per answer, not per chunk.
  Activity/approval transitions retain their turn identity and newest sequence.

F-05 owns attachment upload, validation, bytes and turn binding. This store accepts
only `{ attachmentId, name, size, mediaType }` references. Sending with attachments
currently rejects explicitly instead of silently omitting them. Text chat requests
use `speak: false`; voice presentation and scoped audio playback are not activated.

## Persistence and synchronization

Selection, tab visibility/order and messages remain authoritative in F-02/F-03.
Drafts, attachment references, scroll, unread IDs and read watermarks use
origin-local browser storage under `jarvis.brief.chat.v1.<server workspace ID>`.
Each changed field uses its own `.field.<conversation ID>.<field>` key, so an
unrelated scroll, read update or incoming event in another window cannot rewrite
a draft. The last actual write to the same field wins; windows do not provide
collaborative text editing. Send acceptance checks the latest saved draft before
clearing its matching local copy. Existing aggregate v1 records remain readable
as a fallback and are never rewritten or deleted by the new writer.
There is no copied transcript, file body, audio or tool output in that storage.
This is device-local composer state, not cross-device draft synchronization.
Closed conversations keep their draft and cached history; the server retains the
canonical history. Reload restores local state after the server identifies the
workspace, then fetches canonical messages. Unknown or corrupt storage is ignored;
quota errors retain in-memory state and expose `state.persistenceError`.

An open tab subscribes even when it is not selected, so background unread state
continues updating. A close unsubscribes but never cancels a turn. Reconnects
recheck capabilities and reconcile all open tabs before allowing sends. Snapshot
pages continue from `nextSequence` until `subscribed: true`. Each request is
correlated to its own sync ID; stale pages cannot reopen a closed tab. Checkpoints
advance only after a completed sync, and are kept in memory with their projection.

Snapshot messages are canonical as of `sequence`. Replay compaction advances only
to the delivered page's `nextSequence`, preserving later pages even when their
events precede the snapshot watermark. Each canonical message has its own sequence
watermark, so covered text is not appended twice while older missed messages and
terminal events still replay. Reordered live events are projected in sequence
order; gaps are valid. History-only rows are reconstructed when replay reaches
them, preserving their canonical timestamps without duplicating their full text.
History reads can fill missing rows but cannot replace newer streamed content.
Old socket handlers and asynchronous results are fenced after disconnect/unmount.

## Activation and rollback

Merge base: corrected F-03 (`brief/f-03`, `6b37f2ff`), which contains the shared
foundations and F-02/F-02.1 dependencies. D-line presentation stays on its own
branch. Latest main and open PRs were checked before implementation; this PR uses
the owner-approved staged dependency stack rather than rebasing away those cards.

The registered `chatState` capability is supported but disabled by default. Its
readiness follows the actual conversation and transport services. All three
server flags are required for explicit development activation:

```text
JARVIS_BRIEF_CONVERSATIONS=1
JARVIS_BRIEF_CHAT_TRANSPORT=1
JARVIS_BRIEF_CHAT_STATE=1
```

The provider also defaults to `enabled={false}` and is not mounted by a production
entry in F-04. Unsupported/missing/disabled capability snapshots and old 404/501
endpoints use single chat. Authentication and failed network/server reads produce
unavailable, not a fabricated empty result. Losing scoped capability replaces its
socket before legacy use because F-03 scoped opt-in is permanent for that socket.

Rollback by removing the `chatState` activation and keeping the existing dashboard
entry, or reverting this client adapter. Retain the server conversations and local
draft keys; do not delete messages, drop schema or replay model work. This PR adds
no database migration. Code merged: no. Release enabled: no. See
`docs/brief-delivery/F-04.json` for exact verification evidence and limitations.

Design reference: [conversation lifecycle, Figma node 81:212](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis-Brief-Working-design?node-id=81-212).
No tab styling or new visual affordance is included. F-05 is not started.
