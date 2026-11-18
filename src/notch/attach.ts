/**
 * Tells each desktop app that connects whether it should host the notch.
 *
 * The decision is the brain's alone. A desktop app advertises the `notch`
 * capability to say it understands `notch.*`; it hosts nothing until the brain
 * sends `notch.configure {enabled: true}`. That keeps "dark" in one place: a
 * desktop app cannot turn the surface on by itself, and a brain with the
 * switch off never mentions it.
 */

/** The capability a desktop app advertises when it understands `notch.*`. */
export const NOTCH_CAPABILITY = 'notch';

/** What this module needs from the sidecar manager. */
export interface NotchSidecarPort {
  onSidecarConnected(listener: (sidecar: NotchSidecar) => void): void;
  dispatchRPC(sidecarId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NotchSidecar {
  id: string;
  name: string;
  capabilities: readonly string[];
}

export interface AttachNotchOptions {
  enabled: boolean;
  /** The page the notch shows. It must be on the brain's own origin. */
  pageUrl?: string;
  log?: (line: string) => void;
  /** Waits that long. Given by tests; the real one is a timer. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * How long after a window that could not be made it is asked for again. Twice
 * more, then it is left until that desktop app connects again.
 *
 * A window can fail once for a reason that is gone a moment later: on the
 * first start of a new profile the folder its web view keeps its data in was
 * not there yet (17 November 2026). Without a second try that computer had no
 * notch until its desktop app was restarted.
 */
export const NOTCH_SPAWN_AGAIN_MS: readonly number[] = [2000, 6000];

/**
 * What `notch.configure` answers. `surface` is "window" when the desktop app can
 * open the notch's window, and "none" when it only understands the switch.
 */
export interface NotchConfigureResult {
  configured?: boolean;
  enabled?: boolean;
  surface?: string;
  /**
   * Whether that machine can watch the keyboard for the notch's keys: "watch",
   * "blocked" (the system has not allowed it yet) or "none". Absent from a
   * desktop app older than the keys.
   */
  keys?: string;
}

/** How long a notch window that was closed is given to be gone before it is asked for again, and how long between two re-openings at the least. */
export const NOTCH_REOPEN_AFTER_MS = 1500;
export const NOTCH_REOPEN_APART_MS = 60_000;

/**
 * Opens the notch's page again on one desktop app: closed, then asked for
 * anew, which signs it in with a fresh token. For a page whose sign-in has
 * ended (it lasts twelve hours at most, and a notch is up all day and all
 * night): it could no longer take a dropped file, and said "Try dropping it
 * again" for ever. Not more often than once a minute for one desktop app.
 */
export function createNotchReopen(port: Pick<NotchSidecarPort, 'dispatchRPC'>, options: { pageUrl: string; log?: (line: string) => void; wait?: (ms: number) => Promise<void>; now?: () => number }): (sidecarId: string) => Promise<boolean> {
  const log = options.log ?? ((line: string) => console.log(line));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const last = new Map<string, number>();
  return async (sidecarId) => {
    const before = last.get(sidecarId);
    if (before !== undefined && now() - before < NOTCH_REOPEN_APART_MS) return false;
    last.set(sidecarId, now());
    log('[notch] a page\'s sign-in has ended: it is opened again');
    try { await port.dispatchRPC(sidecarId, 'notch.close', {}); } catch { /* it was not up */ }
    for (let tried = 0; tried < 3; tried++) {
      await wait(NOTCH_REOPEN_AFTER_MS);
      try {
        const got = await port.dispatchRPC(sidecarId, 'notch.spawn', { url: options.pageUrl }) as { already?: unknown } | null;
        // "Already there" is the window that is on its way out: asked for again when it has gone.
        if (got?.already !== true) return true;
      } catch (error) {
        log(`[notch] the page could not be opened again: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return false;
  };
}

export function attachNotch(port: NotchSidecarPort, options: AttachNotchOptions): void {
  // Off: register nothing, so no later code path can reach dispatchRPC.
  if (!options.enabled) return;
  const log = options.log ?? ((line: string) => console.log(line));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  log('[notch] switch on');
  /** Which connection of a desktop app is the newest: an older one's second try is not made. */
  const turns = new Map<string, number>();

  /** Asks for the window, and again when it could not be made. */
  const show = async (sidecar: NotchSidecar, turn: number): Promise<void> => {
    for (let tried = 0; ; tried++) {
      try {
        await port.dispatchRPC(sidecar.id, 'notch.spawn', { url: options.pageUrl });
        log(`[notch] "${sidecar.name}" is showing the notch${tried ? `, at try ${tried + 1}` : ''}`);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const again = NOTCH_SPAWN_AGAIN_MS[tried];
        if (again === undefined) {
          log(`[notch] "${sidecar.name}" could not show the notch: ${reason}`);
          return;
        }
        log(`[notch] "${sidecar.name}" could not show the notch: ${reason}. Trying again in ${again / 1000} s`);
        await wait(again);
        // It connected again meanwhile: that connection asks for its own window.
        if (turns.get(sidecar.id) !== turn) return;
      }
    }
  };

  port.onSidecarConnected((sidecar) => {
    const turn = (turns.get(sidecar.id) ?? 0) + 1;
    turns.set(sidecar.id, turn);
    if (!sidecar.capabilities.includes(NOTCH_CAPABILITY)) {
      log(`[notch] "${sidecar.name}" cannot host the notch: its desktop app is older than the notch`);
      return;
    }
    port.dispatchRPC(sidecar.id, 'notch.configure', { enabled: true }).then(
      (result) => {
        const answer = (result ?? {}) as NotchConfigureResult;
        const surface = answer.surface ?? 'unknown';
        log(`[notch] "${sidecar.name}" ready, surface: ${surface}${answer.keys ? `, keys: ${answer.keys}` : ''}`);
        if (answer.keys === 'blocked') {
          log(`[notch] "${sidecar.name}" cannot hear the notch's keys until it is given the Accessibility permission; the mouse still works`);
        }
        // Only a desktop app that says it has a window is asked to open one.
        if (surface !== 'window' || !options.pageUrl) return;
        return show(sidecar, turn);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`[notch] "${sidecar.name}" did not accept notch.configure: ${reason}`);
      },
    );
  });
}
