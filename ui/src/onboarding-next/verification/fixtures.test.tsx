import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixtureProps } from './fixtures';
import { requiredCases, VIEWS } from './matrix';
import { complete, assess } from './report';

test('missing-connection recovery has fixed layout and keyboard cases in both themes', () => {
  const cases = requiredCases().filter(c => c.view === 'activation' && c.state === 'missing-connection');
  expect(cases).toHaveLength(8);
  for (const theme of ['light', 'dark']) {
    expect(cases.filter(c => c.theme === theme && c.kind === 'layout').map(c => c.width)).toEqual([390, 768, 1440]);
    expect(cases.filter(c => c.theme === theme && c.kind === 'keyboard')).toHaveLength(1);
  }
});

test('an old report cannot silently omit the new connection recovery rows', () => {
  const candidate = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false };
  const report = complete({ schemaVersion: 1, candidate, scope: 'fixture', inventory: { views: [], host: false, pebble: false, missing: VIEWS.map(v => v.id) }, cases: [], gates: [] });
  report.cases = report.cases.filter(c => !c.id.includes('--missing-connection--'));
  const result = assess(report, candidate.revision);
  expect(result.releaseReady).toBe(false);
  expect(result.errors.filter(e => e.startsWith('Missing case:') && e.includes('--missing-connection--'))).toHaveLength(8);
});

// Keep the harness importable without this optional owner, just like discovery.
const activationEntry = resolve(import.meta.dir, '../views/activation/index.tsx');
test.skipIf(!existsSync(activationEntry))('actual activation view renders Choose connection for every recovery fixture', async () => {
  const { ActivationView } = await import(activationEntry);
  const cases = requiredCases().filter(c => c.view === 'activation' && c.state === 'missing-connection');
  expect(cases).toHaveLength(8);
  for (const testCase of cases) {
    const props = fixtureProps(testCase, () => {});
    const html = renderToStaticMarkup(<ActivationView {...props} />);
    expect(props.model.phase).toBe('needs_input');
    expect(props.model.issues[0].kind).toBe('connection');
    expect(html).toContain('Choose a Google account');
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Choose connection<\/button>/);
    expect(html).toContain('Prepare meeting follow-ups for my review.');
  }
});

test.skipIf(!existsSync(activationEntry))('missing-detail coverage remains distinct from connection recovery', async () => {
  const { ActivationView } = await import(activationEntry);
  const testCase = requiredCases().find(c => c.view === 'activation' && c.state === 'needs_input')!;
  const html = renderToStaticMarkup(<ActivationView {...fixtureProps(testCase, () => {})} />);
  expect(html).toContain('Recipient');
  expect(html).toContain('<input');
  expect(html).not.toContain('Choose connection');
});

const viewEntry = (name: string) => resolve(import.meta.dir, `../views/${name}/index.tsx`);
test('every layout fixture renders its actual view when the view is present', async () => {
  for (const view of VIEWS) {
    if (!existsSync(viewEntry(view.name))) continue;
    const View = (await import(viewEntry(view.name)))[view.export];
    for (const c of requiredCases().filter(c => c.view === view.name && c.kind === 'layout' && c.width === 1440)) {
      const text = renderToStaticMarkup(<View {...fixtureProps(c, () => {})} />).replace(/<[^>]+>/g, ' ').trim();
      expect(text.length, c.id).toBeGreaterThan(20);
    }
  }
});

test('named fixture states reach the view state they claim', async () => {
  const render = async (view: string, state: string) => {
    const spec = VIEWS.find(v => v.name === view)!;
    if (!existsSync(viewEntry(view))) return null;
    const View = (await import(viewEntry(view)))[spec.export];
    const c = requiredCases().find(c => c.view === view && c.state === state && c.kind === 'layout')!;
    return renderToStaticMarkup(<View {...fixtureProps(c, () => {})} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };
  const expectations: [string, string, string | RegExp][] = [
    ['build', 'saved', 'Your draft is saved.'], ['build', 'failed', 'The build needs another try.'],
    ['build', 'disconnected', 'Reconnecting to your build.'], ['build', 'cancelled', 'The build was cancelled.'],
    ['interview', 'skipped', 'Interview skipped.'], ['interview', 'unknown-facts', 'Saved context unconfirmed'],
    ['result', 'ready', /Draft . Not enabled/], ['result', 'deleted', 'This saved draft is unavailable'],
  ];
  for (const [view, state, expected] of expectations) {
    const text = await render(view, state);
    if (text !== null) expect(text).toMatch(expected);
  }
});
