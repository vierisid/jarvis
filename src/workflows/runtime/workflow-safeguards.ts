import { walkFlowNodes } from '../db/flow-graph';
import { tracksPieceCompletion } from './piece-effects';
import { isHubspotContact } from './hubspot-contact';
/** Evidence of the installed runtime contract, not a claim a saved graph has run. */
export function workflowSafeguards(trigger: unknown) {
  const safeguards: Array<{node:string;kind:string;coverage:string;limits:string}> = [];
  for (const node of walkFlowNodes(trigger as any)) {
    const s = node.settings ?? {};
    const input = s.input && typeof s.input === 'object' && !Array.isArray(s.input) ? s.input : {};
    const add=(kind:string,coverage:string,limits:string)=>safeguards.push({node:node.name,kind,coverage,limits});
    if (s.pieceName === 'webhook' && 'submission_id_field' in input && 'submission_email_field' in input)
      add('submission-admission','Persistent atomic admission by submission ID per workflow; whitespace/email normalization and validation.', 'Requires configured payload paths. Distinct submission IDs are distinct submissions. Failed accepted submissions require review.');
    if (s.pieceName === '@activepieces/piece-gmail' && s.triggerName === 'new_attachment')
      add('attachment-admission','Persistent atomic admission by actual attachment-byte hash per workflow, across deliveries, manual runs, restart and history cleanup.', 'Requires owned stored file and message ID. Different PDF bytes are different attachments, even if invoice number matches.');
    if (tracksPieceCompletion(s.pieceName,s.actionName))
      add('effect-receipt','Durable dispatch claim and completion receipt; completed step replay reuses result; uncertain dispatch stops.', 'No cross-provider transaction or eventual completion guarantee. Scope is one run/step unless another identity safeguard applies.');
    if (isHubspotContact(s.pieceName,s.actionName))
      add('hubspot-contact-identity','Qualified 0.12.1 daemon adapter: normalized email, durable coordination by project/saved connection/email; provider unique-email PATCH/create/conflict handling; partial properties preserved; uncertain replies read back before confirmation.', 'Requires saved native HubSpot OAuth connection. Unconfirmed writes fence that contact for review; other connections/external writers rely on provider email uniqueness. Different people/emails are distinct identities.');
    if (String(s.pieceName).endsWith('jarvis-notify') && s.actionName === 'notify')
      add('notification-identity', input.idempotencyKey ? 'Persistent once-per-workflow idempotencyKey claim across runs, versions and branches; completed duplicates suppressed.' : 'Run/step receipts only; no cross-submission notification identity is configured.', 'Key must identify the business event, e.g. qualified-contact:{{upsert.id}}. Unknown delivery is never automatically repeated; no eventual delivery guarantee.');
  }
  return { basis:'Installed runtime contracts; not a functional test of this draft', safeguards };
}
