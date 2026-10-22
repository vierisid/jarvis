import { expect, test } from 'bun:test';
import { createAccountRooms } from './account-rooms';
import { createHostTransport } from './http';
import { profileEnvelope } from '../account/profile/fixtures';

const REV_A = 'a'.repeat(64), REV_B = 'b'.repeat(64);
const storage = { getItem: () => null, setItem: () => {} };
function host(send: (path: string, init: RequestInit) => Response) {
  const transport = createHostTransport((async (path: string, init: RequestInit = {}) => send(String(path), init)) as unknown as typeof fetch);
  return createAccountRooms({ scopeId: 'scope', transport, capabilities: () => ({}), storage, navigate: async () => ({ state: 'opened' }),
    replayTutorial: async () => ({ state: 'replayed' }), openSetup: () => {},
    manageDevice: async () => ({ state: 'unavailable' }), deviceDetails: () => undefined as never });
}
async function settle(read: () => boolean) { for (let i = 0; i < 200 && read(); i++) await Bun.sleep(1); }

test('a profile save is confirmed only when F-23 reads the saved answer back', async () => {
  let patched = false;
  const account = host((path, init) => {
    if (path === '/api/brief/profile-settings/profile' && init.method === 'PATCH') {
      patched = true;
      return Response.json({ saved: true, profile: { revision: REV_B, answers: { company: 'New' } } });
    }
    // The read after the save still shows the old answer: the write is not visible.
    return Response.json(profileEnvelope({ revision: REV_A, answers: { company: 'Old' } }));
  });
  const c = account.profile;
  c.setAccess(true);
  await settle(() => c.snapshot().availability === 'loading' || c.snapshot().reading);
  expect(c.snapshot().availability).toBe('ready');
  c.edit('company', 'New');
  await c.save();
  expect(patched).toBe(true);
  expect(c.snapshot().phase).toBe('unknown');
  account.retire();
});
