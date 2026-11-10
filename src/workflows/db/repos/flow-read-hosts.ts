/**
 * The per-flow read list (#1153); see `../read-hosts.ts` for what it is.
 *
 * Its own columns, not a key in `flow.metadata`, for the reason the CODE-step
 * grant has its own: `PATCH /api/workflows/:id` replaces metadata wholesale,
 * and a permission must not be something an unrelated write can hand out or
 * discard. Written only by `setFlowReadHosts`, which only the human route and
 * the upgrade call.
 */

import { getWorkflowDb } from "../index";
import { normalizeReadHosts, parseReadHosts, type ReadHostsGrant } from "../read-hosts";

export interface FlowReadHosts {
  hosts: string[];
  /** Who wrote the list; null when it was never set. */
  grantedBy: ReadHostsGrant | null;
  grantedAt: number | null;
}

interface Row {
  read_hosts: string | null;
  read_hosts_grant: ReadHostsGrant | null;
  read_hosts_granted_at: number | null;
}

/** The flow's read list, or null when the flow does not exist. */
export function getFlowReadHosts(flowId: string): FlowReadHosts | null {
  const row = getWorkflowDb()
    .query<Row, [string]>(`SELECT read_hosts, read_hosts_grant, read_hosts_granted_at FROM flow WHERE id = ?`)
    .get(flowId);
  if (!row) return null;
  return { hosts: parseReadHosts(row.read_hosts), grantedBy: row.read_hosts_grant, grantedAt: row.read_hosts_granted_at };
}

/**
 * Replace the flow's read list. Throws on an entry that is not a bare host or
 * a flow that does not exist. An empty list clears it: every GET asks again.
 * Takes effect at the next step's authorization; a step already authorized
 * keeps its decision.
 */
export function setFlowReadHosts(flowId: string, hosts: readonly unknown[], grant: ReadHostsGrant = "user"): FlowReadHosts {
  const list = normalizeReadHosts(hosts);
  const at = Date.now();
  const res = getWorkflowDb().run(
    `UPDATE flow SET read_hosts = ?, read_hosts_grant = ?, read_hosts_granted_at = ? WHERE id = ?`,
    [list.length > 0 ? JSON.stringify(list) : null, list.length > 0 ? grant : null, list.length > 0 ? at : null, flowId],
  );
  if (res.changes === 0) throw new Error(`setFlowReadHosts: flow not found (id=${flowId})`);
  return getFlowReadHosts(flowId)!;
}
