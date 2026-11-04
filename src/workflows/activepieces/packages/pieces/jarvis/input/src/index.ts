import { createPiece, createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
// One request helper for this piece and the legacy approval actions.
import { request as invoke } from '../../../core/approval/src/lib/actions/jarvis-request';
const text = (displayName: string, description?: string) => Property.ShortText({ displayName, description, required: true });
const common = {
  title: text('Request title'), prompt: Property.LongText({ displayName: 'Question and context', required: true }),
  requestKey: text('Stable occurrence key', 'Use a scheduled occurrence date for daily updates, or a stable request ID. Retries within one run reuse its answer; each new run asks again.'),
  timeoutHours: Property.Number({ displayName: 'Response deadline (hours)', required: true, defaultValue: 48 }),
};
const requestInput = createAction({ name: 'request_input', displayName: 'Ask for input and wait for answers',
  description: 'Creates a durable form in Needs you, visible from Today and the navigation badge. Pauses until the signed-in user submits typed answers. Answers survive restart. Each run gets its own request; retries within the run reuse its answer, and a step can opt in to sharing one answer across runs with the same occurrence key. A changed question/schema/graph is refused. Expiry or cancellation fails the step, never continuing as success. No external service or credentials. Fields: array of {key,label,type:text|long_text|number|boolean|select,required:boolean,options?:string[]}. No passwords or credentials.',
  props: { ...common, fields: Property.Json({ displayName: 'Form fields', required: true }),
    shareAcrossRuns: Property.Checkbox({ displayName: 'Share one answer across runs with this key', required: false, defaultValue: false,
      description: 'Off: every run asks for its own answer. On: runs with the same occurrence key (for example a duplicate trigger for the same date) wait for and reuse one answer. Use a key that changes per occurrence.' }) },
  outputSample: { requestId: 'request-reference', status: 'submitted', answers: { update: 'Example update' } }, run: invoke });
const requestApproval = createAction({ name: 'request_approval', displayName: 'Ask for approval and wait for decision',
  description: 'Shows the exact proposal in an authenticated Needs you card, with approve and reject controls. Pending decisions and absolute deadlines survive restart. Rejection, cancellation and expiry fail the step; downstream steps only run after approval. This user decision does not bypass Authority for subsequent external actions. Each run asks for its own decision; a decision never carries over to a later run. Use immutable proposal details in the prompt and a stable request key.',
  props: common, outputSample: { requestId: 'request-reference', status: 'approved', approved: true, answers: {} }, run: invoke });
export const humanInputPiece = createPiece({ displayName: 'Jarvis: Human input', description: 'Durable forms and approvals for workflow handoffs.',
  auth: PieceAuth.None(), minimumSupportedRelease: '0.0.0', logoUrl: '', authors: ['jarvis'], actions: [requestInput, requestApproval], triggers: [] });
