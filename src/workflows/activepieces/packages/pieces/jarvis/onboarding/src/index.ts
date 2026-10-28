import { createPiece, createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
import { postContext } from '../../context/src/lib/shared';

const resources = createAction({
  name: 'create_resources', displayName: 'Create customer task and folder independently',
  description: 'Create one ClickUp onboarding task and one Google Drive customer folder concurrently, waiting for both outcomes even if either fails. Persistent per-workflow/customer receipts survive retries, versions and restart. Completed resources are reused. Explicit provider rejections may retry on a later run; interrupted or uncertain writes require review and are never blindly repeated. Returns successful IDs/links and failure details, summary and stable notificationKey. Follow with dashboard-only Jarvis Notify. Use a stable customer identity, not a fresh delivery ID. Do not add webhook admission that suppresses legitimate partial retries. No browser or delegated agent. Supports saved OAuth2 accounts; unknown account/list/parent/payload mappings remain Setup required in disabled drafts. Live ClickUp lists requiring custom fields need configuration outside this bounded action; rejected writes are reported.',
  props: {
    customer: Property.Json({ displayName: 'Submitted customer', required: true, description: 'Wire the actual webhook payload with {{trigger}}.' }),
    customerIdPath: Property.ShortText({ displayName: 'Stable customer ID field', required: true, description: 'Dot path in the submission; the same customer must retain this identity on retries.' }),
    customerNamePath: Property.ShortText({ displayName: 'Customer name field', required: true }),
    clickupConnection: Property.ShortText({ displayName: 'ClickUp account', required: true, description: 'Select a saved OAuth2 account reference.' }),
    clickupListId: Property.ShortText({ displayName: 'Onboarding ClickUp list ID', required: true }),
    driveConnection: Property.ShortText({ displayName: 'Google Drive account', required: true, description: 'Select a saved OAuth2 account reference.' }),
    driveParentId: Property.ShortText({ displayName: 'Customer parent folder ID', required: true }),
  },
  outputSample: { outcomes: { clickup: { status: 'succeeded', id: 'example-task', url: 'https://app.clickup.com/t/example-task', detail: 'Task created' }, drive: { status: 'failed', detail: 'Request rejected' } }, summary: 'ClickUp task: succeeded. Reference...\nDrive folder: failed. Reason...', notificationKey: 'onboarding:stable-outcome-digest' },
  async run(context) { return postContext(context, '/v1/jarvis/onboarding/resources', context.propsValue, { outcomes: {}, summary: '', notificationKey: '' }); },
});
export const jarvisOnboardingPiece = createPiece({ displayName: 'Jarvis: Onboarding', description: 'Independent ClickUp and Drive resources with durable partial-retry receipts and combined outcomes.', auth: PieceAuth.None(), minimumSupportedRelease: '0.0.0', logoUrl: '', authors: ['jarvis'], actions: [resources], triggers: [] });
