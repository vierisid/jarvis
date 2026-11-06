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

/** The two independent resources a customer onboarding creates. */
export type ResourceBranch = 'clickup' | 'drive';

/**
 * The resource a person found after checking an unknown branch (#1243): the ID
 * or the link of exactly the kind this step creates. A ClickUp task link
 * (https://app.clickup.com/t/<id>) or a Google Drive folder link
 * (https://drive.google.com/drive/folders/<id>, also under /u/<n>/, with any
 * query); anything else is refused rather than guessed.
 */
export function onboardingResource(branch: ResourceBranch, reference: unknown): { id: string; url: string } {
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 2048) throw Error('Give the ID or link of the created resource');
  const value = reference.trim(), idPattern = /^[\w-]{1,256}$/;
  let id: string | undefined;
  if (idPattern.test(value)) id = value;
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw Error(`Give the ${branch === 'clickup' ? 'ClickUp task' : 'Drive folder'} ID or its link`); }
    const match = url.protocol === 'https:' && !url.username && !url.password && !url.port && (branch === 'clickup'
      ? url.hostname === 'app.clickup.com' && /^\/t\/([\w-]{1,256})\/?$/.exec(url.pathname)
      : url.hostname === 'drive.google.com' && /^\/drive\/(?:u\/\d{1,2}\/)?folders\/([\w-]{1,256})\/?$/.exec(url.pathname));
    if (!match) throw Error(branch === 'clickup' ? 'Give the ClickUp task ID or its https://app.clickup.com/t/ link' : 'Give the Drive folder ID or its https://drive.google.com/drive/folders/ link');
    id = match[1]!;
  }
  return { id, url: branch === 'clickup' ? `https://app.clickup.com/t/${id}` : `https://drive.google.com/drive/folders/${id}` };
}
