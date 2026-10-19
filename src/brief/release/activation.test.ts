import { expect, test } from 'bun:test';
import { ACTIVATION_MATRIX, BriefReleaseCapabilities, COMPATIBILITY_CHECKS, RELEASE_CARDS, assessRelease, type ReleaseRecord } from './activation';
import { BRIEF_CAPABILITY_IDS, BriefCapabilities, isBriefCapabilityEnabled } from '../capabilities';
import { createBriefRoutes } from '../routes';
import releaseRecord from './fixtures/release-record.json';

const revision = 'a'.repeat(40), runtime = { revision, deployment: 'hosted' as const, hostingRevision: 'b'.repeat(40) };
const provider = { readiness: () => 'ready' as const };
const registrations = BRIEF_CAPABILITY_IDS.map(id => ({ id, provider }));
function record(): ReleaseRecord {
  return { version: 1, revision, deployment: 'hosted', hostingRevision: runtime.hostingRevision, approvedCapabilities: [...BRIEF_CAPABILITY_IDS], rollback: 'feature_flags',
    prs: RELEASE_CARDS.map((card, i) => ({ card, repository: card === 'F-24' ? 'usejarvis/hosting' : 'vierisid/jarvis',
      number: i + 1, head: revision, state: 'MERGED', mergeCommit: 'b'.repeat(40) })),
    checks: Object.fromEntries([...COMPATIBILITY_CHECKS, 'hosted_pair'].map(name => [name, { status: 'passed', revision,
      ...(name === 'hosted_pair' ? { hostingRevision: runtime.hostingRevision } : {}), evidence: `fixture:${name}` }])) };
}
const snapshot = () => new BriefCapabilities(registrations, BRIEF_CAPABILITY_IDS).snapshot();

test('complete synthetic release evidence permits only requested and approved capabilities, never deployment', () => {
  const r = record();
  const report = assessRelease(r, snapshot(), runtime);
  expect(report.status).toBe('ready'); expect(report.deploymentAuthorized).toBe(false);
  for (const id of BRIEF_CAPABILITY_IDS) expect(report.capabilities[id].enabled).toBe(true);
  const disabled = new BriefReleaseCapabilities(registrations, [], runtime, () => r);
  for (const id of BRIEF_CAPABILITY_IDS) expect(isBriefCapabilityEnabled(disabled.snapshot(), id)).toBe(false);
});
test.each(RELEASE_CARDS)('%s must be merged; a PR, passing CI or closed-without-merge is insufficient', card => {
  for (const state of ['OPEN', 'CLOSED'] as const) {
    const r = record(); r.prs.find(p => p.card === card)!.state = state;
    expect(assessRelease(r, snapshot(), runtime).blockers).toContain(`pr_not_merged:${card}`);
    expect(new BriefReleaseCapabilities(registrations, BRIEF_CAPABILITY_IDS, runtime, () => r).snapshot().capabilities.chatState.enabled).toBe(false);
  }
  const r = record(); r.prs = r.prs.filter(p => p.card !== card);
  expect(assessRelease(r, snapshot(), runtime).status).toBe('blocked');
});
test.each([...COMPATIBILITY_CHECKS])('%s needs passing evidence for the current runtime revision', name => {
  for (const status of ['failed', 'blocked', 'not_run'] as const) {
    const r = record(); r.checks[name]!.status = status;
    expect(assessRelease(r, snapshot(), runtime).blockers).toContain(`check_not_passed:${name}`);
  }
  const r = record(); r.checks[name]!.revision = 'c'.repeat(40);
  expect(assessRelease(r, snapshot(), runtime).status).toBe('blocked');
});
test('missing, malformed, unknown-major and stale deployment records cannot authorize controls', () => {
  const r = record();
  for (const value of [undefined, {}, { ...r, version: 2 }, { ...r, approvedCapabilities: ['constructor'] },
    { ...r, prs: [...r.prs, r.prs[0]] }, { ...r, checks: { fresh: { status: 'passed', revision, evidence: '' } } }]) {
    expect(assessRelease(value, snapshot(), runtime).blockers).toContain('invalid_or_missing_release_record');
  }
  expect(assessRelease(r, snapshot(), { ...runtime, revision: 'd'.repeat(40) }).blockers).toContain('runtime_mismatch');
  expect(assessRelease(r, snapshot(), { ...runtime, deployment: 'self_hosted' }).blockers).toContain('runtime_mismatch');
  r.rollback = 'previous_binary';
  expect(assessRelease(r, snapshot(), runtime).blockers).toContain('check_not_passed:binary_rollback');
});
test.each(Object.entries(ACTIVATION_MATRIX))('%s fails closed for every absent, degraded or unrequested member', (_family, group) => {
  for (const missing of group.requires) {
    for (const mode of ['missing', 'unavailable', 'disabled'] as const) {
      const providers = registrations.filter(r => mode !== 'missing' || r.id !== missing).map(r => r.id === missing && mode === 'unavailable'
        ? { id: r.id, provider: { readiness: () => 'unavailable' as const } } : r);
      const requested = BRIEF_CAPABILITY_IDS.filter(id => mode !== 'disabled' || id !== missing);
      const registry = new BriefReleaseCapabilities(providers, requested, runtime, record);
      for (const action of group.actions) expect(registry.snapshot().capabilities[action].enabled).toBe(false);
    }
    const r = record(); r.approvedCapabilities = r.approvedCapabilities.filter(id => id !== missing);
    for (const action of group.actions) expect(assessRelease(r, snapshot(), runtime).capabilities[action].enabled).toBe(false);
  }
});
test('dynamic loss of release evidence or provider readiness closes the same API registry without stale true flags', () => {
  let healthy = true, current: unknown = record();
  const providers = registrations.map(r => r.id === 'chatState' ? { id: r.id, provider: { readiness: () => healthy ? 'ready' as const : 'unavailable' as const } } : r);
  const registry = new BriefReleaseCapabilities(providers, BRIEF_CAPABILITY_IDS, runtime, () => current);
  expect(registry.snapshot().capabilities.chatTransport.enabled).toBe(true);
  healthy = false; expect(registry.snapshot().capabilities.chatTransport.enabled).toBe(false);
  healthy = true; expect(registry.snapshot().capabilities.chatTransport.enabled).toBe(true);
  current = undefined;
  for (const id of BRIEF_CAPABILITY_IDS) expect(registry.snapshot().capabilities[id].enabled).toBe(false);
});
test('release gates compose with real API refusal paths and old-server client fallback', async () => {
  let calls = 0;
  const decisions = { readiness: () => 'ready' as const, read: () => { calls++; return { state: 'empty', asOf: 1 }; } };
  const registry = new BriefReleaseCapabilities([{ id: 'decisions', provider: decisions }], ['decisions'], runtime);
  const routes = createBriefRoutes(registry, (body, status = 200) => Response.json(body, { status }), undefined, undefined, undefined, undefined,
    undefined, decisions as any);
  const response = await routes['/api/brief/decisions']!.GET!(new Request('http://fixture/api/brief/decisions') as any);
  expect(response.status).toBe(503); expect(calls).toBe(0);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  for (const old of [null, {}, { contractVersion: 0 }, { contractVersion: 2, capabilities: snapshot().capabilities }]) {
    for (const id of BRIEF_CAPABILITY_IDS) expect(assessRelease(record(), old, runtime).capabilities[id].enabled).toBe(false);
  }
});
test('self-hosted account is explicitly unsupported and shell opt-in cannot activate features', () => {
  const r = record(); r.deployment = 'self_hosted';
  expect(assessRelease(r, snapshot(), { ...runtime, deployment: 'self_hosted' }).capabilities.hostedAccount.blockers)
    .toContain('unsupported_deployment:hostedAccount');
  r.approvedCapabilities = [];
  const withShell = { ...r, visualShell: true, JARVIS_BRIEF: '1' };
  const report = assessRelease(withShell, snapshot(), { ...runtime, deployment: 'self_hosted' });
  for (const id of BRIEF_CAPABILITY_IDS) expect(report.capabilities[id].enabled).toBe(false);
});
test('hosted releases require the exact hosting/brain pair and separate read-only contract evidence', () => {
  const r = record();
  expect(assessRelease(r, snapshot(), { ...runtime, hostingRevision: undefined }).blockers).toContain('hosting_revision_mismatch');
  expect(assessRelease(r, snapshot(), { ...runtime, hostingRevision: 'c'.repeat(40) }).blockers).toContain('hosting_revision_mismatch');
  r.checks.hosted_pair!.status = 'not_run';
  expect(assessRelease(r, snapshot(), runtime).blockers).toContain('check_not_passed:hosted_pair');
});
test('changing the hosting revision cannot reuse evidence from the previous deployment pair', () => {
  const r = record(); r.hostingRevision = 'c'.repeat(40);
  expect(assessRelease(r, snapshot(), { ...runtime, hostingRevision: r.hostingRevision }).blockers)
    .toContain('check_not_passed:hosted_pair');
});
test('all capabilities retain their ordinary transitive dependencies through release approval', () => {
  const r = record(); r.approvedCapabilities = r.approvedCapabilities.filter(id => id !== 'memoryUsage');
  expect(assessRelease(r, snapshot(), runtime).capabilities.memoryStream.enabled).toBe(false);
  const failed = new BriefReleaseCapabilities(registrations, BRIEF_CAPABILITY_IDS, runtime, () => { throw Error('secret'); });
  expect(JSON.stringify(failed.assessment())).not.toContain('secret');
  expect(failed.snapshot().capabilities.conversations.enabled).toBe(false);
});
test('checked-in activation record covers every prerequisite and truthfully leaves the source stack disabled', () => {
  expect(releaseRecord.prs.map(p => p.card).sort()).toEqual([...RELEASE_CARDS].sort());
  const report = assessRelease(releaseRecord, snapshot(), { revision: releaseRecord.revision, deployment: 'self_hosted' });
  expect(report.blockers).not.toContain('invalid_or_missing_release_record');
  expect(report.status).toBe('blocked');
  expect(releaseRecord.activeCapabilities).toEqual([]);
  expect(releaseRecord.releaseEnabled).toBe(false);
  for (const id of BRIEF_CAPABILITY_IDS) expect(report.capabilities[id].enabled).toBe(false);
});
test('an unavailable composite action does not disable unrelated usable lower-level providers', () => {
  const r = record(); r.approvedCapabilities = r.approvedCapabilities.filter(id => !['opportunityActivation', 'workflowRemoval'].includes(id));
  const report = assessRelease(r, snapshot(), runtime);
  expect(report.capabilities.preparedOpportunities.enabled).toBe(false);
  expect(report.capabilities.workflowRemoval.enabled).toBe(false);
  for (const id of ['workflowComposition', 'compositionIngredients', 'reconciliation', 'workflowContext', 'goalMeasurements'] as const)
    expect(report.capabilities[id].enabled).toBe(true);
});
test('release evaluation bundles for browser consumers without backend or SQLite imports', async () => {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/activation.ts`], target: 'browser' });
  expect(build.success).toBe(true);
  for (const output of build.outputs) expect(await output.text()).not.toContain('bun:sqlite');
});
