/** Shared wire contract for the awareness events consumed by Goals. */
export const AWARENESS_ACTIVITY_SCHEMA_VERSION = 1 as const;

// This schema defines both the producer's TypeScript payload and the runtime
// decoder. Unversioned producer envelopes use the same fields (legacy v1).
const payloadSchema = {
  context_changed: { fromApp: 'string', toApp: 'string', fromWindow: 'string', toWindow: 'string' },
  // Older trackers can emit an empty ended-session identity. It is representable
  // for compatibility, but consumers must not attribute it to observed work.
  session_ended: { sessionId: 'nullableString', apps: 'strings' },
} as const;

type FieldType = { string: string; nullableString: string | null; strings: string[] };
type Payload<K extends keyof typeof payloadSchema> = {
  [F in keyof typeof payloadSchema[K]]: FieldType[(typeof payloadSchema[K])[F] & keyof FieldType];
} & Record<string, unknown>;

export type AwarenessActivityEvent<K extends keyof typeof payloadSchema = keyof typeof payloadSchema> = {
  [T in K]: {
    schemaVersion: typeof AWARENESS_ACTIVITY_SCHEMA_VERSION;
    type: T;
    data: Payload<T>;
    timestamp: number;
  }
}[K];

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject unknown versions/shapes instead of interpreting arbitrary text as activity. */
export function normalizeAwarenessActivityEvent(value: unknown): AwarenessActivityEvent | null {
  if (!object(value) || (value.schemaVersion !== undefined && value.schemaVersion !== AWARENESS_ACTIVITY_SCHEMA_VERSION)) return null;
  if (value.type !== 'context_changed' && value.type !== 'session_ended') return null;
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) || value.timestamp < 0 || !object(value.data)) return null;
  const data: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(payloadSchema[value.type])) {
    const entry = value.data[field];
    if (kind === 'string' && typeof entry !== 'string') return null;
    if (kind === 'nullableString' && entry !== null && typeof entry !== 'string') return null;
    if (kind === 'strings' && (!Array.isArray(entry) || !entry.every(item => typeof item === 'string'))) return null;
    data[field] = entry;
  }
  // All required fields have been checked against the same schema that defines
  // AwarenessActivityEvent. Extra fields are deliberately not searchable.
  return { schemaVersion: AWARENESS_ACTIVITY_SCHEMA_VERSION, type: value.type,
    data, timestamp: value.timestamp } as AwarenessActivityEvent;
}
