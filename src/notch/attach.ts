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
}

/**
 * What `notch.configure` answers. `surface` is "window" when the desktop app can
 * open the notch's window, and "none" when it only understands the switch.
 */
export interface NotchConfigureResult {
  configured?: boolean;
  enabled?: boolean;
  surface?: string;
}

export function attachNotch(port: NotchSidecarPort, options: AttachNotchOptions): void {
  // Off: register nothing, so no later code path can reach dispatchRPC.
  if (!options.enabled) return;
  const log = options.log ?? ((line: string) => console.log(line));
  log('[notch] switch on');
  port.onSidecarConnected((sidecar) => {
    if (!sidecar.capabilities.includes(NOTCH_CAPABILITY)) {
      log(`[notch] "${sidecar.name}" cannot host the notch: its desktop app is older than the notch`);
      return;
    }
    port.dispatchRPC(sidecar.id, 'notch.configure', { enabled: true }).then(
      (result) => {
        const answer = (result ?? {}) as NotchConfigureResult;
        const surface = answer.surface ?? 'unknown';
        log(`[notch] "${sidecar.name}" ready, surface: ${surface}`);
        // Only a desktop app that says it has a window is asked to open one.
        if (surface !== 'window' || !options.pageUrl) return;
        return port.dispatchRPC(sidecar.id, 'notch.spawn', { url: options.pageUrl }).then(
          () => log(`[notch] "${sidecar.name}" is showing the notch`),
          (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            log(`[notch] "${sidecar.name}" could not show the notch: ${reason}`);
          },
        );
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`[notch] "${sidecar.name}" did not accept notch.configure: ${reason}`);
      },
    );
  });
}
