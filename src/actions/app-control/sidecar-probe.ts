import type { DesktopController } from './desktop-controller.ts';

// How long to wait before re-probing for a sidecar after a failed attempt.
const SIDECAR_RETRY_MS = 30_000;

/**
 * Lazily connects to the desktop-bridge sidecar, reusing one controller (and
 * its TCP connection) across calls and backing off after failed probes.
 *
 * Meaningful only if the owning controller itself is long-lived —
 * getAppController() caches controllers per process for exactly that reason.
 */
export class SidecarProbe {
  private enabled: boolean;
  private sidecar: DesktopController | null = null;
  private retryAt = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  async get(): Promise<DesktopController | null> {
    if (!this.enabled) return null;
    if (this.sidecar?.connected) return this.sidecar;
    if (Date.now() < this.retryAt) return null;
    try {
      const { DesktopController } = await import('./desktop-controller.ts');
      const sidecar = this.sidecar ?? new DesktopController();
      await sidecar.connect();
      this.sidecar = sidecar;
      return sidecar;
    } catch {
      this.retryAt = Date.now() + SIDECAR_RETRY_MS;
      return null;
    }
  }
}
