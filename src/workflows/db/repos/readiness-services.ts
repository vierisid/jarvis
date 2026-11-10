import type { Database } from 'bun:sqlite';
import { getWorkflowDb } from '../index';
import type { ReadinessContext } from '../../runtime/workflow-readiness';
import type { PieceLookup } from '../../runtime/piece-catalog';
import type { CredentialResolver } from '../../credentials/adapter';
import type { SidecarInfo } from '../../../sidecar/types';

/**
 * The live inventories readiness and binding pins read: the piece catalog,
 * credential sources, tools, roles and, for Q-05, the enrolled computers and
 * whether this computer may run local tools. Configured by the daemon; tests
 * configure only what they exercise.
 */
export interface ReadinessServices {
  pieces?: PieceLookup;
  credentials?: CredentialResolver;
  tool?: ReadinessContext['tool'];
  roles?: ReadinessContext['roles'];
  /** A specialist's tool entries, for whether its delegations act on the computer (#1314 M2). */
  roleTools?: (roleId: string) => readonly string[] | null;
  /** Enrolled sidecars, most recently enrolled first, each with its persisted capabilities. */
  machines?: () => SidecarInfo[];
  /** False when local tools are disabled, so no step may run on this computer. */
  localTools?: () => boolean;
  /**
   * Why nothing on this Jarvis can answer a step that asks a person (Brief
   * decisions is off), or null when something can. The message the step
   * itself would fail with (human-input-contract.ts).
   */
  humanInputUnavailable?: () => string | null;
}

// Scoped to the live database, not a process-wide test flag. A missing catalog
// fails closed for piece nodes; primitive/manual graphs need no catalog.
const services = new WeakMap<Database, ReadinessServices>();
export function configureWorkflowReadiness(context: ReadinessServices): void {
  services.set(getWorkflowDb(), context);
}
export function workflowReadinessServices(): ReadinessServices | undefined {
  return services.get(getWorkflowDb());
}
