/**
 * A file, from one Pillow to another.
 *
 * The engine carries text and no files (docs/peers/README.md). So a file
 * crosses as what the engine does carry: messages, through the same sealed
 * channel as every other word. It is cut into pieces, each piece is one
 * message, and the other Pillow puts them together again.
 *
 * The owner agreed to this on 20 November 2026, for a demo, with a cap of
 * 25 MB.
 *
 *   1. The sender says who it is for. An OFFER goes: the file's name, its
 *      size, and what its bytes add up to. Nothing of the file itself.
 *   2. The receiver is asked: "Sam sends you a file: deck.pdf, 2.1 MB. Take
 *      it?" Only a yes brings it.
 *   3. The pieces cross. The receiver checks the whole against the offer,
 *      byte count and SHA-256, and only then is it put where the person
 *      finds it. A file that does not check is thrown away, and both are told.
 *
 * What holds:
 *
 *   - A yes on both sides. The sender's is the saying, with the window to
 *     take it back that everything has which goes to another person. The
 *     receiver's is a key. Nothing of a file leaves before both.
 *   - What arrives is a file from outside. It is saved, and then it is held
 *     as a file is that the person dropped on the notch themselves
 *     (./drop.ts): the same card, the same three things to ask with a click,
 *     and it is read only when the person asks something about it. Until
 *     then nothing opens it, nothing runs it, and no model sees it. Its name
 *     is made safe before it is shown or used (src/peers/notes.ts).
 *   - A piece is taken only for an offer the person said yes to, from the
 *     one who made it, and only as large as the offer said it would be. A
 *     piece of anything else is dropped unseen.
 *   - Both sides must be Pillows. Anyone else gets one sentence that says a
 *     file is offered, and cannot take it.
 *
 * ASKING FOR ONE. The owner, 22 November 2026: "i might want to retreive a
 * file in someone elses pc like we built in our poc". The prototype (v15,
 * fetchFromLapo and lfile) is the script:
 *
 *   1. "Get me the Q3 numbers from Leo's laptop." An ASKING goes: the words
 *      for the file, nothing else.
 *   2. Leo's Pillow looks for it by name, on his own laptop, and asks HIM:
 *      "Sam asks for the Q3 numbers. I found Q3 numbers.xlsx in your
 *      Documents. Send only that?" Send it, Another file, or No.
 *   3. On his yes it crosses as any file does, and is not asked about again
 *      on Sam's side: the asking was the yes.
 *
 * And for it:
 *
 *   - The one who asks is told nothing by the looking. Not what was found,
 *     and not that nothing was: only the owner's yes or no comes back, so
 *     nobody can find out from afar which files a laptop holds.
 *   - What is found is only ever put to the owner of the laptop. One file
 *     leaves, the one named on the line, and only after that yes.
 *   - "Another file" sends nothing. The owner drops the right one on the
 *     notch, and it goes as the answer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotchInbox } from './inbox.ts';
import { NOTCH_NAME } from './name.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import type { PeerItem, PeerLink, PeerPerson, PeerSent } from '../peers/link.ts';
import { PEER_FILE_MAX, PEER_FILE_PART, peerFileName, peerFileParts, peerNoteText } from '../peers/notes.ts';
import type { PeerNote } from '../peers/notes.ts';
import type { PeerFileRow, PeerStore } from '../peers/store.ts';

const em = (text: string): NotchPart => ({ em: text });

/** The window in which an offer can be taken back. The same as for a message. */
export const NOTCH_FILE_FUSE_MS = 3000;
/**
 * The pause between two pieces. The server takes two messages a second from
 * one machine: a little slower than that, so that a file does not use up
 * what a word said meanwhile would need.
 */
export const NOTCH_FILE_PACE_MS = 600;
/** How often a piece that did not go is tried again, and the first wait between two tries. */
export const NOTCH_FILE_TRIES = 6;
/** How often, and how far apart, an offer is tried again while something else has the notch. */
export const NOTCH_FILE_OFFER_TRIES = 240;
export const NOTCH_FILE_OFFER_WAIT_MS = 500;
export const NOTCH_FILE_RETRY_MS = 4000;

export const fileSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The largest file that is taken from its folder to be sent: what the desktop app hands over (sidecar/notch_files.go). */
export const NOTCH_FILE_HAND_MAX = 16 * 1024 * 1024;
/** How long, after "Another file", a file sent to that person counts as the answer to what they asked for. */
export const NOTCH_FILE_SHOW_MS = 15 * 60_000;

export type PeerFileNote = Extract<PeerNote, { kind: 'file' | 'file-yes' | 'file-no' | 'file-got' | 'file-lost' | 'file-part' | 'file-want' | 'file-want-no' }>;

/** A file that fits what was asked for, as the desktop app names it. */
export interface PeerFileFound { place: 'desktop' | 'documents' | 'downloads'; name: string; kind: string; size: number }

/** Where a place is, as it is said. */
const WHERE: Record<PeerFileFound['place'], string> = { desktop: 'on your desktop', documents: 'in your Documents', downloads: 'in your Downloads' };
export const isFileNote = (note: PeerNote | null): note is PeerFileNote => !!note && note.kind.startsWith('file');

export interface NotchPeopleFilesDeps {
  inbox: NotchInbox;
  link: PeerLink;
  store: PeerStore;
  /** A folder of the brain's own, where a file is kept while it crosses. */
  dir: string;
  /**
   * Puts a file that arrived whole where the person finds it. Gives the
   * place as it is said ("Downloads") and the name it was saved under, or
   * null when it could not be saved.
   */
  save(name: string, bytes: Uint8Array): Promise<{ place: string; name: string } | null>;
  /**
   * Hands a file that arrived to the notch, to be held like one the person
   * dropped: `place` is where it was saved, or null when it could not be.
   * True when the notch took it and says so itself.
   */
  arrived?: (file: { name: string; bytes: Uint8Array; from: string; place: string | null }) => boolean;
  /** Looks on this laptop for the files that fit some words, the best first. Null when it cannot look. */
  find?: (words: string) => Promise<PeerFileFound[] | null>;
  /** Takes one of them from its folder. Null when it is not handed over. */
  open?: (place: PeerFileFound['place'], name: string) => Promise<Uint8Array | null>;
  person(id: string): PeerPerson | null;
  /** News that is said once. */
  news(id: string, say: NotchPart[], more?: { who?: string; sorry?: boolean }): void;
  log?: (line: string) => void;
  now?: () => number;
  /** For tests: no pause between pieces, and none before a piece is tried again. */
  paceMs?: number;
  retryMs?: number;
}

export interface NotchPeopleFiles {
  /** Offers a file to a person. */
  send(to: PeerPerson, file: { name: string; bytes: Uint8Array }): void;
  /** Asks a person's Pillow for a file of theirs, in words. */
  want(to: PeerPerson, what: string): void;
  /** Takes in a note about a file that arrived. */
  note(item: PeerItem, from: PeerPerson, note: PeerFileNote, words: string): Promise<void>;
  /** After the brain was started anew: what was on its way goes on. */
  restore(): void;
  /** The pieces of every file that is crossing have gone. For tests. */
  idle(): Promise<void>;
}

export function attachNotchPeopleFiles(deps: NotchPeopleFilesDeps): NotchPeopleFiles {
  const { inbox, link, store } = deps;
  const log = deps.log ?? (() => { /* quiet */ });
  const now = deps.now ?? Date.now;
  const pace = deps.paceMs ?? NOTCH_FILE_PACE_MS;
  const retry = deps.retryMs ?? NOTCH_FILE_RETRY_MS;
  const pumping = new Map<string, Promise<void>>();
  const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); }) : Promise.resolve());

  const folder = (id: string): string => join(deps.dir, id);
  const clear = (id: string): void => { try { rmSync(folder(id), { recursive: true, force: true }); } catch { /* nothing was there */ } };
  const sorry = (sent: Extract<PeerSent, { ok: false }>): NotchPart[] =>
    sent.why === 'signed_out' ? ['You are signed out. It was not offered.'] : sent.why === 'offline' || sent.why === 'down' ? ['I have no line to the others now. It was not offered.'] : ['That could not be offered.'];

  // --- sending ---

  /** What waits to be offered. The notch takes one thing at a time, so two files dropped together are offered one after the other. */
  const waiting: { to: PeerPerson; file: { name: string; bytes: Uint8Array }; tries: number }[] = [];
  let offering = false;

  function send(to: PeerPerson, file: { name: string; bytes: Uint8Array }): void {
    waiting.push({ to, file, tries: 0 });
    next();
  }

  function next(): void {
    const job = waiting[0];
    if (offering || !job) return;
    const up = inbox.present('people-file', async (stage) => {
      offering = true;
      waiting.shift();
      try { await offer(stage, job.to, job.file); } finally { offering = false; if (waiting.length) later(); }
    });
    if (up) return;
    // Something else has the notch. Tried again for two minutes, then let go: an offer nobody saw go is not made.
    if (++job.tries > NOTCH_FILE_OFFER_TRIES) { waiting.shift(); log('[notch] a file was not offered: the notch had no room for it'); if (waiting.length) later(); return; }
    later();
  }

  let again: ReturnType<typeof setTimeout> | null = null;
  function later(): void {
    if (again) return;
    again = setTimeout(() => { again = null; next(); }, deps.paceMs === 0 ? 0 : NOTCH_FILE_OFFER_WAIT_MS);
    (again as { unref?: () => void }).unref?.();
  }

  /** The files that are on a notch's line while they cross: how they end is said there, and not as news too. */
  const inView = new Set<string>();
  const endWaiters = new Map<string, (() => void)[]>();
  /** A file's crossing is over, one way or the other. */
  const ended = (id: string): void => { for (const wake of endWaiters.get(id) ?? []) wake(); endWaiters.delete(id); };
  const untilEnded = (id: string): Promise<void> => new Promise((resolve) => {
    const state = store.fileOf(id)?.state;
    if (state !== 'offered' && state !== 'going') { resolve(); return; }
    endWaiters.set(id, [...(endWaiters.get(id) ?? []), resolve]);
  });

  /**
   * Offers one file. `want`: it answers what that person asked for, so the
   * line says that one file goes, stays until it has gone, and their Pillow
   * does not ask them again.
   */
  async function offer(stage: NotchStage, to: PeerPerson, file: { name: string; bytes: Uint8Array }, more: { want?: string } = {}): Promise<void> {
    const name = peerFileName(file.name);
    const size = file.bytes.length;
    // The owner said "Another file" to what this person asked for, and this is the one they show.
    const shown = more.want ? null : store.wantToShow(to.id, now() - NOTCH_FILE_SHOW_MS);
    const want = more.want ?? shown?.id;
    {
      if (size < 1) { await stage.say([em(name), ' is empty.'], 2600); return; }
      if (size > PEER_FILE_MAX) { await stage.say([em(name), ` is larger than I can send yet: ${Math.round(PEER_FILE_MAX / (1024 * 1024))} MB is the most.`], 3600, { mood: 'sorry' }); return; }
      const went = await stage.fuse(want ? ['Sending ', em(to.name), ' ', em(name), `, ${fileSize(size)}, and nothing else…`] : ['Offering ', em(to.name), ' the file ', em(name), `, ${fileSize(size)}…`], NOTCH_FILE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was sent.'], 2000); return; }
      // Nobody saw the line burn: what nobody may have seen does not go out.
      if (went === 'lost') return;
      const id = crypto.randomUUID();
      const sha = createHash('sha256').update(file.bytes).digest('hex');
      try {
        mkdirSync(folder(id), { recursive: true, mode: 0o700 });
        writeFileSync(join(folder(id), 'whole'), file.bytes, { mode: 0o600 });
      } catch { await stage.say(['I could not keep the file to send it.'], 3000, { mood: 'sorry' }); return; }
      const parts = peerFileParts(size);
      // The sentence is for a contact who is not on a Pillow: they read it, and cannot take the file.
      // Known here before it is offered: a yes to something they asked for themselves can be back before the offer is known to have gone.
      store.file({ id, dir: 'out', peer: to.id, name, size, parts, sha });
      const sent = await link.tell(to.id, peerNoteText(
        want ? `The file you asked for: ${name}, ${fileSize(size)}.` : `A file for you: ${name}, ${fileSize(size)}. It comes when you take it on your ${NOTCH_NAME}.`,
        { kind: 'file', id, name, size, parts, sha, ...(want ? { want } : {}) }));
      if (!sent.ok) { store.fileState(id, 'lost', ['offered']); clear(id); await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      if (shown) store.wantState(shown.id, 'done', ['show']);
      if (!want) {
        await stage.say(sent.delivered ? ['Offered to ', em(to.name), '. It goes when ', em(to.name), ' takes it.'] : ['Offered. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 3000, { mark: 'check' });
        return;
      }
      // They asked for it, so it goes without another question there. On the line until it has gone; Esc leaves it going.
      inView.add(id);
      try {
        const line = stage.id();
        stage.put({ id: line, kind: 'work', say: ['Sending ', em(to.name), ' that one file…'], steps: 0, done: 0, mood: 'work', who: to.name });
        const left = stage.answer(line, ['stop', 'no']).then(() => true, () => true);
        if (await Promise.race([untilEnded(id).then(() => false), left])) return;
        const state = store.fileOf(id)?.state;
        if (state === 'done') await stage.say(['Sent. One file left this laptop, nothing else.'], 3400, { mark: 'check', who: to.name });
        else if (state === 'no') await stage.say([em(to.name), ' did not take it. Nothing left this laptop.'], 3200, { who: to.name });
        else await stage.say(['It did not reach ', em(to.name), '. Send it again when you are both on.'], 3400, { mood: 'sorry', who: to.name });
      } finally { inView.delete(id); }
    }
  }

  // --- asking for a file ---

  /** "Get me the Q3 numbers from Leo's laptop." */
  function want(to: PeerPerson, what: string): void {
    const theirs = `${to.name}'s ${NOTCH_NAME}`;
    inbox.present('people-want', async (stage) => {
      const went = await stage.fuse(['Asking ', em(theirs), ' for ', em(what), '. ', em(to.name), ' must say yes there.'], NOTCH_FILE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was asked.'], 2000); return; }
      if (went === 'lost') return;
      const id = crypto.randomUUID();
      // The sentence is for a contact who is not on a Pillow: they read it, and answer in their own words.
      const sent = await link.tell(to.id, peerNoteText(`Can you send me a file: ${what}? I asked from my ${NOTCH_NAME}.`, { kind: 'file-want', id, what }));
      if (!sent.ok) {
        await stage.say(sent.why === 'signed_out' ? ['You are signed out. It was not asked.'] : sent.why === 'offline' || sent.why === 'down' ? ['I have no line to the others now. It was not asked.'] : ['That could not be asked.'], 3400, { mood: 'sorry' });
        return;
      }
      store.want({ id, dir: 'out', peer: to.id, what });
      await stage.say(sent.delivered ? ['Asked ', em(theirs), '. I will tell you what ', em(to.name), ' does.'] : ['Asked. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 2800, { mark: 'check' });
    });
  }

  /** "Sam asks for the Q3 numbers. I found Q3 numbers.xlsx in your Documents. Send only that?" */
  function wanted(id: string): void {
    const first = store.wantOf(id);
    const from = first ? deps.person(first.peer) : null;
    if (!first || !from || first.dir !== 'in') return;
    const settled = (): void => { if (first.item) { store.done(first.item); void link.seen(first.item); } };
    inbox.add({
      id: `people:want:${id}`, subject: `people:want:${id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' asks for a file: ', first.what],
      check: () => store.wantOf(id)?.state === 'open',
      play: async (stage) => {
        // Looked for when its line is about to be shown: what is on the laptop now. Nothing of the looking leaves.
        let found: PeerFileFound[] | null = null;
        if (deps.find) {
          const line = stage.id();
          stage.put({ id: line, kind: 'work', say: ['Looking for what ', em(from.name), ' asks for…'], steps: 0, done: 0, mood: 'work', who: from.name });
          found = await deps.find(first.what).catch(() => null);
        }
        const best = (found ?? []).find((one) => one.size > 0 && one.size <= NOTCH_FILE_HAND_MAX) ?? null;
        const large = !best ? (found ?? []).find((one) => one.size > NOTCH_FILE_HAND_MAX) ?? null : null;
        const asks: NotchPart[] = [em(from.name), ' asks for ', em(first.what), '. '];
        const answer = best
          ? await stage.choose([...asks, 'I found ', em(best.name), ` ${WHERE[best.place]}, ${fileSize(best.size)}. Send only that?`], ['Send it', 'Another file', 'No'], { who: from.name, mood: 'look' })
          : await stage.choose(large ? [...asks, 'I found ', em(large.name), `, but at ${fileSize(large.size)} it is larger than I can take from its folder.`]
            : found ? [...asks, 'I do not find a file like that on this laptop.'] : [...asks, 'I cannot look through the files on this laptop right now.'], ['Another file', 'No'], { who: from.name, mood: 'look' });
        if (answer.act !== 'pick' || typeof answer.index !== 'number') return 'waits';
        const picked = (best ? ['send', 'other', 'no'] : ['other', 'no'])[answer.index];
        if (picked === 'no') {
          const sent = await link.tell(first.peer, peerNoteText('No, I cannot send that.', { kind: 'file-want-no', of: id }), first.item ? { replyTo: first.item } : {});
          if (!sent.ok) { await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' }); return 'waits'; }
          store.wantState(id, 'no', ['open']);
          settled();
          await stage.say(['Told ', em(from.name), ' no. Nothing left this laptop.'], 3000, { who: from.name });
          return 'settled';
        }
        const show = async (why: NotchPart[]): Promise<'settled'> => {
          // Nothing is sent. The next file that is sent to them is the answer.
          store.wantState(id, 'show', ['open']);
          settled();
          await stage.say([...why, 'Drop it on me, and pick ', em(`Send to ${from.name}`), '.'], 4600, { who: from.name });
          return 'settled';
        };
        if (picked === 'other' || !best) return show(['Show me which. ']);
        const bytes = deps.open ? await deps.open(best.place, best.name).catch(() => null) : null;
        if (!bytes || bytes.length < 1) return show(['I could not take ', em(best.name), ' from its folder. ']);
        if (!store.wantState(id, 'done', ['open'])) return 'settled';
        settled();
        await offer(stage, from, { name: best.name, bytes }, { want: id });
        return 'settled';
      },
    });
  }

  /** Sends the pieces of a file that was taken, one after the other. */
  function pump(row: PeerFileRow): void {
    if (pumping.has(row.id)) return;
    const to = deps.person(row.peer);
    const job = (async () => {
      let bytes: Uint8Array;
      try { bytes = readFileSync(join(folder(row.id), 'whole')); } catch { bytes = new Uint8Array(0); }
      const failed = (): void => {
        if (!store.fileState(row.id, 'lost', ['going'])) return;
        clear(row.id);
        ended(row.id);
        if (!inView.has(row.id)) deps.news(`people:file-lost:${row.id}`, [em(row.name), ' did not reach ', em(to?.name ?? 'them'), '. Send it again when you are both on.'], { who: to?.name, sorry: true });
      };
      // What was kept is no longer what was offered: nothing of it goes.
      if (bytes.length !== row.size) { failed(); return; }
      for (let n = 0; n < row.parts; n++) {
        if (store.fileOf(row.id)?.state !== 'going') return;
        const piece = Buffer.from(bytes.subarray(n * PEER_FILE_PART, Math.min((n + 1) * PEER_FILE_PART, row.size))).toString('base64');
        let sent: PeerSent = { ok: false, why: 'down' };
        for (let tries = 0; tries < NOTCH_FILE_TRIES; tries++) {
          if (tries > 0) await wait(retry * tries);
          sent = await link.tell(row.peer, peerNoteText(piece, { kind: 'file-part', of: row.id, n }));
          if (sent.ok) break;
        }
        if (!sent.ok) { log(`[notch] a file stopped crossing at piece ${n + 1} of ${row.parts}`); failed(); return; }
        await wait(pace);
      }
      log(`[notch] a file's ${row.parts} piece(s) have gone`);
    })().finally(() => { pumping.delete(row.id); });
    pumping.set(row.id, job);
  }

  // --- receiving ---

  /** "Sam sends you a file: deck.pdf, 2.1 MB. Take it?" */
  function ask(id: string): void {
    const first = store.fileOf(id);
    const from = first ? deps.person(first.peer) : null;
    if (!first || !from || first.dir !== 'in') return;
    inbox.add({
      id: `people:file:${id}`, subject: `people:file:${id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' sends a file: ', first.name],
      check: () => store.fileOf(id)?.state === 'offered',
      play: async (stage) => {
        const answer = await stage.choose([em(from.name), ' sends you a file: ', em(first.name), `, ${fileSize(first.size)}. Take it?`], ['Take it', 'No'], { who: from.name, mood: 'look' });
        if (answer.act !== 'pick') return 'waits';
        const yes = answer.index === 0;
        if (yes) {
          try { mkdirSync(folder(id), { recursive: true, mode: 0o700 }); } catch { /* a piece that cannot be kept is not counted, and the file then never completes */ }
          // Open for its pieces before the yes leaves: the first piece may be here before the yes is known to have gone.
          if (!store.fileState(id, 'going', ['offered'])) return 'settled';
        }
        const sent = await link.tell(first.peer, peerNoteText(yes ? 'Yes, send it.' : 'No, thank you.', { kind: yes ? 'file-yes' : 'file-no', of: id }), first.item ? { replyTo: first.item } : {});
        if (!sent.ok) {
          if (yes) store.fileState(id, 'offered', ['going']);
          await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' });
          return 'waits';
        }
        if (!yes) store.fileState(id, 'no', ['offered']);
        if (first.item) { store.done(first.item); void link.seen(first.item); }
        await stage.say(yes ? ['It is coming. I will tell you when it is here.'] : ['Told ', em(from.name), ' no. Nothing was sent to you.'], 2800, { who: from.name });
        return 'settled';
      },
    });
  }

  /** A piece arrived. When it is the last one missing, the file is checked and saved. */
  async function piece(row: PeerFileRow, from: PeerPerson, n: number, words: string): Promise<void> {
    if (n >= row.parts) return;
    const expected = n === row.parts - 1 ? row.size - n * PEER_FILE_PART : PEER_FILE_PART;
    // Never longer than the piece it says it is: checked before it is turned into bytes.
    if (words.length > Math.ceil(expected / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(words)) return;
    const bytes = Buffer.from(words, 'base64');
    if (bytes.length !== expected) return;
    try {
      mkdirSync(folder(row.id), { recursive: true, mode: 0o700 });
      writeFileSync(join(folder(row.id), String(n)), bytes, { mode: 0o600 });
    } catch { return; }
    let have = 0;
    try { have = readdirSync(folder(row.id)).filter((name) => /^\d+$/.test(name) && Number(name) < row.parts).length; } catch { have = 0; }
    if (have < row.parts) return;
    // Every piece is here. Only one arrival puts them together.
    if (!store.fileState(row.id, 'done', ['going'])) return;
    const whole = Buffer.alloc(row.size);
    let at = 0;
    let fits = true;
    for (let part = 0; part < row.parts; part++) {
      let one: Uint8Array;
      try { one = readFileSync(join(folder(row.id), String(part))); } catch { fits = false; break; }
      if (at + one.length > row.size) { fits = false; break; }
      whole.set(one, at);
      at += one.length;
    }
    const good = fits && at === row.size && createHash('sha256').update(whole).digest('hex') === row.sha;
    clear(row.id);
    const saved = good ? await deps.save(row.name, whole).catch(() => null) : null;
    // It is whole: the notch holds it as it holds a file the person dropped, to be asked about. That it could
    // not be put in a folder does not lose it.
    let held = false;
    if (good) { try { held = deps.arrived?.({ name: saved?.name ?? row.name, bytes: whole, from: from.name, place: saved?.place ?? null }) ?? false; } catch { held = false; } }
    if (!saved && !held) {
      // Not what was offered, or nowhere to put it and nothing to hold it: nothing of it is kept.
      store.fileState(row.id, 'lost', ['done']);
      void link.tell(row.peer, peerNoteText('It did not arrive whole.', { kind: 'file-lost', of: row.id }));
      deps.news(`people:file-lost:${row.id}`, good ? ['I could not save ', em(row.name), ' from ', em(from.name), '. Ask for it again.'] : [em(row.name), ' from ', em(from.name), ' did not arrive whole, so I did not keep it. Ask for it again.'], { who: from.name, sorry: true });
      return;
    }
    void link.tell(row.peer, peerNoteText('Got it.', { kind: 'file-got', of: row.id }));
    // Held by the notch: its own card says where the file is. Otherwise one line of news.
    if (!held && saved) deps.news(`people:file-here:${row.id}`, [em(saved.name), ' from ', em(from.name), ' is in your ', em(saved.place), '.'], { who: from.name });
  }

  /** Takes a file without asking: it answers what this machine asked for. False when the yes could not be sent. */
  async function take(row: PeerFileRow, from: PeerPerson): Promise<boolean> {
    try { mkdirSync(folder(row.id), { recursive: true, mode: 0o700 }); } catch { /* a piece that cannot be kept is not counted */ }
    if (!store.fileState(row.id, 'going', ['offered'])) return false;
    const sent = await link.tell(row.peer, peerNoteText('Yes, send it.', { kind: 'file-yes', of: row.id }), row.item ? { replyTo: row.item } : {});
    if (!sent.ok) { store.fileState(row.id, 'offered', ['going']); return false; }
    if (row.item) { store.done(row.item); void link.seen(row.item); }
    deps.news(`people:file-coming:${row.id}`, [em(from.name), ' is sending ', em(row.name), '.'], { who: from.name });
    return true;
  }

  async function note(item: PeerItem, from: PeerPerson, got: PeerFileNote, words: string): Promise<void> {
    const settle = async (): Promise<void> => { store.done(item.id); await link.seen(item.id); };
    if (got.kind === 'file') {
      // An offer waits for its yes: it stays unread at the engine until the person answers.
      if (!store.fileOf(got.id)) store.file({ id: got.id, dir: 'in', peer: item.from, name: got.name, size: got.size, parts: got.parts, sha: got.sha, item: item.id });
      const row = store.fileOf(got.id);
      if (!row || row.dir !== 'in' || row.peer !== item.from || row.state !== 'offered') { await settle(); return; }
      // It answers something this machine asked of them, and that is still open: the asking was the yes.
      const asked = got.want ? store.wantOf(got.want) : null;
      if (asked && asked.dir === 'out' && asked.peer === item.from && asked.state === 'open' && await take(row, from)) { store.wantState(asked.id, 'done', ['open']); return; }
      if (!inbox.has(`people:file:${got.id}`)) ask(got.id);
      return;
    }
    if (got.kind === 'file-want') {
      // An asking waits for the owner's answer, as an offer does.
      if (!store.wantOf(got.id)) store.want({ id: got.id, dir: 'in', peer: item.from, what: got.what, item: item.id });
      const asked = store.wantOf(got.id);
      if (!asked || asked.dir !== 'in' || asked.peer !== item.from || asked.state !== 'open') { await settle(); return; }
      if (!inbox.has(`people:want:${got.id}`)) wanted(got.id);
      return;
    }
    if (got.kind === 'file-want-no') {
      const asked = store.wantOf(got.of);
      if (asked && asked.dir === 'out' && asked.peer === item.from && store.wantState(asked.id, 'no', ['open'])) {
        deps.news(`people:want-no:${asked.id}`, [em(from.name), ' said no. Nothing left ', em(`${from.name}'s`), ' laptop.'], { who: from.name });
      }
      await settle();
      return;
    }
    const row = store.fileOf(got.of);
    // About a file this machine knows nothing of, or from somebody it is not with: dropped unseen.
    if (!row || row.peer !== item.from) { await settle(); return; }
    if (got.kind === 'file-part') {
      if (row.dir === 'in' && row.state === 'going') await piece(row, from, got.n, words);
      await settle();
      return;
    }
    if (row.dir === 'out') {
      if (got.kind === 'file-yes' && store.fileState(row.id, 'going', ['offered'])) pump({ ...row, state: 'going' });
      // How it ended is news, unless the file's own line is on the notch and says it.
      const quiet = inView.has(row.id);
      if (got.kind === 'file-no' && store.fileState(row.id, 'no', ['offered'])) { clear(row.id); ended(row.id); if (!quiet) deps.news(`people:file-no:${row.id}`, [em(from.name), ' did not take ', em(row.name), '.'], { who: from.name }); }
      else if (got.kind === 'file-got' && store.fileState(row.id, 'done', ['going'])) { clear(row.id); ended(row.id); if (!quiet) deps.news(`people:file-got:${row.id}`, [em(from.name), ' has ', em(row.name), '.'], { who: from.name }); }
      else if (got.kind === 'file-lost' && store.fileState(row.id, 'lost', ['going'])) { clear(row.id); ended(row.id); if (!quiet) deps.news(`people:file-lost:${row.id}`, [em(row.name), ' did not arrive whole at ', em(`${from.name}'s`), '. Send it again.'], { who: from.name, sorry: true }); }
    }
    await settle();
  }

  function restore(): void {
    for (const row of store.openFiles('out')) {
      // The pieces start again from the first: the other side keeps what it has and takes each piece once.
      if (row.state === 'going' && existsSync(join(folder(row.id), 'whole'))) pump(row);
    }
    for (const row of store.openFiles('in')) if (row.state === 'offered') ask(row.id);
    for (const row of store.openWants('in')) if (row.state === 'open') wanted(row.id);
  }

  return {
    send, want, note, restore,
    idle: async () => { while (pumping.size) await Promise.all([...pumping.values()]); },
  };
}
