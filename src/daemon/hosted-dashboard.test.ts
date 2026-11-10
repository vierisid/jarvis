import { expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types';
import { configureHostedDashboard, hostedDashboardDefault, HOSTED_BRIEF_FEATURES, HOSTED_ONLY_BRIEF_FEATURES } from './hosted-dashboard';
import { BriefCapabilities, type BriefCapabilityId } from '../brief/capabilities';

const self = structuredClone(DEFAULT_CONFIG) as JarvisConfig;
const hosted = { ...self, daemon: { ...self.daemon, listen: 'unix:/run/jarvis/instance.sock' } };

test('a normal hosted install enables the dashboard and its provider defaults without development flags', () => {
  const env: Record<string, string | undefined> = {};
  configureHostedDashboard(hosted, env);
  expect(hostedDashboardDefault(hosted, env)).toBe('brief');
  expect(Object.keys(env)).toHaveLength(HOSTED_BRIEF_FEATURES.length);
  for (const feature of HOSTED_BRIEF_FEATURES) expect(env[`JARVIS_BRIEF_${feature}`]).toBe('1');
  expect(env.JARVIS_LOCAL_INTEGRATION).toBeUndefined();
});

test('self-hosted production enables Brief and Needs you but not quiet awareness or background preparation', () => {
  const env: Record<string, string | undefined> = {};
  configureHostedDashboard(self, env);
  expect(hostedDashboardDefault(self, env)).toBe('brief');
  expect([...HOSTED_ONLY_BRIEF_FEATURES].sort()).toEqual(['PREPARED_OPPORTUNITIES', 'QUIET_AWARENESS']);
  for (const feature of HOSTED_BRIEF_FEATURES)
    expect(env[`JARVIS_BRIEF_${feature}`]).toBe(HOSTED_ONLY_BRIEF_FEATURES.includes(feature) ? undefined : '1');
  expect(env.JARVIS_BRIEF_DECISIONS).toBe('1');
  expect(Object.keys(env)).toHaveLength(HOSTED_BRIEF_FEATURES.length - HOSTED_ONLY_BRIEF_FEATURES.length);
  expect(env.JARVIS_LOCAL_INTEGRATION).toBeUndefined();
  expect(env.JARVIS_HOSTED_DASHBOARD).toBeUndefined();
  // Activation is defaulted but closed by its dependency until preparation is turned on.
  const capabilities = (enable: readonly BriefCapabilityId[]) => new BriefCapabilities([
    { id: 'preparedOpportunities', provider: { readiness: () => 'ready' } },
    { id: 'opportunityActivation', provider: { readiness: () => 'ready' } },
  ], enable).snapshot().capabilities;
  expect(capabilities(['opportunityActivation']).opportunityActivation).toMatchObject({ enabled: false, reason: 'dependency_not_ready' });
  expect(capabilities(['opportunityActivation']).preparedOpportunities).toMatchObject({ enabled: false, reason: 'disabled' });
});

test('a self-hosted operator opts in to the hosted-only defaults or keeps any default off', () => {
  const env: Record<string, string | undefined> = { JARVIS_BRIEF_QUIET_AWARENESS: '1', JARVIS_BRIEF_PREPARED_OPPORTUNITIES: '1', JARVIS_BRIEF_DECISIONS: '0' };
  configureHostedDashboard(self, env);
  expect(env.JARVIS_BRIEF_QUIET_AWARENESS).toBe('1');
  expect(env.JARVIS_BRIEF_PREPARED_OPPORTUNITIES).toBe('1');
  expect(env.JARVIS_BRIEF_OPPORTUNITY_ACTIVATION).toBe('1');
  expect(env.JARVIS_BRIEF_DECISIONS).toBe('0');
});

test('the dashboard override supports either installation and takes precedence over the hosted alias', () => {
  for (const config of [self, hosted]) {
    for (const choice of ['legacy', '0', '', 'unexpected']) {
      const env = { JARVIS_DASHBOARD: choice, JARVIS_HOSTED_DASHBOARD: 'brief' };
      configureHostedDashboard(config, env);
      expect(hostedDashboardDefault(config, env)).toBe('legacy');
      expect(Object.keys(env)).toHaveLength(2);
    }
    expect(hostedDashboardDefault(config, { JARVIS_DASHBOARD: 'brief', JARVIS_HOSTED_DASHBOARD: 'legacy' })).toBe('brief');
  }
});

test('operator rollback and unknown switch values retain the old dashboard without enabling providers', () => {
  // The older name is honoured on self-hosted installs too: an operator who set it asked for legacy.
  for (const config of [hosted, self]) for (const choice of ['legacy', '0', '', 'unexpected']) {
    const env = { JARVIS_HOSTED_DASHBOARD: choice };
    configureHostedDashboard(config, env);
    expect(hostedDashboardDefault(config, env)).toBe('legacy');
    expect(env).toEqual({ JARVIS_HOSTED_DASHBOARD: choice });
  }
});

test('explicit feature disables survive defaults and dependencies still fail closed', () => {
  const env = { JARVIS_BRIEF_CONVERSATIONS: '0', JARVIS_BRIEF_PROFILE_SETTINGS: '' };
  configureHostedDashboard(hosted, env);
  expect(env.JARVIS_BRIEF_CONVERSATIONS).toBe('0');
  expect(env.JARVIS_BRIEF_PROFILE_SETTINGS).toBe('');
  const capabilities = new BriefCapabilities([
    { id: 'conversations', provider: { readiness: () => 'ready' } },
    { id: 'chatTransport', provider: { readiness: () => 'ready' } },
    { id: 'workflowComposition', provider: { readiness: () => 'unavailable' } },
  ], ['chatTransport', 'workflowComposition']);
  expect(capabilities.snapshot().capabilities.chatTransport).toMatchObject({ enabled: false, reason: 'dependency_not_ready' });
  expect(capabilities.snapshot().capabilities.workflowComposition.enabled).toBe(false);
});
