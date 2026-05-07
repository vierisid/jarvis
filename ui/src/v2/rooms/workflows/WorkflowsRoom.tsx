/**
 * Stub for the workflows room.
 *
 * The legacy in-house workflow builder has been removed. The new workflow
 * system (activepieces-based) builder lands in Phase 4. Until then this room
 * is a placeholder so the dashboard nav slot stays available; the v2 API
 * (`/api/workflows/*`) is fully functional and can be exercised via curl or
 * the assistant once the new workflow tools land.
 */

import React from "react";

export function WorkflowsRoomBody(): React.ReactElement {
  return (
    <div style={{ padding: "1rem", color: "#94a3b8" }}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Workflows</h2>
      <p style={{ marginTop: "0.5rem", fontSize: "0.9rem", lineHeight: 1.5 }}>
        The visual builder is being rebuilt on top of the new workflow runtime.
        Until then, manage workflows via the <code>/api/workflows</code> API or
        wait for the next dashboard release.
      </p>
    </div>
  );
}

export function WorkflowsRoom(): React.ReactElement {
  return <WorkflowsRoomBody />;
}
