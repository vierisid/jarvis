/** Shared, credential-free form contract used by the runtime and dashboard. */
export const HUMAN_INPUT_PIECE = '@jarvispieces/piece-jarvis-input';
export type InputField = { key: string; label: string; type: 'text' | 'long_text' | 'number' | 'boolean' | 'select'; required: boolean; options?: string[] };
export type HumanRequest = {
  id: string; kind: 'input' | 'approval'; title: string; prompt: string; fields: InputField[];
  requestKey: string; workflowName: string; flowId: string; runId: string; created: number; deadline: number;
  status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  answers: Record<string, unknown> | null;
  /** Read-only continuation receipts. Shared forms can belong to several runs. */
  runs?: Array<{ runId: string; versionId: string; status: string }>;
  closureReason?: 'workflow_changed';
  /** Set when the user acknowledged an outcome that needed attention. */
  dismissedAt?: number;
  /** A shared form reopened after it closed is a new instance; earlier waits keep `reopenedFrom`. */
  generation?: number; reopenedFrom?: HumanRequest['status'];
};
export function formFields(value: unknown): InputField[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw Error('Provide 1–20 input fields');
  const keys = new Set<string>();
  return value.map(field => {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string'
      || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.key) || ['constructor', 'prototype', '__proto__'].includes(field.key)
      || keys.has(field.key)) throw Error('Input field keys must be unique simple identifiers');
    keys.add(field.key);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 200) throw Error('Each input field needs a label');
    if (!['text', 'long_text', 'number', 'boolean', 'select'].includes(field.type) || typeof field.required !== 'boolean') throw Error('Invalid input field type or required flag');
    if (field.type === 'select' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 30
      || field.options.some((v: unknown) => typeof v !== 'string' || !v || v.length > 200)
      || new Set(field.options).size !== field.options.length)) throw Error('Select fields need distinct options');
    return { key: field.key, label: field.label, type: field.type, required: field.required,
      ...(field.type === 'select' ? { options: field.options } : {}) };
  });
}
/** The response route's body cap. All answers together must fit in it, not just each field. */
export const HUMAN_INPUT_MAX_BODY_BYTES = 64_000;
/** Room left under the body cap for the decision and JSON framing. */
export const HUMAN_INPUT_MAX_ANSWER_BYTES = 60_000;
export function answerErrors(fields: InputField[], value: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { _form: 'Provide an answer object' };
  const answers = value as Record<string, unknown>;
  if (Object.keys(answers).some(key => !fields.some(f => f.key === key))) errors._form = 'Unknown answer field';
  for (const field of fields) {
    const v = answers[field.key];
    // Whitespace alone is no answer: a required text field needs real text.
    if (v === undefined || (typeof v === 'string' && !v.trim())) { if (field.required) errors[field.key] = 'This answer is required'; continue; }
    const valid = field.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : field.type === 'boolean' ? typeof v === 'boolean'
      : typeof v === 'string' && v.length <= 10000 && (field.type !== 'select' || field.options!.includes(v));
    if (!valid) errors[field.key] = `Enter a valid ${field.type === 'long_text' ? 'text' : field.type} answer`;
  }
  if (!errors._form && new TextEncoder().encode(JSON.stringify(answers)).length > HUMAN_INPUT_MAX_ANSWER_BYTES)
    errors._form = 'These answers are too long together. Shorten the longest answers and submit again.';
  return errors;
}

const LIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'PAUSED'];
/**
 * An accepted response is not evidence that its workflow completed. A failed or
 * unknown continuation, or a form withdrawn because the workflow changed, stays
 * until the user dismisses it. A stopped run (cancelled, turned off or deleted)
 * needs nothing more.
 */
export function humanRequestNeedsAttention(request: HumanRequest): boolean {
  if (request.status === 'pending') return true;
  if (request.dismissedAt) return false;
  return request.closureReason === 'workflow_changed'
    || (['submitted', 'approved'].includes(request.status) && !!request.runs?.some(run =>
      ![...LIVE_RUN_STATUSES, 'SUCCEEDED', 'STOPPED'].includes(run.status)));
}
/** Only a settled outcome can be dismissed: no run of the request may still change it. */
export function humanRequestDismissable(request: HumanRequest): boolean {
  return request.status !== 'pending' && humanRequestNeedsAttention(request)
    && !request.runs?.some(run => LIVE_RUN_STATUSES.includes(run.status));
}
