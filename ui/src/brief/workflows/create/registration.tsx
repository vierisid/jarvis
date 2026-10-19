import React from "react";
import type { BriefRoomModule } from "../../contracts";
import { WorkflowCreationRoom, type WorkflowCreationBinding } from "./WorkflowCreationRoom";

/** F-25 host opt-in seam. The owner hook supplies one scope-retained controller,
 * an F-07 capability snapshot and canonical recent-run reads. No eager requests. */
export function workflowCreationRegistration(useBinding: () => WorkflowCreationBinding | undefined): BriefRoomModule {
  return { id:"workflows", title:"Workflows", legacyRoom:"workflows", Body: function CreationBody({ shell }) {
    return <WorkflowCreationRoom shell={shell} binding={useBinding()} />;
  } };
}
