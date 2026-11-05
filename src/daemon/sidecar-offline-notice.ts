/**
 * The "Sidecar disconnected" notification: when a machine drops, tell the
 * other connected machines. It rides a grace timer (a quick reconnect cancels
 * it) plus a per-machine cooldown, so a flapping connection cannot nag every
 * flap.
 *
 * The cooldown is armed only by a notice some machine actually received
 * (#1160). With no other machine connected, nobody is shown it, and arming the
 * cooldown anyway meant the next drop within five minutes, by then with
 * another machine connected to hear about it, said nothing either. Same rule
 * as #1080: a caller that tells something only once must not count a notice
 * nobody saw.
 */

export const OFFLINE_NOTIFY_GRACE_MS = 15_000;
export const OFFLINE_NOTIFY_COOLDOWN_MS = 5 * 60_000;

export type OfflineNoticeDeps = {
  /** Sends a notify.show payload to every connected sidecar; true when any was connected. */
  notify: (payload: Record<string, unknown>) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export function createSidecarOfflineNotifier(deps: OfflineNoticeDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const names = new Map<string, string>();
  const timers = new Map<string, unknown>();
  const notifiedAt = new Map<string, number>();

  return {
    connected(id: string, name: string): void {
      names.set(id, name);
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimer(t);
        timers.delete(id);
      }
    },
    disconnected(id: string): void {
      const name = names.get(id) ?? 'A machine';
      names.delete(id);
      if (timers.has(id)) return;
      if (now() - (notifiedAt.get(id) ?? 0) < OFFLINE_NOTIFY_COOLDOWN_MS) return;
      timers.set(id, setTimer(() => {
        timers.delete(id);
        const delivered = deps.notify({
          id: `sidecar:${id}`,
          kind: 'sidecar',
          title: 'Sidecar disconnected',
          body: `${name} went offline. The agent can't act on that machine until it's back.`,
          destructive: false,
          actions: [
            { id: 'review', label: 'Open Jarvis', primary: true },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        });
        if (delivered) notifiedAt.set(id, now());
      }, OFFLINE_NOTIFY_GRACE_MS));
    },
  };
}
