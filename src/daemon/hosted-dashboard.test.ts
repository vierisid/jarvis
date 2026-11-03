import { expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types';
import { configureHostedDashboard, hostedDashboardDefault, HOSTED_BRIEF_FEATURES } from './hosted-dashboard';
import { BriefCapabilities } from '../brief/capabilities';

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

test('self-hosted installs retain their existing defaults even with the hosted switch', () => {
  for (const choice of [undefined, 'brief', 'legacy']) {
    const env = { JARVIS_HOSTED_DASHBOARD: choice, JARVIS_BRIEF_MEMORY_USAGE: '1' };
    const before = { ...env };
    configureHostedDashboard(self, env);
    expect(env).toEqual(before);
    expect(hostedDashboardDefault(self, env)).toBe('legacy');
  }
});

test('operator rollback and unknown switch values retain the old dashboard without enabling providers', () => {
  for (const choice of ['legacy', '0', '', 'unexpected']) {
    const env = { JARVIS_HOSTED_DASHBOARD: choice };
    configureHostedDashboard(hosted, env);
    expect(hostedDashboardDefault(hosted, env)).toBe('legacy');
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
