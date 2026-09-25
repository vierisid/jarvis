/**
 * The marker modelExecEnv() (util/model-exec-env.ts) sets on every
 * model-directed child: `JARVIS_MODEL_EXEC=1`.
 *
 * Why it exists. That env carries none of the daemon's secrets, so a daemon
 * started FROM it -- the model running `jarvis start`, `restart` or `update`
 * in run_command, in an install no service manager owns -- comes up without
 * them. For JARVIS_WORKFLOW_ENCRYPTION_KEY that is worse than a missing
 * feature: with no key file, getKey() would mint one, credentials saved
 * afterwards would be encrypted under it, and the user's next own restart --
 * env key back, and preferred over any file -- could not decrypt them.
 * rivalKeyWarning() does not see it, since only one file exists. So
 * workflows/db/encryption.ts refuses to GENERATE a key under this marker
 * (reading an existing one is fine), an unmarked daemon creates its key file
 * at boot so that refusal only ever meets an env-key install
 * (ensureWorkflowEncryptionKeyAtBoot), and the daemon and the CLI say what is
 * missing.
 *
 * The normal paths never carry it: a daemon the user starts, or one systemd or
 * launchd (re)starts -- including `systemctl --user restart` issued from
 * run_command, since the unit gets the service manager's env, not the
 * caller's. Nor is it a boundary: a child can unset it. It is hygiene, like
 * the strip it accompanies.
 *
 * A separate module so the daemon, the CLI and workflows/db can read the
 * marker without importing the model-exec spawn helper, which the spawn guard
 * keeps to its MODEL_EXEC sites.
 */

export const MODEL_EXEC_MARKER_ENV = 'JARVIS_MODEL_EXEC';

/** True when this process descends from a command the assistant ran. */
export function isModelExecProcess(env: Record<string, string | undefined> = process.env): boolean {
  return env[MODEL_EXEC_MARKER_ENV] === '1';
}

/** What the warning names, when absent, and what its absence costs. */
const CONSEQUENCES: ReadonlyArray<[string, string]> = [
  ['JARVIS_WORKFLOW_ENCRYPTION_KEY', 'no new workflow key is generated; an existing key file is still used'],
  ['JARVIS_GITHUB_TOKEN', 'site publishing falls back to a token stored in the keychain, if any'],
];

/**
 * What a daemon started under the marker logs at boot, or what `jarvis
 * start -d/restart/update` run under it prints first; null without the
 * marker, or when every secret it names is present anyway (passed inside the
 * command, or re-exported by the shell's rc). The CLI cannot know whether the
 * daemon it starts goes through a service manager (unaffected) or inherits
 * this shell, so it says both.
 */
export function modelExecDaemonWarning(
  env: Record<string, string | undefined> = process.env,
  from: 'daemon' | 'cli' = 'daemon',
): string | null {
  if (!isModelExecProcess(env)) return null;
  const missing = CONSEQUENCES.filter(([name]) => !env[name]).map(([name, cost]) => `${name} (${cost})`);
  if (missing.length === 0) return null;
  const list = `${missing.join(', ')}, and any other JARVIS_* secret`;
  if (from === 'cli') {
    return (
      `This command is running in the assistant's shell (${MODEL_EXEC_MARKER_ENV}=1), which carries ` +
      'none of the daemon\'s secrets. A daemon restarted by systemd or launchd is unaffected; one ' +
      `started directly from here comes up without any you set as environment variables: ${list}.`
    );
  }
  return (
    `This Jarvis was started from a command the assistant ran (${MODEL_EXEC_MARKER_ENV}=1). That ` +
    'environment deliberately carries none of the daemon\'s secrets, so any you set as environment ' +
    `variables are missing here: ${list}. Restart Jarvis from your own terminal or service manager.`
  );
}
