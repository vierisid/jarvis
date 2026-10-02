import { getWorkflowDb } from "../index";

/**
 * A refusal the route layer answers verbatim. `trapErrors` in
 * `workflows/api/routes.ts` maps it to `status` with this message, so a repo
 * that knows exactly why it refused does not have to be re-diagnosed from a
 * 500 by a regex over the message.
 *
 * 413 joined 400 and 404 for the sample-data map caps (#635). Those are
 * enforced in `flow-version.ts` rather than at the route because that is where
 * the read-modify-write they guard is atomic -- `withOwnedFlowVersion` wraps it
 * in one transaction, and a route-level pre-read of the current map would be
 * TOCTOU. That does mean `flow-version.ts` now raises two error vocabularies:
 * this class where it knows the status, and plain `Error` everywhere else,
 * which `trapErrors` still maps by regex.
 */
export class FlowVersionRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413) {
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
