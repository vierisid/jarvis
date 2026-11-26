/**
 * The notch is an optional surface: the brain starts without it when it cannot
 * be made, and stops it when the brain itself goes down.
 *
 * Before this, the notch was made inside the one `try` of the brain's start,
 * whose `catch` exits: a notch table that could not be created took the whole
 * assistant with it, and under a supervisor that looped. And nothing stopped
 * the notch on the way down, so for as long as the last turns drained it went
 * on looking at the window in front and reading the mail.
 */
import { listUnreadDashboardNotifications, recordDashboardNotification } from '../vault/dashboard-notifications.ts';

/** What the dashboard says when the notch could not be made. The first line is its title there. */
export const NOTCH_FAILED_NOTICE = '**The notch did not start**\n'
  + 'Jarvis is running without it. Approvals and notices are here on the dashboard. '
  + 'Restart Jarvis to try again; the log says what went wrong.';

/** What it says when only the part that talks to other people's Jarvises could not be made. */
export const NOTCH_PEOPLE_FAILED_NOTICE = '**The notch started without other people**\n'
  + 'The part that talks to other people\'s Jarvises could not be started, so nothing is sent to them or taken from them. '
  + 'Restart Jarvis to try again; the log says what went wrong.';

export interface NotchPartDeps {
  /** What the dashboard is told when this part cannot be made. */
  say: string;
  /** Puts back what was set for the part before it was made. */
  undo?: () => void;
  /** Tells the dashboard. Without it, the notice is kept for the next dashboard that opens. */
  notice?: (message: string) => void;
  log?: (line: string) => void;
}

/**
 * Makes one part of the notch. A throw in `make` ends here: one line in the
 * log, what was set for it is put back, the dashboard is told, and null comes
 * back, which everything that asks for the notch already reads as "no notch".
 */
export function startNotchPart<T>(what: string, make: () => T, deps: NotchPartDeps): T | null {
  const log = deps.log ?? ((line: string) => console.error(line));
  try {
    return make();
  } catch (error) {
    // With where it failed: a table that could not be made is found by that, not by its message.
    log(`[notch] ${what} could not be started, and the brain goes on without it: ${describe(error)}${where(error)}`);
    try { deps.undo?.(); } catch (undoError) { log(`[notch] what was set for ${what} could not be put back: ${describe(undoError)}`); }
    try { (deps.notice ?? notchDashboardNotice)(deps.say); } catch (noticeError) { log(`[notch] the dashboard could not be told: ${describe(noticeError)}`); }
    return null;
  }
}

/** Where an error was thrown, on lines of its own after the message. Empty when it does not say. */
function where(error: unknown): string {
  try { return error instanceof Error && error.stack ? `\n${error.stack}` : ''; } catch { return ''; }
}

function describe(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return 'an error that could not be described'; }
}

/**
 * Tells the dashboard, through its saved notifications: nobody has a dashboard
 * open while the brain starts, and a saved one is there when one opens. Said
 * once: a brain that is started again and again with the same fault does not
 * stack the same notice while the first is still unread. `live` shows it at
 * once in a dashboard that is open.
 */
export function notchDashboardNotice(message: string, live?: (message: string, storedId: string) => void): void {
  if (listUnreadDashboardNotifications().some((row) => row.message === message)) return;
  const row = recordDashboardNotification({ message, priority: 'normal' });
  live?.(message, row.id);
}

/** The notch that is running, for the brain's way down. The daemon's own holder is a local of its start. */
let running: { stop(): void } | null = null;

/** Says which notch is running. Null when there is none. */
export function holdNotch(notch: { stop(): void } | null): void {
  running = notch;
}

/**
 * Stops the notch that is running, once: it looks at nothing and reads nothing
 * from here on, and a yes whose window was still running sends nothing. Never
 * throws: the rest of the way down does not depend on it. True when there was
 * a notch to stop: then what showed its cancel window on that notch (a promise
 * about to be kept) has lost the window, and whoever keeps such things by a
 * clock of their own has to be stopped with it.
 */
export function stopNotch(log: (line: string) => void = (line) => console.warn(line)): boolean {
  const notch = running;
  running = null;
  if (!notch) return false;
  try {
    notch.stop();
  } catch (error) {
    log(`[notch] the notch did not stop cleanly: ${describe(error)}${where(error)}`);
  }
  return true;
}
