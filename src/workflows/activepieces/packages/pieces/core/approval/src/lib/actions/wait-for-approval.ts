import { createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
import { request } from './jarvis-request';
export const waitForApprovalLink = createAction({ auth: PieceAuth.None(), name: 'wait_for_approval', displayName: 'Wait for Approval',
  description: 'Wait for an authenticated decision in Jarvis Needs you. Returns approved: false on rejection, cancellation or expiry and the flow continues, so branch on it. Reuses a previous Create Approval Links request in this run, or creates a standalone approval.',
  props: { requestId: Property.ShortText({ displayName: 'Approval request ID', description: 'Optional result of Create Approval Links; required if this run has multiple link requests.', required: false }),
    prompt: Property.LongText({ displayName: 'Proposal to review', required: false }) },
  errorHandlingOptions: { continueOnFailure: { hide: true }, retryOnFailure: { hide: true } }, run: request });
