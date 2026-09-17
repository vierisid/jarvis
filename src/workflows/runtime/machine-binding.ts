import { randomUUID } from 'node:crypto';
import { getSidecarManager } from '../../actions/tools/sidecar-route';
import { isNoLocalTools } from '../../actions/tools/local-tools-guard';
import { withMachineScope, type MachineScope } from '../../actions/machine-scope';
import type { SidecarCapability, SidecarInfo } from '../../sidecar/types';
import { ensureRunMachineBinding, getRunMachineBinding, machineBindingBlocked } from '../db/repos/run-machine-binding';
import { assertRunNotCanceled } from './cancellation';
import { getWorkflowDb } from '../db';

// A new daemon process cannot reuse local UI references or an old approval.
const localSessionId = randomUUID();

function identify(selector: string, inventory: SidecarInfo[]): SidecarInfo {
  const exact = inventory.find(s => s.id === selector);
  if (exact) return exact;
  const named = inventory.filter(s => s.name.toLowerCase() === selector.toLowerCase());
  const matches = named.length ? named : inventory.filter(s => s.name.toLowerCase().includes(selector.toLowerCase()));
  if (matches.length !== 1) machineBindingBlocked('WORKFLOW_TARGET_AMBIGUOUS', `Workflow target "${selector}" is missing or ambiguous.`);
  return matches[0]!;
}

export function withWorkflowMachineBinding<T>(ctx: { runId: string; projectId: string }, execute: () => T): T {
  const policy: MachineScope = {
    binding: () => getRunMachineBinding(ctx.runId),
    resolveTarget(explicit, capability) {
      assertRunNotCanceled(ctx.runId);
      const selector = typeof explicit === 'string' && explicit.trim() ? explicit.trim() : null;
      const manager = getSidecarManager();
      const inventory = manager?.listSidecars() ?? [];
      const prior = getRunMachineBinding(ctx.runId);
      if ((!capability && !prior) || (capability && ['desktop', 'browser', 'screenshot'].includes(capability))) {
        const row = getWorkflowDb().query('SELECT execution_config FROM flow_run WHERE id=?').get(ctx.runId) as { execution_config: string | null } | null;
        const config = row?.execution_config ? JSON.parse(row.execution_config) : null;
        if (config?.stepNameToTest && Object.keys(config.sampleData ?? {}).length) {
          machineBindingBlocked('WORKFLOW_SAMPLE_BINDING_UNKNOWN', 'Saved UI test outputs have no verified machine/session provenance. Run the required perception steps again in a full run.');
        }
      }
      // Frozen IDs continue to identify an offline/revoked device. Never let
      // fuzzy name matching reinterpret a previously selected ID.
      const requested = selector && prior?.sidecarId !== selector ? identify(selector, inventory).id : selector;
      const binding = ensureRunMachineBinding(ctx.runId, ctx.projectId, () => {
        const sidecarId = requested ?? inventory.find(s => s.connected && (!capability ||
          (s.capabilities?.includes(capability) && !s.unavailable_capabilities?.some(c => c.name === capability))))?.id ?? null;
        if (sidecarId === null && isNoLocalTools()) {
          machineBindingBlocked('WORKFLOW_MACHINE_UNAVAILABLE', 'No capable sidecar is connected and local execution is disabled.');
        }
        return { sidecarId, sessionId: sidecarId === null ? localSessionId : manager?.getConnectionSessionId(sidecarId) ?? null,
          selectedBy: selector ? 'explicit' : 'implicit' };
      });
      if (requested && requested !== binding.sidecarId) {
        machineBindingBlocked('WORKFLOW_RETARGET_REQUIRED', `Run is bound to ${binding.sidecarId ?? 'the local host'}; retargeting to ${requested} requires a new decision.`);
      }
      return binding.sidecarId;
    },
    assertDispatch(sidecarId, capability) {
      const target = policy.resolveTarget(sidecarId, capability);
      if (target !== sidecarId) machineBindingBlocked('WORKFLOW_RETARGET_REQUIRED', 'Dispatch does not match the bound machine.');
      const binding = getRunMachineBinding(ctx.runId)!;
      if (sidecarId === null) {
        if (isNoLocalTools() || binding.sessionId !== localSessionId) {
          machineBindingBlocked('WORKFLOW_SESSION_CHANGED', 'The bound local session changed or local tools were disabled.');
        }
        return;
      }
      const manager = getSidecarManager();
      const sidecar = manager?.listSidecars().find(s => s.id === sidecarId);
      if (!sidecar?.connected) machineBindingBlocked('WORKFLOW_MACHINE_OFFLINE', `Bound computer ${sidecarId} is offline or no longer enrolled.`);
      if (!binding.sessionId || manager?.getConnectionSessionId(sidecarId) !== binding.sessionId) {
        machineBindingBlocked('WORKFLOW_SESSION_CHANGED', `The connection session for bound computer ${sidecarId} changed or cannot be verified.`);
      }
      if (capability && (!sidecar.capabilities?.includes(capability) || sidecar.unavailable_capabilities?.some(c => c.name === capability))) {
        machineBindingBlocked('WORKFLOW_CAPABILITY_UNAVAILABLE', `Bound computer ${sidecarId} lacks the ${capability} capability.`);
      }
    },
  };
  return withMachineScope(policy, execute);
}
