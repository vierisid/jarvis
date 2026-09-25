/**
 * Two markers modelExecEnv() (util/model-exec-env.ts) sets on model-directed
 * children:
 *   - `JARVIS_MODEL_EXEC=1` on every one;
 *   - `JARVIS_MODEL_EXEC_ENV_KEY=1` when the parent's environment held
 *     JARVIS_WORKFLOW_ENCRYPTION_KEY, or had inherited this flag itself.
 *
 * Why. That env carries none of the daemon's secrets, so a daemon started FROM
 * it comes up without them. `jarvis start`, `restart` and `update` run through
 * run_command do exactly that on an install no service manager runs (the
 * daemon was started with `jarvis start -d` from a terminal): restart stops
 * the daemon, then starts it from the calling shell, and update's
 * restartDaemonDetached spawns it with that shell's env.
 *
 * Under a service manager the assistant's shell does not start one. On
 * systemd the shell and the CLI it runs are the daemon's descendants, in the
 * unit's cgroup: SIGTERM ends in a clean exit, Restart=on-failure does not
 * fire, and the default KillMode=control-group kills the CLI with the daemon
 * -- Jarvis stays DOWN, and an update is cut short (measured with a transient
 * user unit; a pre-existing limit, not #514's). If the stop escalates to
 * SIGKILL, systemd restarts the unit with the unit's env. launchd's KeepAlive
 * relaunches with launchd's env, and the CLI sees the new pid and stops there
 * (cmdRestart; update's "a daemon is still running"). `systemctl --user
 * restart jarvis` is the way to restart a systemd install.
 *
 * For JARVIS_WORKFLOW_ENCRYPTION_KEY a missing secret is worse than a missing
 * feature: with no key file, getKey() would mint one, credentials saved
 * afterwards would be encrypted under it, and the user's next own restart --
 * env key back, and preferred over any file -- could not decrypt them.
 * rivalKeyWarning() does not see it, since only one file exists. So
 * workflows/db/encryption.ts refuses to GENERATE a key under the env-key flag
 * (reading an existing file is fine).
 *
 * Why a separate flag rather than refusing on JARVIS_MODEL_EXEC alone: an
 * install whose key lives in a FILE must keep generating one when there is
 * none -- after `rm -rf ~/.jarvis && jarvis restart`, for a second instance
 * under another JARVIS_HOME, or with a fresh JARVIS_SECRETS_DIR -- all of which
 * a model may legitimately run. Only an env-key install can split.
 *
 * What the flag gives away: one bit, whether the daemon's environment holds a
 * workflow key. Not the key, and nothing a same-uid child could not read from
 * /proc/<daemon pid>/environ anyway.
 *
 * Neither marker is a boundary: a child can unset them, and an app the model
 * launches keeps them -- a terminal opened inside it is marked too. They are
 * hygiene, like the strip they accompany. The generated systemd unit unsets
 * both (UnsetEnvironment=) and the launchd plist blanks them, so a service
 * started from a marked shell's imported environment is not marked.
 *
 * A separate module so the daemon, the CLI and workflows/db can read the
 * markers without importing the model-exec spawn helper, which the spawn
 * guard keeps to its MODEL_EXEC sites.
 */

export const MODEL_EXEC_MARKER_ENV = 'JARVIS_MODEL_EXEC';
export const MODEL_EXEC_ENV_KEY_FLAG = 'JARVIS_MODEL_EXEC_ENV_KEY';

type Env = Record<string, string | undefined>;

/** True when this process descends from a command the assistant ran. */
export function isModelExecProcess(env: Env = process.env): boolean {
  return env[MODEL_EXEC_MARKER_ENV] === '1';
}

/**
 * True when a model-directed ancestor's daemon held its workflow key in the
 * environment, so a key missing here was stripped, not absent.
 */
export function hadEnvWorkflowKey(env: Env = process.env): boolean {
  return env[MODEL_EXEC_ENV_KEY_FLAG] === '1';
}

/**
 * The markers a model-directed child gets, given its parent's env: always the
 * marker, plus the env-key flag when the parent held the key or had the flag.
 */
export function modelExecMarkers(parent: Env = process.env): Record<string, string> {
  const out: Record<string, string> = { [MODEL_EXEC_MARKER_ENV]: '1' };
  if (parent.JARVIS_WORKFLOW_ENCRYPTION_KEY || hadEnvWorkflowKey(parent)) out[MODEL_EXEC_ENV_KEY_FLAG] = '1';
  return out;
}

/**
 * What a daemon logs at boot when its workflow key was stripped on the way;
 * null otherwise -- including for every install whose key lives in a file,
 * which a restart from run_command costs nothing -- and when the key is back
 * (passed inside the command, or re-exported by the shell's rc).
 */
export function modelExecDaemonWarning(env: Env = process.env): string | null {
  if (!hadEnvWorkflowKey(env) || env.JARVIS_WORKFLOW_ENCRYPTION_KEY) return null;
  return (
    'This Jarvis was started from a command the assistant ran. JARVIS_WORKFLOW_ENCRYPTION_KEY was in the ' +
    'environment of the Jarvis that ran it and is not in this one, so no workflow key is available unless a ' +
    'key file exists, and none will be generated: saving a workflow credential fails. Restart Jarvis from ' +
    'your own terminal, or with `systemctl --user restart jarvis` on a systemd install.'
  );
}

/**
 * What `jarvis <command>` prints first when it is about to start a daemon from
 * this shell and that daemon would lose the workflow key; null otherwise.
 *
 * Only for the paths that start a daemon AND leave its warning somewhere the
 * user would not see it: `start -d` / `restart -d` (the detached daemon logs
 * its warning to a file). A foreground `start` or `restart` IS the daemon and
 * warns itself, so the CLI stays quiet there rather than say it twice.
 * `update` warns from update.ts, and only for install methods whose update
 * restarts the daemon (not docker or dev checkouts, where nothing restarts).
 */
export function modelExecCliWarning(command: string, args: readonly string[], env: Env = process.env): string | null {
  const detached = args.includes('-d') || args.includes('--detach');
  if (!(command === 'start' || command === 'restart') || !detached) return null;
  return modelExecRestartWarning(env);
}

/** The CLI's wording: this shell, not the daemon, is what lacks the key. */
export function modelExecRestartWarning(env: Env = process.env): string | null {
  if (!hadEnvWorkflowKey(env) || env.JARVIS_WORKFLOW_ENCRYPTION_KEY) return null;
  return (
    'This shell is the assistant\'s: JARVIS_WORKFLOW_ENCRYPTION_KEY was in the running Jarvis\'s environment ' +
    'but is not in this one, and the Jarvis started from here will not have it (no new workflow key is ' +
    'generated; saving a workflow credential fails). Restart from your own terminal, or use ' +
    '`systemctl --user restart jarvis` on a systemd install.'
  );
}
