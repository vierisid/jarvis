/**
 * The native sales follow-up step and the saved accounts it names, by input
 * field: the provider piece each must belong to and its label in the editor.
 * A leaf module with no imports, shared by the runtime, the binding pins, the
 * credential scope rule and the UI.
 */
export const SALES_PIECE = '@jarvispieces/piece-jarvis-sales';
export const SALES_ACTION = 'draft_followups';
export const SALES_ACCOUNTS = { hubspotConnection: '@activepieces/piece-hubspot', gmailConnection: '@activepieces/piece-gmail' } as const;
export type SalesAccountField = keyof typeof SALES_ACCOUNTS;
export const SALES_ACCOUNT_LABELS: Record<SalesAccountField, string> = { hubspotConnection: 'HubSpot', gmailConnection: 'Gmail' };
/** Fields, providers and labels in display order. */
export const SALES_ACCOUNT_FIELDS = (Object.keys(SALES_ACCOUNTS) as SalesAccountField[])
  .map(field => [field, SALES_ACCOUNTS[field], SALES_ACCOUNT_LABELS[field]] as const);
/** The jarvis-sales piece names a sales follow-up step may carry, exactly. */
export const SALES_STEP_PIECES: readonly string[] = [SALES_PIECE, 'jarvis-sales'];
/** One rule for every check (pins, readiness, safeguards): any spelling of the sales piece is the sales step.
 * Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isSalesStep(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && SALES_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === SALES_ACTION;
}
/**
 * Whether a flow node is a sales follow-up step: a PIECE action node of the
 * exact jarvis-sales piece running draft_followups. A CODE node or a trigger
 * carrying the same settings is not one, and neither is a piece whose name
 * merely ends in jarvis-sales.
 */
export function isSalesFollowupsStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isSalesStep(s) && s.triggerName === undefined;
}
