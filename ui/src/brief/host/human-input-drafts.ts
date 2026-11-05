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
    for (let i=0; i<sessionStorage.length; i++) {
      const key=sessionStorage.key(i); if (!key?.startsWith(contextPrefix)) continue;
      try {
        const request=JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (!request || typeof request.id !== 'string' || !Array.isArray(request.fields)
          || !Number.isFinite(request.created) || !Number.isFinite(request.deadline)) continue;
        const answers=JSON.parse(sessionStorage.getItem(draftKey(request)) ?? '{}');
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
    for (let i=0; i<sessionStorage.length; i++) {
      const key=sessionStorage.key(i); if (!key?.startsWith('jarvis:workflow-input:')) continue;
      try { if (filled(JSON.parse(sessionStorage.getItem(key) ?? '{}')).length) ids.add(key.slice('jarvis:workflow-input:'.length).split(':')[0]!); }
      catch { /* Ignore a corrupt entry. */ }
    }
  } catch { /* Browser storage is optional. */ }
  return [...ids];
}
