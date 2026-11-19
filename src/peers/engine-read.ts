/**
 * Reads the engine's state as data.
 *
 * The engine answers a tool call in prose, written for a reader. The same
 * program has a command line that prints the same things as one JSON
 * document, and that is what the brain reads: who the contacts are, what is
 * in the inbox, where a request stands.
 *
 * Two rules:
 *
 *   - READ ONLY, AND ONLY WHAT IS STORED. Every command run from here is one
 *     that changes nothing and opens no line to the server (`--offline`
 *     where the command would otherwise connect). The engine that runs under
 *     the brain is the one line there is.
 *   - NEVER FROM A MODEL. This command line does without the dialogs the
 *     engine's tools go through. It is called from the brain's own code with
 *     fixed words, and no tool the model has reaches it (docs/peers/README.md).
 */
import { engineDataDir, engineEnv, readPipe } from './engine-process.ts';

/** The commands that may be run from here, each with what makes it a read of what is stored. */
export const ENGINE_READS = {
  status: ['status'],
  contacts: ['contacts', 'list'],
  inbox: ['inbox', '--offline'],
  tasks: ['tasks', 'list', '--offline'],
} as const;

export type EngineReadName = keyof typeof ENGINE_READS;

export const ENGINE_READ_MS = 10_000;
/** More than the engine prints for fifty items of the largest size it lists. */
export const ENGINE_READ_MAX = 16 * 1024 * 1024;

export class EngineReadFailed extends Error {
  constructor(message: string) { super(message); this.name = 'EngineReadFailed'; }
}

export interface EngineReadOptions {
  path: string;
  brainDataDir: string;
  env?: Record<string, string | undefined>;
  limitMs?: number;
}

/** Flags a read may add: which items, how many. Checked, so that no word of a contact's becomes a flag. */
export interface EngineReadFlags {
  unread?: boolean;
  active?: boolean;
  limit?: number;
  /** A device id. */
  from?: string;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

function flagWords(flags: EngineReadFlags): string[] {
  const words: string[] = [];
  if (flags.unread) words.push('--unread');
  if (flags.active) words.push('--active');
  if (typeof flags.limit === 'number' && Number.isInteger(flags.limit) && flags.limit > 0 && flags.limit <= 50) words.push('--limit', String(flags.limit));
  if (typeof flags.from === 'string' && DEVICE_ID.test(flags.from)) words.push('--from', flags.from);
  return words;
}

/** Runs one read and gives the document it printed. */
export async function readEngine(name: EngineReadName, options: EngineReadOptions, flags: EngineReadFlags = {}): Promise<Record<string, unknown>> {
  const words = [...ENGINE_READS[name], ...(name === 'inbox' || name === 'tasks' ? flagWords(flags) : []), '--json'];
  const child = Bun.spawn([options.path, ...words], {
    env: engineEnv(options.env ?? process.env, engineDataDir(options.brainDataDir)),
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
  });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, options.limitMs ?? ENGINE_READ_MS);
  try {
    let text = '';
    let tooMuch = false;
    await readPipe(child.stdout as ReadableStream<Uint8Array>, (piece) => {
      text += piece;
      if (text.length <= ENGINE_READ_MAX) return;
      tooMuch = true;
      return false;
    });
    if (tooMuch) { try { child.kill(); } catch { /* already gone */ } throw new EngineReadFailed('the engine printed more than it can have to say'); }
    await child.exited;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new EngineReadFailed('the engine did not print a document'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EngineReadFailed('the engine did not print a document');
    const document = parsed as Record<string, unknown>;
    const failure = document.error;
    if (failure && typeof failure === 'object') {
      const code = (failure as Record<string, unknown>).code;
      throw new EngineReadFailed(typeof code === 'string' ? code : 'refused');
    }
    return document;
  } finally {
    clearTimeout(timer);
  }
}
