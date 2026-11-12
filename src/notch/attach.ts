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
  log?: (line: string) => void;
}

/** What `notch.configure` answers. `surface` is "none" until the window exists. */
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
        log(`[notch] "${sidecar.name}" ready, surface: ${answer.surface ?? 'unknown'}`);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`[notch] "${sidecar.name}" did not accept notch.configure: ${reason}`);
      },
    );
  });
}
