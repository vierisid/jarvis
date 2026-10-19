import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPreview } from './build';
import { fixtureProps } from './fixtures';
import { journeyAssembly } from './journey';
import { fixtureCases, ROOMS, VIEWS } from './matrix';
import { RETRY, retryProjection } from './retry-fixture';
import { views } from './views';
import type { Case } from './matrix';

const render = (c: Case) => { const View = views[c.view]; return renderToStaticMarkup(<View {...fixtureProps(c, () => {})} />); };
const find = (view: string, state: string, theme = 'light') => fixtureCases().find(c => c.view === view && c.state === state && c.theme === theme)!;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('fixture cases cover every view state in both themes and every tour room in the rail', () => {
  const cases = fixtureCases();
  expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  for (const view of VIEWS) for (const state of view.states) for (const theme of ['light', 'dark'])
    expect(cases.some(c => c.view === view.name && c.state === state && c.theme === theme)).toBe(true);
  for (const room of ROOMS) expect(cases.some(c => c.view === 'tour' && c.state === room && c.sidebar === 'rail')).toBe(true);
});

test('every fixture case renders its actual view', () => {
  for (const c of fixtureCases()) expect(text(render(c)).trim().length, c.id).toBeGreaterThan(20);
});

test('state fixtures reach the view states they are named for', () => {
  expect(text(render(find('build', 'saved')))).toContain('Your draft is saved.');
  expect(text(render(find('build', 'failed')))).toContain('The build needs another try.');
  expect(text(render(find('build', 'disconnected')))).toContain('Reconnecting to your build.');
  expect(text(render(find('build', 'cancelled')))).toContain('The build was cancelled.');
  expect(text(render(find('interview', 'skipped')))).toContain('Interview skipped.');
  expect(text(render(find('interview', 'unknown-facts')))).toContain('Saved context unconfirmed');
  expect(text(render(find('result', 'ready')))).toMatch(/Draft . Not enabled/);
  expect(text(render(find('result', 'deleted')))).toContain('This saved draft is unavailable');
  for (const room of ['memory', 'billing']) expect(render(find('tour', room))).toContain(`data-room-id="${room}"`);
});

test('activation missing-connection offers an enabled Choose connection, distinct from the missing-detail form', () => {
  for (const theme of ['light', 'dark']) {
    const testCase = find('activation', 'missing-connection', theme), props = fixtureProps(testCase, () => {});
    expect(props.model.phase).toBe('needs_input');
    expect(props.model.issues[0].kind).toBe('connection');
    const html = render(testCase);
    expect(html).toContain('Choose a Google account');
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Choose connection<\/button>/);
  }
  const detail = render(find('activation', 'needs_input'));
  expect(detail).toContain('Recipient');
  expect(detail).toContain('<input');
  expect(detail).not.toContain('Choose connection');
});

test('retry fixtures preserve draft identity while replacing every old job reference', () => {
  const original = { jobId: 'old', requestId: 'old-request', flowId: 'flow', versionId: 'version' };
  const build = retryProjection('build', { ...original, status: { jobId: 'old', outcome: 'succeeded' }, result: { state: 'ready', reference: original } });
  const result = retryProjection('result', { ...original, result: { ...original, reference: original, recovery: { input: { jobId: 'old', expected: { flowId: 'flow' } } } } });
  expect(build.result.reference).toEqual({ ...original, ...RETRY });
  expect(result.result.reference).toEqual(build.result.reference);
  expect(result.result.recovery.input).toEqual({ jobId: RETRY.jobId, expected: { flowId: 'flow' } });
  expect(build.status.jobId).toBe(RETRY.jobId); expect(result.jobId).toBe(RETRY.jobId);
  expect(original.jobId).toBe('old');
});

const context = (assembly: ReturnType<typeof journeyAssembly>) => ({ journey: assembly.journey(), signal: new AbortController().signal } as any);

test('failed-build-retry journey fails the build, retries under a new job id, then saves', async () => {
  const trace: string[] = [], assembly = journeyAssembly('failed-build-retry', entry => trace.push(entry));
  const build = assembly.config.adapters.build!.create();
  expect(((await build.read(context(assembly))).model as any).status.outcome).toBe('failed');
  await build.command(context(assembly), 'retry', undefined);
  expect(assembly.journey().jobId).toBe(RETRY.jobId);
  for (let i = 0; i < 4; i++) assembly.advance();
  const saved = (await build.read(context(assembly))).model as any;
  expect(saved.status.outcome).toBe('succeeded');
  expect(saved.jobId).toBe(RETRY.jobId);
  expect(saved.result.reference.jobId).toBe(RETRY.jobId);
  expect(trace).toEqual(['build:retry']);
});

test('journeys connect Google unless they skip it, and replay returns to the tour', async () => {
  const connected = journeyAssembly('welcome-to-result'), skipped = journeyAssembly('skip-connection-interview');
  expect(((await connected.config.adapters.google!.create().read(context(connected))).model as any).connection.state).toBe('connected');
  expect(((await skipped.config.adapters.google!.create().read(context(skipped))).model as any).connection.state).toBe('idle');
  const trace: string[] = [], replay = journeyAssembly('tour-replay', entry => trace.push(entry));
  replay.replayTour();
  expect(replay.journey()).toMatchObject({ stepId: 'tour', tourState: 'in_progress', tourStepId: 'today' });
  expect(trace).toEqual(['fixture:replay']);
});

test('the preview bundle builds against the actual views and host', async () => {
  const output = await mkdtemp(resolve(tmpdir(), 'on-u-11-build-test-'));
  try {
    const result = await buildPreview(output);
    expect(result.logs.filter(log => log.level === 'error')).toEqual([]);
    expect(result.success).toBe(true);
    expect(await readdir(output)).toContain('index.html');
  } finally { await rm(output, { recursive: true, force: true }); }
}, 60_000);
