import { randomUUID } from 'node:crypto';
import { getSidecarManager } from '../../actions/tools/sidecar-route';
import { isNoLocalTools } from '../../actions/tools/local-tools-guard';
import { withMachineScope, type MachineScope } from '../../actions/machine-scope';
import type { SidecarCapability, SidecarInfo } from '../../sidecar/types';
import { ensureRunMachineBinding, getRunMachineBinding, machineBindingBlocked } from '../db/repos/run-machine-binding';
import { assertRunNotCanceled } from './cancellation';
import { getWorkflowDb } from '../db';
import { getFlowVersion } from '../db/repos/flow-version';
import type { RunExecutionConfig } from '../db/repos/flow-run';
import { walkFlowNodes } from '../db/flow-graph';
import { workflowExpressionReferences } from './safe-expression';

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

function inputReferences(input: unknown): Set<string> {
  const references = new Set<string>();
  const pending: unknown[] = [input];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      // Match the engine's template grammar. A quoted step name is a literal,
      // whereas computed members and nested expressions can reference samples.
      for (const [, expression] of value.matchAll(/\{\{(.*?)\}\}/g)) {
        if (expression!.startsWith('connections')) continue;
        for (const name of workflowExpressionReferences(expression!)) references.add(name);
      }
    } else if (value && typeof value === 'object') {
      pending.push(...Object.values(value));
    }
  }
  return references;
}

function previewUsesUnqualifiedSamples(runId: string, activeStepName?: string): boolean {
  const row = getWorkflowDb().query('SELECT flow_version_id, execution_config FROM flow_run WHERE id=?')
    .get(runId) as { flow_version_id: string; execution_config: string | null } | null;
  const config: RunExecutionConfig | null = row?.execution_config ? JSON.parse(row.execution_config) : null;
  if (!config?.stepNameToTest) return false;
  // The API forwards the whole version's sample map, and the worker captures
  // successful previews back into it. The engine excludes the tested step's
  // own output, so neither that output nor unrelated samples taint this call.
  const samples = new Set(Object.keys(config.sampleData ?? {}).filter(name => name !== config.stepNameToTest));
  if (!samples.size) return false;
  const version = getFlowVersion(row!.flow_version_id);
  const nodes = new Map(version ? walkFlowNodes(version.trigger).map(node => [node.name, node]) : []);
  // A router/loop preview can execute a child. Validate the dispatching step,
  // not just the container selected in the editor.
  const stepName = activeStepName ?? config.stepNameToTest;
  const step = nodes.get(stepName);
  if (!step) machineBindingBlocked('WORKFLOW_SAMPLE_BINDING_UNKNOWN', 'The saved preview step is unavailable for provenance validation.');
  // Match the engine's replacement semantics, using the run's frozen override
  // rather than live version samples or the already-resolved tool arguments.
  const overrides = config.sampleInputOverride;
  const input = overrides && Object.hasOwn(overrides, stepName)
    ? overrides[stepName] : step.settings?.input;
  // BEGIN replaces the trigger's sample with this run's payload. Other step
  // outputs are fixtures; loop items are derived from fixtures during preview
  // context construction, BEFORE that trigger replacement.
  const pending = [...inputReferences(input)].filter(name => name !== version!.trigger.name);
  const visited = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const node = nodes.get(name);
    if (node?.type === 'LOOP_ON_ITEMS') {
      const roots = [...inputReferences(node.settings)];
      // The selected loop itself runs with the current payload; other loop
      // outputs were assembled from samples by testExecutionContext.
      pending.push(...roots.filter(root => name !== config.stepNameToTest || root !== version!.trigger.name));
    } else if (samples.has(name)) {
      // Sample rows have no trusted session provenance today, regardless of
      // fields a user may have put inside the sample's arbitrary JSON value.
      return true;
    }
  }
  return false;
}

export function withWorkflowMachineBinding<T>(ctx: { runId: string; projectId: string; stepName?: string }, execute: () => T): T {
  const policy: MachineScope = {
    binding: () => getRunMachineBinding(ctx.runId),
    resolveTarget(explicit, capability) {
      assertRunNotCanceled(ctx.runId);
      const selector = typeof explicit === 'string' && explicit.trim() ? explicit.trim() : null;
      const manager = getSidecarManager();
      const inventory = manager?.listSidecars() ?? [];
      const prior = getRunMachineBinding(ctx.runId);
      if ((!capability && !prior) || (capability && ['desktop', 'browser', 'screenshot'].includes(capability))) {
        if (previewUsesUnqualifiedSamples(ctx.runId, ctx.stepName)) {
          machineBindingBlocked('WORKFLOW_SAMPLE_BINDING_UNKNOWN', 'Referenced test outputs have no verified machine/session provenance. Run the required perception steps again in a full run.');
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
