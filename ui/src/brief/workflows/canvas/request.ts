import type { WorkflowRequest } from "../../../v2/rooms/workflows/WorkflowEditorEnvironment";
/** Editable-version pin, not a new server contract. F-21 supplies the scoped,
 * redacted request. A changed latest draft must never silently become editable. */
export function versionBoundRequest(
  request: WorkflowRequest,
  flowId: string,
  versionId: string,
): WorkflowRequest {
  return async (input, init) => {
    const response = await request(input, init);
    if (
      (init?.method ?? "GET") !== "GET" ||
      String(input) !== `/api/workflows/${flowId}` ||
      !response.ok
    )
      return response;
    const detail = await response.clone().json();
    const editable = detail?.latestDraft ?? detail?.published;
    if (
      detail?.flow?.id !== flowId ||
      editable?.id !== versionId ||
      editable?.flowId !== flowId
    )
      throw new Error(
        "The selected version changed. Reopen this workflow to continue.",
      );
    return response;
  };
}
