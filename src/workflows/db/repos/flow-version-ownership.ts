import { getWorkflowDb } from "../index";

export class FlowVersionRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = "FlowVersionRequestError";
  }
}

/** Check identity before loading version content or its editor sidecar. */
export function assertFlowVersionOwnership(flowId: string, versionId: string): void {
  const owned = getWorkflowDb().query<{ id: string }, [string, string]>(
    `SELECT v.id FROM flow_version v JOIN flow f ON f.id = v.flow_id
     WHERE v.id = ? AND v.flow_id = ?`,
  ).get(versionId, flowId);
  // Missing and wrong-parent versions deliberately have the same response.
  if (!owned) throw new FlowVersionRequestError("version not found in flow", 404);
}

/** Keep the ownership check and nested operation in one synchronous transaction. */
export function withOwnedFlowVersion<T>(flowId: string, versionId: string, operation: () => T): T {
  return getWorkflowDb().transaction(() => {
    assertFlowVersionOwnership(flowId, versionId);
    return operation();
  })();
}
