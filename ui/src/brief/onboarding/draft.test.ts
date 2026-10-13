import { expect, test } from 'bun:test';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerOnboarding } from '../../../../src/brief/registrations/onboarding';
import type { BriefCompositionJob, BriefComposeRequest } from '../../../../src/brief/composition-contracts';
import { OnboardingDraft, sessionOnboardingStorage, type OnboardingHost } from './draft';
import { tutorialIndex, tutorialStepId, TUTORIAL_STEPS } from './targets';

const registration = registerOnboarding(() => ({ targets: true, progress: true, draftHandoff: true }));
export const enabledSnapshot = () => new BriefCapabilities([
  ...registration, { id: 'workflowComposition', provider: { readiness: () => 'ready' } },
], ['onboarding', 'workflowComposition']).snapshot();
const job = (request: BriefComposeRequest, state: BriefCompositionJob['state'] = 'draft_ready'): BriefCompositionJob => ({
  jobId: 'job-1', requestId: request.requestId, specification: { name: 'Draft', prompt: request.prompt }, state,
  progress: { checkedCandidates: 1 }, compositionId: 'composition-1',
  workflow: state === 'draft_ready' ? { flowId: 'flow-1', versionId: 'version-1' } : null,
  blocker: null, createdAt: 1, updatedAt: 2,
});
function setup() {
  let saved: string | null = null, storageFails = false, id = 0;
  let snapshot: unknown = enabledSnapshot();
  const calls: BriefComposeRequest[] = [], opened: unknown[] = [];
  const host: OnboardingHost = { capabilities: () => snapshot, roomAvailable: () => true,
    canLeave: async signal => !signal.aborted, commit: route => { opened.push(route); } };
  const storage = { read: () => saved, write: (value: string) => { if (storageFails) throw Error('Storage blocked'); saved = value; } };
  const api = { submit: async (request: BriefComposeRequest) => { calls.push(request); return job(request); },
    read: async (_id: string) => job(calls.at(-1)!) };
  const make = () => new OnboardingDraft('account-1/vault-1', storage, host, api, () => `request-${++id}`);
  return { make, api, calls, opened, host, storage, snapshot: (v: unknown) => { snapshot = v; },
    failStorage: (v = true) => { storageFails = v; }, saved: () => saved };
}

test('registration is optional, default off and depends on enabled F-07 plus every host seam', () => {
  expect(registerOnboarding()).toEqual([]);
  expect(new BriefCapabilities(registration).snapshot().capabilities.onboarding).toMatchObject({ ready: true, enabled: false });
  expect(new BriefCapabilities(registration, ['onboarding']).snapshot().capabilities.onboarding.reason).toBe('dependency_not_ready');
  for (const missing of ['targets', 'progress', 'draftHandoff']) {
    const values = { targets: true, progress: true, draftHandoff: true, [missing]: false };
    expect(new BriefCapabilities(registerOnboarding(() => values), ['onboarding']).snapshot().capabilities.onboarding.ready).toBe(false);
  }
  expect(enabledSnapshot().capabilities.onboarding.enabled).toBe(true);
});

test('editing/reading the prompt performs no effects; explicit preparation keeps the exact prompt and pinned draft IDs', async () => {
  const f = setup(), draft = f.make();
  draft.setRoutine('Draft a report from the notes I supply.');
  expect(f.calls).toHaveLength(0); expect(f.opened).toEqual([]);
  await draft.prepare();
  expect(f.calls[0]).toEqual({ requestId: 'request-1', prompt: 'Draft a report from the notes I supply.' });
  expect(f.saved()).toContain('request-1'); expect(f.opened).toEqual([]);
  await draft.openDraft();
  expect(f.opened).toEqual([{ room: 'workflow-draft', selection: { flowId: 'flow-1', versionId: 'version-1' } }]);
  expect(draft.getSnapshot().routine).toBe('Draft a report from the notes I supply.');
});

test('lost response, duplicate clicks and reload recover the same persisted F-07 key', async () => {
  const f = setup(); let fail!: () => void;
  f.api.submit = request => { f.calls.push(request); return new Promise((_, reject) => { fail = () => reject(Error('Lost response')); }); };
  const first = f.make(); first.setRoutine('Draft weekly notes');
  const pending = first.prepare(); await first.prepare();
  expect(f.calls).toHaveLength(1);
  first.setRoutine('Replacement'); expect(first.getSnapshot().routine).toBe('Draft weekly notes');
  fail(); await pending; first.dispose();
  const recovered = f.make();
  f.api.submit = async request => { f.calls.push(request); return job(request); };
  await recovered.prepare();
  expect(f.calls[1]).toEqual(f.calls[0]); expect(recovered.getSnapshot().job?.state).toBe('draft_ready');
  await recovered.prepare(); expect(f.calls).toHaveLength(2);
});

test('blocked/failed attempts retain editable prompts and require another explicit prepare for a fresh request', async () => {
  const f = setup(); f.api.submit = async request => { f.calls.push(request); return job(request, 'blocked'); };
  const draft = f.make(); draft.setRoutine('Unspecified task'); await draft.prepare();
  expect(draft.getSnapshot().routine).toBe('Unspecified task');
  draft.setRoutine('Draft my weekly notes'); expect(f.calls).toHaveLength(1);
  await draft.prepare(); expect(f.calls.map(c => c.requestId)).toEqual(['request-1', 'request-2']);
});

test('pending jobs read by job identity without creating another workflow', async () => {
  const f = setup(); f.api.submit = async request => { f.calls.push(request); return job(request, 'queued'); };
  const draft = f.make(); draft.setRoutine('Draft notes'); await draft.prepare(); await draft.check();
  expect(f.calls).toHaveLength(1); expect(draft.getSnapshot().job?.state).toBe('draft_ready');
});

for (const outcome of ['receipt', 'error'] as const) test(`a late polling ${outcome} cannot alter a new handoff after clear`, async () => {
  const f = setup(), draft = f.make();
  f.api.submit = async request => { f.calls.push(request); return job(request, 'queued'); };
  let resolveRead!: (value: BriefCompositionJob) => void, rejectRead!: (error: Error) => void;
  f.api.read = () => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
  draft.setRoutine('Old task'); await draft.prepare();
  const oldRequest = f.calls[0]!, polling = draft.check();
  draft.clear(); draft.setRoutine('New task');
  let resolveSubmit!: (value: BriefCompositionJob) => void;
  f.api.submit = request => { f.calls.push(request); return new Promise(resolve => { resolveSubmit = resolve; }); };
  const preparing = draft.prepare(), current = draft.getSnapshot();
  expect(current.busy).toBe(true);
  if (outcome === 'receipt') resolveRead(job(oldRequest)); else rejectRead(Error('Late network failure'));
  await polling;
  expect(draft.getSnapshot()).toBe(current);
  resolveSubmit(job(f.calls[1]!)); await preparing;
  expect(draft.getSnapshot()).toMatchObject({ routine: 'New task', busy: false, error: null, job: { requestId: 'request-2' } });
});

test('a failed clear keeps the pending read owned by the retained handoff', async () => {
  const f = setup(), draft = f.make();
  f.api.submit = async request => { f.calls.push(request); return job(request, 'queued'); };
  let resolveRead!: (value: BriefCompositionJob) => void;
  f.api.read = () => new Promise(resolve => { resolveRead = resolve; });
  draft.setRoutine('Keep my task'); await draft.prepare();
  const polling = draft.check(); f.failStorage();
  expect(() => draft.clear()).toThrow('Could not clear');
  resolveRead(job(f.calls[0]!)); await polling;
  expect(draft.getSnapshot()).toMatchObject({ routine: 'Keep my task', storageFailed: true, job: { state: 'draft_ready' } });
});

test('missing/stale access, invalid receipts and unready destinations cannot create or open a misleading result', async () => {
  const f = setup(), draft = f.make(); draft.setRoutine('Draft notes'); f.snapshot(null);
  await draft.prepare(); expect(f.calls).toEqual([]); expect(draft.getSnapshot().routine).toBe('Draft notes');
  f.snapshot(enabledSnapshot()); f.api.submit = async request => ({ ...job(request), requestId: 'foreign-request' });
  await draft.prepare(); expect(draft.getSnapshot().job).toBeNull(); expect(draft.getSnapshot().error).toContain('Could not confirm');
  f.api.submit = async request => job(request); await draft.prepare();
  f.host.roomAvailable = () => false; await expect(draft.openDraft()).rejects.toThrow(); expect(f.opened).toEqual([]);
  f.host.roomAvailable = () => true; f.snapshot(null); await expect(draft.openDraft()).rejects.toThrow(); expect(f.opened).toEqual([]);
});

test('failed storage writes fence POST and retain the key for recovery', async () => {
  const f = setup(), draft = f.make(); draft.setRoutine('Draft notes'); f.failStorage();
  await draft.prepare(); expect(f.calls).toEqual([]); expect(draft.getSnapshot().storageFailed).toBe(true);
  f.failStorage(false); await draft.prepare();
  expect(f.calls[0]?.requestId).toBe('request-1'); expect(draft.getSnapshot().storageFailed).toBe(false);
});

test('unreadable storage is never replaced with defaults or a fresh request', async () => {
  const f = setup(); f.storage.read = () => '{';
  const draft = f.make(); draft.setRoutine('Draft notes'); await draft.prepare();
  expect(f.saved()).toBeNull(); expect(f.calls).toEqual([]); expect(draft.getSnapshot().storageFailed).toBe(true);
});

test('retired account ignores late receipts and aborts deferred navigation', async () => {
  const f = setup(), draft = f.make(); let finish!: (job: BriefCompositionJob) => void;
  f.api.submit = request => { f.calls.push(request); return new Promise(resolve => { finish = resolve; }); };
  draft.setRoutine('Draft notes'); const pending = draft.prepare(); draft.dispose();
  finish(job(f.calls[0]!)); await pending; expect(draft.getSnapshot().job).toBeNull();
  await expect(draft.openDraft()).rejects.toThrow();
  const next = f.make(); f.api.submit = async request => job(request); await next.prepare();
  let release!: () => void;
  f.host.canLeave = async () => { await new Promise<void>(resolve => { release = resolve; }); return true; };
  const opening = next.openDraft(); next.dispose(); release(); await expect(opening).rejects.toThrow(); expect(f.opened).toEqual([]);
});

test('account-scoped storage never restores another account prompt and old tutorial steps safely restart', () => {
  const data = new Map<string, string>(); const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k,v); } };
  sessionOnboardingStorage('account-a', storage).write('private prompt');
  expect(sessionOnboardingStorage('account-b', storage).read()).toBeNull();
  expect(tutorialIndex('legacy:now')).toBe(0);
  TUTORIAL_STEPS.forEach((step, i) => expect(tutorialIndex(tutorialStepId(step))).toBe(i));
});

test('a failed final clear preserves both in-memory and persisted prompt/receipt for retry', async () => {
  const f = setup(), draft = f.make(); draft.setRoutine('Keep this task'); await draft.prepare();
  const before = draft.getSnapshot(), saved = f.saved(); f.failStorage();
  expect(() => draft.clear()).toThrow('Could not clear');
  expect(draft.getSnapshot().routine).toBe(before.routine); expect(draft.getSnapshot().job).toBe(before.job);
  expect(draft.getSnapshot().request).toBe(before.request); expect(f.saved()).toBe(saved);
  f.failStorage(false); draft.clear(); expect(draft.getSnapshot().routine).toBe('');
  expect(f.calls).toHaveLength(1);
});

for (const loss of ['capability', 'room', 'cancel'] as const) test(`draft handoff rechecks ${loss} after the shared leave guard`, async () => {
  const f = setup(), draft = f.make(); draft.setRoutine('Draft notes'); await draft.prepare();
  let release!: (allowed: boolean) => void;
  f.host.canLeave = () => new Promise(resolve => { release = resolve; });
  const opening = draft.openDraft();
  if (loss === 'capability') f.snapshot(null);
  if (loss === 'room') f.host.roomAvailable = () => false;
  release(loss !== 'cancel'); await expect(opening).rejects.toThrow(); expect(f.opened).toEqual([]);
  expect(draft.getSnapshot().routine).toBe('Draft notes');
});
