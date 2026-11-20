/**
 * The engine, put in place.
 *
 * The engine is a separate program that is not part of this product
 * (docs/peers/README.md). Until now its place had to be named by hand. Here
 * it comes by itself: whoever joins an organisation takes the build for
 * their system from the organisation's own server, and whoever makes one
 * builds it there (./host.ts) and takes it the same way.
 *
 * It is kept in the brain's data folder, `peers/bin/`, beside the engine's
 * own folder.
 *
 * WHAT THIS TRUSTS. The engine that runs here is whatever the organisation's
 * server hands out. So the address is one a person typed, or the one of the
 * server this machine itself runs, never one that arrived in a message; it
 * is reached over https, or on this machine itself; and what comes back is
 * taken only when it is an archive that holds a program for this system
 * under the name the build gives it. That is the same trust as joining the
 * organisation at all: its server is where everything goes through.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PEER_LOCAL_PAGE } from './link.ts';
import { ZipBad, zipEntries, zipRead } from './zip.ts';

export const ENGINE_BIN_FOLDER = join('peers', 'bin');

/** The systems the engine is built for, by the name its builds carry. */
export const ENGINE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64'] as const;
export type EngineTarget = (typeof ENGINE_TARGETS)[number];

/** The build for a system, or null when there is none for it. */
export function engineTarget(platform: string = process.platform, arch: string = process.arch): EngineTarget | null {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' || platform === 'linux' ? platform : null;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : null;
  const target = os && cpu ? `${os}-${cpu}` : '';
  return (ENGINE_TARGETS as readonly string[]).includes(target) ? (target as EngineTarget) : null;
}

export const engineFileName = (target: EngineTarget): string => (target.startsWith('windows-') ? 'collab-claude.exe' : 'collab-claude');

/** Where the engine is kept once it is in place. */
export function installedEnginePath(brainDataDir: string, target: EngineTarget | null = engineTarget()): string {
  return join(brainDataDir, ENGINE_BIN_FOLDER, target ? engineFileName(target) : 'collab-claude');
}

/** The engine that is in place, or null. */
export function installedEngine(brainDataDir: string, target: EngineTarget | null = engineTarget()): string | null {
  const path = installedEnginePath(brainDataDir, target);
  try { return statSync(path).isFile() ? path : null; } catch { return null; }
}

/** The name of an organisation's archive for a system, and of the program inside it. */
export const engineArchiveName = (target: EngineTarget): string => `collab-plugin-${target}.zip`;
export const engineArchiveEntry = (target: EngineTarget): string => `collab-plugin-${target}/plugin/runtime/${engineFileName(target)}`;

/**
 * A server's address as it was typed, made into the one form that is used:
 * `https://host`, with a port when one was given. A name alone is taken for
 * https. Plain http is taken for this machine itself and nothing else.
 */
export function peerServerAddress(typed: string): string | null {
  const text = typed.trim().replace(/\s+/g, '');
  if (!text || text.length > 200) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:') return PEER_LOCAL_PAGE.test(`${url.origin}/`) ? url.origin : null;
  if (url.protocol !== 'https:') return null;
  // A name with a dot in it: one word alone is a slip of the hand, not a server.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname)) return null;
  return url.origin.toLowerCase();
}

/** The most an archive may be, and the most the program in it. A build is about a third of the first. */
export const ENGINE_ARCHIVE_MAX = 300 * 1024 * 1024;
export const ENGINE_MAX = 400 * 1024 * 1024;
export const ENGINE_FETCH_MS = 10 * 60_000;

/** How a program for each system begins. What does not begin so is not one. */
function isProgram(bytes: Uint8Array, target: EngineTarget): boolean {
  if (bytes.length < 4096) return false;
  const [a, b, c, d] = bytes;
  if (target.startsWith('linux-')) return a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46;
  if (target.startsWith('darwin-')) return a === 0xcf && b === 0xfa && c === 0xed && d === 0xfe;
  return a === 0x4d && b === 0x5a;
}

export type EngineFetched =
  | { ok: true; path: string }
  /**
   * system: no engine is built for this kind of machine at all. no_build:
   * the server has none for it yet. unreachable: the server did not answer.
   * bad: what came is not the engine. disk: it could not be written here.
   */
  | { ok: false; why: 'system' | 'no_build' | 'unreachable' | 'bad' | 'disk' };

export interface EngineFetch {
  /** The server's address, as `peerServerAddress` gives it. */
  server: string;
  brainDataDir: string;
  target?: EngineTarget | null;
  fetch?: typeof fetch;
  limitMs?: number;
}

/** Puts a program in the engine's place: written beside it first, then moved over it. */
export function placeEngine(bytes: Uint8Array, brainDataDir: string, target: EngineTarget): string {
  const path = installedEnginePath(brainDataDir, target);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = `${path}.new`;
  writeFileSync(fresh, bytes, { mode: 0o755 });
  chmodSync(fresh, 0o755);
  renameSync(fresh, path);
  return path;
}

/** Takes the engine for this system from an organisation's server and puts it in place. */
export async function fetchEngine(options: EngineFetch): Promise<EngineFetched> {
  const target = options.target === undefined ? engineTarget() : options.target;
  if (!target) return { ok: false, why: 'system' };
  const server = peerServerAddress(options.server);
  if (!server) return { ok: false, why: 'unreachable' };
  const get = options.fetch ?? fetch;
  let archive: Uint8Array;
  try {
    const response = await get(`${server}/plugin/${engineArchiveName(target)}`, {
      // A tunnel may put a page of its own in front of a browser. This is not one, and says so.
      headers: { 'ngrok-skip-browser-warning': '1', accept: 'application/zip' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.limitMs ?? ENGINE_FETCH_MS),
    });
    if (response.status === 404) return { ok: false, why: 'no_build' };
    if (!response.ok || !response.body) return { ok: false, why: 'unreachable' };
    if (Number(response.headers.get('content-length') ?? 0) > ENGINE_ARCHIVE_MAX) return { ok: false, why: 'bad' };
    const pieces: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > ENGINE_ARCHIVE_MAX) { void reader.cancel().catch(() => { /* gone already */ }); return { ok: false, why: 'bad' }; }
      pieces.push(value);
    }
    archive = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) { archive.set(piece, at); at += piece.length; }
  } catch {
    return { ok: false, why: 'unreachable' };
  }
  let program: Uint8Array;
  try {
    const entry = zipEntries(archive).find((one) => one.name === engineArchiveEntry(target));
    if (!entry) return { ok: false, why: 'bad' };
    program = await zipRead(archive, entry, ENGINE_MAX);
  } catch (error) {
    if (error instanceof ZipBad) return { ok: false, why: 'bad' };
    throw error;
  }
  if (!isProgram(program, target)) return { ok: false, why: 'bad' };
  try { return { ok: true, path: placeEngine(program, options.brainDataDir, target) }; } catch { return { ok: false, why: 'disk' }; }
}

/** True when there is an engine in place already. For a caller that only needs to know. */
export function engineInPlace(brainDataDir: string): boolean {
  return existsSync(installedEnginePath(brainDataDir));
}
