import type { JobKind } from './opportunity-types.ts';

/** Bounded outcome vocabulary, not a semantic model or a promise of business impact. */
export const GOAL_CONTRIBUTIONS: Record<JobKind, { outcome: RegExp; contribution: string }> = {
  invoice_review: {
    outcome: /\b(?:(?:reduce|clear|collect|recover|review) (?:the |all |our )?(?:unpaid |overdue |outstanding )invoices?|improve cash collection)\b/i,
    contribution: 'Reviewed invoice reminders could help collect outstanding balances',
  },
  lead_followup: {
    outcome: /\b(?:(?:contact|follow up with) (?:qualified |sales )?(?:leads|prospects)|(?:increase|improve) (?:qualified leads|lead conversion|prospect responses))\b/i,
    contribution: 'Reviewed follow-up drafts could help reach leads awaiting contact',
  },
  recurring_report: {
    outcome: /\b(?:produce|prepare|deliver|publish) (?:an? |the )?(?:accurate |checked )?(?:daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?reports?\b/i,
    contribution: 'A source-checked report draft could support the required reporting cadence',
  },
  meeting_followup: {
    outcome: /\b(?:assign owners to (?:meeting )?actions|(?:close|track|complete) meeting action items|(?:prepare|deliver) meeting follow-ups)\b/i,
    contribution: 'A reviewed action list could clarify owners and next steps from meetings',
  },
  expense_reconciliation: {
    outcome: /\b(?:reconcile (?:business )?expenses|match receipts to transactions|reduce unmatched (?:expenses|transactions))\b/i,
    contribution: 'A reviewed reconciliation could identify receipts and unmatched expenses',
  },
  support_triage: {
    outcome: /\b(?:reduce (?:the )?(?:support )?ticket backlog|improve support response time|reply to customer requests)\b/i,
    contribution: 'Prioritized requests and reviewed replies could help address the support queue',
  },
};
