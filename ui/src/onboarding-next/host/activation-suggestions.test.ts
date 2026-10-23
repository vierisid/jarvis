import { expect, test } from 'bun:test';
import { interviewSuggestions } from './activation-suggestions';
import { createLiveOnboardingAdapters } from './live-adapters';
import type { Context, } from './contract';
const facts = [
  { theme: 'work', summary: 'Runs a surf apparel brand' },
  { theme: 'goals', summary: 'Grow sales' },
  { theme: 'goals', summary: 'Reach 50 orders a month by December' },
  { theme: 'rhythm', summary: 'Prepare a Friday sales summary' },
  { theme: 'tools', summary: 'Uses Shopify and Google Sheets' },
  { theme: 'scope', summary: 'Review all drafts before sending' },
];
test('suggestion combines the latest goal, actual routine, tools and approval preferences', () => {
  const result = interviewSuggestions(facts);
  expect(result.goal).toBe(facts[2]!.summary);
  expect(result.suggestions).toHaveLength(1);
  const suggestion = result.suggestions[0]!;
  expect(suggestion.label).toBe(facts[3]!.summary);
  for (const i of [0, 2, 3, 4, 5]) expect(suggestion.prompt).toContain(facts[i]!.summary);
  expect(suggestion.prompt).not.toContain('Grow sales');
  expect(suggestion.prompt).not.toContain('investor');
});
test('different work stays personal without domain templates or an invented routine', () => {
  const result = interviewSuggestions([{ theme: 'goals', summary: 'Finish my ceramics exhibition' }]);
  expect(result.suggestions[0]!.prompt).toContain('plan the next step toward this goal: Finish my ceramics exhibition');
  expect(result.suggestions[0]!.prompt).not.toContain('Friday');
  expect(interviewSuggestions([{ theme: 'work', summary: 'I am a potter' }]).suggestions).toEqual([]);
});
test('long facts never create overlong prompts or cut off an approval boundary', () => {
  const result = interviewSuggestions([...facts, { theme: 'work', summary: 'x'.repeat(4000) }]);
  expect(result.suggestions[0]!.prompt.length).toBeLessThanOrEqual(2000);
  expect(result.suggestions[0]!.prompt).toContain('Review all drafts before sending');
  expect(result.suggestions[0]!.prompt).not.toContain('xxx');
  expect(interviewSuggestions([{ theme: 'goals', summary: 'x'.repeat(4000) }]).suggestions).toEqual([]);
  expect(interviewSuggestions([...facts, { theme: 'scope', summary: 'x'.repeat(4000) }]).suggestions).toEqual([]);
});
function fixture() {
  const values = new Map<string, string>(); let current = facts, error = false, reads = 0;
  const adapters = createLiveOnboardingAdapters({ available: () => true,
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
    readInterviewFacts: async () => { reads++; if (error) throw Error('offline'); return current; },
  } as any);
  const adapter = adapters.activation!.create();
  const context = { journey: { scopeId: 'owner', journeyId: 'journey', revision: 1, interviewState: 'done' }, signal: new AbortController().signal } as Context;
  return { adapter, context, values, setFacts: (value: typeof facts) => { current = value; }, fail: () => { error = true; }, reads: () => reads };
}
test('reload refreshes canonical suggestions without overwriting an edited or deliberately cleared draft', async () => {
  const f = fixture(); const first = await f.adapter.read(f.context);
  expect((first.model.interview as any).goal).toBe(facts[2]!.summary);
  expect((first.model.draft as any).prompt).toBe('');
  for (const prompt of ['My edited request', '']) {
    f.adapter.setDraft!(f.context, { prompt, contextRefs: [], answers: {} });
    expect((await f.adapter.read(f.context)).model.draft).toEqual({ prompt, contextRefs: [], answers: {} });
  }
  f.setFacts([]); expect((await f.adapter.read(f.context)).model.interview).toEqual({ state: 'ready', suggestions: [], goal: undefined });
});
test('skipped interview never reads another profile; failure does not show stale suggestions', async () => {
  const f = fixture();
  await f.adapter.read({ ...f.context, journey: { ...f.context.journey, interviewState: 'skipped' } }); expect(f.reads()).toBe(0);
  await f.adapter.read(f.context); f.fail();
  expect((await f.adapter.read(f.context)).model.interview).toEqual({ state: 'unavailable', suggestions: [] });
});


test('only confirmed failed build history releases an uncertain request for editing', async () => {
  const f = fixture();
  const data = { prompt: 'Keep my request', contextRefs: [], answers: {}, pendingRequest: { request: { requestId: 'failed-request' }, answers: {} } };
  f.values.set('onboarding-next:draft:v1:["owner","journey","activation"]', JSON.stringify({ schemaVersion: 1, value: data }));
  expect((await f.adapter.read(f.context)).model.pendingRequest).toEqual(data.pendingRequest);
  const recovered = await f.adapter.read({ ...f.context, journey: { ...f.context.journey, jobId: null, buildRequestId: null,
    buildHistory: [{ buildRequestId: 'failed-request', jobId: 'failed-job', outcome: 'failed' }] } });
  expect(recovered.model.pendingRequest).toBeUndefined(); expect((recovered.model.draft as any).prompt).toBe(data.prompt);
  expect(recovered.model.message).toContain('wasn’t created');
  expect(f.adapter.setDraft!(f.context, { prompt: 'Edited request', contextRefs: [], answers: {} }).model.draft).toMatchObject({ prompt: 'Edited request' });
});
