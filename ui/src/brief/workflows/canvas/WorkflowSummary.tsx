import React, { useMemo } from "react";
import type { FlowStepNode, PieceCatalogEntry } from "../../../v2/rooms/workflows/useWorkflowEditor";
import { summarizeWorkflow } from "../../../v2/rooms/workflows/workflow-summary";

/** What the workflow does, in a sentence, generated from the graph as it stands (unsaved edits included). */
export function WorkflowSummary({
  trigger,
  catalog,
}: {
  trigger: FlowStepNode | null;
  catalog: PieceCatalogEntry[];
}): React.ReactElement | null {
  const summary = useMemo(() => (trigger ? summarizeWorkflow(trigger, catalog) : null), [trigger, catalog]);
  if (!summary) return null;
  return (
    <p className="brief-workflow-summary" data-testid="workflow-summary">
      {summary.text}
    </p>
  );
}
