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
/** Fields, providers and labels in display order. */
export const MEETING_ACCOUNT_FIELDS = (Object.keys(MEETING_ACCOUNTS) as MeetingAccountField[])
  .map(field => [field, MEETING_ACCOUNTS[field], MEETING_ACCOUNT_LABELS[field]] as const);
