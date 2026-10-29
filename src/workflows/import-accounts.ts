/**
 * The native contact import step and the saved accounts it names, by input
 * field: the provider piece each must belong to and its label in the editor.
 * A leaf module with no imports, shared by the runtime, the binding pins, the
 * readiness rule and the UI.
 */
export const IMPORT_PIECE = '@jarvispieces/piece-jarvis-import';
export const IMPORT_ACTION = 'resumable_contact_import';
export const IMPORT_ACCOUNTS = {
  hubspotConnection: '@activepieces/piece-hubspot',
  sourceConnection: '@activepieces/piece-http-oauth2',
} as const;
export type ImportAccountField = keyof typeof IMPORT_ACCOUNTS;
export const IMPORT_ACCOUNT_LABELS: Record<ImportAccountField, string> = { hubspotConnection: 'HubSpot', sourceConnection: 'Source API' };
/** Fields, providers and labels in display order. */
export const IMPORT_ACCOUNT_FIELDS = (Object.keys(IMPORT_ACCOUNTS) as ImportAccountField[])
  .map(field => [field, IMPORT_ACCOUNTS[field], IMPORT_ACCOUNT_LABELS[field]] as const);
/**
 * The account fields a step with this input names: the HubSpot account
 * always, the source account only when the source uses OAuth2.
 */
export function importAccountFields(input: unknown): ImportAccountField[] {
  const oauth2 = !!input && typeof input === 'object' && (input as Record<string, unknown>).sourceAuth === 'oauth2';
  return oauth2 ? ['hubspotConnection', 'sourceConnection'] : ['hubspotConnection'];
}
/**
 * No managed-connection exemption covers the contact import: every account it
 * names must be a saved account, refused in readiness and at run time.
 */
export function managedImportRefusal(field: ImportAccountField): string {
  return `Select a saved ${IMPORT_ACCOUNT_LABELS[field]} account; a Jarvis-managed connection cannot be used by the contact import`;
}
/** The jarvis-import piece names a contact import step may carry, exactly. */
export const IMPORT_STEP_PIECES: readonly string[] = [IMPORT_PIECE, 'jarvis-import'];
/** One rule for every check (pins, readiness, safeguards), as for the report step: any spelling of the import piece is the
 * import step. Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isImportStep(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && IMPORT_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === IMPORT_ACTION;
}
/**
 * Whether a flow node is a contact import step: a PIECE action node of the
 * exact jarvis-import piece running resumable_contact_import. A CODE node or
 * a trigger carrying the same settings is not one, and neither is a piece
 * whose name merely ends in jarvis-import.
 */
export function isContactImportStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isImportStep(s) && s.triggerName === undefined;
}
