import type { EditableProfile, ProfilePatch, ProfileSettingsSnapshot, VoiceSaveResult } from '../../../../src/brief/profile-settings-contracts';

export class ProfileRequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export function createProfileSettingsClient(send: typeof fetch = fetch) {
  const request = async (suffix: string, body?: unknown) => {
    const response = await send('/api/brief/profile-settings' + suffix, body === undefined ? { cache: 'no-store' } : {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new ProfileRequestError(data.code ?? 'unavailable', response.status);
    return data;
  };
  return {
    async read(): Promise<ProfileSettingsSnapshot> {
      const result = await request('');
      if (result.status !== 'ready' || result.data?.contractVersion !== 1) throw new ProfileRequestError('unsupported', 501);
      return result.data;
    },
    async saveProfile(revision: string, answers: ProfilePatch): Promise<EditableProfile> {
      return (await request('/profile', { revision, answers })).profile;
    },
    async saveVoice(revision: string, voice: string): Promise<VoiceSaveResult> {
      return request('/voice', { revision, voice });
    },
  };
}
