/**
 * The native weekly report step and the saved accounts it names, by input
 * field: the provider piece each must belong to and its label in the editor.
 * A leaf module with no imports, shared by the runtime, the binding pins, the
 * readiness rule and the UI.
 */
export const REPORT_PIECE = '@jarvispieces/piece-jarvis-report';
export const REPORT_ACTION = 'weekly_operating_report';
export const REPORT_ACCOUNTS = {
  stripeConnection: '@activepieces/piece-stripe',
  hubspotConnection: '@activepieces/piece-hubspot',
  googleConnection: '@activepieces/piece-google-docs',
} as const;
export type ReportAccountField = keyof typeof REPORT_ACCOUNTS;
export const REPORT_ACCOUNT_LABELS: Record<ReportAccountField, string> = { stripeConnection: 'Stripe', hubspotConnection: 'HubSpot', googleConnection: 'Google Docs' };
/** Fields, providers and labels in display order. */
export const REPORT_ACCOUNT_FIELDS = (Object.keys(REPORT_ACCOUNTS) as ReportAccountField[])
  .map(field => [field, REPORT_ACCOUNTS[field], REPORT_ACCOUNT_LABELS[field]] as const);
/**
 * No managed-connection exemption covers the weekly report: every account it
 * names must be a saved account, refused in readiness and at run time.
 */
export function managedReportRefusal(field: ReportAccountField): string {
  return `Select a saved ${REPORT_ACCOUNT_LABELS[field]} account; a Jarvis-managed connection cannot be used by the weekly report`;
}
/** The jarvis-report piece names a weekly report step may carry, exactly. */
export const REPORT_STEP_PIECES: readonly string[] = [REPORT_PIECE, 'jarvis-report'];
/** One rule for every check (pins, readiness, safeguards), as for the sales step: any spelling of the report piece is the
 * report step. Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isReportStep(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && REPORT_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === REPORT_ACTION;
}
/**
 * Whether a flow node is a weekly report step: a PIECE action node of the
 * exact jarvis-report piece running weekly_operating_report. A CODE node or a
 * trigger carrying the same settings is not one.
 */
export function isWeeklyReportStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isReportStep(s) && s.triggerName === undefined;
}
