/**
 * A file dropped on the notch.
 *
 * The page takes the drop (ui/src/notch/drop.ts). While a file is over the
 * notch it says so, and the notch opens its mouth. A file that is let go is
 * sent to the brain by the page itself, as the body of one request to
 * `/api/notch/drop`, because a file is too large for a message.
 *
 * What can be read: what a chat attachment can be (plain text, Markdown,
 * CSV, JSON, a PDF that has text in it, a PNG or a JPEG, up to the same
 * sizes), and files that are made of words in another dress, which are
 * turned into their words first (./drop-read.ts): a web page, a Word
 * document, a spreadsheet, a deck, code and settings files. The owner asked
 * for those on 15 November 2026, after an HTML file was turned away. Such a
 * file waits for its question (attachNotchDrop, below), which is then an
 * instruction that carries it, and the answer comes as any answer does: one
 * line, or a sheet. Anything else is refused in a sentence that says what kind of file it is
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
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchSurface } from './surface.ts';

/**
 * The most the page sends: the largest file that could be read at all. A
 * Word file or a deck is mostly its pictures, so it may be far larger than
 * the words that are taken from it.
 */
export const NOTCH_DROP_MAX_BYTES = 16 * 1024 * 1024;
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

/** How long a file that was dropped waits for its question before it is let go. */
export const NOTCH_DROP_HOLD_MS = 5 * 60_000;
/** The most files held at once, dropped together or one after another: "what changed between these two?". */
export const NOTCH_DROP_MOST = 3;
/** How long "Got it" is up before the question about it. */
export const NOTCH_DROP_GOT_MS = 900;

/** A file that was dropped and waits for its question. */
export interface DropHeld {
  /** The name as the person knows it. */
  name: string;
  /** How large the file itself is, in bytes. */
  size: number;
  /** Only its first part could be read. */
  cut: boolean;
  file: NotchAskFile;
}

/** One thing that can be asked about a file with a click. */
export interface DropSuggestion {
  label: string;
  /** The instruction it stands for. */
  question: string;
}

const SHEETS = /^(xlsx|xlsm|csv)$/;
const CODE = /^(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|c|h|cc|cpp|hpp|cs|rb|php|swift|kt|sh|bash|ps1|sql|css|scss)$/;
const megabytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What kind of thing a held file is, for its picture and for what is offered about it. */
export function dropSort(held: Pick<DropHeld, 'name' | 'file'>): 'picture' | 'sheet' | 'code' | 'words' {
  if (held.file.kind !== 'document') return 'picture';
  const ext = extension(held.name);
  return SHEETS.test(ext) ? 'sheet' : CODE.test(ext) ? 'code' : 'words';
}

/** The line under a file's name on its card: what it is and how large. */
export function dropMeta(held: DropHeld): string {
  const ext = extension(held.name).toUpperCase();
  const sort = dropSort(held);
  const what = sort === 'picture' ? 'Picture' : sort === 'sheet' ? 'Spreadsheet' : sort === 'code' ? 'Code' : ext === 'PDF' ? 'PDF' : 'Document';
  return [what, megabytes(held.size), held.cut ? 'first part only' : ''].filter(Boolean).join(' · ');
}

/**
 * Three things to ask with one click, by what was dropped. They are the
 * prototype's, less the ones the product cannot do yet. The first is what a
 * bare Enter asks.
 */
export function dropSuggestions(held: DropHeld[]): DropSuggestion[] {
  const [first] = held;
  if (!first) return [];
  if (held.length > 1) {
    const names = held.map((one) => one.name).join(', ');
    return [
      { label: 'What changed', question: `I dropped these files, in this order: ${names}. Tell me what changed from the first to the last, in a few short lines.` },
      { label: 'Compare them', question: `Compare the files I dropped (${names}): where they agree, and where they differ, in a few short lines.` },
      { label: 'Summarise them', question: `Summarise each of the files I dropped (${names}) in one or two short lines.` },
    ];
  }
  const name = first.name;
  const cut = first.cut ? ' It is long: only its first part could be read, so say that you read the first part.' : '';
  switch (dropSort(first)) {
    case 'picture': return [
      { label: 'Describe it', question: dropQuestion(name, first.file.kind) },
      { label: 'Read the text in it', question: `Write out the text in the picture I dropped, ${name}, as it stands.` },
      { label: 'What stands out', question: `Tell me what stands out in the picture I dropped, ${name}, in a few short lines.` },
    ];
    case 'sheet': return [
      { label: 'Totals', question: `Give me the totals in the spreadsheet I dropped, ${name}: each with what it adds up, in a few short lines.${cut}` },
      { label: 'What stands out', question: `Tell me what stands out in the spreadsheet I dropped, ${name}: the highest, the lowest, and anything that looks wrong, in a few short lines.${cut}` },
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
    ];
    case 'code': return [
      { label: 'Explain it', question: `Explain what the file I dropped, ${name}, does, in a few short lines.${cut}` },
      { label: 'Find problems', question: `Read the file I dropped, ${name}, and tell me what is wrong or risky in it, most serious first, in a few short lines.${cut}` },
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
    ];
    default: return [
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
      { label: 'Find the numbers', question: `List the numbers that matter in the file I dropped, ${name}, each with what it measures, in a few short lines.${cut}` },
      { label: 'What is missing', question: `Read the file I dropped, ${name}, and tell me what is missing from it, or what a careful reader would ask for, in a few short lines.${cut}` },
    ];
  }
}

export interface NotchDropDeps {
  /** Runs an instruction that carries the files. */
  ask(text: string, files: NotchAskFile[]): void;
  /** One line that is not about an instruction. */
  tell(parts: NotchPart[], mood?: 'careful' | 'confused' | 'sorry'): void;
  /** Everything is stopped (Esc twice). */
  paused?: () => boolean;
  /** A file was taken, and what is wanted from it is being asked. Day one, waiting for a file, hears of it here. */
  taken?: () => void;
  holdMs?: number;
  gotMs?: number;
  log?: (line: string) => void;
}

export interface NotchDropped {
  name: string;
  mediaType: string;
  /** How large the page says the file is. The bytes may be fewer: a file too large to read is not sent. */
  size: number;
  bytes: Uint8Array;
  /** How many files were dropped together. The page sends the first NOTCH_DROP_MOST. */
  count: number;
}

export interface NotchDrop {
  /** A file arrived from the page. Comes back with whether it was taken, for the page's own record. */
  take(dropped: NotchDropped): { taken: boolean };
  /** Whether a file is waiting for its question. */
  holding(): boolean;
  /**
   * The files that wait for their question, handed over: something was said
   * with the talk keys while they waited, and it is about them. After this
   * nothing is held, and the question about them is off the notch.
   */
  claim(): NotchAskFile[];
  stop(): void;
}

/**
 * A file dropped on the notch.
 *
 * The notch opens its mouth while a file is over it, and swallows it when it
 * is let go: the animation of the prototype. Then it says what it got and
 * asks what is wanted from it, with three things that can be picked by a
 * click, and a field for anything else. The file waits. What is
 * typed in the field, or said with the talk keys held while it waits, is
 * the question, and the file goes with it.
 *
 * The owner, 16 November 2026: "right now it just gives me a summary, but it
 * should either give me the opportunity to ask a specific question about it,
 * or give me a few options. Sometimes I might want something specific, like
 * I drop a deck and I ask what has changed since the last deck." A second
 * file dropped while the first waits joins it, so that can be asked.
 */
export function attachNotchDrop(surface: NotchSurface, inbox: NotchInbox, deps: NotchDropDeps): NotchDrop {
  const log = deps.log ?? ((line: string) => console.log(line));
  const holdMs = deps.holdMs ?? NOTCH_DROP_HOLD_MS;
  const gotMs = deps.gotMs ?? NOTCH_DROP_GOT_MS;
  let held: DropHeld[] = [];
  /** The newest file has not been said yet ("Got ..."). */
  let unsaid: string | null = null;
  /** The item that asks about what is held, while there is one. */
  let item: string | null = null;
  let shows = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mouth = false;
  let stopped = false;

  const shut = (how: 'shut' | 'gulp'): void => {
    if (!mouth && how === 'shut') return;
    mouth = false;
    surface.act({ mouth: how });
  };
  const forget = (): void => {
    held = [];
    unsaid = null;
    if (timer) clearTimeout(timer);
    timer = null;
    const id = item;
    item = null;
    if (id) inbox.remove(id);
  };
  const hand = (): NotchAskFile[] => {
    const files = held.map((one) => one.file);
    forget();
    return files;
  };

  /** Puts the question about what is held on the notch. A new one takes the place of the one before it. */
  function show(): void {
    const id = `drop-${++shows}`;
    item = id;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Nothing was asked about it: it is let go, and not kept.
      if (item !== id) return;
      log(`[notch] ${held.length} dropped file(s) were let go: nothing was asked about them in ${Math.round(holdMs / 1000)} s`);
      forget();
    }, holdMs);
    (timer as { unref?: () => void }).unref?.();
    inbox.add({
      id, subject: 'drop', class: 'person', speaks: true, urgent: true, asked: true, returns: true,
      title: () => held.length === 1 ? ['You gave me ', em(held[0]!.name), '. What do you want from it?'] : [`You gave me ${held.length} files. What do you want from them?`],
      check: () => item === id && held.length > 0,
      play: async (stage) => {
        if (unsaid) {
          const name = unsaid;
          unsaid = null;
          await stage.say(held.length > 1 ? ['Got ', em(name), ' too.'] : ['Got ', em(name), '.'], gotMs, { mood: 'happy' });
        }
        if (item !== id || held.length === 0) return 'settled';
        const asks = dropSuggestions(held);
        const line = stage.id();
        stage.put({
          id: line, kind: 'ask', say: [], yes: 'ask', mood: 'curious', focus: true,
          placeholder: `Ask about ${held.length > 1 ? 'them' : 'it'}, or hold the keys and say it`,
          blocks: [
            ...held.map((one): NotchBlock => ({ kind: 'file', icon: dropSort(one) === 'picture' ? 'image' : dropSort(one) === 'sheet' ? 'sheet' : 'doc', name: one.name, meta: dropMeta(one) })),
            // No number keys on them: the field has the keyboard, as in the prototype, and a number typed there is a number.
            { kind: 'buttons', buttons: asks.map((ask, i) => ({ id: `ask${i}`, label: ask.label })) },
          ],
        });
        const answer = await stage.answer(line, ['button', 'ask', 'no']);
        // Said with the keys while this was up: the words took the files.
        if (item !== id || held.length === 0) return 'settled';
        if (answer.act === 'no') {
          forget();
          return 'settled';
        }
        const typed = answer.act === 'ask' ? (answer.text ?? '').trim() : '';
        const picked = answer.act === 'button' ? asks[Number(answer.button?.slice(3))] : undefined;
        const question = typed || (picked ?? asks[0]!).question;
        deps.ask(question, hand());
        return 'settled';
      },
    });
  }

  const unlisten = surface.onDrag((state) => {
    if (stopped) return;
    if (state === 'over') {
      if (deps.paused?.()) return;
      // The page hears of a file only once it is over the notch itself: the
      // mouth opens, and is at once as wide as it gets.
      mouth = true;
      surface.act({ mouth: 'open' });
      surface.act({ mouth: 'over' });
      return;
    }
    shut('shut');
    if (state === 'lost') deps.tell(['I could not take that file. Try dropping it again.'], 'sorry');
  });

  return {
    take(dropped) {
      const name = dropName(dropped.name);
      // Sizes and kinds, never the name.
      log(`[notch] a file was dropped: ${dropped.size} bytes, type "${dropped.mediaType.slice(0, 60)}", ${dropped.count} at once`);
      const refuse = (parts: NotchPart[], mood?: 'careful' | 'confused' | 'sorry'): { taken: boolean } => {
        shut('shut');
        deps.tell(parts, mood);
        return { taken: false };
      };
      if (deps.paused?.()) return refuse(['Everything is stopped. Wake me first.']);
      const verdict = dropVerdict(name, dropped.mediaType, dropped.size);
      if (!verdict.ok) return refuse([verdict.why]);
      if (dropped.bytes.length !== dropped.size) return refuse(['Only part of ', em(name), ' arrived, so I did not read it. Try dropping it again.'], 'sorry');
      let bytes = dropped.bytes;
      let cut = false;
      if (verdict.reader) {
        // A web page, an Office file, code: its words, as plain text under its own name.
        const read = readDropped(verdict.reader, dropped.bytes);
        if (!read) return refuse(['I could not read ', em(name), '. It may be damaged, protected with a password, or hold no words.'], 'sorry');
        bytes = new TextEncoder().encode(read.text);
        cut = read.cut;
      }
      if (held.length >= NOTCH_DROP_MOST) return refuse([`I am holding ${NOTCH_DROP_MOST} files already. Ask about those first.`]);
      const together = held.reduce((sum, one) => sum + one.file.bytes.length, 0) + bytes.length;
      if (held.length > 0 && together > ATTACHMENT_LIMITS.turnBytes) return refuse([em(name), ' is too large to read together with what I am holding. Ask about that first.']);
      held.push({ name, size: dropped.size, cut, file: { kind: verdict.kind, name, mediaType: verdict.mediaType, bytes } });
      unsaid = name;
      // Swallowed: one gulp, then what it got and what is wanted from it.
      shut('gulp');
      show();
      try { deps.taken?.(); } catch { /* a sign, and nothing depends on it */ }
      return { taken: true };
    },
    holding: () => held.length > 0,
    claim: () => (held.length > 0 ? hand() : []),
    stop() {
      stopped = true;
      unlisten();
      shut('shut');
      forget();
    },
  };
}
