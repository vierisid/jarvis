import { createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
import { request } from './jarvis-request';
export const createApprovalLink = createAction({ auth: PieceAuth.None(), name: 'create_approval_links', displayName: 'Create Approval Links',
  description: 'Create an authenticated Needs you request without pausing. Both links open the review form; opening a link never approves or rejects. Follow with Wait for Approval and map requestId when there is more than one request.',
  props: { prompt: Property.LongText({ displayName: 'Proposal to review', required: false }) },
  errorHandlingOptions: { continueOnFailure: { hide: true }, retryOnFailure: { hide: true } }, run: request });
