import { createAction, Property } from '@activepieces/pieces-framework';
import { postContext } from '../shared';

export const meetingBriefsAction = createAction({
  name: 'meeting_briefs', displayName: 'Prepare upcoming external meeting briefs',
  description: 'Read-only, fully paginated Calendar, HubSpot contact search and recent Gmail thread context. Finds timed meetings starting in (now, now+30 minutes], expands recurrence, excludes cancellations, declined owners, resources and internal-only meetings. Returns deterministic event/start identity and a guard for Jarvis Notify to recheck immediately before dashboard delivery. No model, browser or attendee-contact capability. All unknown settings can remain empty in a disabled draft.',
  props: {
    calendarConnection: Property.ShortText({ displayName: 'Google Calendar account', required: true, description: 'Select a saved Calendar account in the editor. Plain account reference, not a token.' }),
    gmailConnection: Property.ShortText({ displayName: 'Gmail account', required: true, description: 'Select a saved Gmail account in the editor. Plain account reference, not a token.' }),
    hubspotConnection: Property.ShortText({ displayName: 'HubSpot account', required: true, description: 'Select a saved HubSpot account in the editor. Plain account reference, not a token.' }),
    calendarId: Property.ShortText({ displayName: 'Calendar ID', required: true, description: 'Actual selected calendar ID, or primary if the user selects their primary calendar.' }),
    ownerEmail: Property.ShortText({ displayName: 'Your email address', required: true }),
    internalDomains: Property.ShortText({ displayName: 'Internal email domains', required: true, description: 'Comma-separated exact domains belonging to your team. Subdomains must be listed explicitly.' }),
    hubspotPortalId: Property.ShortText({ displayName: 'HubSpot portal ID', required: true, description: 'The numeric account ID from your HubSpot URL, used for source links.' }),
    recentDays: Property.Number({ displayName: 'Recent conversation window (days)', required: true, defaultValue: 30 }),
    timezone: Property.ShortText({ displayName: 'Timezone', required: false, description: 'IANA timezone for meeting times in the brief. Leave empty to use the timezone configured for Jarvis.' }),
  },
  outputSample: { complete: true, meetings: [{ eventId: 'event-occurrence-id', start: '2026-10-23T09:15:00.000Z', title: 'Meeting', brief: 'Sourced contact context and recent conversation excerpts', notificationKey: 'meeting-brief:sha256', guard: { setup: {}, eventId: 'event-occurrence-id', start: '2026-10-23T09:15:00.000Z', fingerprint: 'sha256' } }], failed: [] },
  async run(context) {
    return postContext(context, '/v1/jarvis/context/meeting-briefs', context.propsValue, { complete: false, meetings: [], failed: [] });
  },
});
