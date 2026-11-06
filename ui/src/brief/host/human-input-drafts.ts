import type { HumanRequest } from '../../../../src/workflows/runtime/human-input-contract';
export const instanceKey = (request: HumanRequest) => `${request.id}:${request.generation ?? 0}`;
// Generation zero keeps the original storage key for existing browser drafts.
export const draftKey = (request: HumanRequest) => `jarvis:workflow-input:${request.id}${request.generation ? `:${request.generation}` : ''}`;
const contextPrefix = 'jarvis:workflow-input-context:';
/** Store labels and identity with the draft so it is readable even after history removal. */
export function rememberDraft(request: HumanRequest) {
  try { sessionStorage.setItem(contextPrefix + instanceKey(request), JSON.stringify({ ...request, answers: null, runs: undefined })); }
  catch { /* The mounted form still retains its answers when storage is unavailable. */ }
}
export function forgetDraft(request: HumanRequest) {
  try { sessionStorage.removeItem(draftKey(request)); sessionStorage.removeItem(contextPrefix + instanceKey(request)); }
  catch { /* Optional browser storage. */ }
}
export function localDraftRequests(): HumanRequest[] {
  const result: HumanRequest[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i); if (!key?.startsWith(contextPrefix)) continue;
      try {
        const request = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (!request || typeof request.id !== 'string' || !Array.isArray(request.fields)
          || !Number.isFinite(request.created) || !Number.isFinite(request.deadline)) continue;
        const answers = JSON.parse(sessionStorage.getItem(draftKey(request)) ?? '{}');
        if (filled(answers).length) result.push(request);
      } catch { /* A corrupt entry cannot hide the other recoverable drafts. */ }
    }
  } catch { /* Browser storage is optional. */ }
  return result;
}
export function filled(answers: unknown): string[] {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  return Object.entries(answers).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())).map(([k]) => k);
}

/** Also discover pre-upgrade answer-only entries that have no saved context yet. */
export function localDraftIds(): string[] {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i); if (!key?.startsWith('jarvis:workflow-input:')) continue;
      try { if (filled(JSON.parse(sessionStorage.getItem(key) ?? '{}')).length) ids.add(key.slice('jarvis:workflow-input:'.length).split(':')[0]!); }
      catch { /* Ignore a corrupt entry. */ }
    }
  } catch { /* Browser storage is optional. */ }
  return [...ids];
}

/** The answers this browser stored for one request instance ({} when none or unreadable). */
export function storedAnswers(request: HumanRequest): Record<string, unknown> {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(request)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
/** Stored answers for any instance of request `id`, without the saved labels. */
export function answerOnlyDrafts(id: string): Array<{ storageKey: string; answers: Record<string, unknown> }> {
  const result: Array<{ storageKey: string; answers: Record<string, unknown> }> = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key !== `jarvis:workflow-input:${id}` && !key?.startsWith(`jarvis:workflow-input:${id}:`)) continue;
      try { const answers = JSON.parse(sessionStorage.getItem(key!) ?? '{}'); if (filled(answers).length) result.push({ storageKey: key!, answers }); }
      catch { /* Ignore a corrupt entry. */ }
    }
  } catch { /* Browser storage is optional. */ }
  return result;
}
export function forgetStoredDraft(storageKey: string) {
  try { sessionStorage.removeItem(storageKey); } catch { /* Optional browser storage. */ }
}
