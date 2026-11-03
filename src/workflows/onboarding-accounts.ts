/**
 * The native customer onboarding step and the saved accounts it names, by input
 * field: the provider piece each must belong to and its label in the editor.
 * A leaf module with no imports, shared by the runtime, the binding pins, the
 * readiness rule and the UI.
 */
export const ONBOARDING_PIECE = '@jarvispieces/piece-jarvis-onboarding';
export const ONBOARDING_ACTION = 'create_resources';
export const ONBOARDING_ACCOUNTS = { clickupConnection: '@activepieces/piece-clickup', driveConnection: '@activepieces/piece-google-drive' } as const;
export type OnboardingAccountField = keyof typeof ONBOARDING_ACCOUNTS;
export const ONBOARDING_ACCOUNT_LABELS: Record<OnboardingAccountField, string> = { clickupConnection: 'ClickUp', driveConnection: 'Google Drive' };
/** Fields, providers and labels in display order. */
export const ONBOARDING_ACCOUNT_FIELDS = (Object.keys(ONBOARDING_ACCOUNTS) as OnboardingAccountField[])
  .map(field => [field, ONBOARDING_ACCOUNTS[field], ONBOARDING_ACCOUNT_LABELS[field]] as const);
/** The jarvis-onboarding piece names an onboarding step may carry, exactly. */
export const ONBOARDING_STEP_PIECES: readonly string[] = [ONBOARDING_PIECE, 'jarvis-onboarding'];
/** One rule for every check (pins, readiness, safeguards), as for the sales step: any spelling of the onboarding piece is
 * the onboarding step. Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isOnboardingStep(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && ONBOARDING_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === ONBOARDING_ACTION;
}
/**
 * Whether a flow node is a customer onboarding step: a PIECE action node of the
 * exact jarvis-onboarding piece running create_resources. A CODE node or a
 * trigger carrying the same settings is not one.
 */
export function isCustomerOnboardingStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isOnboardingStep(s) && s.triggerName === undefined;
}
