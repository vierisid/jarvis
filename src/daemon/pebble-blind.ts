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
