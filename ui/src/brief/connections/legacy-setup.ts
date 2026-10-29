import type { ConnectionSetupAction } from '../../../../src/brief/connected-workspace-contracts';
import { requestSettingsTab } from '../../v2/shell/settings-tab-request';
import { requestPieceSetup } from '../../v2/rooms/workflows/connection-setup-request';
import { openRoom } from '../../v2/router';

/** Current, working setup surfaces. No new credential form or universal OAuth flow. */
export function openLegacyConnectionSetup(action: ConnectionSetupAction, rowId: string | null): void {
  switch (action.target.kind) {
    case 'hosted_integration': requestSettingsTab('integrations'); openRoom('settings'); return;
    case 'google': requestSettingsTab('integrations'); openRoom('settings'); return;
    case 'channel': requestSettingsTab('channels'); openRoom('settings'); return;
    case 'device': requestSettingsTab('sidecar'); openRoom('settings'); return;
    case 'piece_credentials': requestPieceSetup({ ...action.target, rowId }); openRoom('workflows'); return;
    default: throw new Error('Unsupported setup path');
  }
}
