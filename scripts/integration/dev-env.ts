/**
 * The environment `bun run dev:local` gives the daemon.
 *
 * Built from scratch on purpose: the launcher must not inherit credentials or
 * an existing hosted instance's settings. Anything a developer wants carried
 * across has to be named here.
 */
import { isAbsolute } from 'node:path';

const PLATFORM_KEYS = ['TZ', 'SystemRoot', 'SYSTEMROOT', 'WSL_INTEROP', 'WSL_DISTRO_NAME'] as const;

const BRIEF_FEATURES = [
  'NAVIGATION_COMPATIBILITY', 'RECONCILIATION', 'ONBOARDING', 'CONVERSATIONS', 'CHAT_TRANSPORT', 'CHAT_STATE',
  'CHAT_ATTACHMENTS', 'CHAT_PROGRESS', 'WORKFLOW_COMPOSITION', 'COMPOSITION_INGREDIENTS', 'PREPARED_OPPORTUNITIES',
  'OPPORTUNITY_ACTIVATION', 'QUIET_AWARENESS', 'DECISIONS', 'DECISION_EDITS', 'RECOMMENDATIONS', 'GOAL_MEASUREMENTS',
  'OUTCOMES', 'MEMORY_STREAM', 'MEMORY_USAGE', 'MEMORY_FORGET', 'WORKFLOW_REMOVAL', 'WORKFLOW_CONTEXT', 'CONNECTIONS', 'PROFILE_SETTINGS',
] as const;

/**
 * What the engine that talks to other people's Jarvises may be given from
 * outside (src/peers/engine-process.ts names the same): where its server is,
 * how it keeps its keys, what this device is called, and the two that reach
 * the desktop's keychain. Carried across only together with the engine.
 */
const PEERS_KEYS = ['COLLAB_SERVER_URL', 'COLLAB_KEYSTORE', 'COLLAB_DEVICE_NAME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const;

export interface DevPaths { home: string; data: string; tmp: string }

export function devEnv(parent: Record<string, string | undefined>, paths: DevPaths, port: number): Record<string, string> {
  const env: Record<string, string> = { PATH: parent.PATH ?? '', HOME: paths.home, TMPDIR: paths.tmp,
    LANG: parent.LANG ?? 'C.UTF-8', JARVIS_HOME: paths.data, JARVIS_SECRETS_DIR: paths.data,
    JARVIS_PORT: String(port), JARVIS_PUBLIC_URL: `http://localhost:${port}`, JARVIS_LOCAL_INTEGRATION: '1' };
  for (const key of PLATFORM_KEYS) if (parent[key]) env[key] = parent[key]!;
  for (const key of BRIEF_FEATURES) env[`JARVIS_BRIEF_${key}`] = '1';
  // The notch is off unless the caller asks for it by exactly "1", the same
  // rule the daemon applies (src/notch/switch.ts).
  if (parent.JARVIS_NOTCH === '1') {
    env.JARVIS_NOTCH = '1';
    // The demo secret only means anything with the notch on (src/notch/demo-gate.ts).
    if (parent.JARVIS_NOTCH_DEMO) env.JARVIS_NOTCH_DEMO = parent.JARVIS_NOTCH_DEMO;
    // Other people's Jarvises: the place of the engine (src/peers/switch.ts),
    // by the same rule the daemon applies, a path from the root. It was not
    // named here, so "JARVIS_PEERS_ENGINE=... scripts/notch/try.sh" started a
    // brain that never heard of it: no engine, and no row to make an
    // organisation with (the first try at it with a second person, 20
    // November 2026). Only with the notch on, which is what shows it.
    const engine = parent.JARVIS_PEERS_ENGINE?.trim();
    if (engine && isAbsolute(engine)) env.JARVIS_PEERS_ENGINE = engine;
    // The same switch with no engine yet (JARVIS_PEERS=1): one comes when an
    // organisation is made or joined. And the engine's source, for whoever
    // makes one: its server is run from there (src/peers/host.ts).
    if (parent.JARVIS_PEERS === '1') env.JARVIS_PEERS = '1';
    const source = parent.JARVIS_PEERS_SOURCE?.trim();
    if (source && isAbsolute(source)) env.JARVIS_PEERS_SOURCE = source;
    if (env.JARVIS_PEERS_ENGINE || env.JARVIS_PEERS) {
      for (const key of PEERS_KEYS) if (parent[key]) env[key] = parent[key]!;
    }
  }
  return env;
}
