/**
 * The collab engine as a child of the brain.
 *
 * Started with the brain, started again when it falls, stopped with it. It
 * gets a data folder of its own inside the brain's, and an environment made
 * here name by name.
 *
 * WHY THE ENVIRONMENT IS MADE AND NOT PASSED ON. The engine decides from its
 * environment whether a person can be asked. A brain started from a coding
 * agent's shell carries that agent's variables, and with them the engine
 * would take itself for a session nobody watches and refuse every dialog.
 * And nothing of the brain's own (its keys, its JARVIS_ settings) is the
 * engine's business. So: the allowlist every child of the brain gets
 * (src/util/subprocess-env.ts), then the few COLLAB_ names set below, and
 * nothing else.
 *
 * The engine's command line reads the same folder as data (./engine-read.ts).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { filterEnv } from '../util/subprocess-env.ts';
import type { EngineTransport } from './engine-client.ts';

/** Where the engine keeps its keys, its contacts and its mail, inside the brain's data folder. */
export const ENGINE_DATA_FOLDER = 'peers';

/** What the person may set for the engine from outside. Passed on as they are. */
const PASSED_ON = ['COLLAB_SERVER_URL', 'COLLAB_KEYSTORE'] as const;
/** Needed to reach the desktop's keychain, where the engine prefers to keep the key that locks its keys. */
const KEYCHAIN = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const;

export function engineDataDir(brainDataDir: string): string {
  return join(brainDataDir, ENGINE_DATA_FOLDER);
}

/** The environment the engine runs in. Pure, so that what reaches it can be tested. */
export function engineEnv(base: Record<string, string | undefined>, dataDir: string): Record<string, string> {
  const env = filterEnv(base);
  for (const name of [...PASSED_ON, ...KEYCHAIN]) {
    const value = base[name];
    if (typeof value === 'string' && value) env[name] = value;
  }
  env.COLLAB_DATA_DIR = dataDir;
  // Tells the brain that something arrived, the moment it does.
  env.COLLAB_CHANNELS = '1';
  // The notch tells the person. Two voices for one message would be one too many.
  env.COLLAB_DESKTOP_NOTIFY = '0';
  // Nothing may take a request without the person: no unattended work, ever.
  env.COLLAB_UNATTENDED_TASKS = '0';
  return env;
}

/** Reads a pipe to its end, a piece at a time as text. */
export async function readPipe(stream: ReadableStream<Uint8Array>, piece: (text: string) => void | false): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (piece(decoder.decode(value, { stream: true })) === false) return;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already let go */ }
  }
}

export interface EngineChild {
  transport: EngineTransport;
  pid: number;
  /** Resolves when the program has ended, with its exit code when it gave one. */
  ended: Promise<number | null>;
  stop(): void;
}

export interface EngineStart {
  /** The engine program. */
  path: string;
  /** The brain's data folder. */
  brainDataDir: string;
  env?: Record<string, string | undefined>;
  /** What the engine wrote besides its answers. Never content: the engine writes none there. */
  onStderr?: (text: string) => void;
}

/** Starts the engine and gives its line. */
export function startEngine(start: EngineStart): EngineChild {
  const dataDir = engineDataDir(start.brainDataDir);
  // Its own, and nobody else's: the engine refuses a folder others can read.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([start.path, 'mcp'], {
    env: engineEnv(start.env ?? process.env, dataDir),
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) { try { listener(); } catch { /* a listener's own fault */ } }
  };

  let rest = '';
  void readPipe(child.stdout as ReadableStream<Uint8Array>, (text) => {
    rest += text;
    for (;;) {
      const end = rest.indexOf('\n');
      if (end < 0) break;
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      for (const listener of lineListeners) { try { listener(line); } catch { /* a listener's own fault */ } }
    }
  }).catch(() => { /* the pipe broke: the same as the end */ }).then(close);

  void readPipe(child.stderr as ReadableStream<Uint8Array>, (text) => { start.onStderr?.(text); }).catch(() => { /* nothing to read any more */ });

  const ended = child.exited.then((code) => { close(); return typeof code === 'number' ? code : null; }, () => { close(); return null; });

  return {
    pid: child.pid,
    ended,
    transport: {
      send(line) { child.stdin.write(`${line}\n`); void child.stdin.flush(); },
      onLine(listener) { lineListeners.push(listener); },
      onClose(listener) { if (closed) listener(); else closeListeners.push(listener); },
      close() { try { void child.stdin.end(); } catch { /* already gone */ } },
    },
    stop() {
      // Its input closing is how the engine is told to leave: it then closes its line to the server in order.
      try { void child.stdin.end(); } catch { /* already gone */ }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, ENGINE_STOP_MS);
      (timer as { unref?: () => void }).unref?.();
      void child.exited.then(() => clearTimeout(timer), () => clearTimeout(timer));
    },
  };
}

/** How long the engine has to leave by itself before it is made to. */
export const ENGINE_STOP_MS = 3_000;
