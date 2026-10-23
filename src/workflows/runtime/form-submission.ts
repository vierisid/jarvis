/** Deterministic form ingress. No model, credentials or external effects. */
import { createHash } from 'node:crypto';
export interface SubmissionConfig { idField: string; emailField: string }
const reserved = new Set(['__proto__', 'prototype', 'constructor', '_webhook']);
export function submissionConfig(value: unknown): SubmissionConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Webhook input must be an object');
  const input = value as Record<string, unknown>;
  if (input.submission_id_field === undefined && input.submission_email_field === undefined) return undefined;
  const raw: Record<string, unknown> = { idField: input.submission_id_field, emailField: input.submission_email_field };
  for (const key of ['idField', 'emailField']) {
    const path = raw[key];
    if (typeof path !== 'string' || path.length > 200 || !path.split('.').every(p => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p) && !reserved.has(p))) {
      throw Error(`Form submission ${key} requires an explicit payload field path`);
    }
  }
  const idField = raw.idField as string, emailField = raw.emailField as string;
  if (idField === emailField || idField.startsWith(emailField + '.') || emailField.startsWith(idField + '.')) throw Error('Submission ID and email must be distinct fields');
  return { idField, emailField };
}
function normalize(value: unknown, depth = 0): unknown {
  if (depth > 24) throw Error('Submission nesting exceeds 24 levels');
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !reserved.has(key)).map(([key, item]) => [key, normalize(item, depth + 1)]));
  return value;
}
function field(data: Record<string, unknown>, path: string): { parent: Record<string, unknown>; key: string; value: unknown } {
  const parts = path.split('.'); let parent = data;
  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw Error(`Missing submission field: ${path}`);
    parent = next as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  return { parent, key, value: parent[key] };
}
/** Pragmatic ASCII mailbox validation; quoted/Unicode addresses require explicit support. */
export function validSubmissionEmail(value: string): boolean {
  if (value.length > 254 || value.includes('..')) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.')
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    && domain.includes('.') && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
export function prepareSubmission(payload: unknown, config: SubmissionConfig) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Submission must be a JSON object');
  const data = normalize(payload) as Record<string, unknown>;
  const id = field(data, config.idField);
  if (typeof id.value === 'number' && Number.isSafeInteger(id.value)) id.value = String(id.value);
  if (typeof id.value !== 'string' || !id.value || id.value.length > 256) throw Error('Submission ID must be a nonempty string of at most 256 characters or a safe integer');
  id.parent[id.key] = id.value;
  const email = field(data, config.emailField);
  if (typeof email.value !== 'string' || !validSubmissionEmail(email.value.toLowerCase())) throw Error('Submission email is invalid');
  email.parent[email.key] = email.value.toLowerCase();
  // Hash the entire ID, never truncate it. IDs remain case-sensitive.
  const key = 'submission:v1:' + createHash('sha256').update(id.value).digest('hex');
  return { data, key };
}
