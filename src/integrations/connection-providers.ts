/** Public setup metadata only. Credential access and action permissions stay in their own sources. */
export const HOSTED_CONNECTION_PROVIDERS = {
  clickup: 'ClickUp', slack: 'Slack', trello: 'Trello', mailchimp: 'Mailchimp', github: 'GitHub',
  dropbox: 'Dropbox', asana: 'Asana', intercom: 'Intercom', typeform: 'Typeform', airtable: 'Airtable',
  notion: 'Notion', calendly: 'Calendly', linear: 'Linear', todoist: 'Todoist', monday: 'monday.com',
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
export function connectionProviderForPiece(pieceName: string): ConnectionProvider | null {
  if (['gmail', 'google-calendar', 'google-drive', 'google-sheets'].some(name => pieceName === `@activepieces/piece-${name}`)) return 'google';
  for (const id of Object.keys(HOSTED_CONNECTION_PROVIDERS) as HostedConnectionProvider[]) {
    if (pieceName === `@activepieces/piece-${id}`) return id;
  }
  return null;
}
