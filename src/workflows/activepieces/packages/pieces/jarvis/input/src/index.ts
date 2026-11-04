import { createPiece, createAction, PieceAuth, Property } from '@activepieces/pieces-framework';
const text = (displayName: string, description?: string) => Property.ShortText({ displayName, description, required: true });
const common = {
  title: text('Request title'), prompt: Property.LongText({ displayName: 'Question and context', required: true }),
  requestKey: text('Stable occurrence key', 'Use a scheduled occurrence date for daily updates, or a stable request ID. Replays reuse the same answer; different dates need different keys.'),
  timeoutHours: Property.Number({ displayName: 'Response deadline (hours)', required: true, defaultValue: 48 }),
};
async function invoke(context: any) {
  const response = await fetch(context.server.apiUrl.replace(/\/$/, '') + '/v1/jarvis/human-input', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + context.server.token,
      'X-Jarvis-Step-Name': context.step.name, 'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []) }, body: JSON.stringify(context.propsValue),
  });
  if (!response.ok) throw Error((await response.text()).slice(0, 1000));
  const result = await response.json() as any;
  if (response.status === 202) context.run.waitForWaitpoint(result.waitpointId);
  return result;
}
const requestInput = createAction({ name: 'request_input', displayName: 'Ask for input and wait for answers',
  description: 'Creates a durable form in Needs you, visible from Today and the navigation badge. Pauses until the signed-in user submits typed answers. Answers survive restart. A stable occurrence key reuses a completed response across retries; changed question/schema/graph is refused. Expiry or cancellation fails the step, never continuing as success. No external service or credentials. Fields: array of {key,label,type:text|long_text|number|boolean|select,required:boolean,options?:string[]}. No passwords or credentials.',
  props: { ...common, fields: Property.Json({ displayName: 'Form fields', required: true }) },
  outputSample: { requestId: 'request-reference', status: 'submitted', answers: { update: 'Example update' } }, run: invoke });
const requestApproval = createAction({ name: 'request_approval', displayName: 'Ask for approval and wait for decision',
  description: 'Shows the exact proposal in an authenticated Needs you card, with approve and reject controls. Pending decisions and absolute deadlines survive restart. Rejection, cancellation and expiry fail the step; downstream steps only run after approval. This user decision does not bypass Authority for subsequent external actions. Use immutable proposal details in the prompt and a stable request key.',
  props: common, outputSample: { requestId: 'request-reference', status: 'approved', approved: true, answers: {} }, run: invoke });
export const humanInputPiece = createPiece({ displayName: 'Jarvis: Human input', description: 'Durable forms and approvals for workflow handoffs.',
  auth: PieceAuth.None(), minimumSupportedRelease: '0.0.0', logoUrl: '', authors: ['jarvis'], actions: [requestInput, requestApproval], triggers: [] });
