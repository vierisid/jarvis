import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { activationFeedback } from './feedback.ts';
import { fixture, issue, owner, ref, submission } from './test-fixture.ts';
import { intentScopeId } from './index.ts';
import type { ContextRef, IntentResult, Submission } from './types.ts';
const viewPath = '../../../ui/src/onboarding-next/views/activation/index.tsx';
const hostPath = '../../../ui/src/onboarding-next/host/session.ts', fixturePath = '../../../ui/src/onboarding-next/host/test-fixture.ts';
const cases = [{ id: 'meeting', label: 'Meeting follow-up', required: 'note' },
  { id: 'update', label: 'Weekly update', required: 'metrics' }, { id: 'competitor', label: 'Competitor brief', required: 'source' }];
/** A deterministic stand-in for the existing service's read-only assessment.
 * These requirements are fixtures, not production keyword rules or templates. */
function services(required: string) {
  const f = fixture();
  f.services.assess = async input => {
    f.calls.push('assess');
    return { schemaVersion: 1, issues: input.references.some(r => r.ref.kind === required) || input.answers[required]?.trim()
      ? [] : [issue(required)] };
  };
  return f;
}
describe.skipIf(!existsSync(join(import.meta.dir, viewPath)))('actual U07 activation view and B07 validation', () => {
  let act: any, createRoot: any, View: any, examples: Array<{ id: string; prompt: string }>, root: any, element: HTMLElement;
  const originalAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  beforeAll(async () => {
    GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
    ({ ActivationView: View, activationExamples: examples } = await import(viewPath));
  });
  afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; element?.remove(); });
  afterAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });
  async function recoveryHarness(f: ReturnType<typeof fixture>, draft: any, issues: any[] = []) {
    let model: any = { journeyId: 'recovery', revision: 0, theme: 'light', availability: 'ready', phase: 'ready', draft, issues };
    let last: IntentResult | undefined, calls = 0;
    const render = () => root.render(<View model={model} onDraftChange={(draft: unknown) => { model = { ...model, draft }; render(); }}
      onIntent={async (intent: Submission) => {
        calls++; last = await f.provider.validate(null, { action: intent.action, request: intent.request, answers: intent.answers });
        model = { ...model, ...activationFeedback(last), revision: model.revision + 1 }; render();
      }} />);
    element = document.createElement('div'); document.body.append(element); root = createRoot(element);
    await act(async () => render());
    return {
      model: () => model, result: () => last, calls: () => calls,
      async click(label: string) {
        const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label);
        if (!button) throw Error(`Missing ${label}`); await act(async () => button.click());
      },
      async answer(value: string) {
        const input = element.querySelector<HTMLInputElement>('input[type="text"]');
        if (!input) throw Error('Missing correction field');
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      },
    };
  }
  test('a temporary assessment failure retains clarification fields and allows an explicit retry', async () => {
    const f = fixture(), assess = f.services.assess;
    f.services.assess = async () => { throw Error('temporary'); };
    const h = await recoveryHarness(f, { prompt: 'Draft my follow-up', contextRefs: [], answers: { notes: 'Original notes' } }, [issue('notes')]);
    await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ reason: 'service_unavailable' });
    expect(element.querySelector('input')?.value).toBe('Original notes');
    expect(element.querySelector('button[type="submit"]')?.getAttribute('aria-disabled')).toBe('false');
    f.services.assess = assess; await h.click('Create my workflow');
    expect(h.calls()).toBe(2); expect(h.result()).toMatchObject({ state: 'ready' });
  });
  test('an overlong clarification remains editable and can be corrected without losing the prompt', async () => {
    const f = fixture(), original = 'n'.repeat(2001), prompt = '  Draft my follow-up.  ';
    const h = await recoveryHarness(f, { prompt, contextRefs: [], answers: { notes: original } }, [issue('notes')]);
    await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ availability: 'ready', state: 'invalid', intent: null });
    expect(element.querySelector('input')?.value).toBe(original); expect(f.calls).not.toContain('assess');
    await h.answer('Corrected notes'); expect(h.model().draft.answers.notes).toBe('Corrected notes');
    await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ state: 'ready', intent: { request: { prompt }, answers: { notes: 'Corrected notes' } } });
  });
  test.each(['note', 'connection'])('an unavailable %s can be explicitly removed without clearing other selections', async kind => {
    const f = fixture(), broken = ref(kind, 'selected'), retained = ref('source', 'selected'), resolve = f.services.resolve;
    f.services.resolve = async r => r.kind === broken.kind ? { availability: 'unavailable' } : resolve(r);
    const h = await recoveryHarness(f, { prompt: 'Draft from my selected sources', contextRefs: [broken, retained], answers: { notes: 'Keep these notes' } });
    await h.click('Create my workflow'); expect(h.result()).toMatchObject({ state: 'needs_input' });
    expect(element.querySelectorAll('input[type="text"]').length).toBe(0);
    await h.click('Remove selection');
    expect(h.calls()).toBe(1); expect(f.calls).not.toContain('assess');
    expect(h.model().draft).toEqual({ prompt: 'Draft from my selected sources', contextRefs: [retained], answers: { notes: 'Keep these notes' } });
    await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ state: 'ready', intent: { request: { contextRefs: [retained] } } });
  });
  test('removing an essential reference still requires explicit replacement data and another Create', async () => {
    const f = services('note'); f.services.resolve = async () => ({ availability: 'unavailable' });
    const h = await recoveryHarness(f, { prompt: 'Draft a follow-up', contextRefs: [ref('note', 'deleted')], answers: {} });
    await h.click('Create my workflow'); await h.click('Remove selection');
    expect(h.calls()).toBe(1); await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ state: 'needs_input', intent: null, issues: [{ id: 'note' }] });
    await h.answer('Replacement meeting notes'); expect(h.calls()).toBe(2);
    await h.click('Create my workflow');
    expect(h.result()).toMatchObject({ state: 'ready', intent: { answers: { note: 'Replacement meeting notes' }, references: [] } });
  });
  test.each(cases)('$label remains editable and requires an explicit create with available data', async c => {
    const f = services(c.required); let last: IntentResult | undefined, calls = 0;
    let model: any = { journeyId: 'journey', revision: 0, theme: 'light', availability: 'ready', phase: 'ready',
      draft: { prompt: '', contextRefs: [], answers: {} } };
    const render = () => root.render(<View model={model} onDraftChange={(draft: unknown) => { model = { ...model, draft }; render(); }}
      onIntent={async (intent: Submission) => {
        calls++; last = await f.provider.validate(null, { action: intent.action, request: intent.request, answers: intent.answers });
        model = { ...model, ...activationFeedback(last), revision: model.revision + 1 }; render();
      }} />);
    element = document.createElement('div'); document.body.append(element); root = createRoot(element);
    await act(async () => render());
    const click = async (label: string) => {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label);
      if (!button) throw Error(`Missing ${label}`); await act(async () => button.click());
    };
    await click(c.label);
    expect(calls).toBe(0); expect(f.calls).toEqual([]); expect(model.draft.prompt).toBe(examples.find(e => e.id === c.id)!.prompt);
    await click('Create my workflow');
    expect(last).toMatchObject({ state: 'needs_input', intent: null }); expect(model.phase).toBe('needs_input');
    const prompt = `${model.draft.prompt}\nKeep my original wording and review first.`;
    model = { ...model, draft: { prompt, contextRefs: [ref(c.required)], answers: {} } };
    await act(async () => render()); await click('Create my workflow');
    expect(last).toMatchObject({ state: 'ready', intent: { request: { prompt, contextRefs: [ref(c.required)] } } });
    expect(model.phase).toBe('ready'); expect(model.message).toContain('No workflow has been created'); expect(calls).toBe(2);
  });
  test('missing Google is actionable and user-provided notes remain untrusted answers', async () => {
    const f = services('note'); const input = submission(examples.find(e => e.id === 'meeting')!.prompt);
    input.request.contextRefs = [ref('connection', 'google')]; input.answers = { note: 'My notes: prepare an agenda; never send automatically.' };
    f.services.resolve = async () => ({ availability: 'unavailable' });
    expect(await f.provider.validate(null, input)).toMatchObject({ state: 'needs_input', submission: input, issues: [{ kind: 'connection' }], intent: null });
    input.request.contextRefs = [];
    expect(await f.provider.validate(null, input)).toMatchObject({ state: 'ready', intent: { answers: input.answers, references: [] } });
  });
});

test.skipIf(!existsSync(join(import.meta.dir, hostPath)))('U10 consumes B07 feedback without claiming B08 accepted a job', async () => {
  const { createSession } = await import(hostPath), { fixture: hostFixture } = await import(fixturePath);
  const h = hostFixture(), f = services('note'); let draft = { prompt: 'Draft my follow-up', contextRefs: [] as ContextRef[], answers: {} }, revision = 0;
  let feedback = activationFeedback({ availability: 'ready', schemaVersion: 1, state: 'ready', submission: submission(), issues: [], intent: null });
  const presentation = () => ({ model: { journeyId: 'journey', revision, theme: 'light', draft, ...feedback } });
  h.setJourney({ scopeId: intentScopeId(owner), stepId: 'activation', setupState: 'completed', interviewState: 'done', tourState: 'done' });
  h.config.adapters.activation = { available: () => true, create: () => ({ available: () => true,
    read: async () => presentation(), setDraft: (_c: unknown, value: typeof draft) => { draft = value; return presentation(); },
    command: async (_c: unknown, action: string, input: Submission) => {
      feedback = { ...feedback, ...activationFeedback(await f.provider.validate(null, { action, request: input.request, answers: input.answers })) }; revision++;
    } }) };
  const host = createSession(h.config);
  try {
    await host.start(); host.draft(host.key(), draft); expect(f.calls).toEqual([]);
    await host.act(host.key(), 'create', submission(draft.prompt)); expect(host.state().presentation.model.phase).toBe('needs_input');
    const input = submission(draft.prompt); input.answers = { note: 'Explicitly supplied meeting notes' };
    await host.act(host.key(), 'create', input); expect(host.state().presentation.model.phase).toBe('ready');
    expect(host.state().view).toBe('activation'); expect(host.state().journey.activationState).toBe('pending');
  } finally { host.dispose(); }
});
