/** Shared, credential-free form contract used by the runtime and dashboard. */
export const HUMAN_INPUT_PIECE = '@jarvispieces/piece-jarvis-input';
/**
 * How many requests one workflow may have waiting for an answer at once
 * (#1266, kept by the owner 2026-11-06). A step that would add one more is
 * refused, typed with `HUMAN_INPUT_LIMIT_CODE`, so the run says why.
 */
export const HUMAN_INPUT_PENDING_LIMIT = 20;
export const HUMAN_INPUT_LIMIT_CODE = 'HUMAN_INPUT_LIMIT';
/**
 * A step refused because nothing on this Jarvis can answer it: requests are
 * answered in Needs you, the Brief decisions feature, and it is off (#1266).
 */
export const HUMAN_INPUT_UNAVAILABLE_CODE = 'HUMAN_INPUT_UNAVAILABLE';
/** The person rejected the request: the step stops the run, and nothing after it runs. */
export const HUMAN_INPUT_REJECTED_CODE = 'HUMAN_INPUT_REJECTED';
/**
 * Why nothing could answer a request on this Jarvis, or null when Needs you
 * (the Brief decisions capability) can take it. Requests are answered only in
 * Brief, and under the previous dashboard Brief does not open in production,
 * so there a step is refused whatever JARVIS_BRIEF_DECISIONS says: a request
 * nobody can see would wait unanswered (owner decision, #1311 follow-up).
 * Otherwise it names the cause: decisions turned off, or a decisions provider
 * that is not ready.
 */
export function humanInputRefusal(decisions: { enabled: boolean; reason: string | null }, dashboard: 'brief' | 'legacy'): string | null {
  const why = 'so nothing could answer this request.';
  if (dashboard === 'legacy') {
    return `Needs you is not available with the previous dashboard, ${why} Requests for input or approval are answered only in Brief. Switch to Brief (set JARVIS_DASHBOARD=brief) to let workflows ask for input or approval.`;
  }
  if (decisions.enabled) return null;
  if (decisions.reason !== 'disabled') {
    return `Needs you is not ready on this Jarvis, ${why} Run it again once Jarvis has finished starting; if it keeps failing, check the Jarvis log.`;
  }
  return `Needs you is off on this Jarvis, ${why} Turn on decisions (JARVIS_BRIEF_DECISIONS=1) to let workflows ask for input or approval.`;
}
/** A step that asks a person: the input piece's two actions, and the legacy approval piece's. */
export function isHumanInputStep(piece: unknown, action: unknown): boolean {
  return (piece === HUMAN_INPUT_PIECE && (action === 'request_input' || action === 'request_approval'))
    || (piece === '@activepieces/piece-approval' && (action === 'create_approval_links' || action === 'wait_for_approval'));
}
export type InputField = { key: string; label: string; type: 'text' | 'long_text' | 'number' | 'boolean' | 'select'; required: boolean; options?: string[] };
export type HumanRequest = {
  id: string; kind: 'input' | 'approval'; title: string; prompt: string; fields: InputField[];
  requestKey: string; workflowName: string; flowId: string; runId: string; created: number; deadline: number;
  status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  answers: Record<string, unknown> | null;
  /** Time this instance closed, independent of its response deadline. */
  closedAt?: number;
  /** Read-only continuation receipts. Shared forms can belong to several runs. */
  runs?: Array<{ runId: string; versionId: string; status: string }>;
  closureReason?: 'workflow_changed';
  /** Set when the user acknowledged an outcome that needed attention. */
  dismissedAt?: number;
  /** A shared form reopened after it closed is a new instance; earlier waits keep `reopenedFrom`. */
  generation?: number; reopenedFrom?: HumanRequest['status'];
};
/**
 * The form a step asks for, or an error that says in plain words what to fix.
 * Run at readiness and again when the step runs, so a form that would fail
 * is refused before anything starts. `name` is accepted for `key`, because
 * it is the natural word for a field's short name; the saved field is
 * always `key`.
 */
export function formFields(value: unknown): InputField[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw Error('A form needs between 1 and 20 fields');
  const keys = new Set<string>();
  return value.map((field, i) => {
    const at = `Form field ${i + 1}`;
    if (!field || typeof field !== 'object') throw Error(`${at} must be an object with a key, label, type and required`);
    const key = typeof field.key === 'string' ? field.key : typeof field.name === 'string' ? field.name : undefined;
    if (key === undefined) throw Error(`${at} needs a key, a short name like company_size`);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))
      throw Error(`${at} has a key "${key.slice(0, 40)}" that is not allowed. Use letters, numbers and underscores, starting with a letter, like company_size`);
    if (keys.has(key)) throw Error(`${at} repeats the key "${key}". Each form field needs its own key`);
    keys.add(key);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 200) throw Error(`${at} needs a label`);
    if (!['text', 'long_text', 'number', 'boolean', 'select'].includes(field.type)) throw Error(`${at} needs a type: text, long_text, number, boolean or select`);
    if (typeof field.required !== 'boolean') throw Error(`${at} needs required set to true or false`);
    if (field.type === 'select' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 30
      || field.options.some((v: unknown) => typeof v !== 'string' || !v || v.length > 200)
      || new Set(field.options).size !== field.options.length)) throw Error(`${at} is a select and needs 1 to 30 different options`);
    return { key, label: field.label, type: field.type, required: field.required,
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
