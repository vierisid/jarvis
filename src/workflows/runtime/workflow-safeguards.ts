import { walkFlowNodes } from '../db/flow-graph';
import { tracksPieceCompletion } from './piece-effects';
import { isHubspotContact } from './hubspot-contact';
import { isSalesStep } from './sales-followups';
/** Evidence of the installed runtime contract, not a claim a saved graph has run. */
export function workflowSafeguards(trigger: unknown) {
  const safeguards: Array<{node:string;kind:string;coverage:string;limits:string}> = [];
  for (const node of walkFlowNodes(trigger as any)) {
    const s = node.settings ?? {};
    const input = s.input && typeof s.input === 'object' && !Array.isArray(s.input) ? s.input : {};
    const add=(kind:string,coverage:string,limits:string)=>safeguards.push({node:node.name,kind,coverage,limits});
    if (isSalesStep(s)) {
      add('sales-draft-only','Fixed HubSpot reads (GET plus the open-stage deal search) and Gmail GET/draft-create endpoints; no send, browser, model tools or CRM mutations. Pipeline/inactivity property and Gmail owner checked. Complete bounded cursor pagination; more than 5000 open-stage deals fails explicitly.', 'HubSpot is the supported CRM and must be selected in setup. Inactivity means elapsed 24-hour days. Personalization uses contact, company, deal and sender names in an unsent draft; multiple associated contacts require review.');
      add('sales-daily-identity','Durable atomic per-workflow/Gmail account/normalized-contact/local-date claims and draft receipts; concurrent deliveries, retries, versions and restarts cannot re-dispatch a claimed contact that day.', 'Drafts, reply vetoes and uncertain writes consume the contact for that day, without automatic retry or eventual-delivery guarantees; a deal refused before any draft request, or whose draft Gmail definitely rejected, leaves the contact free for its other deals. Different dates are new daily processing identities.');
      add('sales-results','Exact recent inbound sender/date checks across paginated threads, fresh deal/contact recheck, per-deal failure isolation and complete result aggregation for a single downstream summary.', 'Requires explicit reply window and one associated contact. Source changes after the final recheck are not atomic with draft creation. Governance/cancellation and batch discovery failures stop the run.');
    }
    if (s.pieceName === 'webhook' && 'submission_id_field' in input && 'submission_email_field' in input)
      add('submission-admission','Persistent atomic admission by submission ID per workflow; whitespace/email normalization and validation.', 'Requires configured payload paths. Distinct submission IDs are distinct submissions. Failed accepted submissions require review.');
    if (s.pieceName === '@activepieces/piece-gmail' && s.triggerName === 'new_attachment')
      add('attachment-admission','Persistent atomic admission by actual attachment-byte hash per workflow, across deliveries, manual runs, restart and history cleanup.', 'Requires owned stored file and message ID. Different PDF bytes are different attachments, even if invoice number matches.');
    if (tracksPieceCompletion(s.pieceName,s.actionName))
      add('effect-receipt','Durable dispatch claim and completion receipt; completed step replay reuses result; uncertain dispatch stops.', 'No cross-provider transaction or eventual completion guarantee. Scope is one run/step unless another identity safeguard applies.');
    if (isHubspotContact(s.pieceName,s.actionName))
      add('hubspot-contact-identity','Qualified 0.12.1 daemon adapter: normalized email, durable coordination by project/saved connection/email; provider unique-email PATCH/create/conflict handling; partial properties preserved; uncertain replies read back before confirmation.', 'Requires saved native HubSpot OAuth connection. Unconfirmed writes fence that contact until resolved (recovery mark_done or release); other connections/external writers rely on provider email uniqueness. Different people/emails are distinct identities.');
    if (String(s.pieceName).endsWith('jarvis-context') && s.actionName === 'meeting_briefs')
      add('meeting-read-only','Fixed Calendar/Gmail GET and HubSpot contact-search endpoints only; bounded complete pagination; recurrence expansion, exact external-domain filtering and deterministic event/current-start keys. Typed setup and pinned saved accounts.', '30-day conversation window by default, configurable 1-365 days. Gmail excerpts are snippets with full-thread source links. Limits or unavailable sources fail explicitly. No browser or attendee-contact tools.');
    if (String(s.pieceName).endsWith('jarvis-notify') && input.meetingGuard)
      add('meeting-freshness','Calendar recheck after approval and before persistent dashboard dispatch claim; changed/cancelled/past events skipped without consuming the key. Key derived in code from account/calendar/event/current-start.', 'Provider edits after the final read cannot be transactional with dashboard delivery. Uncertain delivery stays fenced; no eventual-delivery guarantee.');
    if (String(s.pieceName).endsWith('jarvis-notify') && s.actionName === 'notify')
      add('notification-identity', input.idempotencyKey ? 'Persistent once-per-workflow idempotencyKey claim across runs, versions and branches; completed duplicates suppressed.' : 'Run/step receipts only; no cross-submission notification identity is configured.', 'Key must identify the business event, e.g. qualified-contact:{{upsert.id}}. Unknown delivery is never automatically repeated and holds the key until resolved (recovery mark_done or release); no eventual delivery guarantee.');
  }
  return { basis:'Installed runtime contracts; not a functional test of this draft', safeguards };
}
