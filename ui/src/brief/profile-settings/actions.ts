import { resetOnboarding } from '../../v2/onboarding/resetClient';
import { requestSettingsTab } from '../../v2/shell/settings-tab-request';
import { openRoom } from '../../v2/router';

/** Use the current deployment-aware voice form; it owns provider setup and secrets. */
export function openVoiceSettings() { requestSettingsTab('channels'); openRoom('settings'); }

/** Profile replay clears the canonical profile. Only an explicit, confirmed user action may call it. */
export async function replayProfileSettings(scope: 'profile' | 'tutorial', confirmed: boolean) {
  if (confirmed !== true || !['profile', 'tutorial'].includes(scope)) throw new Error('Replay confirmation required');
  return resetOnboarding(scope);
}
