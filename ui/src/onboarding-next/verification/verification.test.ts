import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { catalogSource, discover } from './discovery';
import { FIGMA, GATES, JOURNEYS, requiredCases, ROOMS, VIEWS } from './matrix';
import { assess, blockReason, complete, evidenceIndex, hash, safePath, verifyArtifacts } from './report';
import type { Report } from './report';
import { problems } from './browser';
import { RETRY, retryProjection } from './retry-fixture';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(resolve(tmpdir(), 'u11-test-')); folders.push(dir); return dir; }
const revision = 'a'.repeat(40), candidate = { revision, tree: 'b'.repeat(40), dirty: false };
const emptyInventory = { views: [], host: false, pebble: false, missing: VIEWS.map(v => v.id) };
const fullInventory = { views: VIEWS.map(v => v.name), host: true, pebble: true, missing: [] };
function report(): Report { return complete({ schemaVersion: 1, candidate, scope: 'fixture', inventory: emptyInventory, cases: [], gates: [] }); }
async function addView(root: string, index = 0, patch = {}) {
  const view = VIEWS[index]!, dir = resolve(root, 'ui/src/onboarding-next/views', view.name); await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: view.id, kind: 'view', entry: './index.tsx', provides: [view.capability], requires: view.requires, ...patch }));
  await writeFile(resolve(dir, 'index.tsx'), 'throw Error("discovery must never execute me");'); return dir;
}
test('fixed inventory covers every owner/state, theme, width, tutorial room and four journeys', () => {
  const cases = requiredCases(); expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  for (const view of VIEWS) for (const state of view.states) for (const theme of ['light','dark']) for (const width of [390,768,1440]) expect(cases.some(c => c.view === view.name && c.state === state && c.theme === theme && c.width === width)).toBe(true);
  for (const room of ROOMS) expect(cases.some(c => c.view === 'tour' && c.state === room && c.sidebar === 'rail')).toBe(true);
  for (const journey of JOURNEYS) expect(cases.filter(c => c.kind === 'journey' && c.state === journey).length).toBe(4);
  expect(FIGMA.checkpoint).toBe('2410205462365531104');
});
test('empty and single-module discovery never executes source or emits absent imports', async () => {
  const root = await temp(); expect(await discover(root)).toEqual(emptyInventory); expect(catalogSource(root, emptyInventory)).not.toContain('import ');
  await addView(root); const inventory = await discover(root); expect(inventory.views).toEqual(['welcome']);
  const source = catalogSource(root, inventory); expect(source).toContain('/welcome/index.tsx'); expect(source).not.toContain('/result/'); expect(source).toContain('host = null');
});
test('physically removing a required view restores blocked cases without shrinking the matrix', async () => {
  const root = await temp(), dir = await addView(root); const before = await discover(root);
  await rm(dir, { recursive: true }); const after = await discover(root);
  const testCase = requiredCases()[0]!; expect(blockReason(testCase, before)).toBeNull(); expect(blockReason(testCase, after)).toContain('absent'); expect(report().cases.length).toBe(requiredCases().length);
});
test.each([{ entry: '../other.tsx' }, { id: 'ON-U-99' }, { provides: ['fake.v1'] }, { requires: [] }, { extra: true }, { kind: 'provider' }])('rejects incompatible manifest %j', async patch => {
  const root = await temp(); await addView(root, 0, patch); await expect(discover(root)).rejects.toThrow('Invalid manifest');
});
test('rejects symlinked entry and missing entry', async () => {
  const root = await temp(), dir = await addView(root); await rm(resolve(dir,'index.tsx')); await expect(discover(root)).rejects.toThrow('Missing entry');
  await writeFile(resolve(root, 'outside.tsx'), 'export {}'); await symlink(resolve(root,'outside.tsx'),resolve(dir,'index.tsx')); await expect(discover(root)).rejects.toThrow('Unsafe');
});
test('actual base manifests match frozen projections without importing sibling source', async () => {
  const inventory = await discover(resolve(import.meta.dir, '../../../..')); expect(inventory.missing.length + inventory.views.length).toBe(VIEWS.length);
  for (const name of inventory.views) expect(VIEWS.some(v => v.name === name)).toBe(true);
});
test('missing cases, skipped outcomes, duplicates and stale rows cannot pass', () => {
  const r = report(); expect(assess(r, revision).releaseReady).toBe(false); expect(assess(r, revision).counts.blocked).toBe(requiredCases().length);
  r.cases.pop(); expect(assess(r, revision).errors.some(e => e.startsWith('Missing case'))).toBe(true);
  r.cases.push({ ...r.cases[0]!, outcome: 'skipped' as any, revision: 'c'.repeat(40) });
  expect(assess(r, revision).errors.join()).toContain('duplicate'); expect(assess(r, revision).errors.join()).toContain('Stale'); expect(assess(r, revision).errors.join()).toContain('Invalid outcome');
});
test('candidate and inventory validation fail closed', () => {
  const r = report(); r.candidate = { ...candidate, dirty: true }; expect(assess(r, revision).errors.join()).toContain('clean');
  r.inventory.missing = []; expect(assess(r, revision).errors.join()).toContain('inconsistent');
});
test('absent views and placeholder canvas cannot claim a pass even with artifacts', () => {
  const r = report(), row = r.cases[0]!; row.outcome = 'passed'; row.evidence = [{ path: 'any.txt', sha256: hash('x') }];
  expect(assess(r, revision).errors.join()).toContain('Absent view'); expect(assess(r, revision).errors.join()).toContain('Required screenshot');
  r.inventory = fullInventory; const canvas = r.cases.find(c => c.id.startsWith('layout--result--ready'))!; canvas.outcome = 'passed'; expect(assess(r, revision).errors.join()).toContain('Unbound fixture');
});
test('all-green fixtures never authorize release and gates bind the candidate', () => {
  const r = report(); r.inventory = fullInventory; r.cases = r.cases.map(row => ({ ...row, outcome: 'passed', reason: 'Synthetic', evidence: [{ path: 'x.png', sha256: hash('x') }, { path: 'x.metrics.json', sha256: hash('x') }, { path: 'x.trace.json', sha256: hash('x') }, { path: 'x.review.json', sha256: hash('x') }] }));
  r.gates = GATES.map(owner => ({ owner, revision, outcome: 'passed', evidence: [{ path: 'gate.json', sha256: hash('x') }] }));
  expect(assess(r, revision).releaseReady).toBe(false);
  r.scope = 'runtime'; expect(assess(r, revision).releaseReady).toBe(true);
  r.gates[0]!.revision = 'c'.repeat(40); expect(assess(r, revision).releaseReady).toBe(false);
});
test('artifact verifier detects changes, missing files and escaping symlinks', async () => {
  const root = await temp(), outside = await temp(), r = report(); await writeFile(resolve(root,'proof.txt'),'proof');
  r.cases[0]!.evidence = [{ path: 'proof.txt', sha256: hash('proof') }]; expect(await verifyArtifacts(r, root)).toEqual([]);
  await writeFile(resolve(root,'proof.txt'),'changed'); expect((await verifyArtifacts(r,root)).length).toBe(1);
  await writeFile(resolve(outside,'external.txt'),'proof'); await symlink(resolve(outside,'external.txt'),resolve(root,'link.txt'));
  r.cases[0]!.evidence = [{ path: 'link.txt', sha256: hash('proof') }]; expect((await verifyArtifacts(r,root)).length).toBe(1);
  for (const path of ['../secret','https://test','/tmp/a','a//b','a/./b','a\\b']) expect(safePath(path)).toBe(false);
});
test('index escapes observations and keeps failed/blocked owner repair outcomes', () => {
  const r = report(); r.cases[0]!.reason = '<script>unsafe</script>'; r.cases[0]!.outcome = 'failed';
  const html = evidenceIndex(r); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('ON-U-01'); expect(html).toContain('Release BLOCKED'); expect(html).toContain('failed-build-retry');
});
test('geometry checks reject hidden Pebble, missing contour, mixed theme and premature build success', () => {
  const base = { revision, dirty: 'false', headings: ['Heading'], controls: ['Next'], childThemes: ['light'], theme: 'light', width: 1440, overflow: 0, clipped: [], unnamed: 0, buildPhases: [], text: '', contour: { shadow: 'rgb(45, 120, 255)', border: '', width: '' } };
  const testCase = requiredCases().find(c => c.view === 'pebble-tour' && c.state === 'open' && c.width === 1440 && c.theme === 'light')!;
  const metrics: any = { ...base, caseId: testCase.id, view: testCase.view, state: testCase.state, sidebar: testCase.sidebar, pebbleOpen: 'true', pebbleVisible: true };
  expect(problems(testCase, metrics, candidate)).toEqual([]);
  expect(problems(testCase, { ...metrics, pebbleVisible: false, contour: null, childThemes: ['dark'], clipped: ['Next'] }, candidate).length).toBe(4);
  const build = requiredCases().find(c => c.view === 'build' && c.state === 'saving')!;
  expect(problems(build, { ...metrics, caseId: build.id, view: build.view, state: build.state, width: build.width, text: 'Your draft is saved.' }, candidate).join()).toContain('Unverified build');
});

test('observation bytes bind the case and candidate beyond their file hash', async () => {
  const root = await temp(), r = report(), row = r.cases[0]!;
  const contents = JSON.stringify({ candidate, caseId: 'another-case', metrics: { revision, caseId: row.id }, errors: [] });
  await writeFile(resolve(root, 'wrong.metrics.json'), contents); row.evidence = [{ path: 'wrong.metrics.json', sha256: hash(contents) }];
  expect((await verifyArtifacts(r, root)).length).toBe(1);
});

test('a gate screenshot cannot replace its candidate-bound JSON receipt', () => {
  const r = report(); r.gates = [{ owner: 'ON-B-13', revision, outcome: 'passed', evidence: [{ path: 'gate.png', sha256: hash('image') }] }];
  expect(assess(r, revision).errors.join()).toContain('Gate not verified: ON-B-13');
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
