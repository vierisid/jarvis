/** Per-tab storage, keyed by server-provided scope and journey. Never used for
 * auth, release flags or progress. A corrupt/unwritable draft blocks its action;
 * no fallback overwrites text or invents a new idempotency key. */
export function createDraftStore(storage: Pick<Storage, 'getItem' | 'setItem'>, scopeId: string, journeyId: string) {
  if (![scopeId, journeyId].every(id => id.trim() && id.length <= 200)) throw new Error('Draft identity unavailable');
  const key = (kind: 'interview' | 'activation') => `onboarding-next:draft:v1:${JSON.stringify([scopeId, journeyId, kind])}`;
  const parse = (raw: string): Record<string, unknown> => {
    if (raw.length > 65_536) throw new Error('Draft unavailable');
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== 1 || !data.value || typeof data.value !== 'object' || Array.isArray(data.value)) throw new Error('Draft unavailable');
    return data.value;
  };
  return {
    read(kind: 'interview' | 'activation') {
      const raw = storage.getItem(key(kind));
      return raw === null ? null : parse(raw);
    },
    save(kind: 'interview' | 'activation', value: Record<string, unknown>) {
      // Refuse to replace a corrupt/future record without deliberate recovery.
      const current = storage.getItem(key(kind)); if (current !== null) parse(current);
      const text = JSON.stringify({ schemaVersion: 1, value }); parse(text);
      storage.setItem(key(kind), text);
    },
  };
}
