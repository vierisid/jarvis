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

type Environment = Record<string, string | undefined>;
export function hostedDashboardDefault(config: JarvisConfig, env: Environment = process.env): 'brief' | 'legacy' {
  // One production default for either deployment. Keep the hosted-only alias
  // compatible, with an explicit common rollback taking precedence.
  const choice = env.JARVIS_DASHBOARD ?? (isHostedInstall(config) ? env.JARVIS_HOSTED_DASHBOARD : undefined);
  return choice === undefined || choice === 'brief' ? 'brief' : 'legacy';
}

/** Run after config loading, before constructing any feature provider. */
export function configureHostedDashboard(config: JarvisConfig, env: Environment = process.env): void {
  if (hostedDashboardDefault(config, env) !== 'brief') return;
  for (const feature of HOSTED_BRIEF_FEATURES) env[`JARVIS_BRIEF_${feature}`] ??= '1';
}
