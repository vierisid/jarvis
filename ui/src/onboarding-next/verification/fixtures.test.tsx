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
