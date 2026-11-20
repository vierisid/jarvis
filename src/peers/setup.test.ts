import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineState } from './engine.ts';
import { engineDataDir } from './engine-process.ts';
import { engineArchiveEntry, engineTarget, installedEngine, installedEnginePath, placeEngine } from './install.ts';
import { PeerLink } from './link.ts';
import { PeerSetup } from './setup.ts';
import type { SetupEngine, SetupStep } from './setup.ts';
import { PeerStore } from './store.ts';
import { fakeSource } from './testing/fake-source.ts';
import { zipWrite } from './zip.ts';

const unix = process.platform !== 'win32';
const env = { PATH: process.env.PATH, HOME: '/brain/home' };
const until = async (what: () => boolean, ms = 4000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (what()) return true; await Bun.sleep(20); } return what(); };

/** An engine that comes up a moment after it is started, and notes what was started. */
function engines(more: { never?: boolean } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  const make = (path: string): SetupEngine => {
    let state: EngineState = 'stopped';
    return {
      state: () => state,
      start() { started.push(path); state = 'starting'; if (!more.never) setTimeout(() => { if (state === 'starting') state = 'up'; }, 30); },
      stop() { stopped.push(path); state = 'stopped'; },
      call: async () => ({ text: '', failed: false }),
      read: async () => ({ account: { loggedIn: false } }),
    };
  };
  return { started, stopped, make };
}

function setup(more: { source?: string | null; enginePath?: string; fetch?: typeof fetch; never?: boolean; dir?: string; db?: Database } = {}) {
  const dir = more.dir ?? mkdtempSync(join(tmpdir(), 'peers-setup-'));
  const memory = new PeerStore(more.db ?? new Database(':memory:'));
  const kept = engines({ never: more.never });
  const made = new PeerSetup({
    brainDataDir: dir, link: new PeerLink(), memory, env, source: more.source ?? null, makeEngine: kept.make, engineUpMs: 600,
    ...(more.enginePath ? { enginePath: more.enginePath } : {}), ...(more.fetch ? { fetch: more.fetch } : {}),
  });
  return { dir, memory, made, ...kept };
}

const program = (first: number): Uint8Array => { const bytes = new Uint8Array(6000).fill(first); bytes.set(process.platform === 'darwin' ? [0xcf, 0xfa, 0xed, 0xfe] : process.platform === 'win32' ? [0x4d, 0x5a] : [0x7f, 0x45, 0x4c, 0x46]); return bytes; };
const serving = (bytes: Uint8Array | null, status = 200) => (async () => new Response(bytes as BodyInit | null, { status })) as unknown as typeof fetch;
const target = engineTarget()!;
const archive = (bytes: Uint8Array) => zipWrite([{ name: engineArchiveEntry(target), bytes, mode: 0o755 }]);

describe('with nothing set up', () => {
  test('there is no engine, no server, and nothing is started', () => {
    const { made, started } = setup();
    expect(made.engineReady()).toBe(false);
    expect(made.canHost()).toBe(false);
    expect(made.hosting()).toEqual({ state: 'off', address: null });
    made.start();
    expect(started).toEqual([]);
  });

  test('an engine named by hand is the engine, and is started with the brain', () => {
    const { made, started } = setup({ enginePath: '/opt/collab/collab-claude' });
    expect(made.engineReady()).toBe(true);
    made.start();
    expect(started).toEqual(['/opt/collab/collab-claude']);
  });

  test('a machine that cannot host says so', async () => {
    const { made } = setup();
    expect(await made.host('northwind.ngrok-free.app')).toEqual({ ok: false, why: 'failed' });
    expect(await made.account('Leo')).toEqual({ ok: false, why: 'failed' });
  });
});

describe('joining', () => {
  test('takes the engine from the server, puts it in place and starts it', async () => {
    const bytes = program(1);
    const { made, dir, started } = setup({ fetch: serving(await archive(bytes)) });
    expect(await made.join('northwind.ngrok-free.app')).toEqual({ ok: true });
    expect(made.engineReady()).toBe(true);
    expect(Buffer.from(readFileSync(installedEnginePath(dir))).equals(Buffer.from(bytes))).toBe(true);
    expect(started).toEqual([installedEnginePath(dir)]);
  });

  test('a server with nothing to take leaves the engine that was there, running', async () => {
    const { made, dir, started, stopped } = setup({ fetch: serving(null, 404) });
    placeEngine(program(1), dir, target);
    made.start();
    expect(await made.join('northwind.ngrok-free.app')).toEqual({ ok: false, why: 'no_build' });
    // Stopped for the writing, and started again as it was.
    expect(started).toEqual([installedEnginePath(dir), installedEnginePath(dir)]);
    expect(stopped.length).toBe(1);
    expect(readFileSync(installedEnginePath(dir))[10]).toBe(1);
  });

  test('an engine named by hand is not written over', async () => {
    let asked = 0;
    const { made, dir, started } = setup({ enginePath: '/opt/collab/collab-claude', fetch: (async () => { asked++; return new Response(null, { status: 404 }); }) as unknown as typeof fetch });
    expect(await made.join('northwind.ngrok-free.app')).toEqual({ ok: true });
    expect(asked).toBe(0);
    expect(installedEngine(dir)).toBeNull();
    expect(started).toEqual(['/opt/collab/collab-claude']);
  });

  test('an engine that does not come up is said so', async () => {
    const { made } = setup({ fetch: serving(await archive(program(1))), never: true });
    expect(await made.join('northwind.ngrok-free.app')).toEqual({ ok: false, why: 'engine' });
  });
});

describe.if(unix)('hosting', () => {
  test('starts the server, builds the engine for this machine against it, starts it, and builds for the others after', async () => {
    const source = fakeSource();
    const { made, dir, started, memory } = setup({ source });
    expect(made.canHost()).toBe(true);
    const steps: SetupStep[] = [];
    expect(await made.host('northwind.ngrok-free.app', (step) => steps.push(step))).toEqual({ ok: true, address: 'https://northwind.ngrok-free.app' });
    expect(steps).toEqual(['server', 'build', 'engine']);
    expect(made.hosting()).toEqual({ state: 'on', address: 'https://northwind.ngrok-free.app' });
    expect(started).toEqual([installedEnginePath(dir)]);
    expect(memory.meta('host.on')).toBe('1');
    // The others' engines come by themselves (the stand-in cannot build one of the five).
    expect(await until(() => made.built().length === 4)).toBe(true);
    // Asked again: nothing is built or started twice.
    const again: SetupStep[] = [];
    expect((await made.host(undefined, (step) => again.push(step))).ok).toBe(true);
    expect(again).toEqual(['server']);
    expect(started.length).toBe(1);
    await made.stopHost();
    expect(made.hosting().state).toBe('off');
    expect(memory.meta('host.on')).toBeNull();
  });

  test('an engine from another organisation is replaced by the one built for this server', async () => {
    const source = fakeSource();
    const { made, dir, started, stopped } = setup({ source });
    placeEngine(program(9), dir, target);
    made.start();
    expect(started.length).toBe(1);
    expect((await made.host('northwind.ngrok-free.app')).ok).toBe(true);
    expect(readFileSync(installedEnginePath(dir))[10]).toBe(0);
    expect(stopped.length).toBe(1);
    expect(started.length).toBe(2);
    await made.stopHost();
  });

  test('a server that was on comes back with the brain, and one that was stopped does not', async () => {
    const source = fakeSource();
    const dir = mkdtempSync(join(tmpdir(), 'peers-setup-'));
    const db = new Database(':memory:');
    const first = setup({ source, dir, db });
    expect((await first.made.host('northwind.ngrok-free.app')).ok).toBe(true);
    // The brain ends: nothing is waited for.
    first.made.stop();
    expect(await until(() => existsSync(join(source, 'deploy', 'ngrok', 'stopped')))).toBe(true);
    const second = setup({ source, dir, db });
    second.made.start();
    expect(await until(() => second.made.hosting().state === 'on')).toBe(true);
    expect(second.started).toEqual([installedEnginePath(dir)]);
    await second.made.stopHost();
    const third = setup({ source, dir, db });
    third.made.start();
    await Bun.sleep(150);
    expect(third.made.hosting().state).toBe('off');
    third.made.stop();
  });

  test('the owner\'s own account is made once and given a new password after', async () => {
    const source = fakeSource();
    const { made } = setup({ source });
    await made.host('northwind.ngrok-free.app');
    expect(made.myName()).toBeNull();
    expect(await made.myAccount('Sam')).toEqual({ ok: true, password: 'pw-sam' });
    expect(made.myName()).toBe('Sam');
    // The stand-in says "taken" for leo: an account from an earlier time gets a new password.
    expect(await made.myAccount('Leo')).toEqual({ ok: true, password: 'new-leo' });
    // Somebody who is invited under a name that is taken is not given that account.
    expect(await made.account('Leo')).toEqual({ ok: false, why: 'taken' });
    await made.stopHost();
  });

  test('leaving stops the server, forgets the name, and sets the engine\'s keys aside', async () => {
    const source = fakeSource();
    const { made, dir, started } = setup({ source });
    await made.host('northwind.ngrok-free.app');
    await made.myAccount('Sam');
    mkdirSync(engineDataDir(dir), { recursive: true });
    writeFileSync(join(engineDataDir(dir), 'keys'), 'the keys');
    expect(await made.leave()).toBe(true);
    expect(made.hosting().state).toBe('off');
    expect(made.myName()).toBeNull();
    expect(existsSync(engineDataDir(dir))).toBe(false);
    const aside = readdirSync(join(dir, 'peers')).filter((name) => name.startsWith('engine.left-'));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dir, 'peers', aside[0]!, 'keys'), 'utf8')).toBe('the keys');
    // The engine runs again, with nothing.
    expect(started.length).toBe(2);
  });
});
