/**
 * The same layer against the real engine. Runs only when asked for:
 *
 *   JARVIS_TEST_PEERS_ENGINE=/path/to/collab-claude bun test src/peers/engine-real.test.ts
 *
 * It signs in nowhere and needs no network. The engine checks who owns every
 * folder from its data up to the home folder, so the brain's data folder of
 * this test is made inside HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineDialog } from './engine-client.ts';
import { PeerEngine } from './engine.ts';

const path = process.env.JARVIS_TEST_PEERS_ENGINE;
const made: string[] = [];
afterAll(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });

async function until(done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!path)('the real engine under the brain', () => {
  test('comes up, counts the brain as able to ask a person, and hands it a dialog', async () => {
    const brain = mkdtempSync(join(homedir(), '.jarvis-peers-test-'));
    made.push(brain);
    const dialogs: EngineDialog[] = [];
    const engine = new PeerEngine({
      path: path!, brainDataDir: brain,
      // As if the brain had been started from a coding agent's shell, with a keychain it must not touch in a test.
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', AI_AGENT: 'claude-code/2.1', COLLAB_INTERACTIVE: '0', COLLAB_KEYSTORE: 'file' },
      onDialog: async (dialog) => { dialogs.push(dialog); await new Promise((resolve) => setTimeout(resolve, 600)); return { action: 'cancel' }; },
    });
    engine.start();
    await until(() => engine.state() === 'up');

    const status = await engine.call('account', { action: 'status' });
    expect(status.failed).toBe(false);
    expect(status.text).toContain('Logged in: no');
    expect(status.text).toContain('Dialogs: available');

    const change = await engine.call('policy', { action: 'set', kind: 'message', effect: 'ask' });
    expect(dialogs.length).toBe(1);
    expect(dialogs[0]!.mode).toBe('form');
    expect(dialogs[0]!.during).toEqual({ tool: 'policy', args: { action: 'set', kind: 'message', effect: 'ask' } });
    expect(dialogs[0]!.fields.choice?.options?.map((option) => option.value)).toEqual(['confirm', 'reject']);
    expect(change.text).toContain('nothing changed');
    expect((await engine.call('policy', { action: 'show' })).text).toContain('default message: allow');

    const read = await engine.read('status');
    expect((read.account as { loggedIn: boolean }).loggedIn).toBe(false);
    expect((await engine.read('contacts')).contacts).toEqual([]);
    expect((await engine.read('inbox')).items).toEqual([]);
    expect((await engine.read('tasks')).tasks).toEqual([]);
    engine.stop();
  }, 30_000);
});
