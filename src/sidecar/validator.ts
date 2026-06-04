/**
 * Sidecar Validator — Schema Validation & Sanitization
 *
 * Validates inbound sidecar events and binary frames.
 */

import type { SidecarEvent, EventPriority } from './protocol.ts';

// Size limits
// Large binaries (screenshots, region captures, audio segments) are sent in a
// separate WebSocket binary frame via the ref protocol once they reach
// BINARY_INLINE_THRESHOLD, so the JSON message itself stays small. This cap
// only needs to cover inline (<256 KB) binaries plus JSON result text, with
// headroom for base64 expansion — not full-resolution images.
export const MAX_JSON_SIZE = 2 * 1024 * 1024;        // 2 MB
export const MAX_BINARY_SIZE = 50 * 1024 * 1024;     // 50 MB
export const BINARY_INLINE_THRESHOLD = 256 * 1024;   // 256 KB
export const BINARY_REF_ID_LENGTH = 36;               // UUID length

export interface ValidationResult {
  valid: boolean;
  event?: SidecarEvent;
  error?: string;
}

export interface BinaryValidationResult {
  valid: boolean;
  refId?: string;
  payload?: Buffer;
  error?: string;
}

const VALID_EVENT_TYPES = new Set([
  'rpc_result', 'rpc_progress', 'sidecar_event',
]);

const VALID_PRIORITIES = new Set<EventPriority>([
  'critical', 'high', 'normal', 'low',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively strip dangerous keys from an object.
 */
function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = sanitize(value);
  }
  return clean;
}

/**
 * Validate and sanitize an inbound sidecar event (parsed JSON).
 */
export function validateEvent(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'Event must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  // type
  if (typeof obj.type !== 'string' || !VALID_EVENT_TYPES.has(obj.type)) {
    return { valid: false, error: `Invalid event type: ${String(obj.type)}` };
  }

  // event_type
  if (typeof obj.event_type !== 'string' || obj.event_type.length === 0) {
    return { valid: false, error: 'Missing or empty event_type' };
  }

  // timestamp
  if (typeof obj.timestamp !== 'number' || !Number.isFinite(obj.timestamp)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  // payload
  if (typeof obj.payload !== 'object' || obj.payload === null || Array.isArray(obj.payload)) {
    return { valid: false, error: 'Payload must be a JSON object' };
  }

  // Validate payload fields per type
  const payload = obj.payload as Record<string, unknown>;

  if (obj.type === 'rpc_result') {
    if (typeof payload.rpc_id !== 'string') {
      return { valid: false, error: 'rpc_result requires payload.rpc_id (string)' };
    }
    if (payload.result === undefined && payload.error === undefined) {
      return { valid: false, error: 'rpc_result requires payload.result or payload.error' };
    }
    if (payload.error !== undefined) {
      const err = payload.error as Record<string, unknown>;
      if (typeof err !== 'object' || typeof err.code !== 'string' || typeof err.message !== 'string') {
        return { valid: false, error: 'rpc_result error must have code and message strings' };
      }
    }
  }

  if (obj.type === 'rpc_progress') {
    if (typeof payload.rpc_id !== 'string') {
      return { valid: false, error: 'rpc_progress requires payload.rpc_id (string)' };
    }
    if (typeof payload.progress !== 'number') {
      return { valid: false, error: 'rpc_progress requires payload.progress (number)' };
    }
  }

  // priority (optional)
  if (obj.priority !== undefined && !VALID_PRIORITIES.has(obj.priority as EventPriority)) {
    return { valid: false, error: `Invalid priority: ${String(obj.priority)}` };
  }

  // Sanitize the entire event
  const sanitized = sanitize(obj) as SidecarEvent;

  return { valid: true, event: sanitized };
}

/**
 * Validate a binary frame. First 36 bytes = ref_id (ASCII UUID), rest = payload.
 */
export function validateBinaryFrame(data: Buffer): BinaryValidationResult {
  if (data.length < BINARY_REF_ID_LENGTH) {
    return { valid: false, error: `Binary frame too small: ${data.length} bytes (min ${BINARY_REF_ID_LENGTH})` };
  }

  if (data.length > MAX_BINARY_SIZE) {
    return { valid: false, error: `Binary frame too large: ${data.length} bytes (max ${MAX_BINARY_SIZE})` };
  }

  const refId = data.subarray(0, BINARY_REF_ID_LENGTH).toString('ascii');

  // Basic UUID format check
  if (!/^[0-9a-f-]{36}$/i.test(refId)) {
    return { valid: false, error: `Invalid ref_id format: ${refId}` };
  }

  const payload = data.subarray(BINARY_REF_ID_LENGTH);

  return { valid: true, refId, payload };
}
