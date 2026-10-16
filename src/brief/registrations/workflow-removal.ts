import type { BriefRegistration } from '../capabilities';
import type { WorkflowRemoval } from '../workflow-removal';
export function registerWorkflowRemoval(provider?: WorkflowRemoval): BriefRegistration[] {
  return provider ? [{ id: 'workflowRemoval', provider }] : [];
}
