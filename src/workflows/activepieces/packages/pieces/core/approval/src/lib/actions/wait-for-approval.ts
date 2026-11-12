import { createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
import { request } from './jarvis-request';
export const waitForApprovalLink = createAction({ auth: PieceAuth.None(), name: 'wait_for_approval', displayName: 'Wait for Approval',
  description: 'Wait for an authenticated decision in Jarvis Needs you. Stops the run if the approval is rejected, cancelled or expired, so later steps never run after a refusal. Tick Continue when rejected to get approved: false and keep going instead. Reuses a previous Create Approval Links request in this run, or creates a standalone approval.',
  props: { requestId: Property.ShortText({ displayName: 'Approval request ID', description: 'Optional. Must be the request ID from a Create Approval Links step in this run; required if this run has multiple link requests.', required: false }),
    prompt: Property.LongText({ displayName: 'Proposal to review', required: false }),
    continueOnReject: Property.Checkbox({ displayName: 'Continue when rejected', description: 'Off: a rejected, cancelled or expired approval stops the run here. On: the run continues and this step returns approved: false, so you can branch on it.', required: false, defaultValue: false }) },
  errorHandlingOptions: { continueOnFailure: { hide: true }, retryOnFailure: { hide: true } }, run: request });
