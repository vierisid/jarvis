import type { BriefRegistration } from '../capabilities';
import type { WorkflowContext } from '../workflow-context';
export function registerWorkflowContext(provider?: WorkflowContext): BriefRegistration[] {
  return provider ? [{ id: 'workflowContext', provider }] : [];
}
