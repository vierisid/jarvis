/**
 * The saved accounts a meeting preparation step names, by input field: the
 * provider piece each must belong to and its label in the editor. A leaf
 * module with no imports, shared by the runtime, the binding pins and the UI.
 */
export const MEETING_ACCOUNTS = {
  calendarConnection: '@activepieces/piece-google-calendar',
  gmailConnection: '@activepieces/piece-gmail',
  hubspotConnection: '@activepieces/piece-hubspot',
} as const;
export type MeetingAccountField = keyof typeof MEETING_ACCOUNTS;
export const MEETING_ACCOUNT_LABELS: Record<MeetingAccountField, string> = {
  calendarConnection: 'Google Calendar',
  gmailConnection: 'Gmail',
  hubspotConnection: 'HubSpot',
};
/** Jarvis manages no HubSpot account: why a jarvis: id is refused as the HubSpot account, in readiness and at run time. */
export const MANAGED_HUBSPOT_REFUSAL = 'Select a saved HubSpot account; a Jarvis-managed connection cannot read HubSpot';
/** The jarvis-context piece names a meeting preparation step may carry, exactly. */
export const MEETING_STEP_PIECES: readonly string[] = ['@jarvispieces/piece-jarvis-context', 'jarvis-context'];
/**
 * Whether a flow node is a meeting preparation step: a PIECE action node of
 * the exact jarvis-context piece running meeting_briefs. A CODE node or a
 * trigger carrying the same settings is not one, and neither is a piece whose
 * name merely ends in jarvis-context.
 */
export function isMeetingBriefsStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return typeof s.pieceName === 'string' && MEETING_STEP_PIECES.includes(s.pieceName)
    && s.actionName === 'meeting_briefs' && s.triggerName === undefined;
}
/** Fields, providers and labels in display order. */
export const MEETING_ACCOUNT_FIELDS = (Object.keys(MEETING_ACCOUNTS) as MeetingAccountField[])
  .map(field => [field, MEETING_ACCOUNTS[field], MEETING_ACCOUNT_LABELS[field]] as const);
