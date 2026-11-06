import type { JarvisConfig } from "../config/types";
import { isHostedInstall } from "../daemon/usejarvis-ai";

/** Why a hosted install cannot start one-click setup (#1259). */
export const HOSTED_SETUP_UNAVAILABLE =
  "One-click setup is broken on this hosted instance: its integrations page link (usejarvis_integrations.page_url) is missing or invalid.";

/**
 * The `reason` a hosted connection status carries when setup is expected here
 * but no connect link could be built (#1259). Without it a hosted install
 * whose control plane wrote no usable `page_url` reports exactly what a
 * self-hosted install reports (`configured: false`, `connect_url: null`), and
 * the workflow Connections panel folds the fault into its "not available on
 * this instance" line. The panel reads a status with a `reason` as a refused
 * setup, a fault it shows, not as a provider this instance does not offer.
 *
 * Setup is expected on a hosted install, and wherever the control plane wrote
 * the system-owned `usejarvis_integrations` block at all; a self-hosted
 * install has neither, so it gets no reason. `isHostedInstall` leans toward
 * "hosted": a self-hoster serving the brain on a unix socket reads as hosted
 * and sees these rows instead of the one summary line. Accepted: a fault shown
 * that is not one costs a few rows, a fault hidden costs a broken setup.
 */
export function hostedSetupFault(
  config: JarvisConfig,
  connectUrl: string | null,
): { reason?: string } {
  if (connectUrl) return {};
  // An empty YAML key loads as null, which is no block (the loader's first read keeps it).
  const expected = isHostedInstall(config) || config.usejarvis_integrations != null;
  return expected ? { reason: HOSTED_SETUP_UNAVAILABLE } : {};
}
