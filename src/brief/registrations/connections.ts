import type { BriefRegistration } from '../capabilities';
import type { ConnectedWorkspace } from '../connected-workspace';
export function registerConnections(provider?: ConnectedWorkspace): BriefRegistration[] {
  return provider ? [{ id: 'connections', provider }] : [];
}
