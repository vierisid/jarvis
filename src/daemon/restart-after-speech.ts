import {
  getAutostartName,
  isAutostartInstalled,
  keepaliveUnitState,
  requestSystemdRestart,
  scheduleAutostartRestart,
} from '../cli/autostart.ts';
import { anyRealtimeVoicing } from './realtime-voice.ts';

/**
 * Hold a keepalive restart until live voice has finished saying so (#1156).
 *
 * The voice `restart_daemon` answer is spoken AFTER the restart route has
 * answered: the route's yes goes back to the room action, then to the
 * realtime model as the tool's result, and only then does the model speak.
 * The restart used to be scheduled inside the route, 2s out on Linux and 1s
 * on macOS, so it closed the session while that answer was still being
 * generated or played. Now, while any realtime session may still be heard
 * (anyRealtimeVoicing), the route answers its checks at once and the
 * schedule waits for the sessions to go quiet, polled every
 * RESTART_SPEECH_POLL_MS, for at most RESTART_SPEECH_WAIT_CAP_MS.
 *
 * Nothing voicing (the Settings button, the usual case) schedules at once,
 * exactly as before, so the route still reports a schedule systemd or
 * launchd refused. A held schedule that then fails can only be logged: its
 * yes has been answered.
 *
 * It waits on ANY live session, not only the one that asked: the route
 * cannot tell which session (if any) a request came from, and a restart cuts
 * every session off. So a Settings restart while some session runs a slow
 * tool or speaks is held too, up to the cap.
 */

/**
 * The longest a restart waits for speech. A bound against a session that
 * never goes quiet (a user turn left open pins a voiced result as pending),
 * not an estimate of the answer: the wait normally ends on the session's own
 * signal. It covers the worst wait the session itself allows before asking
 * for the reply (TOOL_RESULT_GRACE_MS, 4s, for sibling calls) plus 11s for
 * the reply's generation and playback. That share is a ceiling, not
 * measured against a live session, kept short so a stuck session cannot hold
 * a restart the person asked for.
 */
export const RESTART_SPEECH_WAIT_CAP_MS = 15_000;

/** How often the wait looks again. The systemd timer it then arms is 100ms accurate. */
export const RESTART_SPEECH_POLL_MS = 100;

export type RestartAfterSpeechDeps = {
  isVoicing: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  capMs?: number;
  pollMs?: number;
};

let held = false;

/** Tests only. */
export function resetRestartAfterSpeech(): void {
  held = false;
}

/** True while a restart is waiting on speech. */
export function restartHeldForSpeech(): boolean {
  return held;
}

/**
 * Run `schedule` once nothing is voicing, or after the cap. Returns 'now'
 * when nothing was voicing (the caller schedules and reports as before),
 * 'held' when the schedule now waits, and 'already' when a held restart is
 * already waiting (one restart, not two). On 'now' `schedule` is NOT called:
 * the caller runs its own synchronous schedule so it can report a refusal.
 */
export function restartAfterSpeech(schedule: () => void, deps: RestartAfterSpeechDeps): 'now' | 'held' | 'already' {
  if (held) return 'already';
  if (!deps.isVoicing()) return 'now';
  const now = deps.now ?? Date.now;
  // Unref'd: a held restart must not keep a stopping daemon alive.
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
  const deadline = now() + (deps.capMs ?? RESTART_SPEECH_WAIT_CAP_MS);
  const pollMs = deps.pollMs ?? RESTART_SPEECH_POLL_MS;
  held = true;
  const check = () => {
    let voicing = false;
    try { voicing = deps.isVoicing(); } catch { voicing = false; }
    if (voicing && now() < deadline) {
      setTimer(check, pollMs);
      return;
    }
    if (voicing) console.warn('[restart] live voice still speaking after the wait cap; restarting anyway');
    held = false;
    try {
      schedule();
    } catch (err) {
      console.error('[restart] held keepalive restart failed:', err);
    }
  };
  setTimer(check, pollMs);
  return 'held';
}

export type KeepaliveRestartDeps = {
  platform: NodeJS.Platform;
  isInstalled: () => boolean;
  serviceName: () => string;
  /** Linux: check the unit and arm its restart timer now (autostart.ts). */
  requestSystemdRestart: () => 'scheduled' | 'not_this_daemon' | 'unknown' | 'failed';
  /** Linux: the unit check alone (autostart.ts keepaliveUnitState). */
  keepaliveUnitState: () => 'runs' | 'other' | 'unknown';
  /** Arm the restart for this platform; false when it was refused. */
  scheduleRestart: () => boolean;
} & RestartAfterSpeechDeps;

export type KeepaliveRestartAnswer = { ok: true; message: string } | { ok: false; error: string; status: number };

/** POST /api/system/autostart/restart: answer now, restart once voice is quiet. */
export function keepaliveRestart(deps: KeepaliveRestartDeps): KeepaliveRestartAnswer {
  if (!(deps.platform === 'darwin' || deps.platform === 'linux')) {
    return { ok: false, error: '24/7 restart is not supported on this platform.', status: 400 };
  }
  if (!deps.isInstalled()) {
    return { ok: false, error: 'JARVIS keepalive mode is not installed yet.', status: 400 };
  }
  const yes: KeepaliveRestartAnswer = { ok: true, message: `Restarting the JARVIS 24/7 ${deps.serviceName()} service.` };
  const notThisDaemon: KeepaliveRestartAnswer = {
    ok: false,
    error: 'This JARVIS is not running under its keepalive service, so restarting the service would not restart it. Restart it the way it was started.',
    status: 409,
  };
  // Status 400, as error() in api-routes.ts has always answered it.
  const failed: KeepaliveRestartAnswer = { ok: false, error: 'Failed to schedule keepalive service restart.', status: 400 };
  // Schedule inside the request, as before, so a refusal is reported.
  const scheduleNow = (): KeepaliveRestartAnswer => {
    if (deps.platform === 'linux') {
      const outcome = deps.requestSystemdRestart();
      if (outcome === 'not_this_daemon') return notThisDaemon;
      return outcome === 'scheduled' ? yes : failed;
    }
    return deps.scheduleRestart() ? yes : failed;
  };
  if (!restartHeldForSpeech() && !deps.isVoicing()) return scheduleNow();
  // An installed unit is not proof it runs THIS daemon: restarting it while
  // the daemon was started by hand restarts nothing here. Checked before the
  // hold, so a voice restart that cannot happen is still a no.
  if (deps.platform === 'linux') {
    const state = deps.keepaliveUnitState();
    if (state === 'other') return notThisDaemon;
    if (state === 'unknown') return failed;
  }
  const scheduleRefusalLogged = () => {
    const ok = deps.scheduleRestart();
    if (!ok) console.error('[restart] the held keepalive restart was refused');
    return ok;
  };
  // 'now' only if the session went quiet since the check above: schedule
  // inside the request after all, reporting as the quiet path does.
  if (restartAfterSpeech(scheduleRefusalLogged, deps) === 'now') return scheduleNow();
  return yes;
}

/** What the route runs on: this process, its keepalive service, its live voice. */
export function keepaliveRestartDeps(): KeepaliveRestartDeps {
  return {
    platform: process.platform,
    isInstalled: isAutostartInstalled,
    serviceName: getAutostartName,
    requestSystemdRestart: () => requestSystemdRestart(),
    keepaliveUnitState: () => keepaliveUnitState(),
    scheduleRestart: scheduleAutostartRestart,
    isVoicing: anyRealtimeVoicing,
  };
}
