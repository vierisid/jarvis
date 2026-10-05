# F-05: chat attachments

F-05 adds Document, Image and Screenshot to the existing F-04 composer adapter. It is stacked on the corrected `brief/f-04` commit `72f3078a4857e28ae6738c336f55f2988bf6f31b`. Nothing is merged or enabled on a running daemon. D-12 through D-15 still own the production host, attachment menu and presentation.

## Activation and adapter

The initialized daemon registers `chatAttachments`, default off. Local test hosts must opt into `JARVIS_BRIEF_CONVERSATIONS=1`, `JARVIS_BRIEF_CHAT_TRANSPORT=1`, `JARVIS_BRIEF_CHAT_STATE=1` and `JARVIS_BRIEF_CHAT_ATTACHMENTS=1`, and mount `BriefConversationProvider enabled`. Attachment API availability requires conversations and chatTransport; the browser adapter also requires chatState. Removing a flag does not delete stored conversations or files.

Use `thread.client.attachments` from the provider, capturing the intended conversation ID before opening a picker:

```ts
await client.attachments.upload(conversationId, 'document', selectedFile);
await client.attachments.upload(conversationId, 'image', selectedFile);
// Call only after an explicit Screenshot action and device selection/confirmation.
await client.attachments.capture(conversationId, selectedDeviceId, true);
await client.attachments.retry(conversationId, attachmentId);
await client.attachments.remove(conversationId, attachmentId);
client.send(conversationId, text); // Empty text is allowed with ready files.
```

`current.attachments` exposes uploading/ready/failed/removing and an error string. Send waits for every reference to be ready. The original file stays in this window's memory for failed-upload retry, never in localStorage. Reload verifies saved references and asks for reselection when bytes are missing. Ready references survive close/reopen with the draft; closing aborts incomplete uploads and tombstones their IDs. Uncertain sends retain the same request, turn and attachment IDs. Their attachments cannot be removed until the request is acknowledged. Acceptance clears only the submitted IDs, preserving files added subsequently, including by another window.

Accepted references are available on `current.messages[].attachments` and `thread.messages[].attachments`, including after history pagination and reconnect. The D-line can render them without a new socket or duplicated upload state. F-05 makes no visual layout change and adds no new production entry.

## Formats, bounds and lifetime

| Choice | Supported content | Limits |
| --- | --- | --- |
| Document | UTF-8 plain text, Markdown, CSV, JSON text; text-bearing PDF | 1 MiB; 128,000 extracted characters; PDF at most 40 pages |
| Image | PNG without interlacing; JPEG | 4 MiB; at most 8 million decoded pixels |
| Screenshot | The selected connected sidecar's `capture_screen` result, PNG/JPEG | Same image bounds; existing sidecar permission checks |

A turn accepts at most four files and 8 MiB total. Each workspace stores at most 64 MiB of raw attachment bytes. Content expires 24 hours after upload; reads/admission validate expiry, and the next attachment operation clears expired bytes and extracted text. This is lazy cleanup, not a promise that idle vaults erase bytes at the exact expiry second. Accepted metadata remains part of history; removed/expired IDs cannot resurrect on a late upload.

There are at most four active upload/capture HTTP requests and two decoder workers per daemon process. Workers have a five-second processing deadline; PNG dimensions and JPEG decoder memory are bounded. PDF extraction runs in a disposable worker with byte/page/text/time bounds; this is not an OS process memory sandbox. No OCR, Office document conversion, archive extraction, SVG execution, path loading, external URL fetching or automatic permission granting is added.

Text is extracted with `unpdf` (PDF), images validated with `pngjs` / `jpeg-js`, pinned in the lockfile. Worker source ships through the package's existing `src/` inclusion. This reuses the existing authenticated API and sidecar RPC, but does not overload `/api/content/:id/attachments`: those records belong to content items, not chat turns.

## Ownership and model behavior

The caller supplies an opaque stable attachment ID. The server supplies workspace identity and checks conversation ownership. Upload retries with different bytes or metadata conflict. The turn transaction checks every reference and atomically binds all of them together with the user message and queued event; any failure rolls everything back. Accepted references cannot bind to another turn. Replayed sends must contain the original attachment set and do not run the model again.

Documents and filenames are framed with the existing nonce-based untrusted-content wrapper. Images remain image blocks, preceded by source framing. The model receives content only for the accepting turn, with that conversation's history, cancellation signal and context key. Historical messages retain metadata; later turns do not automatically resend old file bytes. Attach the file again if another turn needs it. Image/file turns use the existing classic multimodal runner, preferring the conversation tier when configured and retaining its medium-tier fallback. Text-only turns keep their existing router.

Attachment turns seed the existing authority taint gate. File-suggested machine changes, outbound actions and delegation therefore require approval under the configured taint policy. No tool is executed by the decoder. Existing owner-configured authority settings continue to apply.

## HTTP and wire

All paths are under the existing authenticated panel API and return `Cache-Control: no-store`:

- `PUT /api/brief/conversations/:id/attachments/:attachmentId`: raw bytes; `Content-Type`, `X-Attachment-Kind` (`document` or `image`) and URI-encoded `X-Attachment-Name`.
- `GET` on that path returns metadata only. `DELETE` removes a pending reference and its bytes, or records a tombstone for a racing upload.
- `POST .../:attachmentId/capture`: `{ "deviceId": "selected-device", "confirm": true }`. Missing/disconnected/unsupported/permission-denied devices fail clearly. No fallback silently captures another device.
- `brief_chat_send` adds optional `attachmentIds`; accepted user-message events and history carry metadata, never bytes or extracted text.

## Quick verification

From this worktree, without a live daemon, account, model or screen capture:

```bash
bun test src/brief/attachments.test.ts src/daemon/api-brief-attachments.test.ts src/daemon/agent-service-attachments.test.ts ui/src/brief/chat/attachments.test.ts ui/src/brief/chat/integration.test.ts
```

The fixtures use isolated databases and synthetic text/PDF/pixel data. They upload in A, switch to B, retry, remove during decode, close during upload, reconnect and replay. Assertions prove one accepted binding, no cross-chat model content, authenticated routes, byte/format/expiry limits and model tool approval. Screenshot tests inject a fake RPC; they never capture a user's screen. Three unsafe mutations (omit binding, weaken retry identity, drop taint) must fail the targeted tests; sources are restored afterward.

For a D-line integration preview: select a small text file in A, switch to B and send a different message, then return to A and send. Only A should show the accepted reference and receive a file-based answer. An oversized/unsupported file should show an error, Retry should preserve its ID, and Remove should prevent a late upload from reappearing. Test Screenshot only with explicit user confirmation on a permitted sidecar; the automated recipe is sufficient without doing so.

## Rollback

Disable `JARVIS_BRIEF_CHAT_ATTACHMENTS` and the D-line attachment affordance. Keep the additive table, metadata and existing conversations; do not replay accepted turns, delete messages, drop tables or grant permissions. On an older backend, the client refuses to silently send attachments as a text-only message. F-06 is not implemented here.
