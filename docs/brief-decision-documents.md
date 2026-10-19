# Safe decision documents and Keep draft (F-14)

F-14 adds typed editing and durable deferral to supported workflow permission decisions. Saving a document creates a new pending approval for its exact parameters. Old approval IDs expire and stale queue revisions conflict. Approving grants permission; it is not proof that an email was sent, an event was created, or a result was verified. Keep draft retires permission and retains the document without running it. Reject denies permission and the workflow resumes only to record a blocked effect.

## Activation and ownership

F-14 builds on the F-12 decision queue. Set `JARVIS_BRIEF_DECISIONS=1` and `JARVIS_BRIEF_DECISION_EDITS=1` and restart. Check `GET /api/brief/capabilities`: `decisionEdits` must be supported, ready and enabled. Both flags default off.

F-14 owns the typed adapter, revision/receipt routes and engine parameter handoff. D-07/D-08 own Today document presentation and confirmation. The approval/Authority policy, cancellation and workflow execution owners remain in place: approving or rejecting a pending document goes through the same decision path as every other surface (`applyApprovalDecision`), decided as a dashboard click, so Pause holds the approval and Kill refuses it with a 409 `held` (Q-08), and the decision is audited and broadcast. Saving a revision and rejecting a kept draft are audited as clicks too. Unsupported tools retain their existing read-only review and approval controls. There is no generic argument editor, auto-approval on save, or new provider-side draft creation action.

The schema is additive and installed even when the feature flag is off. Saved drafts must still be honored by the approval scheduler. The engine cache hash includes the document protocol source. The engine half lives in the vendored `piece-executor.ts` gate, which `piece-executor-gate.drift.test.ts` pins (re-apply it after a re-vendor, as for the rest of the gate).

## Supported documents

| Adapter | Editable fields | Restrictions and read-only fields |
| --- | --- | --- |
| Gmail `send_email` / `gmail_send_email` | To, CC, BCC, subject, body | Explicit `plain_text`; no nonempty attachments, reply-to, reply thread or custom sender; `draft` absent or false. Auth stays in the engine. |
| Google Calendar `create_google_calendar_event` / `google_calendar_create_event` | Title, description, start, end, attendees, location | Explicit valid start/end with timezone, end after start. Calendar ID, notification policy, Meet and guest permissions remain fixed. |

Email subject/calendar title/location are limited to 512 characters, body/description to 16,000, each address list to 25 entries of at most 254 characters. Unknown fields, control/framing delimiters, malformed addresses and invalid dates are refused. Rich/opaque or oversized source documents stay read-only. Reads return text for display, never executable HTML. UI adapters must render it as text.

The engine sends the complete supported input, without auth, alongside the bounded preview's Q-08 input digest. The daemon validates it again. A new record becomes an editable document only when `JARVIS_BRIEF_DECISION_EDITS` is on and no text spells a content-framing delimiter that `defangDelimiters` would rewrite (#634); otherwise it is recorded exactly as without F-14, as the bounded and defanged preview, and stays read-only. A save whose text spells such a delimiter is refused. On resume the daemon matches the original invocation digest, checks Authority/cancellation/target and recipient facts, claims the current document generation and returns the approved typed document. The engine validates and applies only those fields to the processed input, which is the action context's `propsValue`, before the action runs. An engine that does not send the document protocol cannot match a document's invocation digest. Retry semantics are unchanged: a tracked send (Q-07, Gmail) stays `dispatching` until its completion receipt and a retry before it is refused; an untracked action's retry receives the same approved document and may repeat its outbound call.

A recorded effect keeps the protocol it was recorded under, whatever the flag says now. Existing approvals created without the protocol are not upgraded into editable documents: their bounded record is matched as before, so pending approvals and recorded retries survive an upgrade with either flag setting, and changed targets remain refused. A document record stays a document after the flag is turned off, so its pending revision still resumes. Enrollment applies to new supported workflow approval requests, before notification delivery yields.

Calendar read-only options show effective provider defaults: omitted guest-invite and guest-visibility permissions are true, while guest modification and Meet creation are false. Explicit false values remain false. The original request is preserved; review does not silently change permissions. These defaults follow [Google Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

The engine overlays approved editable fields into both execution input and its already-censored run input. Stored progress and compressed execution-state backups therefore show the actual approved recipients, content and dates. Credential redaction and unrelated options remain intact.

## API and recovery

All routes live inside the existing authenticated daemon session boundary and return `Cache-Control: no-store`. The document endpoint is `/api/brief/decisions/:id/document`, where `id` is the stable F-12 decision ID, URL-encoded.

- `GET` returns `{decision, editable, document, generation, state, actions, reason, options}`. Use `decision.revision` as the concurrency token. `options` contains the fixed Calendar facts.
- `POST` accepts `{requestId, revision, action, document?}`. Only `save` accepts/requires `document`; send the complete typed document. The other actions are `approve`, `keep_draft`, `reopen` and `reject`. Bodies are bounded to 128,000 bytes.
- `GET ?requestId=ID` returns `{receipt}` or `{receipt:null}` for a lost response. Repeating the exact POST returns its original receipt. Reusing an ID with a different command returns `request_conflict`.

An email document is `{kind:"email",to:[...],cc:[...],bcc:[...],subject,body}`. A Calendar document is `{kind:"calendar",title,description,start,end,attendees:[...],location}`. No tool name, credentials, target object, flow identity, execution arguments or permission level is accepted.

Receipts contain request/decision IDs, outcome, current approval ID at that action, generation, revision, timestamp and `executed:false`. Outcomes are `revision_saved`, `permission_granted`, `deferred`, `reopened` and `rejected`. Document view states `permission_granted` and `dispatch_authorized` also stay distinct from an external completion receipt. A historical receipt does not claim that its revision is still current. After receipt recovery, fetch the document again and reconcile its current state before showing controls.

Saving or reopening preserves the original decision identity, creation time and queue placement while creating a fresh pending approval. Revision history and prior approvals are retained. Historical approval aliases also resolve to the stable decision, including when recovering a lost edit response. No day boundary hides a deferred or expired draft. Keep draft remains retrievable in F-12 with `state:"deferred"` and inspect-only legacy queue controls. Open its F-14 document to resume review. Repeated deferral is harmless. An expired or deferred document must be reopened or saved to obtain a new approval before approval is possible.

A new approval, an edit, a rejection or a legacy approval changes the revision. Concurrent stale writes return 409. Editing is unavailable once permission was granted, execution was claimed, the run is terminal/canceled, or its waitpoint was resumed. Save, reopen, Keep draft and rejecting a kept draft commit their write and receipt together, before notifications, so socket failures do not erase a saved outcome. Approving or rejecting a pending review is checked against the revision in the shared decision path's write transaction and its receipt is written right after; if that response is lost before the receipt, reload the document, which shows the decided state.

## D-08 integration

1. Fetch the document from the canonical decision ID. Render only `document` and the explicit read-only `options`. Unsupported/read-only states retain the existing review view.
2. Use the server's `actions` list and revision. Do not make a local change into permission. Save first, then show the returned new pending revision for approval.
3. Persist each request ID and exact command until the server receipt is recovered. Do not advance a stack or clear a draft on a lost response.
4. Treat `permission_granted` as permission, `deferred` as retained work and `rejected` as rejection. Never show “sent”, “done” or goal progress from these outcomes.
5. Refresh the current document/queue after every result or conflict. Stable decision identity and placement survive edits. Other legacy approval views must refresh their expired old approval IDs; approving those IDs fails at the canonical writer.
6. Kept drafts remain in the queue for retrieval. Presentation may move past one only after correlating its persisted receipt; do not erase it or treat it as completed work.

This delivery changes backend and engine behavior. It does not activate or modify the visible Today UI; there is no UI screenshot to present.

## Q-05 recipient facts

When a revision changes recipients, the daemon captures Q-05 facts for the new addresses (`fact-bindings.ts`) and keeps the original fact IDs for unchanged addresses, so a stale or deleted fact cannot be evaded by a body-only edit. F-14 replaces only `bindings.facts`; other binding fields remain, and Q-05 keeps checking the recorded facts before approval, dispatch and replay.

The queue only shows documents whose effect is in its own project; a document of another project is neither shown nor editable through it.

## Testing and rollback

```sh
bun test src/brief/decision-documents.test.ts src/daemon/api-brief-decision-documents.test.ts src/workflows/runtime/decision-document-engine.test.ts
```

Tests use temporary databases, a real workflow Authority boundary, the engine authorization helper and the authenticated API routes. Two real-engine cases load synthetic Gmail/Calendar actions, pause for review, resume after edits, and compare executed parameters with persisted run input and the compressed backup; no email or calendar event is sent. Coverage includes recipients/body/dates, old IDs/revisions, two competing processes, deferral/expiry/restart, rejected workflow resumption, lost responses, bounds, secrets, Pause/Kill, audit, delimiters, project scope, work/queue identity, notification failures and Q-05 facts, plus upgrades of pre-protocol approvals with edits on and off.

Rollback the feature by unsetting `JARVIS_BRIEF_DECISION_EDITS` on the new runtime and restarting. Retain the additive document/revision/receipt tables and expired old approvals. Re-enable to resume review. Do not roll back the engine/daemon protocol while edited or deferred work is pending: an older binary cannot provide the new recovery behavior.
