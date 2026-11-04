/** Shared, credential-free form contract used by the runtime and dashboard. */
export const HUMAN_INPUT_PIECE = '@jarvispieces/piece-jarvis-input';
export type InputField = { key: string; label: string; type: 'text' | 'long_text' | 'number' | 'boolean' | 'select'; required: boolean; options?: string[] };
export type HumanRequest = {
  id: string; kind: 'input' | 'approval'; title: string; prompt: string; fields: InputField[];
  requestKey: string; workflowName: string; flowId: string; runId: string; created: number; deadline: number;
  status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  answers: Record<string, unknown> | null;
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
export function answerErrors(fields: InputField[], value: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { _form: 'Provide an answer object' };
  const answers = value as Record<string, unknown>;
  if (Object.keys(answers).some(key => !fields.some(f => f.key === key))) errors._form = 'Unknown answer field';
  for (const field of fields) {
    const v = answers[field.key];
    if (v === undefined || v === '') { if (field.required) errors[field.key] = 'This answer is required'; continue; }
    const valid = field.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : field.type === 'boolean' ? typeof v === 'boolean'
      : typeof v === 'string' && v.length <= 10000 && (field.type !== 'select' || field.options!.includes(v));
    if (!valid) errors[field.key] = `Enter a valid ${field.type === 'long_text' ? 'text' : field.type} answer`;
  }
  return errors;
}
