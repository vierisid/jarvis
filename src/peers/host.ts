/**
 * An organisation's server, run on this machine.
 *
 * Whoever makes an organisation is its host: the server that carries what
 * the others send runs here, behind a tunnel, for as long as the host keeps
 * it on. This file starts it, stops it, makes the accounts of the people who
 * are invited, and builds the engine for their systems.
 *
 * NOTHING OF THE SERVER IS IN THIS PRODUCT. The server, its tunnel script
 * and the engine's source are a separate program that is not part of Jarvis
 * (docs/peers/README.md). The host names a checkout of it in
 * JARVIS_PEERS_SOURCE, and what is run from here is that checkout's own
 * script, with fixed words. With the name unset, nothing of this file runs
 * and nobody can make an organisation here: they can still join one.
 *
 * FOR A DEMO. The script it runs calls itself a test environment: no
 * backups, one machine, and a tunnel whose address is the server's whole
 * identity. That is what the owner asked for on 20 November 2026: "This
 * would only be for a demo."
 *
 * Three things hold:
 *
 *   - The server lives only as long as the brain. It is started through a
 *     small watcher that ends it when the brain's end of a pipe closes, so a
 *     brain that falls leaves no server and no open tunnel behind.
 *   - A password is made by the server's own tool, passes through here once,
 *     and is written nowhere: not in a log, not in the store.
 *   - What runs gets an environment made name by name, as the engine does
 *     (./engine-process.ts): the allowlist, the real home (the tunnel
 *     program keeps its account there), and the two settings named below.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { filterEnv } from '../util/subprocess-env.ts';
import { readPipe } from './engine-process.ts';
import { ENGINE_TARGETS, engineArchiveName, engineFileName, engineTarget, peerServerAddress } from './install.ts';
import type { EngineTarget } from './install.ts';
import { PEER_LOCAL_PAGE } from './link.ts';
import { zipWrite } from './zip.ts';
import type { ZipFile } from './zip.ts';

/** The script that runs the server and its tunnel, inside the source. And where it keeps what it makes. */
export const HOST_SCRIPT = join('deploy', 'ngrok', 'test-env.sh');
const HOST_SETTINGS = join('deploy', 'ngrok', '.env');
const HOST_DATA = join('deploy', 'ngrok', 'data');
const HOST_BUILDS = join('deploy', 'ngrok', 'dist');
const HOST_BUILDER = join('packages', 'connector-claude-code');

/** How long the server and its tunnel have to come up: packages are fetched first, the first time. */
export const HOST_START_MS = 5 * 60_000;
/** How long they have to go down by themselves before they are made to. */
export const HOST_STOP_MS = 12_000;
export const HOST_ACCOUNT_MS = 60_000;
/** A build fetches the runtime for its system the first time. */
export const HOST_BUILD_MS = 10 * 60_000;

/** True when this machine can host: the source is named, its script is there, and the system can run it. */
export function canHost(source: string | null, platform: string = process.platform): source is string {
  return !!source && platform !== 'win32' && existsSync(join(source, HOST_SCRIPT));
}

/** The address the server was set up with, or null when it never was. */
export function hostAddress(source: string): string | null {
  let text: string;
  try { text = readFileSync(join(source, HOST_SETTINGS), 'utf8'); } catch { return null; }
  const domain = /^NGROK_DOMAIN=(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const address = peerServerAddress(domain);
  return address && address.startsWith('https://') ? address : null;
}

/**
 * A person's name as the server knows them: small letters, digits and
 * hyphens. "Leo Rossi" is `leo-rossi`. It is what their pairing codes begin
 * with, so it is made from the name the host typed and nothing else.
 */
export function peerLoginName(name: string): string | null {
  const login = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(login) ? login : null;
}

export interface HostEnvMore {
  /** The person's own home: the tunnel program keeps its account there. */
  home?: string;
  /** Where the runtime that runs the brain is, so that the scripts find the same one. */
  runtimeDir?: string;
  /** The tunnel's address, the first time. */
  domain?: string;
  /** The address a build takes for its server. */
  server?: string;
}

/** The environment the server's scripts run in. Pure, so that what reaches them can be tested. */
export function hostEnv(base: Record<string, string | undefined>, more: HostEnvMore = {}): Record<string, string> {
  const env = filterEnv(base);
  if (more.home) env.HOME = more.home;
  if (more.runtimeDir) env.PATH = env.PATH ? `${more.runtimeDir}${delimiter}${env.PATH}` : more.runtimeDir;
  if (more.domain) env.NGROK_DOMAIN = more.domain;
  if (more.server) env.COLLAB_OFFICIAL_SERVER_URL = more.server;
  return env;
}

/**
 * Starts the script and ends it when this end of its input closes: when the
 * brain says so, and when the brain is gone. The script itself reads nothing.
 */
const WATCHED = [
  'exec 3<&0',
  '"$1" start </dev/null &',
  'script=$!',
  '{ cat <&3 >/dev/null; kill -TERM "$script" 2>/dev/null; } &',
  'wait "$script"',
].join('\n');

export interface HostChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  /** Closes its input. */
  close(): void;
  kill(): void;
}
export type HostRun = (words: string[], more: { cwd: string; env: Record<string, string>; input: boolean }) => HostChild;

/** Runs one of the source's own programs. The only place in this file that starts anything. */
function runHost(words: string[], more: { cwd: string; env: Record<string, string>; input: boolean }): HostChild {
  const child = Bun.spawn(words, { cwd: more.cwd, env: more.env, stdin: more.input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited: child.exited.then((code) => (typeof code === 'number' ? code : null), () => null),
    close() { try { void (child.stdin as { end(): unknown } | undefined)?.end(); } catch { /* gone already */ } },
    kill() { try { child.kill('SIGKILL'); } catch { /* gone already */ } },
  };
}

export type HostState = 'off' | 'starting' | 'on';

export type HostStarted =
  | { ok: true; address: string }
  /**
   * address: no tunnel address is known yet, or the one given is not one.
   * tools: a program the script needs is not installed (`missing` names it).
   * busy: something else answers on the server's port. tunnel: the tunnel did
   * not come up at that address. failed: anything else.
   */
  | { ok: false; why: 'address' | 'tools' | 'busy' | 'tunnel' | 'failed'; missing?: string };

export type HostAccount = { ok: true; password: string } | { ok: false; why: 'name' | 'taken' | 'failed' };

export interface PeerHostOptions {
  /** The checkout of the engine's source. */
  source: string;
  env?: Record<string, string | undefined>;
  /** The person's own home, when the brain runs with another. */
  home?: string;
  runtimeDir?: string;
  log?: (line: string) => void;
  onState?: (state: HostState) => void;
  /** For tests: another way to run things, and other clocks. */
  run?: HostRun;
  startMs?: number;
  stopMs?: number;
}

/** What the script said went wrong, by its own fixed sentences. */
export function hostFailure(said: string): Extract<HostStarted, { ok: false }> {
  const missing = /^test-env: (\S+) is not installed$/m.exec(said)?.[1];
  if (missing) return { ok: false, why: 'tools', missing };
  if (/^test-env: something already answers on port/m.test(said)) return { ok: false, why: 'busy' };
  if (/^test-env: ngrok (exited|did not answer)/m.test(said)) return { ok: false, why: 'tunnel' };
  if (/is not a host name/.test(said)) return { ok: false, why: 'address' };
  return { ok: false, why: 'failed' };
}

/** Every file under a folder, with its path from there. */
function filesUnder(root: string, at = ''): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const name = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(root, name));
    else if (entry.isFile()) out.push({ path: join(root, name), name });
  }
  return out;
}

export class PeerHost {
  private current: HostState = 'off';
  private child: HostChild | null = null;
  private starting: Promise<HostStarted> | null = null;
  private readonly building = new Map<EngineTarget, Promise<boolean>>();
  private readonly run: HostRun;

  constructor(private readonly options: PeerHostOptions) {
    this.run = options.run ?? runHost;
  }

  state(): HostState { return this.current; }
  /** The server's address, once it was set up. It never changes after that: it is who the server is. */
  address(): string | null { return hostAddress(this.options.source); }

  private env(more: HostEnvMore = {}): Record<string, string> {
    return hostEnv(this.options.env ?? process.env, { home: this.options.home, runtimeDir: this.options.runtimeDir, ...more });
  }

  private set(state: HostState): void {
    if (this.current === state) return;
    this.current = state;
    try { this.options.onState?.(state); } catch { /* a listener's own fault */ }
  }

  /**
   * Starts the server and its tunnel. `domain` is the tunnel's address, and
   * is needed the first time only: after that the server keeps the one it
   * was set up with.
   */
  start(domain?: string): Promise<HostStarted> {
    const known = this.address();
    if (this.current === 'on' && known) return Promise.resolve({ ok: true, address: known });
    if (this.starting) return this.starting;
    this.starting = this.begin(domain).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async begin(domain?: string): Promise<HostStarted> {
    const { source } = this.options;
    let host: string | undefined;
    const fresh = !existsSync(join(source, HOST_SETTINGS));
    if (!this.address()) {
      const typed = peerServerAddress(domain ?? '');
      if (!typed || !typed.startsWith('https://') || new URL(typed).port) return { ok: false, why: 'address' };
      host = new URL(typed).hostname;
    }
    this.set('starting');
    const child = this.run(['bash', '-c', WATCHED, 'host', join(source, HOST_SCRIPT)], { cwd: source, env: this.env(host ? { domain: host } : {}), input: true });
    this.child = child;
    let said = '';
    let up: (address: string | null) => void = () => { /* set below */ };
    const came = new Promise<string | null>((resolve) => { up = resolve; });
    let rest = '';
    void readPipe(child.stdout, (text) => {
      rest += text;
      const found = /^Server is up: (https:\/\/\S+)$/m.exec(rest);
      if (found) up(found[1]!);
      if (rest.length > 20_000) rest = rest.slice(-4000);
    }).catch(() => { /* the same as its end */ });
    // The script's own sentences only: the server writes to files, and nothing of a person passes here.
    void readPipe(child.stderr, (text) => { said = (said + text).slice(-4000); }).catch(() => { /* nothing to read any more */ });
    const timer = setTimeout(() => up(null), this.options.startMs ?? HOST_START_MS);
    void child.exited.then(() => {
      up(null);
      if (this.child === child) { this.child = null; this.set('off'); this.options.log?.('[peers] the organisation\'s server is off'); }
    });
    const address = await came;
    clearTimeout(timer);
    if (address && this.child === child) {
      this.set('on');
      this.options.log?.('[peers] the organisation\'s server is on');
      return { ok: true, address };
    }
    // It did not come up. Whatever is left of it is ended, and what this start alone made is taken away,
    // so that a mistyped address can be typed again.
    await this.end(child);
    if (fresh) {
      rmSync(join(source, HOST_SETTINGS), { force: true });
      rmSync(join(source, HOST_DATA), { recursive: true, force: true });
    }
    const failure = hostFailure(said);
    this.options.log?.(`[peers] the organisation's server did not start (${failure.why})`);
    return failure;
  }

  private async end(child: HostChild): Promise<void> {
    child.close();
    const gone = await Promise.race([child.exited.then(() => true), new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), this.options.stopMs ?? HOST_STOP_MS); (timer as { unref?: () => void }).unref?.(); })]);
    if (!gone) { child.kill(); this.options.log?.('[peers] the organisation\'s server did not stop by itself'); }
    if (this.child === child) { this.child = null; this.set('off'); }
  }

  /**
   * Lets go of the server without waiting for it: with the brain's own end,
   * which has no time to wait. Its input closes, and it goes down in order
   * by itself.
   */
  release(): void { this.child?.close(); }

  /** Stops the server and its tunnel. Nobody in the organisation reaches anybody until it is on again. */
  async stop(): Promise<void> {
    const child = this.child;
    if (child) await this.end(child);
    else this.set('off');
  }

  /** Runs one of the script's short commands and gives what it printed. Null when it failed, with what it said. */
  private async short(words: string[], cwd: string, env: Record<string, string>, limitMs: number): Promise<{ code: number | null; out: string; said: string }> {
    const child = this.run(words, { cwd, env, input: false });
    let out = '';
    let said = '';
    const timer = setTimeout(() => child.kill(), limitMs);
    try {
      await Promise.all([
        readPipe(child.stdout, (text) => { out = (out + text).slice(-20_000); }).catch(() => { /* its end */ }),
        readPipe(child.stderr, (text) => { said = (said + text).slice(-4000); }).catch(() => { /* its end */ }),
      ]);
      return { code: await child.exited, out, said };
    } finally {
      clearTimeout(timer);
    }
  }

  private async password(command: 'account' | 'password', name: string): Promise<HostAccount> {
    const login = peerLoginName(name);
    if (!login || !this.address()) return { ok: false, why: 'name' };
    const { source } = this.options;
    const done = await this.short(['bash', join(source, HOST_SCRIPT), command, login], source, this.env(), HOST_ACCOUNT_MS);
    const password = done.code === 0 ? /^password: (\S+)$/m.exec(done.out)?.[1] : undefined;
    if (password) return { ok: true, password };
    return { ok: false, why: /taken/.test(done.said) ? 'taken' : 'failed' };
  }

  /** Makes an account at the server and gives its password, once. */
  account(name: string): Promise<HostAccount> { return this.password('account', name); }
  /** Gives an account a new password. Whatever was signed in with the old one in a browser is signed out. */
  newPassword(name: string): Promise<HostAccount> { return this.password('password', name); }

  /** The systems an engine is built for here, ready to be taken. */
  built(): EngineTarget[] {
    const dir = join(this.options.source, HOST_BUILDS);
    return ENGINE_TARGETS.filter((target) => existsSync(join(dir, engineArchiveName(target))));
  }

  /** The program of a build that was made here, or null. */
  program(target: EngineTarget | null = engineTarget()): string | null {
    if (!target) return null;
    const path = join(this.options.source, HOST_BUILDS, `collab-plugin-${target}`, 'plugin', 'runtime', engineFileName(target));
    try { return statSync(path).isFile() ? path : null; } catch { return null; }
  }

  /**
   * Builds the engine for a system, with this server as the one it signs in
   * at, and packs it where the server hands it out. One build of a system at
   * a time: a second asking waits for the first.
   */
  build(target: EngineTarget): Promise<boolean> {
    const running = this.building.get(target);
    if (running) return running;
    const job = this.buildNow(target).catch(() => false).finally(() => { this.building.delete(target); });
    this.building.set(target, job);
    return job;
  }

  private async buildNow(target: EngineTarget): Promise<boolean> {
    const address = this.address();
    if (!address) return false;
    const { source } = this.options;
    const name = `collab-plugin-${target}`;
    const out = join(source, HOST_BUILDS, name);
    // Only ever a folder of builds this file made, under the name of a build.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(dirname(out), { recursive: true });
    const done = await this.short(['bun', join('scripts', 'build-plugin.ts'), '--outdir', out, '--target', `bun-${target}`], join(source, HOST_BUILDER), this.env({ server: address }), HOST_BUILD_MS);
    if (done.code !== 0 || !this.program(target)) { this.options.log?.(`[peers] the engine for ${target} could not be built`); return false; }
    const files: ZipFile[] = filesUnder(out).map((file) => ({ name: `${name}/${file.name}`, bytes: readFileSync(file.path), mode: statSync(file.path).mode & 0o111 ? 0o755 : 0o644 }));
    const archive = join(source, HOST_BUILDS, engineArchiveName(target));
    writeFileSync(`${archive}.new`, await zipWrite(files));
    renameSync(`${archive}.new`, archive);
    this.options.log?.(`[peers] the engine for ${target} is built`);
    return true;
  }

  /** Builds for every system that has no build yet, one after the other. Meant to be left running. */
  async buildRest(): Promise<void> {
    for (const target of ENGINE_TARGETS) {
      if (this.current !== 'on') return;
      if (!this.built().includes(target)) await this.build(target);
    }
  }
}

/** The most a sign-in page may be, and how long each step of signing in has. */
const SIGN_IN_PAGE_MAX = 512 * 1024;
export const SIGN_IN_STEP_MS = 30_000;

const unescaped = (text: string): string => text.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Signs in at the server's own page, without a browser.
 *
 * For one case only: the account is one this machine made a moment ago, at
 * the server this machine runs, so the password is in hand and there is
 * nobody to show a page to who could know it. The page is the one the
 * engine asked to have opened; it is filled in as a browser would, and the
 * server sends the answer to the engine's own door on this machine.
 *
 * Every step stays where it must: the page and the form at the server's
 * address, the last step on this machine. Anything else is not followed.
 */
export async function signInByForm(page: string, server: string, login: string, password: string, get: typeof fetch = fetch): Promise<boolean> {
  const origin = peerServerAddress(server);
  if (!origin) return false;
  const inside = (url: string): boolean => { try { return new URL(url).origin.toLowerCase() === origin; } catch { return false; } };
  const jar = new Map<string, string>();
  const take = (response: Response): void => {
    for (const one of response.headers.getSetCookie()) {
      const pair = one.split(';')[0]!;
      const at = pair.indexOf('=');
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };
  const headers = (): Record<string, string> => ({ 'ngrok-skip-browser-warning': '1', ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) });
  const step = (): AbortSignal => AbortSignal.timeout(SIGN_IN_STEP_MS);
  try {
    let at = page;
    if (!inside(at)) return false;
    let response = await get(at, { redirect: 'manual', headers: headers(), signal: step() });
    take(response);
    for (let hop = 0; hop < 5 && response.status >= 300 && response.status < 400; hop++) {
      at = new URL(response.headers.get('location') ?? '', at).toString();
      if (!inside(at)) return false;
      response = await get(at, { redirect: 'manual', headers: headers(), signal: step() });
      take(response);
    }
    if (!response.ok) return false;
    const html = (await response.text()).slice(0, SIGN_IN_PAGE_MAX);
    const action = new URL(unescaped(/<form[^>]*\saction="([^"]*)"/i.exec(html)?.[1] ?? ''), at).toString();
    if (!inside(action)) return false;
    const fields = new URLSearchParams();
    for (const found of html.matchAll(/<input[^>]*\stype="hidden"[^>]*>/gi)) {
      const name = /\sname="([^"]+)"/i.exec(found[0])?.[1];
      const value = /\svalue="([^"]*)"/i.exec(found[0])?.[1] ?? '';
      if (name) fields.set(unescaped(name), unescaped(value));
    }
    fields.set('login', login);
    fields.set('password', password);
    const sent = await get(action, { method: 'POST', redirect: 'manual', headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' }, body: fields.toString(), signal: step() });
    const back = sent.status === 303 || sent.status === 302 ? sent.headers.get('location') ?? '' : '';
    // The answer goes to the engine, which waits for it on this machine and nowhere else.
    if (!PEER_LOCAL_PAGE.test(back)) return false;
    const told = await get(back, { redirect: 'manual', signal: step() });
    return told.status < 400;
  } catch {
    return false;
  }
}
