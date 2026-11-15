/**
 * Jarvis looks at the mail by itself.
 *
 * The owner's word (15 November 2026): Jarvis has to know that it needs to
 * check mail periodically, through a connection when one exists and in the
 * browser when not. So nothing here waits for the owner to open Gmail. On a
 * clock, the mailbox is looked at, and for each thread where a person is
 * waiting (./waiting.ts) a reply is prepared (./proposer.ts) and kept
 * (./store.ts), so that it is ready before the owner looks.
 *
 * What a look does, and what it is careful about:
 *
 *  - It reads the list first, and a thread only when the list says it has
 *    changed since it was last read and the person shown last is not the
 *    owner and not a machine. On a real month that is a sixth of the threads.
 *  - A message is put to the model once, whatever came of it. What is kept
 *    is the row in the store: ready, silent, failed.
 *  - A message that is too new is remembered with the moment it will have
 *    waited long enough, and looked at again then.
 *  - A prepared reply is checked again against the mailbox every minute: once
 *    the owner has answered by hand, begun a draft, or the other side has
 *    written again, it is overtaken and leaves.
 *  - One look at a time. A look that finds no way to the mailbox says so and
 *    does nothing: no way is not an empty mailbox.
 *
 * This file decides and remembers. It reads no page and draws no line: the
 * mailbox is behind `MailReader`, and the notch hears `changed`.
 */
import type { MailCalendarEvent, MailProposal, MailThink } from './proposer.ts';
import { mailAboutMessages, mailTold, mailVoiceSamples, parseMailAbout, proposeMail } from './proposer.ts';
import { mailProposalId, type MailProposalRow, type MailStore } from './store.ts';
import { isOwner, mailFirstName, type MailOwner, type MailPerson, type MailThread } from './thread.ts';
import { MAIL_WAIT_MIN_MS, mailMachine, mailReplyTo, mailWaiting } from './waiting.ts';

/** One thread as a list of the mailbox shows it. */
export interface MailListed {
  id: string;
  /** Who is shown as taking part, the one who wrote last at the end. */
  people: MailPerson[];
  count: number;
  /** The owner has an unsent draft in it. */
  draft: boolean;
  subject: string;
  filed?: MailThread['filed'];
}

/** A way to the mailbox: the browser's tab, or a connection. */
export interface MailReader {
  /** The address the mailbox belongs to. */
  owner(): Promise<string>;
  /**
   * The threads of the last `days` days that are not advertising, the one
   * that changed last first. `pages` limits it to the top of that list.
   */
  list(days: number, pages?: number): Promise<MailListed[]>;
  /** Threads in full. One that could not be read is left out. */
  read(rows: MailListed[]): Promise<MailThread[]>;
  /** The threads the owner last wrote in, the newest first: read for their voice. */
  sent?(days: number): Promise<MailListed[]>;
}

export interface MailWatchDeps {
  /** The way to the mailbox now, with what it is called, or null when there is none. */
  reader(): Promise<{ reader: MailReader; through: string } | null>;
  store: MailStore;
  think: MailThink;
  /** The owner's calendar between two moments, or null when it cannot be reached. */
  calendar?(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  /** Files of the owner's found by some words, or null when their files cannot be reached. */
  files?(words: string): Promise<{ id: string; name: string; kind: string }[] | null>;
  /** Told whenever the replies that wait may have changed. */
  changed?(): void;
  /** Everything is stopped (the product's pause): nothing is looked at. */
  paused?(): boolean;
  /** Whether a model is set up. Without one no reply can be prepared, so nothing is looked at. */
  modelReady?(): boolean;
  now?: () => number;
  zone?: string;
  /** How long a message waits before a reply is prepared. The rule's four hours unless a test brain says otherwise. */
  waitMs?: number;
  log?: (line: string) => void;
}

/** How far back a full look goes: as far as the rule calls a message waiting. */
export const MAIL_SWEEP_DAYS = 30;
/** How far back an ordinary look goes: what can have changed since the last one. */
export const MAIL_RECENT_DAYS = 2;
/** How far ahead the calendar is shown to the model. */
const MAIL_CALENDAR_AHEAD_MS = 10 * 24 * 60 * 60 * 1000;
/** The owner's own threads kept in mind for their voice. */
const MAIL_VOICE_POOL = 300;
/** How far back, and how many, of the owner's own threads a full look reads for their voice. */
const MAIL_VOICE_DAYS = 14;
const MAIL_VOICE_READ = 24;
/** How many replies without a sentence about their thread get one in a look. */
const MAIL_ABOUT_PER_LOOK = 8;
/** How long a reply seen to wait is taken to wait still, before a line about it is shown. */
export const MAIL_CHECKED_FRESH_MS = 90_000;
const MAIL_READ_BATCH = 6;
const MAIL_PROPOSE_PARALLEL = 3;

/**
 *   sweep   everything the rule could call waiting: a month. Also checks every reply that waits.
 *   recent  what can have changed since the last one: two days.
 *   glance  the top of the list, where anything that just changed is: a new mail, or the owner's own answer.
 */
export type MailLookKind = 'sweep' | 'recent' | 'glance';

export interface MailLook {
  /** The way that was used, or null when there was none. */
  through: string | null;
  /** The look was cut short: the browser went away under it, or the mailbox stopped answering. What it did up to then stands. */
  failed?: boolean;
  listed: number;
  read: number;
  /** Messages put to the model in this look. */
  asked: number;
  /** Replies prepared in this look. */
  prepared: number;
  /** Replies that left because their thread moved on. */
  overtaken: number;
}

/** What the list showed of a thread: when this is the same as last time, the thread is not read again. */
export const mailSignature = (row: Pick<MailListed, 'count' | 'people' | 'draft'>): string =>
  `${row.count}|${row.people.at(-1)?.address ?? ''}|${row.draft ? 'draft' : ''}`;

/**
 * Could the rule call this thread waiting, going by the list alone? The
 * person shown last is who wrote last. This only ever leaves out what the
 * rule would leave out too, so that a thread is read because it may matter.
 */
export function mailCandidate(row: MailListed, owner: MailOwner): boolean {
  const last = row.people.at(-1);
  if (!last || isOwner(last, owner) || mailMachine(last) || row.draft) return false;
  const ownerWrote = row.people.some((who) => isOwner(who, owner));
  return ownerWrote || (row.filed !== 'promotions' && row.filed !== 'social' && row.filed !== 'forums');
}

export class MailWatch {
  private looking: Promise<MailLook> | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Threads the owner wrote in, kept for their voice. The newest read is kept longest. */
  private readonly voice = new Map<string, MailThread>();
  private ownerName = '';
  private last: { at: number; look: MailLook } | null = null;
  /** Replies the notch is acting on right now: a look leaves them alone. */
  private readonly held = new Set<string>();
  /** Whether the owner's own latest mail has been read for their voice since the brain started. */
  private voiceRead = false;
  /** Whose mailbox it is, once the mailbox has said so: it does not change, and is not asked for again. */
  private ownerAddress = '';
  /** Replies for which a sentence about their thread was asked for since the brain started. */
  private readonly aboutTried = new Set<string>();
  /** When each reply that waits was last seen, in the mailbox, to still be an answer to the last word. */
  private readonly checked = new Map<string, number>();

  constructor(private readonly deps: MailWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** When the mailbox was last looked at, and what came of it. Null before the first look has ended. */
  lastLook(): { at: number; look: MailLook } | null {
    return this.last;
  }

  /** Whether a look is under way now. A long one (the month) is not waited for by anything the owner is waiting on. */
  busy(): boolean {
    return this.looking !== null;
  }

  /** What the owner is called, as their own mail signs them. Empty until a mail of theirs has been read. */
  name(): string {
    return this.ownerName;
  }

  /** While the notch is writing or sending a reply, no look may take it away. */
  hold(id: string): void { this.held.add(id); }
  release(id: string): void { this.held.delete(id); }

  /** Looks at the mailbox. A look that is already under way is the one that is waited for. */
  look(kind: MailLookKind): Promise<MailLook> {
    if (this.looking) return this.looking;
    const none: MailLook = { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 };
    if (this.deps.paused?.() || this.deps.modelReady?.() === false) return Promise.resolve(none);
    this.looking = this.run(kind).then(
      (look) => { this.last = { at: this.now(), look }; return look; },
      (error: unknown) => {
        this.log(`[notch] looking at the mail failed: ${error instanceof Error ? error.message : String(error)}`);
        return { ...none, failed: true };
      },
    ).finally(() => { this.looking = null; });
    return this.looking;
  }

  private async run(kind: MailLookKind): Promise<MailLook> {
    const look: MailLook = { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 };
    const way = await this.deps.reader();
    if (!way) return look;
    look.through = way.through;
    const { reader } = way;
    const { store } = this.deps;
    const wait = this.deps.waitMs ?? MAIL_WAIT_MIN_MS;
    this.ownerAddress = (await reader.owner()).toLowerCase();
    const owner: MailOwner = new Set([this.ownerAddress]);
    // The first look, and every full one, begins with the owner's own latest mail: a reply is written in
    // their voice, and by their name. The first look is a short one, so that a reply is ready within a
    // minute of the brain starting: it must not be the one reply written without their voice.
    if ((kind === 'sweep' || !this.voiceRead) && reader.sent) {
      try {
        const own = (await reader.sent(MAIL_VOICE_DAYS)).slice(0, MAIL_VOICE_READ);
        for (let at = 0; at < own.length; at += MAIL_READ_BATCH) this.learnVoice(await reader.read(own.slice(at, at + MAIL_READ_BATCH)), owner);
        this.voiceRead = true;
      } catch (error) {
        // Without it replies are plainer, not wrong: the look goes on.
        this.log(`[notch] the owner's own mail could not be read for their voice: ${error instanceof Error ? error.message.slice(0, 120) : 'no answer'}`);
      }
    }
    const rows = kind === 'glance' ? await reader.list(MAIL_RECENT_DAYS, 1) : await reader.list(kind === 'sweep' ? MAIL_SWEEP_DAYS : MAIL_RECENT_DAYS);
    look.listed = rows.length;
    const now = this.now();

    // What to read: what the list says has changed and may matter, and what is due by the clock.
    // A reply that waits is checked the same way: its thread is read when the list shows it changed
    // (the owner answered by hand, or the other side wrote again), and not otherwise. A thread whose
    // reply the notch is writing or sending right now is left alone until that is over.
    const heldThreads = new Set([...this.held].map((id) => id.split(':')[0]!));
    const waitingReply = new Map(store.ready().map((row) => [row.thread, row]));
    const due = new Set(store.due(now));
    const wanted = new Map<string, MailListed>();
    for (const row of rows) {
      if (heldThreads.has(row.id)) continue;
      const seen = store.seen(row.id);
      const changed = seen?.signature !== mailSignature(row);
      const reply = waitingReply.get(row.id);
      if (reply && row.draft) {
        // A draft of the owner's own in it: they have begun their answer. Known from the list alone.
        if (store.move(reply.id, 'ready', 'answered', now)) look.overtaken++;
        store.saw(row.id, mailSignature(row), now, null);
        continue;
      }
      if ((changed && (mailCandidate(row, owner) || reply)) || due.has(row.id)) wanted.set(row.id, row);
      // It was being followed and is no candidate any more (the owner wrote last): nothing is due in it now.
      else if (seen && changed) store.saw(row.id, mailSignature(row), now, null);
    }
    if (kind === 'sweep') {
      // A full look takes nothing on trust: every reply that waits is checked against its thread.
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const reply of waitingReply.values()) {
        if (heldThreads.has(reply.thread) || wanted.has(reply.thread) || store.proposal(reply.id)?.state !== 'ready') continue;
        wanted.set(reply.thread, byId.get(reply.thread) ?? { id: reply.thread, people: [], count: 0, draft: false, subject: reply.subject });
      }
    }

    // The newest first, a few at a time, and a reply prepared as soon as a thread is found to need
    // one: the first replies are ready within a minute of a look that has a month to go through.
    let calendar: MailCalendarEvent[] | null | undefined;
    const order = [...wanted.values()];
    for (let at = 0; at < order.length; at += MAIL_READ_BATCH) {
      if (this.deps.paused?.()) break;
      const batch = order.slice(at, at + MAIL_READ_BATCH);
      const threads = await reader.read(batch);
      look.read += threads.length;
      const asking: { thread: MailThread; row: MailListed; last: MailThread['messages'][number] }[] = [];
      for (const read of threads) {
        const row = wanted.get(read.id)!;
        // A row made up for a reply that waits says nothing of the list: nothing is remembered from it.
        const listed = row.people.length > 0;
        const thread: MailThread = { ...read, ...(row.draft ? { draft: true } : {}), ...(row.filed ? { filed: row.filed } : {}) };
        this.remember(thread, owner);
        const waiting = mailWaiting(thread, owner, now, wait);
        const last = thread.messages.at(-1);
        if (!waiting.waits) {
          look.overtaken += store.overtake(thread.id, null, now).length;
          const dueAt = waiting.why === 'too-new' && last ? last.at + wait : null;
          if (listed) store.saw(thread.id, mailSignature(row), now, dueAt);
          continue;
        }
        const id = mailProposalId(thread.id, waiting.last.at);
        look.overtaken += store.overtake(thread.id, id, now).length;
        if (store.proposal(id)) {
          this.checked.set(id, this.now());
          if (listed) store.saw(thread.id, mailSignature(row), now, null);
          continue;
        }
        asking.push({ thread, row, last: waiting.last });
      }
      for (let from = 0; from < asking.length; from += MAIL_PROPOSE_PARALLEL) {
        if (this.deps.paused?.()) break;
        if (calendar === undefined) calendar = (await this.deps.calendar?.(now, now + MAIL_CALENDAR_AHEAD_MS).catch(() => null)) ?? null;
        const round = asking.slice(from, from + MAIL_PROPOSE_PARALLEL);
        const made = await Promise.all(round.map((entry) => this.prepare(entry.thread, entry.last, owner, calendar ?? null)));
        for (const [index, row] of made.entries()) {
          look.asked++;
          // The model could not be reached: the thread is not marked as seen, and a later look asks again.
          if (!row) continue;
          const entry = round[index]!;
          store.put(row);
          if (entry.row.people.length > 0) store.saw(entry.thread.id, mailSignature(entry.row), this.now(), null);
          if (row.state === 'ready') { look.prepared++; this.checked.set(row.id, this.now()); this.deps.changed?.(); }
        }
      }
    }
    if (look.overtaken) this.deps.changed?.();
    await this.fillAbout(reader, owner).catch(() => {});
    return look;
  }

  /**
   * Replies that were prepared before replies carried a sentence about their
   * thread get one: a few each look, so that the owner knows what they are
   * answering. A reply whose thread cannot be read now keeps none, and is
   * shown without it.
   */
  private async fillAbout(reader: MailReader, owner: MailOwner): Promise<void> {
    const without = this.deps.store.ready().filter((row) => !row.about && !this.held.has(row.id) && !this.aboutTried.has(row.id)).slice(0, MAIL_ABOUT_PER_LOOK);
    if (without.length === 0 || this.deps.paused?.()) return;
    const threads = await reader.read(without.map((row) => ({ id: row.thread, people: [], count: 0, draft: false, subject: row.subject })));
    let filled = 0;
    for (const row of without) {
      // Asked once since the brain started, whatever comes of it: a model that gives none is not asked every minute.
      this.aboutTried.add(row.id);
      const thread = threads.find((entry) => entry.id === row.thread);
      if (!thread) continue;
      const thought = await this.deps.think(mailAboutMessages({ thread, owner, ownerName: this.ownerName || [...owner][0]!.split('@')[0]!, zone: this.deps.zone }), { maxTokens: 120 }).catch(() => null);
      const about = thought ? parseMailAbout(thought.content) : '';
      const now = this.deps.store.proposal(row.id);
      if (!now || now.state !== 'ready') continue;
      this.deps.store.put({ ...now, about, tokensIn: now.tokensIn + (thought ? thought.input + thought.cached : 0), tokensOut: now.tokensOut + (thought?.output ?? 0) });
      if (about) filled++;
    }
    if (filled) this.deps.changed?.();
  }

  /** Keeps a thread the owner wrote in, for their voice, and learns what they are called. */
  private remember(thread: MailThread, owner: MailOwner): void {
    const mine = thread.messages.filter((message) => isOwner(message.from, owner));
    if (mine.length === 0) return;
    this.voice.delete(thread.id);
    this.voice.set(thread.id, thread);
    if (this.voice.size > MAIL_VOICE_POOL) this.voice.delete(this.voice.keys().next().value as string);
    const named = mine.find((message) => message.from.name);
    if (named) this.ownerName = mailFirstName(named.from);
  }

  /** Threads read for the owner's voice alone: their own sent mail. */
  learnVoice(threads: MailThread[], owner: MailOwner): void {
    for (const thread of threads) this.remember(thread, owner);
  }

  /** One message put to the model. Null when the model could not be reached: it is asked again by a later look. */
  private async prepare(thread: MailThread, last: MailThread['messages'][number], owner: MailOwner, calendar: MailCalendarEvent[] | null): Promise<MailProposalRow | null> {
    const at = this.now();
    const ownerName = this.ownerName || [...owner][0]!.split('@')[0]!;
    let made: { proposal: MailProposal | null; cost: { model: string; input: number; output: number; cached: number } };
    try {
      made = await proposeMail({
        thread,
        owner,
        ownerName,
        samples: mailVoiceSamples([...this.voice.values()], owner, { thread: thread.id, to: last.from.address, before: at }),
        ...(calendar ? { calendar } : {}),
        now: at,
        zone: this.deps.zone,
      }, this.deps.think);
    } catch (error) {
      this.log(`[notch] a reply could not be prepared: ${error instanceof Error ? error.message.slice(0, 160) : 'the model did not answer'}`);
      return null;
    }
    const { proposal, cost } = made;
    const { to, cc } = mailReplyTo(last, owner);
    const row: MailProposalRow = {
      id: mailProposalId(thread.id, last.at),
      thread: thread.id,
      messageAt: last.at,
      state: !proposal ? 'failed' : proposal.needsReply ? 'ready' : 'silent',
      who: last.from,
      subject: thread.subject,
      to,
      cc,
      draft: proposal?.reply ?? '',
      time: proposal?.time ?? null,
      missing: proposal?.missing ?? '',
      lookFor: proposal?.lookFor ?? '',
      found: null,
      tone: '',
      told: '',
      about: proposal?.about ?? '',
      model: cost.model,
      tokensIn: cost.input + cost.cached,
      tokensOut: cost.output,
      createdAt: at,
      updatedAt: at,
      sentAt: null,
    };
    // The reply named a file it did not have: it is looked for before anyone is told it is missing.
    if (row.state === 'ready' && row.lookFor && this.deps.files) {
      const found = await this.deps.files(row.lookFor).catch(() => null);
      if (found) row.found = found.slice(0, 4);
    }
    return row;
  }

  /**
   * The reply for a message written again, for the thread as it stands: in
   * another manner ("shorter", "more formal"), or with what the owner told
   * Jarvis after it said what it did not know. What is not changed stays as
   * it was asked before. Null when the thread has moved on or the model gave
   * nothing: the reply that was there stays.
   */
  async redraft(id: string, change: { tone?: string; told?: string }): Promise<MailProposalRow | null> {
    const row = this.deps.store.proposal(id);
    const way = row?.state === 'ready' ? await this.deps.reader() : null;
    if (!row || !way) return null;
    const owner: MailOwner = new Set([(await way.reader.owner()).toLowerCase()]);
    const [thread] = await way.reader.read([{ id: row.thread, people: [], count: 0, draft: false, subject: row.subject }]);
    const last = thread?.messages.at(-1);
    if (!thread || !last || last.at !== row.messageAt || isOwner(last.from, owner)) return null;
    const at = this.now();
    const tone = change.tone ?? row.tone;
    const told = mailTold(change.told ?? row.told);
    const calendar = (await this.deps.calendar?.(at, at + MAIL_CALENDAR_AHEAD_MS).catch(() => null)) ?? null;
    const made = await proposeMail({
      thread,
      owner,
      ownerName: this.ownerName || [...owner][0]!.split('@')[0]!,
      samples: mailVoiceSamples([...this.voice.values()], owner, { thread: thread.id, to: last.from.address, before: at }),
      ...(calendar ? { calendar } : {}),
      now: at,
      zone: this.deps.zone,
      manner: tone,
      ...(told ? { told } : {}),
    }, this.deps.think).catch(() => null);
    const spent = made?.cost ?? { model: row.model, input: 0, output: 0, cached: 0 };
    const next: MailProposalRow = {
      ...row,
      tokensIn: row.tokensIn + spent.input + spent.cached,
      tokensOut: row.tokensOut + spent.output,
      updatedAt: at,
      ...(made?.proposal?.needsReply ? { draft: made.proposal.reply, time: made.proposal.time, missing: made.proposal.missing, tone, told, about: made.proposal.about || row.about } : {}),
    };
    this.deps.store.put(next);
    return made?.proposal?.needsReply ? next : null;
  }

  /**
   * Is the reply still an answer to the last word in its thread? Read from
   * the mailbox now. False when the thread has moved on (and the reply is
   * marked so), true when it still waits, null when the mailbox cannot be
   * reached: then nothing is known and nothing is changed.
   */
  async stillWaits(id: string, fresh = MAIL_CHECKED_FRESH_MS): Promise<boolean | null> {
    const row = this.deps.store.proposal(id);
    if (!row || row.state !== 'ready') return false;
    // Seen to wait a moment ago: the mailbox is not asked again for a line that only has to come up.
    if (this.now() - (this.checked.get(id) ?? -Infinity) < fresh) return true;
    const way = await this.deps.reader().catch(() => null);
    if (!way) return null;
    try {
      // Whose mailbox it is was learned by the first look: one question to the mailbox, not two.
      if (!this.ownerAddress) this.ownerAddress = (await way.reader.owner()).toLowerCase();
      const owner: MailOwner = new Set([this.ownerAddress]);
      const [thread] = await way.reader.read([{ id: row.thread, people: [], count: 0, draft: false, subject: row.subject }]);
      if (!thread) return null;
      const last = thread.messages.at(-1);
      if (last && last.at === row.messageAt && !isOwner(last.from, owner)) { this.checked.set(id, this.now()); return true; }
      if (this.deps.store.move(id, 'ready', 'answered', this.now())) this.deps.changed?.();
      return false;
    } catch {
      return null;
    }
  }
}
