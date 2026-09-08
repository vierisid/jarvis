/**
 * Sidecar Routing — Transparent Remote Execution
 *
 * Holds a reference to the SidecarManager and provides a helper
 * that existing tools call when a `target` parameter is present.
 * The AI decides where to run a command by specifying (or omitting) a target.
 */

import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarCapability, SidecarInfo } from '../../sidecar/types.ts';
import {
  familyLabel,
  hostTarget,
  osFamily,
  type ExecutionTarget,
} from '../../util/execution-environment.ts';
import { isNoLocalTools } from './local-tools-guard.ts';

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
 * Pick a default sidecar for tools that didn't get an explicit target.
 * Returns the first connected sidecar advertising the required capability,
 * or null when nothing's available. Used by desktop_* / browser_* /
 * etc. so calls land on the Go sidecar automatically when one is
 * connected, instead of falling back to legacy local controllers.
 */
export function autoTargetForCapability(cap: SidecarCapability): string | null {
  if (!sidecarManager) return null;
  for (const s of sidecarManager.listSidecars()) {
    if (!s.connected) continue;
    if (s.unavailable_capabilities?.some((u) => u.name === cap)) continue;
    if (s.capabilities && s.capabilities.includes(cap)) return s.id;
  }
  return null;
}

/**
 * The live execution inventory: every enrolled sidecar plus the brain's own
 * host, each with the OS it runs. Feeds the workflow composer's prompts and
 * the agent's tool guide, so both write commands for the machine a step
 * actually lands on instead of whichever OS the model's priors favour.
 *
 * Offline sidecars stay in the list: a workflow composed today runs on a
 * schedule tomorrow, and the laptop asleep right now is still the machine the
 * user means. Dropping it would leave the composer writing commands for the
 * Linux server the brain happens to live on.
 *
 * The host is omitted under --no-local-tools, where it refuses every call --
 * counting it would let a hosted brain's own OS excuse commands that can only
 * ever run on the user's sidecar.
 */
export function collectExecutionTargets(): ExecutionTarget[] {
  const targets: ExecutionTarget[] = [];
  try {
    for (const s of sidecarManager?.listSidecars() ?? []) {
      targets.push({
        id: s.id,
        name: s.name,
        os: s.os ?? null,
        // SidecarInfo.platform carries GOARCH, not an OS. See ExecutionTarget.
        arch: s.platform ?? null,
        connected: s.connected,
        ...(s.capabilities ? { capabilities: [...s.capabilities] } : {}),
      });
    }
  } catch {
    // Registry unavailable (DB not open yet, sidecars disabled). Report what
    // we can rather than nothing.
  }
  if (!isNoLocalTools()) targets.push(hostTarget());
  return targets;
}

/** A machine's name plus its OS, for an error a human has to act on. */
function describeMachine(sidecar: SidecarInfo): string {
  const fam = osFamily(sidecar.os);
  return fam ? `${sidecar.name}, ${familyLabel(fam)}` : sidecar.name;
}

/**
 * Pick the stack that will serve one tool call, and say which it was.
 *
 * Two implementations back every desktop_* and browser_* tool: the Go
 * sidecar, and the daemon's own local controllers. Which one runs depends on
 * whether a sidecar is connected, and the choice used to be made in silence,
 * so "it works sometimes" was untraceable after the fact. One line per call
 * names the stack that answered.
 *
 * An explicit target is returned verbatim rather than trimmed, because it is
 * matched by name downstream and quietly rewriting it would hide a typo
 * rather than surface it. Blank is treated as absent.
 */
export function resolveToolTarget(
  explicit: unknown,
  capability: SidecarCapability,
  tool: string,
): string | null {
  const named = typeof explicit === 'string' && explicit.trim() ? explicit : null;
  const target = named ?? autoTargetForCapability(capability);
  console.log(
    target
      ? `[${capability}] ${tool} -> sidecar stack (target=${target}, ${named ? 'explicit' : 'auto'})`
      : `[${capability}] ${tool} -> local stack`,
  );
  return target;
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
    return `Error: Sidecar "${describeMachine(sidecar)}" is offline.`;
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
      // The RPC outlived the initial timeout. Detached completions are only
      // console-logged (manager.ts onDetachedComplete) — the result never
      // reaches the model — so claiming background success would be a lie
      // for anything interactive. Only run_command keeps fire-and-forget
      // semantics; everything else reports an honest timeout.
      if (method === 'run_command') {
        return `Command dispatched to "${sidecar.name}" and still running in the background. Its output will NOT be reported back — verify its effect yourself if it matters.`;
      }
      return `Error [${sidecar.name}]: "${method}" did not complete within the timeout. The action may or may not have taken effect — do NOT assume it succeeded; verify the current state (e.g. take a snapshot) before continuing.`;
    }

    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // METHOD_NOT_FOUND means the capability is disabled — tell the LLM not to retry
    if (msg.includes('METHOD_NOT_FOUND')) {
      return `Error [${describeMachine(sidecar)}]: Method "${method}" is not available. The "${requiredCapability}" capability is not enabled on this sidecar. Do NOT retry this call — ask the user to enable the capability in the sidecar's config if needed.`;
    }

    // The OS goes in the message on purpose: the commonest remote failure is
    // a command written for the wrong platform (`notepad.exe` sent to a Mac),
    // and "command not found" alone tells neither the model nor the user why.
    return `Error [${describeMachine(sidecar)}]: ${msg}`;
  }
}
