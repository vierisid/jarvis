import type { BriefRegistration } from '../capabilities';
import type { DecisionDocuments } from '../decision-documents';
export function registerDecisionEdits(provider?: DecisionDocuments): BriefRegistration[] {
  return provider ? [{ id: 'decisionEdits', provider }] : [];
}
