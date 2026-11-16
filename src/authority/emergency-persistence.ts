/**
 * Saving the emergency state (paused, killed, normal) so a restart keeps it.
 *
 * The state takes effect in memory before this runs. If the save fails (a full
 * disk) the stop stays in effect, the controller is marked "not saved" so the
 * routes can say so, and the save is retried with the CURRENT state until it
 * works.
 */

import type { EmergencyController, EmergencyState } from './emergency.ts';

export interface EmergencyPersisterOptions {
  controller: EmergencyController;
  /** Writes the state durably; throws when it cannot. */
  save: (state: EmergencyState) => void;
  /** Plain reason for a failure, shown to the owner. */
  describe?: (err: unknown) => string;
  onFailure?: (err: unknown) => void;
  onSaved?: () => void;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createEmergencyPersister(opts: EmergencyPersisterOptions): () => boolean {
  const { controller, save } = opts;
  const retryMs = opts.retryMs ?? 5_000;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let retry: unknown = null;

  const attempt = (): boolean => {
    if (retry !== null) { clearTimer(retry); retry = null; }
    const state = controller.getState();
    try {
      save(state);
      const wasUnsaved = !controller.persistence().saved;
      controller.setPersistence(true);
      if (wasUnsaved) { console.log(`[Daemon] Emergency state "${state}" is saved now.`); opts.onSaved?.(); }
      return true;
    } catch (err) {
      console.error('[Daemon] Failed to persist emergency state:', err instanceof Error ? err.message : err);
      controller.setPersistence(false, opts.describe ? opts.describe(err) : 'the database could not be written');
      opts.onFailure?.(err);
      retry = setTimer(() => { retry = null; attempt(); }, retryMs);
      return false;
    }
  };
  return () => attempt();
}
