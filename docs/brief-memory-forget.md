# F19: Forget a canonical memory

Forget removes one selected fact and its evidence from the canonical vault. It preserves content-free history and durable suppression so replaying the same automatic source cannot silently recreate that assertion. It adds an authenticated backend operation; the D track still owns its visible confirmation and UI.

`brief/f-19` is stacked on reviewed F18 `5f83f7876a9bd1ff84e57aa4e00966eb5dc04cb1`, targeting `brief/f-18`, as requested by the owner. Main initially inspected: `485bb9b3b70f4d3874798810efc6f06355f86ef6`; final recheck: `16c5eec08d5d3e4250b100b584005561fcfded61`, with no new changes to the vault, Brief, AgentService or WS paths. The pinned audit is `69211511c95355776c6c319c01e1df5acd3b8f1e`. The facts and extraction sources are unchanged across the audit, main and F18. Open F/D/Q work was inspected before starting; no other F19 PR existed. The roadmap reference is Figma file `eNfKeirIKLZLlZEasrurZa`, node `382:4043`. No screenshot or visible UI change is claimed.

## Scope and confirmation contract

With the existing panel session, read `GET /api/brief/memory/<fact-id>/forget`. A live fact returns:

```json
{ "state": "ready", "factId": "canonical-fact-id", "revision": "64-character-source-digest", "scope": {} }
```

The actual `scope` describes deletion, suppression and retained sources. Present these limits with the fact already selected by the user. Cancel locally by sending nothing. GET has no side effect. On confirmation, send `POST` to the same URL:

```json
{ "requestId": "client-generated-unique-id", "expectedRevision": "the-exact-GET-revision", "confirmed": true }
```

The atomic result is `state: forgotten`, `replayed: false`, and a receipt containing only fact ID, request ID, original revision digest, time, suppression-key count and scope. A retry with the same identity returns the original receipt and `replayed: true`. GET after deletion also recovers the receipt. A different request ID for an already-forgotten fact recovers that same original receipt; the alias request ID is not reserved. Reusing a recorded request ID for a different fact or revision is a 409 conflict. These are local confirmation semantics, not a separate Authority approval or an Undo promise.

A correction, verification, changed provenance, or changed subject name between prepare and confirm returns 409 `revision_conflict`; no replacement is deleted. Correcting the already-forgotten ID also returns 409 and requires a refresh. Missing GET targets return 404. Bad IDs, unknown query fields, invalid UTF-8/JSON, extra command fields or absent/false confirmation return 400. Bodies above 2 KiB return 413. Missing or mismatched registered provider returns 501, disabled/unavailable/capacity-exhausted provider returns 503. All these route results have `Cache-Control: no-store` and use existing panel authentication. There is no unauthenticated writer.

The transaction deletes the chosen fact and its evidence, records its tombstone and suppression keys, and reconciles surviving peer facts. A storage failure rolls everything back. Existing recall queries and stream revisions read the canonical database, so deletion invalidates fresh retrieval and old pagination cursors. F17 detail reads return a content-free forgotten state (410); F18 retained events keep their IDs and stages with `factState: forgotten`. The existing retention policy still governs those events.

## Re-ingestion and pending context

Suppression uses HMAC-SHA256 with a random database-local key over the normalized assertion and automatic source revision. It stores no subject name, predicate, value, quote, document URL or prompt. It covers the existing automatic writers: conversation extraction, goal-completion extraction, and profile synchronization. Model confidence or quote-selection changes cannot defeat conversation suppression.

New canonical Brief extraction includes the accepted turn identity. Replaying that turn remains suppressed; a later user turn can explicitly restate identical words. Compatibility checks also recognize the older text-pair source digest, using the canonical turn acceptance time to distinguish old replay from new input. Legacy callers without a turn identity still use the exact input-pair digest. New explicit dashboard input and user correction can create a new fact without removing the original tombstone.

Older migrated facts sometimes have no recoverable source revision. Their normalized assertion is conservatively blocked from that automatic writer. An explicit later canonical Brief turn or manual input can introduce it anew. Profile source revisions are recovered from matching current settings where possible. Goal completion identities remain scoped to their completion episode, so another episode is independent.

Profile settings are retained as editable source data. The matching original answer field is withheld from future profile prompts until changed, including when a forgotten alias was derived from part of that field. An unrelated profile save cannot recreate the forgotten projection. Other independently stored assertions, even with overlapping text, remain intact; this is deletion of a chosen fact, not semantic erasure of every copy of a statement.

Canonical Brief and governed workflow contexts, legacy AgentService chat/image paths, and the voice intent classifier check captured memory/profile sources immediately before model-provider handoff. Async streams retain that capture after preparation returns. If Forget invalidates a prepared context, the handoff fails and the next turn rebuilds context. This fence remains active with F18 usage logging off and does not manufacture usage records for legacy channels.

Original messages, dialogue summaries, documents, interview facts, entity identities, relationships, other assertions, backups and SQLite free pages are outside this operation. They may still contain the same words. Already-sent provider context cannot be recalled. Existing realtime sessions or arbitrary tools holding source text are not scrubbed. There is no external file deletion, credential/account deletion, secure database-file erasure or global model unlearning.

## Activation, bounds and rollback

`JARVIS_BRIEF_MEMORY_FORGET=1` enables new Forget requests and the `memoryForget` capability. It is off by default and requires no F18 activation. The daemon registers and routes the same concrete provider. When F17 is separately enabled with its own dependencies, it advertises `canForget` only when its Forget provider is ready.

Tombstones do not expire: expiry would permit resurrection. New requests fail without deleting anything at 10,000 receipts, 100,000 suppression keys, or above 1,000 evidence rows for one fact. Receipts are not silently evicted. The additive schema is initialized transactionally; reopening preserves both the random key and suppression.

Rollback of activation means unsetting `JARVIS_BRIEF_MEMORY_FORGET` and restarting. Existing tombstones and ingestion/handoff suppression remain enforced; the flag only stops new Forget actions. Do not downgrade the writer to a pre-F19 binary after using Forget without retaining these suppression checks. An older writer ignores the additive tombstone tables and could recreate forgotten facts. This operation has no automatic restoration or destructive schema rollback.

## Verify without touching real memories

In WSL:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-19
bun test src/brief/memory-forget.test.ts src/daemon/api-brief-memory-forget.test.ts src/daemon/agent-service-forget.test.ts
```

The tests create isolated SQLite vaults and scripted in-process model providers. They cover deletion/restart/re-extraction, legacy provenance, repeated requests, correction conflicts, rollback, capacity, retained usage history, profile synchronization, new user input, real AgentService dispatch and an authenticated Unix-socket HTTP server. No live model or user memory is needed. Final counts and commands are recorded in `docs/brief-delivery/F-19.json` and its evidence directory. F20 is not started.
