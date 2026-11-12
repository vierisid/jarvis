/**
 * The environment `bun run dev:local` gives the daemon.
 *
 * Built from scratch on purpose: the launcher must not inherit credentials or
 * an existing hosted instance's settings. Anything a developer wants carried
 * across has to be named here.
 */
const PLATFORM_KEYS = ['TZ', 'SystemRoot', 'SYSTEMROOT', 'WSL_INTEROP', 'WSL_DISTRO_NAME'] as const;

const BRIEF_FEATURES = [
  'NAVIGATION_COMPATIBILITY', 'RECONCILIATION', 'ONBOARDING', 'CONVERSATIONS', 'CHAT_TRANSPORT', 'CHAT_STATE',
  'CHAT_ATTACHMENTS', 'CHAT_PROGRESS', 'WORKFLOW_COMPOSITION', 'COMPOSITION_INGREDIENTS', 'PREPARED_OPPORTUNITIES',
  'OPPORTUNITY_ACTIVATION', 'QUIET_AWARENESS', 'DECISIONS', 'DECISION_EDITS', 'RECOMMENDATIONS', 'GOAL_MEASUREMENTS',
  'OUTCOMES', 'MEMORY_STREAM', 'MEMORY_USAGE', 'MEMORY_FORGET', 'WORKFLOW_REMOVAL', 'WORKFLOW_CONTEXT', 'CONNECTIONS', 'PROFILE_SETTINGS',
] as const;

export interface DevPaths { home: string; data: string; tmp: string }

export function devEnv(parent: Record<string, string | undefined>, paths: DevPaths, port: number): Record<string, string> {
  const env: Record<string, string> = { PATH: parent.PATH ?? '', HOME: paths.home, TMPDIR: paths.tmp,
    LANG: parent.LANG ?? 'C.UTF-8', JARVIS_HOME: paths.data, JARVIS_SECRETS_DIR: paths.data,
    JARVIS_PORT: String(port), JARVIS_PUBLIC_URL: `http://localhost:${port}`, JARVIS_LOCAL_INTEGRATION: '1' };
  for (const key of PLATFORM_KEYS) if (parent[key]) env[key] = parent[key]!;
  for (const key of BRIEF_FEATURES) env[`JARVIS_BRIEF_${key}`] = '1';
  // The notch is off unless the caller asks for it by exactly "1", the same
  // rule the daemon applies (src/notch/switch.ts).
  if (parent.JARVIS_NOTCH === '1') env.JARVIS_NOTCH = '1';
  return env;
}
