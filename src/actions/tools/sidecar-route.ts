/**
 * Sidecar Routing — Transparent Remote Execution
 *
 * Holds a reference to the SidecarManager and provides a helper
 * that existing tools call when a `target` parameter is present.
 * The AI decides where to run a command by specifying (or omitting) a target.
 */

import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarCapability, SidecarInfo } from '../../sidecar/types.ts';

let sidecarManager: SidecarManager | null = null;

/**
 * Inject the sidecar manager at startup. Called once from the daemon.
 */
export function setSidecarManagerRef(manager: SidecarManager): void {
  sidecarManager = manager;
}

export function getSidecarManager(): SidecarManager | null {
  return sidecarManager;
}

/**
 * Find a sidecar by name or ID.
 * Priority: exact ID → exact name (case-insensitive) → contains match.
 */
function findSidecar(nameOrId: string, sidecars: SidecarInfo[]): SidecarInfo | null {
  const query = nameOrId.trim();
  if (!query) return null;

  // Exact ID match
  const byId = sidecars.find((s) => s.id === query);
  if (byId) return byId;

  // Exact name (case-insensitive)
  const lower = query.toLowerCase();
  const byName = sidecars.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName;

  // Contains match
  const byContains = sidecars.find((s) => s.name.toLowerCase().includes(lower));
  return byContains ?? null;
}

/**
 * Resolve a default sidecar for a given capability when no explicit target is provided.
 *
 * Returns the sidecar if exactly one connected sidecar has the capability.
 * Returns an error message otherwise with actionable guidance.
 */
export function resolveDefaultSidecar(
  requiredCapability: SidecarCapability,
): { sidecar: SidecarInfo } | { error: string } {
  if (!sidecarManager) {
    return { error: 'Error: Sidecar system not initialized.' };
  }

  const sidecars = sidecarManager.listSidecars();
  const connected = sidecars.filter((s) => s.connected);

  // Filter to connected sidecars that have the capability and it is not unavailable
  const capable = connected.filter(
    (s) =>
      s.capabilities?.includes(requiredCapability) &&
      !s.unavailable_capabilities?.some((u) => u.name === requiredCapability),
  );

  if (capable.length === 1) {
    return { sidecar: capable[0]! };
  }

  if (capable.length > 1) {
    const names = capable.map((s) => s.name).join(', ');
    return {
      error: `Error: Multiple sidecars have the "${requiredCapability}" capability: ${names}. Specify a "target" to choose one.`,
    };
  }

  // No capable sidecars found — build a helpful message
  if (connected.length === 0) {
    if (sidecars.length === 0) {
      return { error: 'Error: No sidecars enrolled. Use list_sidecars to check sidecar availability.' };
    }
    return {
      error: `Error: No sidecars are currently connected. ${sidecars.length} sidecar(s) enrolled but offline. Use list_sidecars to check status.`,
    };
  }

  // Connected but none with the right capability
  const availCaps = [...new Set(connected.flatMap((s) => s.capabilities ?? []))];
  return {
    error: `Error: No connected sidecar has the "${requiredCapability}" capability. Connected sidecar capabilities: ${availCaps.join(', ') || 'none'}. The sidecar may need "${requiredCapability}" enabled in its config.`,
  };
}

/**
 * Route an RPC call to a sidecar, with automatic default resolution.
 *
 * If `target` is provided, routes to that specific sidecar (existing behavior).
 * If `target` is omitted, auto-resolves to the single connected sidecar
 * that has the required capability. Returns an actionable error if the
 * choice is ambiguous (multiple candidates) or impossible (none available).
 */
export async function routeToSidecarOrDefault(
  target: string | undefined,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
): Promise<string> {
  if (target) {
    return routeToSidecar(target, method, params, requiredCapability);
  }

  const resolved = resolveDefaultSidecar(requiredCapability);
  if ('error' in resolved) {
    return resolved.error;
  }

  // Route using sidecar ID (exact match, no ambiguity)
  return routeToSidecar(resolved.sidecar.id, method, params, requiredCapability);
}

/**
 * Route an RPC call to a sidecar. Returns the result string, or an error message.
 *
 * @param target - Sidecar name or ID
 * @param method - RPC method name (e.g. "run_command", "read_file")
 * @param params - RPC parameters
 * @param requiredCapability - The sidecar must advertise this capability
 */
export async function routeToSidecar(
  target: string,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
): Promise<string> {
  if (!sidecarManager) {
    return 'Error: Sidecar system not initialized.';
  }

  const sidecars = sidecarManager.listSidecars();
  const sidecar = findSidecar(target, sidecars);

  if (!sidecar) {
    const available = sidecars.map((s) => s.name).join(', ') || 'none';
    return `Error: No sidecar found matching "${target}". Available: ${available}`;
  }

  if (!sidecar.connected) {
    return `Error: Sidecar "${sidecar.name}" is offline.`;
  }

  // Check if capability is enabled but unavailable (missing system dependencies)
  const unavail = sidecar.unavailable_capabilities?.find(u => u.name === requiredCapability);
  if (unavail) {
    return `Error: Sidecar "${sidecar.name}" has "${requiredCapability}" enabled but it is unavailable: ${unavail.reason}. Do NOT retry.`;
  }

  if (sidecar.capabilities && !sidecar.capabilities.includes(requiredCapability)) {
    return `Error: Sidecar "${sidecar.name}" does not have the "${requiredCapability}" capability enabled. Available capabilities: ${sidecar.capabilities.join(', ')}. Do NOT retry — ask the user to enable it in the sidecar's config if needed.`;
  }

  try {
    const result = await sidecarManager.dispatchRPC(sidecar.id, method, params);

    if (result === 'detached') {
      return `Task dispatched to "${sidecar.name}" and running in the background.`;
    }

    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // METHOD_NOT_FOUND means the capability is disabled — tell the LLM not to retry
    if (msg.includes('METHOD_NOT_FOUND')) {
      return `Error [${sidecar.name}]: Method "${method}" is not available. The "${requiredCapability}" capability is not enabled on this sidecar. Do NOT retry this call — ask the user to enable the capability in the sidecar's config if needed.`;
    }

    return `Error [${sidecar.name}]: ${msg}`;
  }
}
