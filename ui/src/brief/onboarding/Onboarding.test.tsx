import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerOnboarding } from '../../../../src/brief/registrations/onboarding';
import { OnboardingDraft, type OnboardingComposition } from './draft';
import { ONBOARDING_TARGETS, TUTORIAL_STEPS, tutorialStepId } from './targets';
import type { OnboardingStatus } from '../../v2/onboarding/useOnboardingStatus';
import type { BriefComposeRequest, BriefCompositionJob } from '../../../../src/brief/composition-contracts';
GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let Gate: typeof import('../../v2/onboarding/OnboardingGate').OnboardingGate;
let BriefHost: typeof import('../../v2/onboarding/OnboardingGate').BriefOnboardingHost;
let Wizard: typeof import('../../v2/onboarding/OnboardingWizard').OnboardingWizard;
const realFetch = globalThis.fetch, realSocket = globalThis.WebSocket, realAudio = globalThis.AudioContext;
let root: ReturnType<typeof createRoot>, container: HTMLElement;
let status: OnboardingStatus, hosted: boolean, failProgress: boolean, failStatus: boolean, failCompose: boolean, failOpen: boolean;
let posts: Array<{ url: string; body: any }>, requests: BriefComposeRequest[], opened: unknown[], draft: OnboardingDraft;
let composition: OnboardingComposition;
const complete: OnboardingStatus = { setup_completed: true, setup_completed_at: 1, setup_skipped_profile: false,
  profile_completed: true, tutorial_completed: false, tutorial_completed_at: null, tutorial_dismissed: false,
  tutorial_progress_step: null, last_reset_at: null, post_setup_services_ready: true };
class InterviewSocket {
  static OPEN = 1; readyState = 1; onopen: (() => void) | null = null; onmessage = null; onclose = null;
  send() {} close() { this.readyState = 3; }
}
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
  ({ OnboardingGate: Gate, BriefOnboardingHost: BriefHost } = await import('../../v2/onboarding/OnboardingGate'));
  ({ OnboardingWizard: Wizard } = await import('../../v2/onboarding/OnboardingWizard')); });
beforeEach(() => {
  status = { ...complete }; hosted = true; failProgress = failStatus = failCompose = failOpen = false;
  // The URL no longer picks the adapter (#1105, see mountGate); it is kept as a realistic Brief URL.
  posts = []; requests = []; opened = []; window.history.replaceState(null, '', '/?brief=1#/brief/today');
  globalThis.WebSocket = InterviewSocket as never;
  globalThis.AudioContext = class { constructor() { throw Error('No audio allowed'); } } as never;
  const capabilities = new BriefCapabilities([
    ...registerOnboarding(() => ({ targets: true, progress: true, draftHandoff: true })),
    { id: 'workflowComposition', provider: { readiness: () => 'ready' } },
  ], ['onboarding', 'workflowComposition']);
  composition = { submit: async request => {
    requests.push(request); if (failCompose) throw Error('Setup unavailable');
    return { jobId: 'job', requestId: request.requestId, specification: { name: 'Draft', prompt: request.prompt },
      state: 'draft_ready', progress: { checkedCandidates: 1 }, compositionId: 'composition',
      workflow: { flowId: 'flow', versionId: 'version' }, blocker: null, createdAt: 1, updatedAt: 2 };
  }, read: async () => { throw Error('Unexpected read'); } };
  let saved: string | null = null, requestNumber = 0;
  draft = new OnboardingDraft('fixture', { read: () => saved, write: v => { saved = v; } }, {
    capabilities: () => capabilities.snapshot(), roomAvailable: () => true,
    canLeave: async () => !failOpen, commit: route => { opened.push(route); },
  }, composition, () => `fixture-request-${++requestNumber}`);
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'POST') posts.push({ url, body });
    if (url === '/api/config/llm') return Response.json({ hosted_llm: hosted });
    if (url === '/api/system/permissions') return Response.json({ available: false, reason: 'unsupported' });
    if (url === '/api/onboarding/status') return failStatus ? Response.json({}, { status: 503 }) : Response.json(status);
    if (url === '/api/onboarding/setup') { status.setup_completed = true; return Response.json({ ok: true }); }
    if (url === '/api/onboarding/skip') { status = { ...complete, setup_skipped_profile: true, tutorial_dismissed: true }; }
    if (url === '/api/onboarding/profile/skip') { status.setup_skipped_profile = true; }
    if (url === '/api/onboarding/tutorial/progress') {
      if (failProgress) return Response.json({}, { status: 503 }); status.tutorial_progress_step = body.stepId;
    }
    if (url === '/api/onboarding/tutorial/dismiss') status.tutorial_dismissed = true;
    if (url === '/api/onboarding/tutorial/complete') status.tutorial_completed = true;
    return Response.json({ ok: true });
  }) as typeof fetch;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); draft.dispose(); });
afterAll(() => { globalThis.fetch = realFetch; globalThis.WebSocket = realSocket; globalThis.AudioContext = realAudio; GlobalRegistrator.unregister(); });
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
async function waitFor(check: () => boolean) { for (let n = 0; n < 400 && !check(); n++) await act(async () => { await new Promise(r => setTimeout(r, 10)); }); expect(check()).toBe(true); }
async function click(label: string) { await waitFor(() => !!button(label)); expect(!!button(label)).toBe(true); expect(button(label).disabled).toBe(false); await act(async () => button(label).click()); }
// The Brief adapter follows the host the gate renders inside (#1105), so a
// Brief run mounts the gate under BriefOnboardingHost as DashboardEntry does.
async function mountGate(insideBrief = true) {
  const gate = <Gate brief={draft}><div>Live shell</div></Gate>;
  await act(async () => { root.render(insideBrief ? <BriefHost>{gate}</BriefHost> : gate); }); await waitFor(() => !!container.textContent);
}
async function mountWizard() { await act(async () => root.render(<Wizard status={status} brief={draft} onComplete={() => {}} />)); }
async function enter(text: string) { await act(async () => {
  const el = container.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}); }

test('Brief tutorial saves stable targets, retains focus and uses only canonical progress/complete writes', async () => {
  await mountWizard();
  for (let i = 0; i < TUTORIAL_STEPS.length; i++) {
    const step = TUTORIAL_STEPS[i]!;
    expect(container.querySelector('.obw-spot')?.getAttribute('data-tour-target')).toBe(ONBOARDING_TARGETS[step].id);
    expect(container.querySelector(`[data-onboarding-target="${ONBOARDING_TARGETS[step].id}"]`)).not.toBeNull();
    const label = i === 4 ? 'Finish' : 'Next'; button(label).focus(); await click(label);
    if (i < 4) expect(document.activeElement?.textContent).toBe(i === 3 ? 'Finish' : 'Next');
  }
  expect(posts.map(p => p.url)).toEqual([...Array(4).fill('/api/onboarding/tutorial/progress'), '/api/onboarding/tutorial/complete']);
  expect(posts.slice(0,4).map(p => p.body.stepId)).toEqual(TUTORIAL_STEPS.slice(1).map(tutorialStepId));
  expect(requests).toEqual([]); expect(opened).toEqual([]);
  expect(button('Prepare draft')).toBeDefined();
});

test('failed progress stays on the current step and replay resumes the saved target', async () => {
  status.tutorial_progress_step = tutorialStepId('context'); await mountWizard(); failProgress = true;
  await click('Next'); expect(container.textContent).toContain('3 of 5'); expect(container.textContent).toContain("Couldn't save");
});

for (const flag of [false, true]) for (const install of ['hosted','local'] as const) {
  test(`fresh ${install}, Brief flag ${flag}: setup selection and written interview remain canonical`, async () => {
    hosted = install === 'hosted'; status = { ...complete, setup_completed: false, profile_completed: false };
    window.history.replaceState(null, '', flag ? '/?brief=1#/brief/today' : '/'); await mountGate(flag);
    await click('Set up Jarvis');
    await click('Continue');
    if (hosted) {
      expect(container.textContent).toContain('Connect your everyday tools');
      expect(posts.find(p => p.url === '/api/onboarding/setup')?.body.llm).toEqual({ mode: 'multi-tier' });
      await click('Continue'); expect(container.textContent).toContain('your work, in your words');
      expect(container.querySelector('textarea')).not.toBeNull();
      expect(posts.some(p => p.url.includes('speak'))).toBe(false);
      await click('Skip'); await click('Skip tour');
      expect({ url: window.location.href, text: container.textContent?.slice(-400), exists: !!button(flag ? 'Prepare draft' : 'Review request in Talk') }).toMatchObject({ exists: true });
    } else {
      expect(container.textContent).toContain('Anthropic'); expect(container.textContent).toContain('Ollama');
      expect(posts.some(p => p.url === '/api/onboarding/setup')).toBe(false);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.obw-prov')].find(b => b.querySelector('.pn')?.textContent === 'Ollama')!.click());
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>('input[placeholder="http://localhost:11434"]')!;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'http://fixture.invalid');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('Test connection'); await click('Continue'); await click('Continue');
      // Keep optional voice off in the local fixture; no audio or provider effects.
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.obw-choice')].find(b => b.textContent?.includes('No voice'))!.click());
      await click('Continue'); expect(container.textContent).toContain('Connect your everyday tools');
      expect(posts.find(p => p.url === '/api/onboarding/setup')?.body.llm.providers.ollama).toEqual({ kind: 'ollama', base_url: 'http://fixture.invalid' });
      await click('Continue'); await click('Skip'); await click('Skip tour');
      expect(button(flag ? 'Prepare draft' : 'Review request in Talk')).toBeDefined();
    }
  });
}

test('Brief gate retains a failed final refresh and draft-room handoff without composing another draft', async () => {
  await mountGate(); await click('Skip tour'); await enter('Draft my weekly notes');
  failCompose = true; await click('Prepare draft');
  expect(container.querySelector('textarea')!.value).toBe('Draft my weekly notes');
  failCompose = false; await click('Check request');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  failOpen = true; await click('Review draft'); expect(container.textContent).toContain('Your task and draft are kept');
  failOpen = false; failStatus = true; await click('Review draft');
  // Status hook retries briefly; keep the test bounded by its real retry schedule.
  await waitFor(() => !!button('Review draft') && !button('Review draft').disabled);
  expect(container.querySelector('textarea')!.value).toBe('Draft my weekly notes');
  expect(container.textContent).not.toBe('Live shell'); failStatus = false; await click('Review draft');
  expect(container.textContent).toBe('Live shell'); expect(requests).toHaveLength(2); expect(draft.getSnapshot().routine).toBe('');
});

test('completed replay restores a saved unsent prompt; Explore requires no composition and clears only the handoff', async () => {
  status.tutorial_completed = true; draft.setRoutine('Retained before setup failed'); await mountGate();
  await waitFor(() => !!container.querySelector('textarea'));
  expect(container.querySelector('textarea')!.value).toBe('Retained before setup failed');
  await click('Explore Jarvis first'); expect(container.textContent).toBe('Live shell'); expect(requests).toEqual([]);
  expect(posts).toEqual([]); expect(draft.getSnapshot().request).toBeNull();
});

test('Explore ignores a late background poll and tutorial replay can prepare a new task', async () => {
  const submit = composition.submit;
  let receipt!: BriefCompositionJob, resolveRead: ((job: BriefCompositionJob) => void) | undefined;
  composition.submit = async request => {
    receipt = await submit(request);
    return { ...receipt, state: 'queued', workflow: null };
  };
  composition.read = () => new Promise(resolve => { resolveRead = resolve; });
  await mountGate(); await click('Skip tour'); await enter('Draft weekly notes'); await click('Prepare draft');

  // Hold the final status refresh long enough for the existing poll timer to start.
  const normalFetch = globalThis.fetch;
  let resolveStatus!: (response: Response) => void;
  globalThis.fetch = (async (url: string, init?: RequestInit) => url === '/api/onboarding/status'
    ? new Promise<Response>(resolve => { resolveStatus = resolve; }) : normalFetch(url, init)) as typeof fetch;
  try {
    await click('Explore Jarvis first'); await waitFor(() => !!resolveRead);
    await act(async () => { resolveStatus(Response.json(status)); });
    expect(container.textContent).toBe('Live shell');
    const cleared = draft.getSnapshot();
    expect(cleared).toMatchObject({ routine: '', request: null, job: null });
    await act(async () => { resolveRead!(receipt); });
    expect(draft.getSnapshot()).toBe(cleared);
  } finally { globalThis.fetch = normalFetch; }

  status.tutorial_completed = false; status.tutorial_dismissed = false; status.last_reset_at = 99;
  const peer = new BroadcastChannel('v2-onboarding-status');
  try {
    await act(async () => { peer.postMessage({ type: 'reset', scope: 'tutorial' }); await new Promise(r => setTimeout(r, 30)); });
    await click('Skip tour');
    expect(container.querySelector('textarea')!.disabled).toBe(false);
    composition.submit = submit;
    await enter('Prepare a different task'); await click('Prepare draft');
    expect(requests.map(request => request.prompt)).toEqual(['Draft weekly notes', 'Prepare a different task']);
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    expect(button('Review draft').disabled).toBe(false);
  } finally { peer.close(); }
});

for (const flag of [false, true]) test(`tutorial replay with Brief flag ${flag} preserves canonical dismissal and completion`, async () => {
  window.history.replaceState(null, '', flag ? '/?brief=1#/brief/settings' : '/#/_room_settings');
  await mountGate(flag);
  expect(container.textContent).toContain('1 of 5');
  for (let i = 0; i < 4; i++) await click('Next');
  await click('Finish'); expect(status.tutorial_completed).toBe(true); expect(status.tutorial_dismissed).toBe(false);
  await click('Explore Jarvis first'); expect(container.textContent).toBe('Live shell');
  expect(requests).toEqual([]); expect(opened).toEqual([]);
});

test('peer completion cannot discard the final prompt; peer replay resets the tour but keeps that prompt', async () => {
  await mountGate(); await click('Skip tour'); await enter('Keep my task across another tab');
  const peer = new BroadcastChannel('v2-onboarding-status');
  try {
    await act(async () => { peer.postMessage({ type: 'status_changed' }); await new Promise(r => setTimeout(r, 30)); });
    expect(container.querySelector('textarea')!.value).toBe('Keep my task across another tab');
    status.tutorial_completed = false; status.tutorial_dismissed = false; status.last_reset_at = 42;
    await act(async () => { peer.postMessage({ type: 'reset', scope: 'tutorial' }); await new Promise(r => setTimeout(r, 30)); });
    expect(container.textContent).toContain('1 of 5');
    await click('Skip tour'); expect(container.querySelector('textarea')!.value).toBe('Keep my task across another tab');
  } finally { peer.close(); }
});
