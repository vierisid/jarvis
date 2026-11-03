/**
 * The native lead batch step and the saved account it names, by input field:
 * the provider piece it must belong to and its label in the editor. A leaf
 * module with no imports, shared by the runtime, the binding pins, the
 * readiness rule and the UI.
 */
export const BATCH_PIECE = '@jarvispieces/piece-jarvis-batch';
export const BATCH_ACTION = 'update_leads';
export const BATCH_FINALIZE = 'finalize_batch';
export const BATCH_ACCOUNTS = { hubspotConnection: '@activepieces/piece-hubspot' } as const;
export type BatchAccountField = keyof typeof BATCH_ACCOUNTS;
export const BATCH_ACCOUNT_LABELS: Record<BatchAccountField, string> = { hubspotConnection: 'HubSpot' };
/** Fields, providers and labels in display order. */
export const BATCH_ACCOUNT_FIELDS = (Object.keys(BATCH_ACCOUNTS) as BatchAccountField[])
  .map(field => [field, BATCH_ACCOUNTS[field], BATCH_ACCOUNT_LABELS[field]] as const);
/** The jarvis-batch piece names a lead batch step may carry, exactly. */
export const BATCH_STEP_PIECES: readonly string[] = [BATCH_PIECE, 'jarvis-batch'];
/** One rule for every check (pins, readiness, safeguards): any spelling of the batch piece is the
 * lead batch step. Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isBatchStep(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && BATCH_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === BATCH_ACTION;
}
/**
 * Whether a flow node is a lead batch step: a PIECE action node of the exact
 * jarvis-batch piece running update_leads. A CODE node or a trigger carrying
 * the same settings is not one.
 */
export function isLeadBatchStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isBatchStep(s) && s.triggerName === undefined;
}
