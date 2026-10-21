import type { WorkflowRequest } from "../../../v2/rooms/workflows/WorkflowEditorEnvironment";
/** Editable-version pin, not a new server contract. F-21 supplies the scoped,
 * redacted request. A changed latest draft must never silently become editable. */
export function versionBoundRequest(
  request: WorkflowRequest,
  flowId: string,
  versionId: string,
  readOnly = false,
): WorkflowRequest {
  return async (input, init) => {
    if (readOnly && (init?.method ?? 'GET').toUpperCase() !== 'GET')
      return Response.json({ error: 'This version is read-only. Create a new draft to edit it.' }, { status: 403 });
    const response = await request(input, init);
    if (
      (init?.method ?? "GET") !== "GET" ||
      String(input) !== `/api/workflows/${flowId}` ||
      !response.ok
    )
      return response;
    const detail = await response.clone().json();
    if (readOnly && detail?.flow?.id === flowId) {
      const selected = await request(`/api/workflows/${encodeURIComponent(flowId)}/versions/${encodeURIComponent(versionId)}`, init);
      if (!selected.ok) throw new Error('Selected version unavailable');
      const version = await selected.json();
      if (version.id !== versionId || version.flowId !== flowId || version.state !== 'LOCKED') throw new Error('Selected version changed');
      return Response.json({ ...detail, latestDraft: null, published: version, uiMeta: version.uiMeta ?? null });
    }
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
