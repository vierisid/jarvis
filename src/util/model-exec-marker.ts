/**
 * Two markers modelExecEnv() (util/model-exec-env.ts) sets on model-directed
 * children:
 *   - `JARVIS_MODEL_EXEC=1` on every one. Diagnostic only: nothing decides
 *     anything on it; it says where a process came from.
 *   - `JARVIS_MODEL_EXEC_ENV_KEY=<check>` when an ancestor daemon held its
 *     workflow key in JARVIS_WORKFLOW_ENCRYPTION_KEY: a 16-hex-char check value
 *     of that key (workflowKeyCheck), inherited unchanged by descendants.
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
 * rivalKeyWarning() does not see it, since only one file exists. And a key
 * file that merely EXISTS proves nothing: a leftover, another instance's key,
 * or the shared pre-JARVIS_HOME ~/.jarvis/cache one is just as much "not the
 * user's key". So under the flag workflows/db/encryption.ts uses a key -- file
 * or env -- only if its check matches the flag, never generates one, skips
 * the shared legacy candidate, and does not relocate keys at boot.
 *
 * Why a separate flag rather than refusing on JARVIS_MODEL_EXEC alone: an
 * install whose key lives in a FILE must keep generating one when there is
 * none -- after `rm -rf ~/.jarvis && jarvis restart`, for a second instance
 * under another JARVIS_HOME, or with a fresh JARVIS_SECRETS_DIR -- all of which
 * a model may legitimately run. Only an env-key install can split.
 *
 * What the flag gives away: that the daemon's environment holds a workflow
 * key, and 64 bits of a slow (scrypt), domain-separated hash of it -- enough
 * to tell whether a candidate key IS that key, useless for finding a random
 * 256-bit one. The check sits in exactly the environment dumps the strip
 * protects (crash reports, logs, `env` in a transcript), so for a key derived
 * from a passphrase it is an offline guessing target: scrypt makes each guess
 * cost ~35ms instead of nanoseconds, and the docs say to generate the key at
 * random. Nothing a same-uid child could not read from
 * /proc/<daemon pid>/environ anyway. An older parent set the flag to `1`,
 * "an env key existed, check unknown": that refuses every file key and is
 * satisfied only by an env key.
 *
 * Neither marker is a boundary: a child can unset them. And an app the model
 * launches directly keeps them, so a terminal opened inside it can be marked
 * too -- not after macOS `open -a`, which hands the app launchd's environment,
 * and not for a terminal whose windows come from an already-running server
 * process (gnome-terminal, for one). They are
 * hygiene, like the strip they accompany. The generated systemd unit unsets
 * both (UnsetEnvironment=) and the launchd plist blanks them, so a service
 * started from a marked shell's imported environment is not marked.
 *
 * A separate module so the daemon, the CLI and workflows/db can read the
 * markers without importing the model-exec spawn helper, which the spawn
 * guard keeps to its MODEL_EXEC sites.
 */

import { scryptSync } from 'node:crypto';

export const MODEL_EXEC_MARKER_ENV = 'JARVIS_MODEL_EXEC';
export const MODEL_EXEC_ENV_KEY_FLAG = 'JARVIS_MODEL_EXEC_ENV_KEY';

type Env = Record<string, string | undefined>;

/**
 * True when this process descends from a command the assistant ran.
 * Diagnostic only -- see the header; the key decisions use the flag.
 */
export function isModelExecProcess(env: Env = process.env): boolean {
  return env[MODEL_EXEC_MARKER_ENV] === '1';
}

/** The pre-check-value flag an older parent set: "an env key existed, check unknown". */
export const LEGACY_ENV_KEY_FLAG = '1';

const checkCache = new Map<string, string>();

/**
 * The check value of a workflow key: 16 hex chars of scrypt (N=2^14, r=8,
 * p=1; ~35ms, 16 MiB) over the key's lowercase hex, salted with a fixed label.
 * Identifies the key, cannot recover it. Computed once per key per process.
 *
 * FROZEN: a daemon of one release sets this and a daemon of the next checks
 * it, so a change to the label, the parameters or the normalisation would
 * refuse the right key. model-exec-env.test.ts pins a known answer.
 */
export function workflowKeyCheck(hex: string): string {
  const key = hex.trim().toLowerCase();
  let check = checkCache.get(key);
  if (check === undefined) {
    check = scryptSync(key, 'jarvis-workflow-key-check', 8, { N: 16384, r: 8, p: 1 }).toString('hex');
    checkCache.set(key, check);
  }
  return check;
}

/**
 * The env-key flag as set: a check value, `1` from an older parent, or null
 * when absent or anything else.
 */
export function parentWorkflowKeyCheck(env: Env = process.env): string | null {
  const v = env[MODEL_EXEC_ENV_KEY_FLAG];
  if (v === LEGACY_ENV_KEY_FLAG || (v !== undefined && /^[0-9a-f]{16}$/.test(v))) return v;
  return null;
}

/**
 * True when a model-directed ancestor's daemon held its workflow key in the
 * environment, so a key missing here was stripped, not absent.
 */
export function hadEnvWorkflowKey(env: Env = process.env): boolean {
  return parentWorkflowKeyCheck(env) !== null;
}

/**
 * Whether `hex` is the ancestor's env key: true/false against a check value,
 * null against a legacy `1` (unknown).
 */
export function matchesParentWorkflowKey(hex: string, env: Env = process.env): boolean | null {
  const check = parentWorkflowKeyCheck(env);
  if (check === null || check === LEGACY_ENV_KEY_FLAG) return null;
  return workflowKeyCheck(hex) === check;
}

/**
 * The markers a model-directed child gets, given its parent's env: always the
 * marker, plus the env-key flag. An inherited flag passes on unchanged -- it
 * names the key of the daemon the user started, which a key handed in along
 * the way must not replace -- else the parent's own env key sets it.
 */
export function modelExecMarkers(parent: Env = process.env): Record<string, string> {
  const out: Record<string, string> = { [MODEL_EXEC_MARKER_ENV]: '1' };
  const inherited = parentWorkflowKeyCheck(parent);
  if (inherited !== null) out[MODEL_EXEC_ENV_KEY_FLAG] = inherited;
  else if (parent.JARVIS_WORKFLOW_ENCRYPTION_KEY) {
    out[MODEL_EXEC_ENV_KEY_FLAG] = workflowKeyCheck(parent.JARVIS_WORKFLOW_ENCRYPTION_KEY);
  }
  return out;
}

/** True when this process lacks a key known to be the ancestor's env key. */
function missingParentKey(env: Env): boolean {
  if (!hadEnvWorkflowKey(env)) return false;
  const key = env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
  if (!key) return true;
  return matchesParentWorkflowKey(key, env) === false;
}

/**
 * What a daemon logs at boot when its workflow key was stripped on the way;
 * null otherwise -- including for every install whose key lives in a file,
 * which a restart from run_command costs nothing -- and when the key is back
 * (passed inside the command, or re-exported by the shell's rc).
 */
export function modelExecDaemonWarning(env: Env = process.env): string | null {
  if (!missingParentKey(env)) return null;
  return (
    'This Jarvis was started from a command the assistant ran. The Jarvis that ran it kept its workflow key ' +
    'in JARVIS_WORKFLOW_ENCRYPTION_KEY, and that key is not in this environment. A key file is used only if ' +
    'it is that same key, and no new key is generated, so workflow credentials may be unusable here. Start ' +
    'this Jarvis from your own terminal with JARVIS_WORKFLOW_ENCRYPTION_KEY set (on a systemd install: ' +
    '`systemctl --user restart jarvis`), or, if this instance is meant to have its own key, unset ' +
    'JARVIS_MODEL_EXEC_ENV_KEY deliberately.'
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
  if (!missingParentKey(env)) return null;
  return (
    'This shell is the assistant\'s: JARVIS_WORKFLOW_ENCRYPTION_KEY was in the running Jarvis\'s environment ' +
    'but is not in this one, and the Jarvis started from here will not have it (it uses a key file only if ' +
    'that file holds the same key, and generates none). Restart from your own terminal, or use ' +
    '`systemctl --user restart jarvis` on a systemd install.'
  );
}
