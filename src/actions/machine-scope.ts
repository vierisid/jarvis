import { AsyncLocalStorage } from 'node:async_hooks';
import type { SidecarCapability } from '../sidecar/types';

/** The workflow supplies this policy. Ordinary chat keeps its existing routing. */
export interface MachineScope {
  resolveTarget(explicit: unknown, capability?: SidecarCapability): string | null;
  assertDispatch(sidecarId: string | null, capability?: SidecarCapability): void;
  binding(): { sidecarId: string | null; sessionId: string | null } | null;
}
const scope = new AsyncLocalStorage<MachineScope>();
export const getMachineScope = () => scope.getStore();
export function withMachineScope<T>(policy: MachineScope, execute: () => T): T {
  return scope.run(policy, execute);
}

/** Synchronous fence immediately before writing an RPC to its socket. */
export function assertMachineDispatch(sidecarId: string): void {
  scope.getStore()?.assertDispatch(sidecarId);
}
