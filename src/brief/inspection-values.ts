import { createHash } from 'node:crypto';
import type { InspectionField } from './workflow-context-contracts';

export const INSPECTION_LIMITS = {
  sourceBytes: 4_000_000, responseBytes: 512_000, rows: 200, nodes: 100,
  fieldChars: 8_000, valueNodes: 256, valueDepth: 8, manualBytes: 65_536, requests: 10_000,
} as const;
export class WorkflowInspectionError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const inspectionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const opaque = (v: string) => createHash('sha256').update(v).digest('hex');
export function boundedJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  if (Buffer.byteLength(raw) > INSPECTION_LIMITS.sourceBytes) throw new WorkflowInspectionError('source_too_large', 413);
  try { return JSON.parse(raw); } catch { throw new WorkflowInspectionError('record_unavailable', 503); }
}
/** Unknown piece outputs have no safe string schema. Fail closed for ALL string
 * leaves (including credentials copied into innocuous fields), key names and
 * sensitive subtrees. Numbers/booleans and structure remain inspectable. Never
 * decrypt connections, emit resume capabilities, URLs, code or raw error text. */
export function inspectionValue(label: string, value: unknown): InspectionField {
  if (value === undefined) return { label, value: 'Missing: not recorded' };
  let budget = INSPECTION_LIMITS.valueNodes as number, redacted = false, truncated = false;
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > INSPECTION_LIMITS.valueDepth) { truncated = true; return '[Omitted: inspection limit]'; }
    if (typeof v === 'string') { redacted = true; return '[Redacted: text value]'; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (Array.isArray(v)) {
      const out = v.slice(0, 32).map(x => visit(x, depth + 1));
      if (v.length > 32) { truncated = true; out.push('[Omitted: inspection limit]'); }
      return out;
    }
    if (object(v)) {
      const entries = Object.entries(v), out: Record<string, unknown> = {};
      for (const [i, [key, child]] of entries.slice(0, 32).entries()) {
        // Keys are arbitrary provider content too; use ordinals, not raw keys.
        if (/auth|token|secret|password|credential|cookie|header|resume|private|session|key/i.test(key)) {
          out[`Field ${i + 1} (restricted)`] = '[Redacted]'; redacted = true;
        } else out[`Field ${i + 1}`] = visit(child, depth + 1);
      }
      if (entries.length > 32) { truncated = true; out.Omitted = '[Inspection limit]'; }
      redacted ||= entries.length > 0;
      return out;
    }
    redacted = true; return '[Redacted]';
  };
  const result = JSON.stringify(visit(value, 0));
  return { label, value: result.length > INSPECTION_LIMITS.fieldChars
    ? '[Omitted: inspection limit]' : result + (truncated ? '\nPartial: inspection limit' : ''),
    ...(redacted ? { redaction: (typeof value === 'string' ? 'full' : 'partial') as 'full' | 'partial',
      ...(typeof value === 'string' ? { redacted: true } : {}) } : {}) };
}
export function canonicalManualPayload(value: unknown): string {
  let count = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++count > 4096 || depth > 16) throw new WorkflowInspectionError('input_too_complex');
    if (typeof v === 'number' && !Number.isFinite(v)) throw new WorkflowInspectionError('invalid_input_number');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
    if (!object(v)) throw new WorkflowInspectionError('invalid_input');
    return Object.fromEntries(Object.keys(v).sort().map(k => {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new WorkflowInspectionError('invalid_input_key');
      return [k, visit(v[k], depth + 1)];
    }));
  };
  if (!object(value)) throw new WorkflowInspectionError('explicit_object_input_required');
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result) > INSPECTION_LIMITS.manualBytes) throw new WorkflowInspectionError('input_too_large', 413);
  return result;
}
