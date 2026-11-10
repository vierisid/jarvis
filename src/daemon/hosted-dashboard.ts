import type { JarvisConfig } from '../config/types';
import { isHostedInstall } from './usejarvis-ai';

/** Production dashboards use the same registered providers as local acceptance.
 * These defaults request activation; each provider still owns its readiness,
 * dependencies and Authority checks. Explicit operator overrides are retained. */
export const HOSTED_BRIEF_FEATURES = [
  'NAVIGATION_COMPATIBILITY', 'RECONCILIATION', 'ONBOARDING', 'CONVERSATIONS', 'CHAT_TRANSPORT', 'CHAT_STATE',
  'CHAT_ATTACHMENTS', 'CHAT_PROGRESS', 'WORKFLOW_COMPOSITION', 'COMPOSITION_INGREDIENTS', 'PREPARED_OPPORTUNITIES',
  'OPPORTUNITY_ACTIVATION', 'QUIET_AWARENESS', 'DECISIONS', 'DECISION_EDITS', 'RECOMMENDATIONS', 'GOAL_MEASUREMENTS',
  'OUTCOMES', 'MEMORY_STREAM', 'MEMORY_USAGE', 'MEMORY_FORGET', 'WORKFLOW_REMOVAL', 'WORKFLOW_CONTEXT', 'CONNECTIONS', 'PROFILE_SETTINGS',
] as const;

/** Defaults that change how awareness is delivered or spend model calls in the
 * background. Hosted turns them on; a self-hosted operator opts in with
 * JARVIS_BRIEF_<FEATURE>=1, so an upgrade neither silences proactive delivery
 * nor spends the operator's own provider keys (owner decision on #1311).
 * OPPORTUNITY_ACTIVATION stays in the common set: it depends on
 * preparedOpportunities, so it is closed until that is turned on. */
export const HOSTED_ONLY_BRIEF_FEATURES: readonly (typeof HOSTED_BRIEF_FEATURES[number])[] = ['QUIET_AWARENESS', 'PREPARED_OPPORTUNITIES'];

type Environment = Record<string, string | undefined>;
export function hostedDashboardDefault(_config: JarvisConfig, env: Environment = process.env): 'brief' | 'legacy' {
  // One production default for either deployment. The older JARVIS_HOSTED_DASHBOARD
  // name still selects legacy on any install (an operator who set it asked for the
  // previous UI); the common JARVIS_DASHBOARD takes precedence.
  const choice = env.JARVIS_DASHBOARD ?? env.JARVIS_HOSTED_DASHBOARD;
  return choice === undefined || choice === 'brief' ? 'brief' : 'legacy';
}

/** Run after config loading, before constructing any feature provider. */
export function configureHostedDashboard(config: JarvisConfig, env: Environment = process.env): void {
  if (hostedDashboardDefault(config, env) !== 'brief') return;
  const hosted = isHostedInstall(config);
  for (const feature of HOSTED_BRIEF_FEATURES) {
    if (!hosted && HOSTED_ONLY_BRIEF_FEATURES.includes(feature)) continue;
    env[`JARVIS_BRIEF_${feature}`] ??= '1';
  }
}
