/**
 * Getting into an organisation: the engine in place, and the server for the
 * one who makes it.
 *
 * Two ways in, as the owner put it on 20 November 2026:
 *
 *   - MAKE ONE. This machine becomes the host: the server and its tunnel are
 *     started here (./host.ts), the engine for this machine is built against
 *     that server and started, and the engines for the other systems are
 *     built after it, for whoever joins. The host chooses when the server is
 *     on: it stays on until they stop it, and comes back with the brain.
 *   - JOIN ONE. The engine for this machine is taken from the organisation's
 *     server (./install.ts) and started. No server here.
 *
 * This file holds the one engine there is (./engine.ts), so that it can be
 * started after the brain is up, and started anew when another one is put in
 * its place.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { PeerEngine } from './engine.ts';
import type { EngineState } from './engine.ts';
import { engineDataDir } from './engine-process.ts';
import { PeerHost, canHost, signInByForm } from './host.ts';
import type { HostAccount, HostStarted, HostState } from './host.ts';
import { engineTarget, fetchEngine, installedEngine, peerServerAddress, placeEngine } from './install.ts';
import type { EngineFetched, EngineTarget } from './install.ts';
import type { PeerEngineLike, PeerLink } from './link.ts';

/** How long an engine that was just put in place has to come up. */
export const SETUP_ENGINE_UP_MS = 30_000;

/** What is remembered between two runs of the brain. The peers' store is it (./store.ts). */
export interface PeerSetupMemory {
  meta(key: string): string | null;
  setMeta(key: string, value: string | null): void;
}

/** The name of this machine's owner at the server it runs, and whether the server is meant to be on. */
const MY_NAME = 'host.me', HOST_ON = 'host.on';
/** The address of the organisation whose engine was put in place here. */
const SERVER = 'server';

export type SetupStep = 'server' | 'build' | 'engine';

export type SetupHosted =
  | { ok: true; address: string }
  /** As ./host.ts says, and: build, the engine for this machine could not be built. engine, it did not start. */
  | { ok: false; why: 'address' | 'tools' | 'busy' | 'tunnel' | 'failed' | 'build' | 'engine' | 'system'; missing?: string; code?: string; account?: string };

export type SetupJoined = { ok: true } | { ok: false; why: Extract<EngineFetched, { ok: false }>['why'] | 'engine' };

/** What the notch needs of this file. A test passes its own. */
export interface PeerSetupLike {
  /** There is an engine on this machine: one that was named by hand, or one that was put in place. */
  engineReady(): boolean;
  /** This machine can run an organisation's server. */
  canHost(): boolean;
  /** The server this machine runs. `address` is null until one was set up here. */
  hosting(): { state: HostState; address: string | null };
  /** The name the owner took at their own server, when this machine made one. */
  myName(): string | null;
  /** Starts the server (`domain`: its tunnel's address, the first time), and the engine for this machine with it. */
  host(domain: string | undefined, step?: (step: SetupStep) => void): Promise<SetupHosted>;
  /** Stops the server. It stays off until it is started again. */
  stopHost(): Promise<void>;
  /** Makes the owner's own account at their server, or gives it a new password, and remembers the name. */
  myAccount(name: string): Promise<HostAccount>;
  /** Makes an account for somebody who is invited. */
  account(name: string): Promise<HostAccount>;
  /** Gives somebody who is in the organisation already a new password: their laptop was set up anew. */
  newPassword(name: string): Promise<HostAccount>;
  /** Signs in at this machine's own server with a password it just made. No browser. */
  signIn(page: string, login: string, password: string): Promise<boolean>;
  /** Takes the engine from an organisation's server and starts it. */
  join(server: string): Promise<SetupJoined>;
  /** The systems an engine is ready for, for those who join. */
  built(): EngineTarget[];
  /** Leaves the organisation: the engine's keys are set aside, and the server stops when this machine ran it. */
  leave(): Promise<boolean>;
  /** Sets the engine's keys and its sign-in aside and starts it anew, with nothing. False when that could not be done. */
  fresh(): Promise<boolean>;
  /** The server went on or off. */
  onChange(listener: () => void): void;
}

/** The engine as this file holds it. ./engine.ts is it; a test passes its own. */
export interface SetupEngine extends PeerEngineLike {
  start(): void;
  stop(): void;
}

export interface PeerSetupOptions {
  brainDataDir: string;
  link: PeerLink;
  memory: PeerSetupMemory;
  /** The engine's place, named by hand (JARVIS_PEERS_ENGINE). It is used as it is, and nothing is put in its place. */
  enginePath?: string | null;
  /** The engine's source, for hosting (JARVIS_PEERS_SOURCE). */
  source?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
  runtimeDir?: string;
  log?: (line: string) => void;
  /** For tests: other ways to do each thing, and another clock. */
  makeEngine?: (path: string, env: Record<string, string | undefined>) => SetupEngine;
  makeHost?: (source: string, onState: () => void) => PeerHost;
  fetch?: typeof fetch;
  engineUpMs?: number;
  platform?: string;
}

export class PeerSetup implements PeerSetupLike {
  private engine: SetupEngine | null = null;
  private readonly peerHost: PeerHost | null;
  private stateWaiters: (() => void)[] = [];
  private changeListeners: (() => void)[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly options: PeerSetupOptions) {
    this.log = options.log ?? (() => { /* quiet */ });
    const source = options.source ?? null;
    this.peerHost = canHost(source, options.platform ?? process.platform)
      ? (options.makeHost?.(source, () => this.changed()) ?? new PeerHost({ source, env: options.env, home: options.home, runtimeDir: options.runtimeDir, log: this.log, onState: () => this.changed() }))
      : null;
  }

  private changed(): void {
    for (const listener of this.changeListeners) { try { listener(); } catch { /* a listener's own fault */ } }
  }

  private path(): string | null {
    return this.options.enginePath ?? installedEngine(this.options.brainDataDir);
  }

  /** With the brain: the engine when there is one, and the server when it was left on. */
  start(): void {
    const path = this.path();
    if (path) this.startEngine(path);
    if (this.peerHost && this.peerHost.address() && this.options.memory.meta(HOST_ON) === '1') {
      void this.peerHost.start().then((started) => { if (started.ok) void this.peerHost?.buildRest(); });
    }
  }

  /** With the brain's end: both are told to leave, and neither is waited for. The server is on again with the next brain. */
  stop(): void {
    this.engine?.stop();
    this.engine = null;
    this.peerHost?.release();
  }

  private startEngine(path: string): void {
    this.engine?.stop();
    const { link } = this.options;
    const onState = (state: EngineState): void => {
      link.engineState(state);
      for (const waiter of this.stateWaiters.splice(0)) waiter();
    };
    this.engine = this.options.makeEngine?.(path, this.engineEnv()) ?? new PeerEngine({
      path, brainDataDir: this.options.brainDataDir, env: this.engineEnv(), log: this.log,
      onDialog: link.dialog, onNotice: link.notice, onState,
    });
    link.attach(this.engine);
    this.engine.start();
  }

  /**
   * What the engine is started with. An engine that was put in place here
   * belongs to one organisation, and is told that organisation's address: a
   * server setting left over in the environment from another time would
   * otherwise send its first sign-in there. An engine named by hand keeps
   * the environment as it is.
   */
  private engineEnv(): Record<string, string | undefined> {
    const base = this.options.env ?? process.env;
    const server = this.options.enginePath ? null : (this.peerHost?.address() ?? this.options.memory.meta(SERVER));
    return server ? { ...base, COLLAB_SERVER_URL: server } : base;
  }

  /** Waits until the engine is up, as long as it is given. */
  private async engineUp(): Promise<boolean> {
    const until = Date.now() + (this.options.engineUpMs ?? SETUP_ENGINE_UP_MS);
    while (this.engine && this.engine.state() !== 'up') {
      const left = until - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.stateWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.engine?.state() === 'up';
  }

  engineReady(): boolean { return this.path() !== null; }
  canHost(): boolean { return this.peerHost !== null; }
  hosting(): { state: HostState; address: string | null } {
    return { state: this.peerHost?.state() ?? 'off', address: this.peerHost?.address() ?? null };
  }
  myName(): string | null { return this.options.memory.meta(MY_NAME); }
  built(): EngineTarget[] { return this.peerHost?.built() ?? []; }

  async host(domain: string | undefined, step?: (step: SetupStep) => void): Promise<SetupHosted> {
    const host = this.peerHost;
    if (!host) return { ok: false, why: 'failed' };
    step?.('server');
    const started = await host.start(domain);
    if (!started.ok) return started;
    this.options.memory.setMeta(HOST_ON, '1');
    // An engine named by hand is the owner's own choice, and is left as it is.
    if (!this.options.enginePath) {
      const target = engineTarget(this.options.platform ?? process.platform);
      if (!target) return { ok: false, why: 'system' };
      if (!host.program(target)) {
        step?.('build');
        if (!(await host.build(target))) return { ok: false, why: 'build' };
      }
      const program = host.program(target);
      if (!program) return { ok: false, why: 'build' };
      // The engine that runs here is the one built for this server: one from another organisation would sign in there.
      const placed = installedEngine(this.options.brainDataDir, target);
      try {
        const built = readFileSync(program);
        if (!placed || !built.equals(readFileSync(placed))) {
          this.engine?.stop();
          this.engine = null;
          placeEngine(built, this.options.brainDataDir, target);
        }
      } catch { return { ok: false, why: 'build' }; }
    }
    if (!this.engine || this.engine.state() !== 'up') {
      step?.('engine');
      const path = this.path();
      if (!path) return { ok: false, why: 'engine' };
      if (!this.engine) this.startEngine(path);
      if (!(await this.engineUp())) return { ok: false, why: 'engine' };
    }
    // The engines for the others, in their own time.
    void host.buildRest();
    return started;
  }

  async stopHost(): Promise<void> {
    this.options.memory.setMeta(HOST_ON, null);
    await this.peerHost?.stop();
  }

  async myAccount(name: string): Promise<HostAccount> {
    const host = this.peerHost;
    if (!host) return { ok: false, why: 'failed' };
    let made = await host.account(name);
    // It is there already: the owner's own, from an earlier time. It gets a new password, and nobody else had the old one.
    if (!made.ok && made.why === 'taken') made = await host.newPassword(name);
    if (made.ok) this.options.memory.setMeta(MY_NAME, name);
    return made;
  }

  account(name: string): Promise<HostAccount> {
    return this.peerHost ? this.peerHost.account(name) : Promise.resolve({ ok: false, why: 'failed' });
  }

  newPassword(name: string): Promise<HostAccount> {
    return this.peerHost ? this.peerHost.newPassword(name) : Promise.resolve({ ok: false, why: 'failed' });
  }

  signIn(page: string, login: string, password: string): Promise<boolean> {
    const address = this.peerHost?.address();
    return address ? signInByForm(page, address, login, password, this.options.fetch) : Promise.resolve(false);
  }

  async join(server: string): Promise<SetupJoined> {
    if (!this.options.enginePath) {
      // The one that runs is stopped first: a program that runs cannot be written over on every system.
      this.engine?.stop();
      this.engine = null;
      const fetched = await fetchEngine({ server, brainDataDir: this.options.brainDataDir, target: engineTarget(this.options.platform ?? process.platform), fetch: this.options.fetch });
      if (!fetched.ok) {
        const before = this.path();
        if (before) this.startEngine(before);
        return fetched;
      }
      const address = peerServerAddress(server);
      if (address) this.options.memory.setMeta(SERVER, address);
    }
    const path = this.path();
    if (!path) return { ok: false, why: 'engine' };
    this.startEngine(path);
    return (await this.engineUp()) ? { ok: true } : { ok: false, why: 'engine' };
  }

  async leave(): Promise<boolean> {
    await this.stopHost();
    this.options.memory.setMeta(MY_NAME, null);
    this.options.memory.setMeta(SERVER, null);
    return this.fresh();
  }

  async fresh(): Promise<boolean> {
    this.engine?.stop();
    this.engine = null;
    // Set aside, not destroyed: under a name with the day in it, beside where it was.
    const folder = engineDataDir(this.options.brainDataDir);
    let done = true;
    try {
      if (existsSync(folder)) renameSync(folder, `${folder}.left-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    } catch {
      this.log('[peers] the engine\'s folder could not be set aside');
      done = false;
    }
    const path = this.path();
    if (path) {
      this.startEngine(path);
      if (done) await this.engineUp();
    }
    return done;
  }

  onChange(listener: () => void): void { this.changeListeners.push(listener); }
}
