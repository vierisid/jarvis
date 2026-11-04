/** Public setup metadata only. Credential access and action permissions stay in their own sources. */
export const HOSTED_CONNECTION_PROVIDERS = {
  clickup: 'ClickUp', slack: 'Slack', trello: 'Trello', mailchimp: 'Mailchimp', github: 'GitHub',
  dropbox: 'Dropbox', asana: 'Asana', intercom: 'Intercom', typeform: 'Typeform', airtable: 'Airtable',
  notion: 'Notion', calendly: 'Calendly', linear: 'Linear', todoist: 'Todoist', monday: 'monday.com', wrike: 'Wrike',
  figma: 'Figma',
} as const;
export type HostedConnectionProvider = keyof typeof HOSTED_CONNECTION_PROVIDERS;
export type ConnectionProvider = HostedConnectionProvider | 'google';
export const CONNECTION_PROVIDER_NAMES = { google: 'Google', ...HOSTED_CONNECTION_PROVIDERS } as const;
export function isHostedConnectionProvider(value: string): value is HostedConnectionProvider {
  return Object.hasOwn(HOSTED_CONNECTION_PROVIDERS, value);
}
export function isConnectionProvider(value: string): value is ConnectionProvider {
  return Object.hasOwn(CONNECTION_PROVIDER_NAMES, value);
}
/**
 * The hosted connection that replaces manual setup for a workflow piece. Google pieces are
 * deliberately absent: the Jarvis Google grant is read-only Gmail and Calendar, so it cannot
 * stand in for a Drive, Sheets or write-capable credential and manual setup must stay reachable.
 */
export function connectionProviderForPiece(pieceName: string): HostedConnectionProvider | null {
  for (const id of Object.keys(HOSTED_CONNECTION_PROVIDERS) as HostedConnectionProvider[]) {
    if (pieceName === `@activepieces/piece-${id}`) return id;
  }
  return null;
}
