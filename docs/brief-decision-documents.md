# Safe decision documents and Keep draft (F-14)

F-14 adds typed editing and durable deferral to supported workflow permission decisions. Saving a document creates a new pending approval for its exact parameters. Old approval IDs expire and stale queue revisions conflict. Approving grants permission; it is not proof that an email was sent, an event was created, or a result was verified. Keep draft retires permission and retains the document without running it. Reject denies permission and the workflow resumes only to record a blocked effect.

## Activation and ownership

The PR is stacked on corrected F-13 (`d7e1bde053cc905fb5b02406da021c9f8a290cfb`) as requested. Compile dependencies are F-01 and F-12; enable after F-12. Set `JARVIS_BRIEF_DECISIONS=1` and `JARVIS_BRIEF_DECISION_EDITS=1` in a disposable integrated daemon and restart. Check `GET /api/brief/capabilities`: `decisionEdits` must be supported, ready and enabled. Both flags default off. No production flag was changed.

F-14 owns the typed adapter, revision/receipt routes and engine parameter handoff. D-07/D-08 own Today document presentation and confirmation. The approval/Authority policy, cancellation and workflow execution owners remain in place. Unsupported tools retain their existing read-only review and approval controls. There is no generic argument editor, auto-approval on save, or new provider-side draft creation action.

The schema is additive and installed even when the feature flag is off. Saved drafts must still be honored by the approval scheduler. The engine cache hash includes the document protocol source, and re-vendoring reapplies the authorization/handoff patch before execution-context conversion.

## Supported documents

| Adapter | Editable fields | Restrictions and read-only fields |
| --- | --- | --- |
| Gmail `send_email` / `gmail_send_email` | To, CC, BCC, subject, body | Explicit `plain_text`; no nonempty attachments, reply-to, reply thread or custom sender; `draft` absent or false. Auth stays in the engine. |
| Google Calendar `create_google_calendar_event` / `google_calendar_create_event` | Title, description, start, end, attendees, location | Explicit valid start/end with timezone, end after start. Calendar ID, notification policy, Meet and guest permissions remain fixed. |

Email subject/calendar title/location are limited to 512 characters, body/description to 16,000, each address list to 25 entries of at most 254 characters. Unknown fields, control/framing delimiters, malformed addresses and invalid dates are refused. Rich/opaque or oversized source documents stay read-only. Reads return text for display, never executable HTML. UI adapters must render it as text.

The protocol carries the complete supported input, without auth, instead of the existing 512-character preview. The daemon validates it again. On resume it matches the original invocation digest, checks Authority/cancellation/target, claims the current document generation and returns the approved typed document. The engine validates and applies only those fields to the processed input before constructing the compatible action context. A pre-protocol engine cannot match an edited document's invocation digest. The piece's own retry semantics are unchanged: an authorized step retry receives the same approved document and may repeat its outbound call. F-14 does not promise exactly-once external delivery.

Existing approvals created without this protocol are not upgraded into editable documents. Enabled enrollment applies to new supported workflow approval requests, before notification delivery yields.

## API and recovery

All routes live inside the existing authenticated daemon session boundary and return `Cache-Control: no-store`. The document endpoint is `/api/brief/decisions/:id/document`, where `id` is the stable F-12 decision ID, URL-encoded.

- `GET` returns `{decision, editable, document, generation, state, actions, reason, options}`. Use `decision.revision` as the concurrency token. `options` contains the fixed Calendar facts.
- `POST` accepts `{requestId, revision, action, document?}`. Only `save` accepts/requires `document`; send the complete typed document. The other actions are `approve`, `keep_draft`, `reopen` and `reject`. Bodies are bounded to 128,000 bytes.
- `GET ?requestId=ID` returns `{receipt}` or `{receipt:null}` for a lost response. Repeating the exact POST returns its original receipt. Reusing an ID with a different command returns `request_conflict`.

An email document is `{kind:"email",to:[...],cc:[...],bcc:[...],subject,body}`. A Calendar document is `{kind:"calendar",title,description,start,end,attendees:[...],location}`. No tool name, credentials, target object, flow identity, execution arguments or permission level is accepted.

Receipts contain request/decision IDs, outcome, current approval ID at that action, generation, revision, timestamp and `executed:false`. Outcomes are `revision_saved`, `permission_granted`, `deferred`, `reopened` and `rejected`. Document view states `permission_granted` and `dispatch_authorized` also stay distinct from an external completion receipt. A historical receipt does not claim that its revision is still current. After receipt recovery, fetch the document again and reconcile its current state before showing controls.

Saving or reopening preserves the original decision identity, creation time and queue placement while creating a fresh pending approval. Revision history and prior approvals are retained. Historical approval aliases also resolve to the stable decision, including when recovering a lost edit response. No day boundary hides a deferred or expired draft. Keep draft remains retrievable in F-12 with `state:"deferred"` and inspect-only legacy queue controls. Open its F-14 document to resume review. Repeated deferral is harmless. An expired or deferred document must be reopened or saved to obtain a new approval before approval is possible.

A new approval, an edit, a rejection or a legacy approval changes the revision. Concurrent stale writes return 409. Editing is unavailable once permission was granted, execution was claimed, the run is terminal/canceled, or its waitpoint was resumed. The write transaction and receipt are committed together, before notifications. Socket failures do not erase a saved outcome.

## D-08 integration

1. Fetch the document from the canonical decision ID. Render only `document` and the explicit read-only `options`. Unsupported/read-only states retain the existing review view.
2. Use the server's `actions` list and revision. Do not make a local change into permission. Save first, then show the returned new pending revision for approval.
3. Persist each request ID and exact command until the server receipt is recovered. Do not advance a stack or clear a draft on a lost response.
4. Treat `permission_granted` as permission, `deferred` as retained work and `rejected` as rejection. Never show “sent”, “done” or goal progress from these outcomes.
5. Refresh the current document/queue after every result or conflict. Stable decision identity and placement survive edits. Other legacy approval views must refresh their expired old approval IDs; approving those IDs fails at the canonical writer.
6. Kept drafts remain in the queue for retrieval. Presentation may move past one only after correlating its persisted receipt; do not erase it or treat it as completed work.

This delivery changes backend and engine behavior. It does not activate or modify the visible Today UI; there is no UI screenshot to present.

## Q-05 and main integration

Q-05 PR #778 pins connections/computer and recipient facts. Its `fact-bindings.ts` module is loaded through a fixed optional owner seam at boot. When present, edits capture facts for new addresses and preserve the original fact IDs for unchanged addresses. Stale/deleted facts cannot be evaded by a body-only edit. Missing or incompatible owner exports disable document readiness rather than drop binding validation. An already-bound record cannot be edited without the adapter.

Preserve Q-05's `bindings`, `revalidate` and `revalidateOnReplay` additions when resolving the overlapping effect-boundary/service-backends edits. F-14 replaces only `bindings.facts` during revision creation; other binding fields remain intact. Q-05 must continue checking those recorded facts and connection/computer bindings before dispatch and replay. The actual Q-05 fact module at `b523efb76c5cd71df3daa6272b65138991790fc4` was tested in a temporary overlay and removed; its source is not copied into this PR. This is a fact-owner compatibility check, not a claim that the full unmerged F/Q stack was integrated.

Pinned roadmap source A15 matches F-13 and reviewed main. A13 matches F-13; main at `538179e3a91edfaa435698cac94bc4ca41e6c873` additionally bounds approval labels. Preserve that main fix when integrating. F-14 does not include unrelated main changes. F-13's corrected CI tests and Docker checks passed before F-14 delivery.

## Testing and rollback

From this worktree in WSL:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-14
bun test src/brief/decision-documents.test.ts src/daemon/api-brief-decision-documents.test.ts
```

Expect 25 passing tests and one Q-05 skip on the independent F stack. Tests use temporary databases, a real workflow Authority boundary, the engine authorization helper and an authenticated Unix-socket API. Outbound provider calls are represented by the processed input handed to a piece; no email or calendar event is sent. Coverage includes recipients/body/dates, old IDs/revisions, two competing processes, deferral/expiry/restart, rejected workflow resumption, lost responses, bounds, secrets, work/queue identity and notification failures. The Q-05 case skips on the independent F stack and was also run with its real optional source.

The affected command, fresh test/type-check output, engine build, unsafe-mutation evidence and delivery receipt live in `docs/brief-delivery/`. The real engine bundle build checks vendor resolution and cache invalidation; it does not contact Gmail or Calendar.

Rollback the feature by unsetting `JARVIS_BRIEF_DECISION_EDITS` on the new runtime and restarting. Retain the additive document/revision/receipt tables and expired old approvals. Re-enable to resume review. Do not roll back the engine/daemon protocol while edited or deferred work is pending: an older binary cannot provide the new recovery behavior. All PRs remain unmerged. F-15 has not started.
