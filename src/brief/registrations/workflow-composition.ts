import type { BriefCompositionProvider } from '../composition';
import type { BriefRegistration } from '../capabilities';

export function registerWorkflowComposition(provider: BriefCompositionProvider): BriefRegistration[] {
  return [{ id: 'workflowComposition', provider }];
}
