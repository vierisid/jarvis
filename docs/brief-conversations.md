# Persistent conversation lifecycle, F-02

F-02 gives Brief an explicit conversation repository. Creating a conversation
always allocates a new identity; it does not reuse the channel's four-hour chat.
Titles, tab visibility, order and the selected tab survive restart. Messages stay
in the existing conversation message table. Closing a tab changes metadata only.

This is a backend change. It provides the history query and reopen operation for a
future compact history view. It does not add that view, switch the existing chat
transport to a selected conversation, cancel work, or implement parallel model
streams. Those integrations belong to the later D/F chat tasks.

## Quick verification

In WSL, run:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-02
/home/vierisid/.bun/bin/bun test src/vault/conversation-lifecycle.test.ts src/vault/conversation-schema.test.ts src/daemon/api-brief-conversations.test.ts
```

Expected: 18 passing tests. They use temporary SQLite files, memory databases and
private Unix sockets. They create two conversations with different histories,
close/reopen one and restart storage, then verify identities, messages, titles,
order and selection. They also cover migration and old-writer compatibility,
authentication, workspace isolation, equal-timestamp pagination, stale renames,
bounded inputs, unsupported providers and disabled writes. No live daemon, user
database, model, account or shared TCP port is used.

The ordinary dashboard still uses its existing channel chat. There is no F-02 UI
change to screenshot.

## Capability and workspace

Daemon startup explicitly registers the `conversations` provider. Its capability
is supported and ready after vault initialization, but **disabled by default**.
Set `JARVIS_BRIEF_CONVERSATIONS=1` in an intentionally configured development
daemon's startup environment to enable these lifecycle routes. Restart to change
the flag. Other spellings do not opt in; visual shell flags do not enable it.
All later chat capabilities remain unsupported, including `chatTransport`.

The brain serves one authenticated owner. Its default workspace ID is generated
once and stored in the vault. The provider binds that server-owned workspace;
request bodies and query parameters cannot select another workspace. Internal
repositories can bind a different trusted workspace for integration, and every
operation checks its conversation ownership. This is not a new multi-tenant
authorization system. Panel-session authentication remains the outer gate,
including its existing setup-only insecure-open-access exception.

Old conversation rows with a null workspace belong only to the default workspace.
The migration adds their tab metadata as closed history. The legacy channel
adapter does the same for new legacy conversations. Explicit Brief conversations
have no channel, so they never replace the chat restored by an old websocket
client. Legacy list/message routes also exclude foreign workspace records.
Unknown or foreign IDs now receive 404 on the legacy per-conversation message
route, instead of an ambiguous empty result for an unknown ID.

## HTTP contract

All routes are under `/api/brief/conversations`, require the existing panel
session, and return `Cache-Control: no-store`.

| Method and suffix | Input | Result |
| --- | --- | --- |
| GET `/` | `limit`, `cursor`, optional `closed=true` | Page of conversation references, including closed history by default |
| POST `/` | `{ "title": "Optional title" }` or `{}` | 201; a new open, selected conversation |
| GET `/:id` | ID | Conversation reference |
| PATCH `/:id` | `{ "title": "New title", "revision": "1" }` | Renamed reference; optional revision rejects stale edits with 409 |
| GET `/tabs` | None | Workspace ID, selected conversation ID, metadata revision and open tabs in order |
| PUT `/tabs` | `{ "order": ["id-b", "id-a"] }` | Reordered tab state; must include every open tab exactly once |
| PUT `/active` | `{ "conversationId": "id-a" }` or null ID | Selected-tab metadata; an ID must belong to an open tab |
| PATCH `/:id/tab` | `{ "open": false }` or true | Close/reopen metadata; never deletes history or touches generation |
| GET `/:id/messages` | `limit`, `cursor` | Page of existing stored message records |

The collection routes use the exact path without a trailing slash. Error results:
400 invalid input/cursor, 401 unauthenticated, 404 unknown/foreign ID, 409 stale
rename/closed selection/open-tab limit, 413 body too large, 501 absent provider,
503 disabled/unavailable provider. Provider exceptions are not serialized.
There is no delete or send-message route in F-02.

Titles are trimmed, contain 1-160 UTF-16 code units and exclude control characters.
Writes accept at most 16 KiB of actual body bytes, including chunked requests.
Pages contain 1-100 records, default 50. At most 50 tabs can be open in a workspace.
Closing preserves a tab's slot. Reordering open tabs uses their existing slots,
so a closed tab returns to the same slot. Closing the active tab selects the first
remaining open tab, or null. Reopening preserves the current selection unless
none is selected. These changes do not select or cancel a running model turn.

History is paginated by creation time and ID descending, so message activity does
not move conversations across history pages. Tabs have their separate saved order.
Message pages select the newest records and present each page in ascending
`(created_at, id)` order. `nextCursor` reads the preceding page; null means no more
records. Cursor payloads are versioned and bound to workspace, collection/filter
or conversation ID. A timestamp alone never breaks a tie.

Message records retain the existing `id`, `conversation_id`, `role`, `content`,
`tool_calls` and `created_at` shape. F-02 does not invent turn/request/event IDs for
old messages. F-03 owns scoped transport and those later persistence decisions.
Conversation revisions cover lifecycle metadata, not message-stream positions.

## Manual API check

In an authenticated development dashboard running this branch with the opt-in
environment variable, the browser console can create and close a fixture chat:

```js
const base = '/api/brief/conversations';
const created = await fetch(base, {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Lifecycle check' }),
});
const chat = await created.json(); // 201 and a stable conversationId
await fetch(`${base}/${chat.conversationId}/tab`, {
  method: 'PATCH', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: false }),
});
console.log(await (await fetch(`${base}?closed=true`, { credentials: 'same-origin' })).json());
```

The closed chat remains in history. PATCH the same tab with `open: true` to reopen
it. Restarting the development daemon preserves it. With the flag absent, writes
return 503 with `reason: disabled`; old API callers with no provider get 501.

## Migration, rollback and evidence

The migration adds nullable `conversations.workspace_id`, three metadata tables
and two ordinary indexes. It keeps existing messages and conversation fields.
Old inserts remain valid; old-writer rows created during rollback acquire closed
tab metadata on the next upgraded startup. Existing titles/order are preserved.
The new schema source participates in the repository's migration guard.

Disable the environment flag to roll back activation. Retain the additive tables,
IDs and history. Reverting the binary leaves legacy channel selection operational;
it does not make that older binary understand explicit Brief chat selection.
Do not drop tables, replay work or delete user conversations as rollback.

Task receipt: `docs/brief-delivery/F-02.json`. Figma reference:
[chat lifecycle, node 81:212](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis-Brief-Working-design?node-id=81-212).
Merge prerequisite F-01 is supplied by the approved shared `brief/foundations`
base. No F-03 transport or F-04 client-state implementation is included.
