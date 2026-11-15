/**
 * A file dropped on the notch.
 *
 * The page takes the drop (ui/src/notch/drop.ts). While a file is held over
 * the notch it says so, and the notch says where to let go. A file that is
 * let go is sent to the brain by the page itself, as the body of one request
 * to `/api/notch/drop`, because a file is too large for a message.
 *
 * What can be read: what a chat attachment can be (plain text, Markdown,
 * CSV, JSON, a PDF that has text in it, a PNG or a JPEG, up to the same
 * sizes), and files that are made of words in another dress, which are
 * turned into their words first (./drop-read.ts): a web page, a Word
 * document, a spreadsheet, a deck, code and settings files. The owner asked
 * for those on 15 November 2026, after an HTML file was turned away. Such a
 * file is asked about at once ("Summarise ..."), as an instruction that
 * carries it, and the answer comes as any answer does: one line, or a sheet.
 * Anything else is refused in a sentence that says what kind of file it is
 * and what would work instead. Nothing is guessed from a file that cannot be
 * read.
 *
 * The file's name is the person's own. It is shown on the notch and given to
 * the model with the file. It is never written to a log.
 */
import { ATTACHMENT_LIMITS } from '../brief/attachment-contracts.ts';
import type { NotchAskFile } from './asks.ts';
import { NOTCH_DROP_READERS, readDropped, type DropReader } from './drop-read.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchSurface } from './surface.ts';

/**
 * The most the page sends: the largest file that could be read at all. A
 * Word file or a deck is mostly its pictures, so it may be far larger than
 * the words that are taken from it.
 */
export const NOTCH_DROP_MAX_BYTES = 16 * 1024 * 1024;
/** How long "let go of it here" stays up when the file is neither dropped nor taken away. */
export const NOTCH_DROP_OVER_MS = 20_000;
export const NOTCH_DROP_NAME_MAX = 120;

const em = (text: string): NotchPart => ({ em: text });

/** The kinds of file that can be read, by the end of their name. */
const READABLE: Record<string, { kind: NotchAskFile['kind']; mediaType: string }> = {
  txt: { kind: 'document', mediaType: 'text/plain' }, log: { kind: 'document', mediaType: 'text/plain' },
  md: { kind: 'document', mediaType: 'text/markdown' }, markdown: { kind: 'document', mediaType: 'text/markdown' },
  csv: { kind: 'document', mediaType: 'text/csv' }, json: { kind: 'document', mediaType: 'application/json' },
  pdf: { kind: 'document', mediaType: 'application/pdf' },
  png: { kind: 'image', mediaType: 'image/png' }, jpg: { kind: 'image', mediaType: 'image/jpeg' }, jpeg: { kind: 'image', mediaType: 'image/jpeg' },
};
const BY_TYPE: Record<string, { kind: NotchAskFile['kind']; mediaType: string }> = Object.fromEntries(
  Object.values(READABLE).map((entry) => [entry.mediaType, entry]));

/** Kinds that cannot be read yet, each with the sentence that says so and what would work. */
const NOT_YET: [RegExp, string][] = [
  [/^(xls|ods|numbers)$/, 'a spreadsheet of a kind I cannot read yet. Saved as .xlsx or CSV, I can.'],
  [/^(doc|odt|rtf|pages)$/, 'a text document of a kind I cannot open yet. Saved as .docx, PDF or plain text, I can read it.'],
  [/^(ppt|odp|key)$/, 'a presentation of a kind I cannot read yet. Saved as .pptx or PDF, I can.'],
  [/^(mp3|wav|m4a|aac|ogg|flac|opus)$/, 'a sound file. I cannot listen to files yet.'],
  [/^(mp4|mov|mkv|avi|webm|m4v)$/, 'a video. I cannot watch files yet.'],
  [/^(zip|rar|7z|tar|gz|tgz)$/, 'an archive. I cannot open those. Drop a file from inside it.'],
  [/^(gif|webp|bmp|tif|tiff|heic|svg)$/, 'a picture of a kind I cannot read yet. As PNG or JPEG, I can.'],
  [/^(exe|msi|dll|com|scr|app|dmg)$/, 'a program. I do not read or run dropped programs.'],
];

/** A file's name made fit to show: no path, no control characters, not too long. */
export function dropName(raw: string): string {
  const base = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\s+/g, ' ').trim();
  return name.length > NOTCH_DROP_NAME_MAX ? `${name.slice(0, NOTCH_DROP_NAME_MAX - 1)}…` : name;
}

const extension = (name: string): string => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

export type DropVerdict =
  /** `reader`: the file is turned into its words first, and travels as plain text. */
  | { ok: true; kind: NotchAskFile['kind']; mediaType: string; reader?: DropReader }
  | { ok: false; why: string };

/**
 * Whether a dropped file can be read, from its name, what the browser says
 * it is, and its size. The name decides first: a browser gives no type at
 * all for a `.md` or a `.log`, and a wrong one for some CSV files.
 */
export function dropVerdict(name: string, mediaType: string, size: number): DropVerdict {
  const shown = name || 'That';
  if (!(size > 0)) return { ok: false, why: `${shown} is empty.` };
  const ext = extension(name);
  const type = mediaType.split(';')[0]!.trim().toLowerCase();
  // Made of words in another dress: a web page, an Office file, code.
  const reader = NOTCH_DROP_READERS[ext] ?? (type === 'text/html' ? 'html' : null);
  if (reader && !READABLE[ext]) {
    if (size > NOTCH_DROP_MAX_BYTES) return { ok: false, why: `${shown} is larger than I can read yet: ${Math.round(NOTCH_DROP_MAX_BYTES / (1024 * 1024))} MB is the most.` };
    return { ok: true, kind: 'document', mediaType: 'text/plain', reader };
  }
  const known = READABLE[ext] ?? BY_TYPE[type] ?? null;
  if (!known) {
    for (const [pattern, sentence] of NOT_YET) if (pattern.test(ext)) return { ok: false, why: `${shown} is ${sentence}` };
    return { ok: false, why: `I cannot read that kind of file yet${ext ? ` (.${ext})` : ''}. Text, a web page, Word, Excel, PowerPoint, CSV, a PDF, a PNG or a JPEG I can.` };
  }
  const most = known.kind === 'document' ? ATTACHMENT_LIMITS.documentBytes : ATTACHMENT_LIMITS.fileBytes;
  if (size > most) {
    const megabytes = Math.round(most / (1024 * 1024));
    return { ok: false, why: `${shown} is larger than I can read yet: ${megabytes} MB is the most for ${known.kind === 'document' ? 'a document' : 'a picture'}.` };
  }
  return { ok: true, kind: known.kind, mediaType: known.mediaType };
}

/** What is asked about a file that was dropped with no question. `cut`: it was long, and only its first part is there. */
export function dropQuestion(name: string, kind: NotchAskFile['kind'], cut = false): string {
  if (kind !== 'document') return `Tell me what the picture I dropped, ${name}, shows, in a few short lines.`;
  return `Summarise the file I dropped, ${name}: what it is, and the points that matter, in a few short lines.${cut ? ' It is long: only its first part could be read, so say that the summary is of the first part.' : ''}`;
}

export interface NotchDropDeps {
  /** Runs an instruction that carries the file. */
  ask(text: string, files: NotchAskFile[]): void;
  /** One line that is not about an instruction. */
  tell(parts: NotchPart[], mood?: 'careful' | 'confused' | 'sorry'): void;
  /** Everything is stopped (Esc twice). */
  paused?: () => boolean;
  overMs?: number;
  log?: (line: string) => void;
}

export interface NotchDropped {
  name: string;
  mediaType: string;
  /** How large the page says the file is. The bytes may be fewer: a file too large to read is not sent. */
  size: number;
  bytes: Uint8Array;
  /** How many files were dropped together. Only the first is taken. */
  count: number;
}

export interface NotchDrop {
  /** A file arrived from the page. Comes back with whether it was taken, for the page's own record. */
  take(dropped: NotchDropped): { taken: boolean };
  stop(): void;
}

export function attachNotchDrop(surface: NotchSurface, inbox: NotchInbox, deps: NotchDropDeps): NotchDrop {
  const log = deps.log ?? ((line: string) => console.log(line));
  const overMs = deps.overMs ?? NOTCH_DROP_OVER_MS;
  /** Ends the "let go of it here" line, when it is up. */
  let endOver: (() => void) | null = null;

  const unlisten = surface.onDrag((state) => {
    if (state === 'over') {
      if (endOver) return;
      let done = (): void => {};
      const ended = new Promise<void>((resolve) => { done = resolve; });
      // Only when the notch is free: whatever is on it is not taken down for a file that may never be dropped.
      // The file can be let go on the notch as it is.
      const end = (): void => { if (endOver === end) endOver = null; done(); };
      const shown = inbox.present('drop-over', async (stage) => {
        const said = stage.say(['Let go of it here. I will read it.'], overMs, { mood: 'curious' });
        said.catch(() => {});
        try { await Promise.race([said, ended]); } finally {
          // Its time ran out with the file still held there: the next file is told again.
          if (endOver === end) endOver = null;
        }
      });
      if (shown) endOver = end;
      return;
    }
    endOver?.();
    if (state === 'lost') deps.tell(['I could not take that file. Try dropping it again.'], 'sorry');
  });

  return {
    take(dropped) {
      endOver?.();
      const name = dropName(dropped.name);
      // Sizes and kinds, never the name.
      log(`[notch] a file was dropped: ${dropped.size} bytes, type "${dropped.mediaType.slice(0, 60)}", ${dropped.count} at once`);
      if (deps.paused?.()) {
        deps.tell(['Everything is stopped. Wake me first.']);
        return { taken: false };
      }
      const verdict = dropVerdict(name, dropped.mediaType, dropped.size);
      if (!verdict.ok) {
        deps.tell([verdict.why]);
        return { taken: false };
      }
      if (dropped.bytes.length !== dropped.size) {
        deps.tell(['Only part of ', em(name), ' arrived, so I did not read it. Try dropping it again.'], 'sorry');
        return { taken: false };
      }
      let bytes = dropped.bytes;
      let cut = false;
      if (verdict.reader) {
        // A web page, an Office file, code: its words, as plain text under its own name.
        const read = readDropped(verdict.reader, dropped.bytes);
        if (!read) {
          deps.tell(['I could not read ', em(name), '. It may be damaged, protected with a password, or hold no words.'], 'sorry');
          return { taken: false };
        }
        bytes = new TextEncoder().encode(read.text);
        cut = read.cut;
      }
      if (dropped.count > 1) deps.tell([`One file at a time. I took the first: `, em(name), '.']);
      deps.ask(dropQuestion(name, verdict.kind, cut), [{ kind: verdict.kind, name, mediaType: verdict.mediaType, bytes }]);
      return { taken: true };
    },
    stop() {
      unlisten();
      endOver?.();
    },
  };
}
