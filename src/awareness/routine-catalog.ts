import type { JobKind } from './opportunity-types.ts';

export const ROUTINE_POLICY = 'routine-cues-v2' as const;
export type RoutineStage = 'source' | 'operation' | 'output';
export type RoutineDefinition = {
  kind: JobKind; cue: string; title: string; proposedOutcome: string; question: string;
  source: RegExp; operation: RegExp; output: RegExp;
  // Keep goal matching at the existing, explicitly unconfirmed text-overlap seam.
  goalPattern?: RegExp;
  labels: Record<RoutineStage, string>;
};

/** Bounded interpretation of screen text, never evidence of execution or permission. */
export const ROUTINES: readonly RoutineDefinition[] = [
  {
    kind: 'invoice_review', cue: 'unpaid or overdue invoices',
    title: 'Review invoices needing follow-up',
    proposedOutcome: 'A checked list of unpaid invoices and draft follow-ups for approval.',
    question: 'Is reviewing unpaid invoices a recurring job, and what output would help?',
    source: /\b(?:(?:unpaid|overdue|outstanding) invoices?|invoices? (?:overdue|unpaid|outstanding)|fatture (?:scadute|non pagate))\b/i,
    operation: /\b(?:checking payment status|reconciling balances|verifica pagamenti|controllo saldi)\b/i,
    output: /\b(?:invoice follow-up draft|draft invoice reminders|bozza (?:sollecito|promemoria) fatture)\b/i,
    goalPattern: /\b(?:(?:unpaid|overdue|outstanding) invoices?|invoices? (?:overdue|unpaid|outstanding))\b/i,
    labels: { source: 'invoice balances', operation: 'checking balances or payments', output: 'invoice reminder draft' },
  },
  {
    kind: 'lead_followup', cue: 'lead or prospect follow-up',
    title: 'Prepare lead follow-ups',
    proposedOutcome: 'A checked list of leads due for follow-up and drafts for approval.',
    question: 'Is following up with leads a recurring job, and what output would help?',
    source: /\b(?:(?:lead|prospect)s? (?:follow[ -]?up|outreach)|(?:follow[ -]?up|outreach) (?:for |with )?(?:lead|prospect)s?)\b/i,
    operation: /\b(?:reviewing last contact|checking contact history)\b/i,
    output: /\b(?:(?:lead|prospect) (?:follow[ -]?up|outreach) (?:email )?draft)\b/i,
    goalPattern: /\b(?:(?:lead|prospect)s? (?:follow[ -]?up|outreach)|(?:follow[ -]?up|outreach) (?:for |with )?(?:lead|prospect)s?)\b/i,
    labels: { source: 'lead or prospect list', operation: 'reviewing contact history', output: 'follow-up draft' },
  },
  {
    kind: 'recurring_report', cue: 'daily, weekly or monthly report',
    title: 'Prepare a recurring report',
    proposedOutcome: 'A draft report with source references and figures checked before sharing.',
    question: 'Do you prepare this report repeatedly, and which sources and checks does it need?',
    source: /\b(?:daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?report\b/i,
    operation: /\b(?:comparing figures|validating totals)\b/i,
    output: /\b(?:daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?report (?:draft|preview)\b/i,
    goalPattern: /\b(?:daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?report\b/i,
    labels: { source: 'recurring report inputs', operation: 'checking report figures', output: 'report draft or preview' },
  },
  {
    kind: 'meeting_followup', cue: 'meeting notes and follow-up actions',
    title: 'Prepare meeting follow-ups',
    proposedOutcome: 'A draft action list with source references and owners for approval.',
    question: 'Is turning meeting notes into follow-ups a recurring job, and which output would help?',
    source: /\b(?:meeting notes|call transcript|note riunione|trascrizione riunione)\b/i,
    operation: /\b(?:extracting action items|assigning owners|estrazione azioni|assegnazione responsabili)\b/i,
    output: /\b(?:meeting (?:action list|follow-up) draft|bozza (?:azioni|riepilogo) riunione)\b/i,
    labels: { source: 'meeting notes or transcript', operation: 'extracting actions or owners', output: 'meeting follow-up draft' },
  },
  {
    kind: 'expense_reconciliation', cue: 'expense receipts and reconciliation',
    title: 'Prepare expense reconciliation',
    proposedOutcome: 'A draft reconciliation with receipt references and unmatched items for approval.',
    question: 'Is matching expenses to receipts a recurring job, and which checks would help?',
    source: /\b(?:expense receipts|bank transactions)\b/i,
    operation: /\b(?:matching transactions|reconciling receipts)\b/i,
    output: /\bexpense (?:reconciliation|summary) draft\b/i,
    labels: { source: 'receipts or transactions', operation: 'matching receipts and transactions', output: 'expense reconciliation draft' },
  },
  {
    kind: 'support_triage', cue: 'support requests and reply drafts',
    title: 'Prepare support triage',
    proposedOutcome: 'A prioritized request list and draft replies for approval.',
    question: 'Is triaging support requests a recurring job, and which output would help?',
    source: /\b(?:support tickets|customer requests)\b/i,
    operation: /\b(?:categorizing requests|prioritizing tickets)\b/i,
    output: /\b(?:support reply drafts|ticket response draft)\b/i,
    labels: { source: 'support request queue', operation: 'categorizing or prioritizing requests', output: 'support reply draft' },
  },
];
