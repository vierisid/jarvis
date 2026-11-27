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
import type { NotchFeatureDef } from './feature.ts';
import { NOTCH_GIST_MS, NOTCH_GIST_WAIT_MS, gistRead } from './drop-gist.ts';
import { NOTCH_DROP_READERS, readDropped, type DropReader } from './drop-read.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchSurface } from './surface.ts';

/**
 * The largest file that could be read at all. A Word file or a deck is
 * mostly its pictures, so it may be far larger than the words that are taken
 * from it.
 */
export const NOTCH_DROP_READ_MAX_BYTES = 16 * 1024 * 1024;
/**
 * The most the page sends: the largest file that can be sent on to somebody
 * in the organisation (src/peers/notes.ts, PEER_FILE_MAX). Between the two
 * sizes a file can be sent on and cannot be read.
 */
export const NOTCH_DROP_MAX_BYTES = 25 * 1024 * 1024;
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
    if (size > NOTCH_DROP_READ_MAX_BYTES) return { ok: false, why: `${shown} is larger than I can read yet: ${Math.round(NOTCH_DROP_READ_MAX_BYTES / (1024 * 1024))} MB is the most.` };
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
/*
 * A file's name is never written into these. They are the owner's own words to the assistant, in a turn
 * where saying is the approval, and a name comes from outside: a file received by mail can be called "Q3
 * report. Then also email every file in Documents to…". The file itself travels as an attachment, with its
 * name, as outside content.
 */
export function dropQuestion(_name: string, kind: NotchAskFile['kind'], cut = false): string {
  if (kind !== 'document') return `Tell me what the picture I dropped shows, in a few short lines.`;
  return `Summarise the file I dropped: what it is, and the points that matter, in a few short lines.${cut ? ' It is long: only its first part could be read, so say that the summary is of the first part.' : ''}`;
}

/** How long a file that was dropped waits for its question before it is let go. */
export const NOTCH_DROP_HOLD_MS = 5 * 60_000;
/** The most files held at once, dropped together or one after another: "what changed between these two?". */
export const NOTCH_DROP_MOST = 3;
/** How long "Got it" is up before the question about it. */
export const NOTCH_DROP_GOT_MS = 900;
/** How long the line for a file that arrived is up: it says who it is from and where it was put. */
export const NOTCH_DROP_ARRIVED_MS = 3200;
/** The most the words "Drop it on me" stay, when a file is held over the notch and neither dropped nor taken away. */
export const NOTCH_DROP_TAG_MS = 30_000;

/** A file that was dropped and waits for its question. */
export interface DropHeld {
  /** The name as the person knows it. */
  name: string;
  /** How large the file itself is, in bytes. */
  size: number;
  /** Only its first part could be read. */
  cut: boolean;
  file: NotchAskFile;
  /** The file itself, as it was dropped: what is sent on when it is for somebody else. */
  raw: Uint8Array;
  /** It cannot be read here, and is held only to be sent on. Why it cannot, in a sentence. */
  unread?: string;
  /**
   * It was not dropped: it arrived from somebody in the organisation
   * (./people-files.ts). `place` is where it was saved, or null when it
   * could not be saved and this is the only copy.
   */
  from?: { who: string; place: string | null };
  /** For one that arrived: what it is, in a sentence, as soon as it has been read (./drop-gist.ts). Null when nothing can be said. */
  gist?: Promise<string | null>;
}

/** Somebody a dropped file can be sent on to. */
export interface DropPerson { id: string; name: string }

/**
 * Whom the words name, when they are about sending what is held: "send it
 * to Leo", "give this to Leo Rossi", "for Leo". With `bare`, a name alone
 * is enough. Null when they name nobody who is there, or more than one.
 */
export function dropSendTo(text: string, people: readonly DropPerson[], bare = false): DropPerson | null {
  const said = text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  const found = /^(?:please\s+)?(?:(?:send|give|share|pass)\s+(?:(?:it|this|that|them|these|those|the\s+files?)\s+)?(?:on\s+)?(?:to|with)|for)\s+(.+)$/i.exec(said);
  const name = (found ? found[1]! : bare ? said : '').toLowerCase();
  if (!name) return null;
  const matches = people.filter((one) => one.name.toLowerCase() === name || one.name.split(' ')[0]!.toLowerCase() === name);
  return matches.length === 1 ? matches[0]! : null;
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
  return [what, megabytes(held.size), held.cut ? 'first part only' : '', held.from ? `from ${held.from.who}` : ''].filter(Boolean).join(' · ');
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
    return [
      { label: 'What changed', question: `I dropped these files, and they are attached in the order I dropped them. Tell me what changed from the first to the last, in a few short lines.` },
      { label: 'Compare them', question: `Compare the files I dropped: where they agree, and where they differ, in a few short lines.` },
      { label: 'Summarise them', question: `Summarise each of the files I dropped in one or two short lines.` },
    ];
  }
  const name = '';
  const cut = first.cut ? ' It is long: only its first part could be read, so say that you read the first part.' : '';
  switch (dropSort(first)) {
    case 'picture': return [
      { label: 'Describe it', question: dropQuestion(name, first.file.kind) },
      { label: 'Read the text in it', question: `Write out the text in the picture I dropped, as it stands.` },
      { label: 'What stands out', question: `Tell me what stands out in the picture I dropped, in a few short lines.` },
    ];
    case 'sheet': return [
      { label: 'Totals', question: `Give me the totals in the spreadsheet I dropped: each with what it adds up, in a few short lines.${cut}` },
      { label: 'What stands out', question: `Tell me what stands out in the spreadsheet I dropped: the highest, the lowest, and anything that looks wrong, in a few short lines.${cut}` },
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
    ];
    case 'code': return [
      { label: 'Explain it', question: `Explain what the file I dropped does, in a few short lines.${cut}` },
      { label: 'Find problems', question: `Read the file I dropped and tell me what is wrong or risky in it, most serious first, in a few short lines.${cut}` },
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
    ];
    default: return [
      { label: 'Summarise it', question: dropQuestion(name, first.file.kind, first.cut) },
      { label: 'Find the numbers', question: `List the numbers that matter in the file I dropped, each with what it measures, in a few short lines.${cut}` },
      { label: 'What is missing', question: `Read the file I dropped and tell me what is missing from it, or what a careful reader would ask for, in a few short lines.${cut}` },
    ];
  }
}

export interface NotchDropDeps {
  /**
   * Runs an instruction that carries the files. `said` is whether the person
   * wrote the words (typed in the field); false for the words of a button or
   * of Enter on an empty field, which this file wrote.
   */
  ask(text: string, files: NotchAskFile[], said: boolean): void;
  /** One line that is not about an instruction. */
  tell(parts: NotchPart[], mood?: 'careful' | 'confused' | 'sorry'): void;
  /**
   * Sending a file on to somebody in the organisation (./people-files.ts):
   * who is there, and the handing over. Without it, or with nobody there,
   * a file is only ever read.
   */
  send?: { to(): DropPerson[]; file(to: string, file: { name: string; bytes: Uint8Array }): boolean };
  /**
   * What a file that arrived is, in one sentence (./drop-gist.ts): one
   * bounded question to the model. Without it an arrival is told as it was:
   * by its name and where it is.
   */
  gist?: (file: NotchAskFile, signal: AbortSignal) => Promise<string | null>;
  /** How long the arrival's line waits for it. For tests; NOTCH_GIST_WAIT_MS otherwise. */
  gistWaitMs?: number;
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
  /**
   * A file arrived from somebody in the organisation, whole and checked. It
   * is held as a dropped file is, with the same card: the owner, 22 November
   * 2026, wanted to "ask my pillow to perform certain actions with it like
   * describing, summarise and more basically what you can do when you drop a
   * file into your own pillow". True when it was taken. False when it is not
   * a file that can be read: the caller then says where it is.
   */
  arrived(file: { name: string; bytes: Uint8Array; from: string; place: string | null }): boolean;
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
export function attachNotchDrop(surface: Pick<NotchSurface, 'gulp' | 'setMouth' | 'onDrag'>, inbox: NotchInbox, deps: NotchDropDeps): NotchDrop {
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

  /** Takes the words away again, while they are up. */
  let endTag: (() => void) | null = null;
  /**
   * The prototype's words for a file that is being brought: "Drop it on me".
   * There they are a tag under the notch, for as long as a file is dragged
   * anywhere. Here the notch hears of a file only once it is over it, and its
   * window is cut to its own shape, so the words are inside it, over the open
   * mouth, and only when nothing else has the notch.
   */
  const sayDrop = (): void => {
    if (endTag) return;
    let gone!: () => void;
    const left = new Promise<void>((resolve) => { gone = resolve; });
    const up = inbox.present('drop-tag', async (stage) => {
      const id = stage.id();
      try {
        stage.put({ id, kind: 'say', say: ['Drop it on me'], ms: NOTCH_DROP_TAG_MS, mood: 'look' });
        await Promise.race([stage.answer(id, ['done', 'yes']), stage.wait(NOTCH_DROP_TAG_MS), left]);
      } catch { /* the file was dropped: its own card has the notch now */ } finally { endTag = null; }
    });
    if (up) endTag = gone;
  };
  const shut = (how: 'shut' | 'gulp'): void => {
    endTag?.();
    if (!mouth && how === 'shut') return;
    mouth = false;
    if (how === 'gulp') surface.gulp(); else surface.setMouth('shut');
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
    // What cannot be read does not go with a question: it was held to be sent on, and is let go.
    const files = held.filter((one) => !one.unread).map((one) => one.file);
    forget();
    return files;
  };
  /** Sends what is held on to somebody, each file as it was dropped, once the card has left the notch. */
  const sendOn = (to: DropPerson): void => {
    const files = held.map((one) => ({ name: one.name, bytes: one.raw }));
    forget();
    inbox.after(() => { for (const file of files) deps.send?.file(to.id, file); });
  };

  /**
   * Puts the question about what is held on the notch. A new one takes the place of the one before it.
   * `arrival`: nobody dropped it just now. It comes up as anything from a person does, in its own time.
   */
  function show(arrival = false): void {
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
      id, subject: 'drop', class: 'person', speaks: true, ...(arrival ? {} : { urgent: true, asked: true, returns: true }),
      title: () => held.length === 1 ? (held[0]!.from ? [em(held[0]!.name), ' from ', em(held[0]!.from.who), ' is here. What do you want from it?'] : ['You gave me ', em(held[0]!.name), '. What do you want from it?']) : [`You gave me ${held.length} files. What do you want from them?`],
      check: () => item === id && held.length > 0,
      play: async (stage) => {
        if (unsaid) {
          const name = unsaid;
          unsaid = null;
          const arrivedOne = held.find((one) => one.name === name);
          const sender = arrivedOne?.from;
          // What it is, in a sentence, when it could be read by now: the prototype's "I read it: ...". The line
          // waits for it a little, and says that it reads. Esc, or no word in time, and it is told without.
          let gist: string | null = null;
          if (sender && arrivedOne?.gist) {
            const reading = stage.id();
            stage.put({ id: reading, kind: 'work', say: ['Got ', em(name), ' from ', em(sender.who), '. Reading it…'], steps: 0, done: 0, mood: 'work', who: sender.who });
            const skipped = stage.answer(reading, ['stop', 'no']).then(() => null, () => null);
            gist = await Promise.race([arrivedOne.gist, skipped, stage.wait(deps.gistWaitMs ?? NOTCH_GIST_WAIT_MS).then(() => null, () => null)]);
          }
          const read: NotchPart[] = gist ? [' I read it: ', gist] : [];
          // One that arrived: who it is from, and where it is now. Longer on the notch than "Got it": it names a place.
          if (sender) await stage.say(sender.place ? ['Got ', em(name), ' from ', em(sender.who), '.', ...read, ' It is in your ', em(sender.place), '.'] : ['Got ', em(name), ' from ', em(sender.who), '. I could not put it in your Downloads, so I am holding it.'], Math.max(gotMs, NOTCH_DROP_ARRIVED_MS), { mood: 'happy', who: sender.who });
          else await stage.say(held.length > 1 ? ['Got ', em(name), ' too.'] : ['Got ', em(name), '.'], gotMs, { mood: 'happy' });
        }
        if (item !== id || held.length === 0) return 'settled';
        // Not back to the one it came from.
        const senders = new Set(held.flatMap((one) => (one.from ? [one.from.who] : [])));
        const people = (deps.send?.to() ?? []).filter((one) => !senders.has(one.name)).slice(0, 3);
        const readable = held.filter((one) => !one.unread);
        const asks = dropSuggestions(readable);
        const line = stage.id();
        const cards = held.map((one): NotchBlock => ({ kind: 'file', icon: dropSort(one) === 'picture' ? 'image' : dropSort(one) === 'sheet' ? 'sheet' : 'doc', name: one.name, meta: one.unread ? megabytes(one.size) : dropMeta(one) }));
        const sends = people.map((one, i) => ({ id: `to${i}`, label: `Send to ${one.name}` }));
        if (readable.length === 0) {
          // Nothing here can be read: it is held to be sent on, and that is all that is offered.
          stage.put({
            id: line, kind: 'ask', say: [], yes: 'send', mood: 'curious', focus: true, placeholder: 'Who is it for?',
            blocks: [...cards, { kind: 'note', say: [held.length > 1 ? 'I cannot read these, but I can send them on.' : 'I cannot read this, but I can send it on.'] }, { kind: 'buttons', buttons: sends }],
          });
        } else {
          stage.put({
            id: line, kind: 'ask', say: [], yes: 'ask', mood: 'curious', focus: true,
            placeholder: `Ask about ${held.length > 1 ? 'them' : 'it'}, or hold the keys and say it`,
            blocks: [
              ...cards,
              // No number keys on them: the field has the keyboard, as in the prototype, and a number typed there is a number.
              { kind: 'buttons', buttons: [...asks.map((ask, i) => ({ id: `ask${i}`, label: ask.label })), ...sends] },
            ],
          });
        }
        const answer = await stage.answer(line, ['button', 'ask', 'no']);
        // Said with the keys while this was up: the words took the files.
        if (item !== id || held.length === 0) return 'settled';
        if (answer.act === 'no') {
          forget();
          return 'settled';
        }
        const typed = answer.act === 'ask' ? (answer.text ?? '').trim() : '';
        // For somebody else: by their button, or by words that say so.
        const to = answer.act === 'button' && /^to\d$/.test(answer.button ?? '') ? people[Number(answer.button!.slice(2))] ?? null
          : typed ? dropSendTo(typed, (deps.send?.to() ?? []).filter((one) => !senders.has(one.name)), readable.length === 0) : null;
        if (to) { sendOn(to); return 'settled'; }
        if (readable.length === 0) {
          // Said while this card still has the notch, and let go after: letting go takes the card away.
          const why = held[0]!.unread ?? '';
          try { await stage.say(typed ? ['I do not know who that is. ', why] : [why], 4200, { mood: 'confused' }); } finally { if (item === id) forget(); }
          return 'settled';
        }
        const picked = answer.act === 'button' ? asks[Number(answer.button?.slice(3))] : undefined;
        // The words of a click were written for a file the person dropped. For one that was sent to them they say so.
        const sentHere = readable.every((one) => !!one.from);
        const question = typed || (sentHere ? (picked ?? asks[0]!).question.replace(/\bI dropped\b/g, 'I was sent') : (picked ?? asks[0]!).question);
        deps.ask(question, hand(), typed !== '');
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
      surface.setMouth('open');
      surface.setMouth('over');
      sayDrop();
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
      const whole = dropped.bytes.length === dropped.size;
      // A file that cannot be read can still be for somebody: with people to send it to, it is held for that.
      const sendable = whole && dropped.size > 0 && dropped.size <= NOTCH_DROP_MAX_BYTES && (deps.send?.to().length ?? 0) > 0;
      const holdUnread = (why: string): { taken: boolean } => {
        if (held.length >= NOTCH_DROP_MOST) return refuse([`I am holding ${NOTCH_DROP_MOST} files already. Ask about those first.`]);
        held.push({ name, size: dropped.size, cut: false, raw: dropped.bytes, unread: why, file: { kind: 'document', name, mediaType: 'application/octet-stream', bytes: new Uint8Array(0) } });
        unsaid = name;
        shut('gulp');
        show();
        return { taken: true };
      };
      if (!verdict.ok) return sendable ? holdUnread(verdict.why) : refuse([verdict.why]);
      if (!whole) return refuse(['Only part of ', em(name), ' arrived, so I did not read it. Try dropping it again.'], 'sorry');
      let bytes = dropped.bytes;
      let cut = false;
      if (verdict.reader) {
        // A web page, an Office file, code: its words, as plain text under its own name.
        const read = readDropped(verdict.reader, dropped.bytes);
        if (!read) return sendable ? holdUnread(`I could not read ${name}. It may be damaged, protected with a password, or hold no words.`) : refuse(['I could not read ', em(name), '. It may be damaged, protected with a password, or hold no words.'], 'sorry');
        bytes = new TextEncoder().encode(read.text);
        cut = read.cut;
      }
      if (held.length >= NOTCH_DROP_MOST) return refuse([`I am holding ${NOTCH_DROP_MOST} files already. Ask about those first.`]);
      const together = held.reduce((sum, one) => sum + one.file.bytes.length, 0) + bytes.length;
      if (held.length > 0 && together > ATTACHMENT_LIMITS.turnBytes) return refuse([em(name), ' is too large to read together with what I am holding. Ask about that first.']);
      held.push({ name, size: dropped.size, cut, raw: dropped.bytes, file: { kind: verdict.kind, name, mediaType: verdict.mediaType, bytes } });
      unsaid = name;
      // Swallowed: one gulp, then what it got and what is wanted from it.
      shut('gulp');
      show();
      try { deps.taken?.(); } catch { /* a sign, and nothing depends on it */ }
      return { taken: true };
    },
    arrived(file) {
      if (stopped || deps.paused?.()) return false;
      const name = dropName(file.name);
      const verdict = dropVerdict(name, '', file.bytes.length);
      // Not a file that can be read: there is nothing to ask about it here.
      if (!verdict.ok || held.length >= NOTCH_DROP_MOST) return false;
      let bytes = file.bytes;
      let cut = false;
      if (verdict.reader) {
        const read = readDropped(verdict.reader, file.bytes);
        if (!read) return false;
        bytes = new TextEncoder().encode(read.text);
        cut = read.cut;
      }
      const together = held.reduce((sum, one) => sum + one.file.bytes.length, 0) + bytes.length;
      if (held.length > 0 && together > ATTACHMENT_LIMITS.turnBytes) return false;
      // Sizes and kinds, never the name.
      log(`[notch] a file arrived from somebody in the organisation and is held: ${file.bytes.length} bytes`);
      const asked: NotchAskFile = { kind: verdict.kind, name, mediaType: verdict.mediaType, bytes };
      // Read at once, beside everything else: by the time its line comes up, what it is can usually be said.
      const gist = deps.gist ? deps.gist(asked, AbortSignal.timeout(NOTCH_GIST_MS)).then(gistRead, () => null) : undefined;
      held.push({ name, size: file.bytes.length, cut, raw: file.bytes, file: asked, from: { who: file.from, place: file.place }, ...(gist ? { gist } : {}) });
      unsaid = name;
      show(true);
      return true;
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

/**
 * A file dropped on the notch (pass 9) as a feature of the notch (./feature.ts): it waits for its question, one
 * of three offered, typed, or said. Without the asks it is absent, and nothing is said.
 */
export function notchDropFeature(given: Pick<NotchDropDeps, 'gist'> | undefined): NotchFeatureDef<'drop'> {
  return {
    id: 'drop',
    wants: ['asks', 'people', 'dayOne'],
    make(ctx) {
      const asks = ctx.use('asks');
      if (!given || !asks) return null;
      const people = ctx.use('people');
      const api = attachNotchDrop(ctx.surface, ctx.inbox, {
        // A button's words are the notch's own; what was typed in the field is the owner's.
        ask: (text, files, said) => { if (said) asks.typed(text, files); else asks.shown(text, files); },
        tell: (parts, mood) => { asks.tell(parts, mood); },
        // For somebody in the organisation: the file goes on as it was dropped (./people-files.ts).
        ...(people ? { send: { to: () => people.fileTargets(), file: (to: string, file: { name: string; bytes: Uint8Array }) => people.sendFile(to, file) } } : {}),
        paused: () => ctx.paused(),
        // A file that arrived from somebody is read by itself, and what it is is said with its arrival.
        ...(given.gist ? { gist: given.gist } : {}),
        // On day one, the first file anyone drops is the lesson, and is asked about as any file is.
        taken: () => ctx.use('dayOne')?.gave(),
        log: ctx.log,
      });
      return { api, stop: () => api.stop() };
    },
  };
}
