/**
 * The pebble's eye-strike glyph: blinded while awareness is off, or while
 * desktop control is off (awareness drops every capture then, #905). Every
 * connected pebble shows the same state, so a change from any source
 * (a long-press on one machine, a settings reload) is pushed to all of them.
 * A pebble showing a stale state turns a long-press meant as "off" into "on"
 * (#1157).
 */
export type BlindPushDeps = {
  /** Connected sidecars and their capabilities. */
  connected: () => Array<{ id: string; capabilities: readonly string[] }>;
  dispatchRPC: (sidecarId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export function pebbleBlinded(awarenessEnabled: boolean, desktopEnabled: boolean): boolean {
  return !(awarenessEnabled && desktopEnabled);
}

/**
 * Push `blinded` to every connected pebble; a sidecar that fails is skipped.
 * With `awaitFor`, only that sidecar's push is awaited (the one whose
 * long-press is being answered); the others complete in the background, so a
 * slow machine never delays the answer on this one.
 */
export async function pushPebbleBlinded(deps: BlindPushDeps, blinded: boolean, awaitFor?: string): Promise<void> {
  const pushes = deps.connected().filter(s => s.capabilities.includes('pebble')).map(s => ({ id: s.id,
    done: deps.dispatchRPC(s.id, 'pebble.set_blinded', { blinded }).then(() => {}, () => { /* detached, or no cap yet */ }) }));
  await (awaitFor === undefined ? Promise.all(pushes.map(p => p.done)) : pushes.find(p => p.id === awaitFor)?.done);
}

/**
 * What the sidecar's own observers must stop doing (#1159), sent as
 * `observers.set_paused`. Without this the sidecar kept screenshotting,
 * saving and OCRing every tick, and reading the clipboard, while awareness
 * or desktop control was off. The brain drops screen events only while
 * desktop is off or the awareness service runs, and never drops
 * clipboard_change, so pausing also stops those feeds (the generic event
 * pipeline, and the observer.clipboard_changed trigger while desktop is off).
 *
 * - screen (screenshots, OCR, window titles): paused while awareness or
 *   desktop control is off, the same rule as the pebble's blind glyph.
 * - clipboard: paused while desktop control is off. Not tied to awareness,
 *   because clipboard_change also feeds the observer.clipboard_changed
 *   workflow trigger.
 */
export type ObserverPause = { screen: boolean; clipboard: boolean };

export function observerPause(awarenessEnabled: boolean, desktopEnabled: boolean): ObserverPause {
  return { screen: pebbleBlinded(awarenessEnabled, desktopEnabled), clipboard: !desktopEnabled };
}

/**
 * Sleep means it sees nothing (the notch, pass 6). While everything is
 * stopped (Esc twice, the tray's Pause) the observers are paused whatever the
 * switches say: the pause used to freeze what Jarvis does and leave it
 * watching. Awake, the switches decide as before. The daemon applies this
 * only with the notch on.
 */
export function whileAsleep(pause: ObserverPause, asleep: boolean): ObserverPause {
  return asleep ? { screen: true, clipboard: true } : pause;
}

/**
 * Push the pause to every connected sidecar, or only to `onlyId` (a machine
 * that just connected). Not persisted on the sidecar: a fresh process starts
 * unpaused, so it must be told on every connect. A sidecar that predates the
 * RPC answers METHOD_NOT_FOUND, which is swallowed: it keeps observing as it
 * always did, and the brain still drops what it sends.
 */
export async function pushObserverPause(deps: BlindPushDeps, pause: ObserverPause, onlyId?: string): Promise<void> {
  const targets = deps.connected().filter(s => onlyId === undefined || s.id === onlyId);
  await Promise.all(targets.map(s =>
    deps.dispatchRPC(s.id, 'observers.set_paused', { ...pause }).then(() => {}, () => { /* old sidecar, or detached */ })));
}
