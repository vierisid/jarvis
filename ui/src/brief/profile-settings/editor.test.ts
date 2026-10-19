import { test, expect } from 'bun:test';
import { ProfileEditor } from './editor';
import type { EditableProfile, ProfileSettingsSnapshot } from '../../../../src/brief/profile-settings-contracts';
const snapshot = (revision: string): ProfileSettingsSnapshot => ({ contractVersion: 1, profile: { revision, answers: { company: revision } } } as ProfileSettingsSnapshot);
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('polls and reordered reads never overwrite a draft or advance its comparison revision', async () => {
  let value = snapshot('initial'), sent = '';
  const editor = new ProfileEditor({ read: async () => value, saveProfile: async revision => { sent = revision; throw Error('revision_conflict'); } });
  await editor.refresh(); editor.edit('company', 'Local'); value = snapshot('newer');
  await editor.refresh(); await expect(editor.save()).rejects.toThrow('revision_conflict');
  expect(sent).toBe('initial'); expect(editor.current().draft.company).toBe('Local');
  await editor.discardAndReload(); expect(editor.current().profile?.revision).toBe('newer');
  const first = deferred<ProfileSettingsSnapshot>(), second = deferred<ProfileSettingsSnapshot>(); let calls = 0;
  const racing = new ProfileEditor({ read: () => ++calls === 1 ? first.promise : second.promise, saveProfile: async () => { throw Error(); } });
  const a = racing.refresh(), b = racing.refresh(); second.resolve(snapshot('second')); await b; first.resolve(snapshot('first')); await a;
  expect(racing.current().profile?.revision).toBe('second');
});
test('edits typed during save survive and an old poll cannot restore the pre-save revision', async () => {
  const poll = deferred<ProfileSettingsSnapshot>(), save = deferred<EditableProfile>(); let reads = 0, writes = 0;
  const editor = new ProfileEditor({ read: async () => ++reads === 1 ? snapshot('before') : poll.promise, saveProfile: () => { writes++; return save.promise; } });
  await editor.refresh(); const refreshing = editor.refresh(); editor.edit('company', 'Submitted');
  const saving = editor.save(); editor.edit('company', 'Typed during save'); await editor.save();
  save.resolve({ revision: 'saved', answers: { company: 'Submitted' } }); await saving;
  poll.resolve(snapshot('before')); await refreshing;
  expect(editor.current()).toMatchObject({ profile: { revision: 'saved' }, draft: { company: 'Typed during save' }, saving: false });
  expect(writes).toBe(1);
});
