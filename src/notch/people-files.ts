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
 *   - What arrives is a file from outside. It is saved and nothing else: it
 *     is not opened, not read, not run, and no model sees it. Its name is
 *     made safe before it is shown or used (src/peers/notes.ts).
 *   - A piece is taken only for an offer the person said yes to, from the
 *     one who made it, and only as large as the offer said it would be. A
 *     piece of anything else is dropped unseen.
 *   - Both sides must be Pillows. Anyone else gets one sentence that says a
 *     file is offered, and cannot take it.
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

export type PeerFileNote = Extract<PeerNote, { kind: 'file' | 'file-yes' | 'file-no' | 'file-got' | 'file-lost' | 'file-part' }>;
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
  person(id: string): PeerPerson | null;
  /** News that is said once. */
  news(id: string, say: NotchPart[], more?: { who?: string; sorry?: boolean }): void;
  log?: (line: string) => void;
  /** For tests: no pause between pieces, and none before a piece is tried again. */
  paceMs?: number;
  retryMs?: number;
}

export interface NotchPeopleFiles {
  /** Offers a file to a person. */
  send(to: PeerPerson, file: { name: string; bytes: Uint8Array }): void;
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

  async function offer(stage: NotchStage, to: PeerPerson, file: { name: string; bytes: Uint8Array }): Promise<void> {
    const name = peerFileName(file.name);
    const size = file.bytes.length;
    {
      if (size < 1) { await stage.say([em(name), ' is empty.'], 2600); return; }
      if (size > PEER_FILE_MAX) { await stage.say([em(name), ` is larger than I can send yet: ${Math.round(PEER_FILE_MAX / (1024 * 1024))} MB is the most.`], 3600, { mood: 'sorry' }); return; }
      const went = await stage.fuse(['Offering ', em(to.name), ' the file ', em(name), `, ${fileSize(size)}…`], NOTCH_FILE_FUSE_MS, { mood: 'work' });
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
      const sent = await link.tell(to.id, peerNoteText(`A file for you: ${name}, ${fileSize(size)}. It comes when you take it on your ${NOTCH_NAME}.`, { kind: 'file', id, name, size, parts, sha }));
      if (!sent.ok) { clear(id); await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.file({ id, dir: 'out', peer: to.id, name, size, parts, sha });
      await stage.say(sent.delivered ? ['Offered to ', em(to.name), '. It goes when ', em(to.name), ' takes it.'] : ['Offered. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 3000, { mark: 'check' });
    }
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
        deps.news(`people:file-lost:${row.id}`, [em(row.name), ' did not reach ', em(to?.name ?? 'them'), '. Send it again when you are both on.'], { who: to?.name, sorry: true });
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
    if (!saved) {
      // Not what was offered, or nowhere to put it: nothing of it is kept.
      store.fileState(row.id, 'lost', ['done']);
      void link.tell(row.peer, peerNoteText('It did not arrive whole.', { kind: 'file-lost', of: row.id }));
      deps.news(`people:file-lost:${row.id}`, good ? ['I could not save ', em(row.name), ' from ', em(from.name), '. Ask for it again.'] : [em(row.name), ' from ', em(from.name), ' did not arrive whole, so I did not keep it. Ask for it again.'], { who: from.name, sorry: true });
      return;
    }
    void link.tell(row.peer, peerNoteText('Got it.', { kind: 'file-got', of: row.id }));
    deps.news(`people:file-here:${row.id}`, [em(saved.name), ' from ', em(from.name), ' is in your ', em(saved.place), '.'], { who: from.name });
  }

  async function note(item: PeerItem, from: PeerPerson, got: PeerFileNote, words: string): Promise<void> {
    const settle = async (): Promise<void> => { store.done(item.id); await link.seen(item.id); };
    if (got.kind === 'file') {
      // An offer waits for its yes: it stays unread at the engine until the person answers.
      if (!store.fileOf(got.id)) store.file({ id: got.id, dir: 'in', peer: item.from, name: got.name, size: got.size, parts: got.parts, sha: got.sha, item: item.id });
      const row = store.fileOf(got.id);
      if (row && row.dir === 'in' && row.peer === item.from && row.state === 'offered') ask(got.id);
      else await settle();
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
      else if (got.kind === 'file-no' && store.fileState(row.id, 'no', ['offered'])) { clear(row.id); deps.news(`people:file-no:${row.id}`, [em(from.name), ' did not take ', em(row.name), '.'], { who: from.name }); }
      else if (got.kind === 'file-got' && store.fileState(row.id, 'done', ['going'])) { clear(row.id); deps.news(`people:file-got:${row.id}`, [em(from.name), ' has ', em(row.name), '.'], { who: from.name }); }
      else if (got.kind === 'file-lost' && store.fileState(row.id, 'lost', ['going'])) { clear(row.id); deps.news(`people:file-lost:${row.id}`, [em(row.name), ' did not arrive whole at ', em(`${from.name}'s`), '. Send it again.'], { who: from.name, sorry: true }); }
    }
    await settle();
  }

  function restore(): void {
    for (const row of store.openFiles('out')) {
      // The pieces start again from the first: the other side keeps what it has and takes each piece once.
      if (row.state === 'going' && existsSync(join(folder(row.id), 'whole'))) pump(row);
    }
    for (const row of store.openFiles('in')) if (row.state === 'offered') ask(row.id);
  }

  return {
    send, note, restore,
    idle: async () => { while (pumping.size) await Promise.all([...pumping.values()]); },
  };
}
