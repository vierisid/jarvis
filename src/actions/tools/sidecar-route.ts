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
export function setSidecarManagerRef(manager: SidecarManager | null): void {
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

function resolveSidecar(target: string): { sidecar: SidecarInfo | null; error?: string } {
  if (!sidecarManager) {
    return { sidecar: null, error: 'Error: Sidecar system not initialized.' };
  }

  const sidecars = sidecarManager.listSidecars();
  const sidecar = findSidecar(target, sidecars);
  if (!sidecar) {
    const available = sidecars.map((s) => s.name).join(', ') || 'none';
    return {
      sidecar: null,
      error: `Error: No sidecar found matching "${target}". Available: ${available}`,
    };
  }

  return { sidecar };
}

/**
 * Route an RPC call to a sidecar. Returns the result string, or an error message.
 *
 * @param target - Sidecar name or ID
 * @param method - RPC method name (e.g. "run_command", "read_file")
 * @param params - RPC parameters
 * @param requiredCapability - The sidecar must advertise this capability
 */
export async function routeToSidecarRaw(
  target: string,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
): Promise<unknown> {
  const { sidecar, error } = resolveSidecar(target);
  if (!sidecar) {
    return error ?? `Error: No sidecar found matching "${target}".`;
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
    const manager = sidecarManager;
    if (!manager) {
      return 'Error: Sidecar system not initialized.';
    }
    return await manager.dispatchRPC(sidecar.id, method, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // METHOD_NOT_FOUND means the capability is disabled — tell the LLM not to retry
    if (msg.includes('METHOD_NOT_FOUND')) {
      return `Error [${sidecar.name}]: Method "${method}" is not available. The "${requiredCapability}" capability is not enabled on this sidecar. Do NOT retry this call — ask the user to enable the capability in the sidecar's config if needed.`;
    }

    return `Error [${sidecar.name}]: ${msg}`;
  }
}

export async function routeToSidecar(
  target: string,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
): Promise<string> {
  const { sidecar } = resolveSidecar(target);
  const result = await routeToSidecarRaw(target, method, params, requiredCapability);

  if (result === 'detached') {
    return `Task dispatched to "${sidecar?.name ?? target}" and running in the background.`;
  }

  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}
