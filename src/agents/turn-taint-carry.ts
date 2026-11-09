/**
 * Carry a text turn's taint into the next turn when that turn is only a bare
 * "yes" (owner decision 2026-11-06, the text and one-shot counterpart of
 * #1156 for realtime voice).
 *
 * A text turn's taint is per turn (authority/taint-gating.ts): a message
 * from the person starts clean. That left one known gap: a page read in one
 * turn can have the assistant end with "shall I run it?", and the person's
 * "yes" was a new, clean turn, so what the page proposed ran without a card.
 * Now each chat remembers what its last turn ran under, and a turn whose
 * message is a bare affirmation (`isBareAffirmation`, the realtime matcher,
 * shared on purpose) starts with those marks instead of clean. Any message
 * with a word of its own starts clean exactly as before.
 *
 * Bounds:
 * - One turn back. A bare yes inherits only the record of the turn just
 *   before it in the same chat. A turn records everything it ran under,
 *   carried marks included, so "yes", "yes" stays tainted until the person
 *   says what they want, as a bare yes never clears realtime session taint.
 *   The accepted residual of that bound: a question of their own in between
 *   ("what does it do?") answered without reading anything records clean,
 *   and the yes after it runs clean.
 * - Per chat. The key is the channel plus the chat's own context key (a site
 *   project, a Brief conversation, a channel thread); see `taintCarryKey`.
 *   Nothing carries across channels or threads. In a thread several senders
 *   share, the previous turn may be another sender's; it is carried, which is
 *   the fail-closed direction.
 * - Memory only, bounded (`MAX_TAINT_CARRY_CHATS`, least recently used
 *   dropped first). A daemon restart drops every record, and the first bare
 *   yes after it runs clean: an accepted residual. So does a chat evicted by
 *   that bound, which takes that many other chats used since.
 * - Overlapping turns in one chat (two tabs) do not let a clean one erase a
 *   tainted one: a turn that closes after another turn of its chat closed
 *   during its run merges its marks into the record instead of replacing it.
 *
 * The record is all of the turn's marks, declined intents (Q-08) included, as
 * the realtime session keeps them: a yes does not walk around a denied card.
 */

import { isBareAffirmation } from './realtime-taint.ts';

/**
 * Chats remembered at once. Only owner turns open a link (a guest's turn has
 * no tools), so the keys are the owner's own chats: the dashboard, each site
 * project and Brief conversation they used, each channel thread of theirs, the
 * Pebble, plus one for the daemon's own `system` turns (event reactions and
 * commitments; their prompts are never a bare yes, so they only record). Measured with bun:jsc heapStats after a forced GC: 1000 entries of
 * a channel-thread key and three marks take 493 KiB (about 500 bytes each), so
 * the bound costs half a megabyte at worst and still holds far more chats than
 * one owner uses between restarts.
 */
export const MAX_TAINT_CARRY_CHATS = 1000;

/** One turn's handle on its chat's record. */
export interface TurnTaintLink {
  /** The marks this turn started with: the previous turn's, or none. */
  readonly carried: ReadonlySet<string>;
  /**
   * A taint set for one tool loop of this turn, seeded with `carried`. Its
   * marks count toward the turn's record when the turn closes. A router
   * turn opens one per task it runs, so concurrent tasks stay apart.
   */
  open(): Set<string>;
  /** End the turn: record what it ran under. Idempotent. */
  close(): void;
}

/** `closed`: the carry-wide close count when this record was written. */
type Entry = { marks: ReadonlySet<string>; closed: number };

export class TurnTaintCarry {
  private readonly chats = new Map<string, Entry>();
  /**
   * Closes so far, in every chat. One counter rather than one per chat, so an
   * entry dropped by the bound mid-turn cannot reset what a turn compares.
   */
  private closes = 0;
  /**
   * The loops of turns still running, per chat. A bare yes sent while a
   * tainted turn of its chat is still running (a second tab, or a reply that
   * supersedes it) has no record to read yet, so it takes what those loops
   * have read so far. Entries leave on close, so this holds only live turns.
   */
  private readonly running = new Map<string, Set<{ carried: ReadonlySet<string>; loops: Set<string>[] }>>();

  constructor(private readonly limit = MAX_TAINT_CARRY_CHATS) {}

  /** Begin a turn in `key` whose message from the person is `message`. */
  begin(key: string, message: string): TurnTaintLink {
    const entry = this.chats.get(key);
    const closesAtOpen = this.closes;
    const carried = new Set<string>();
    if (isBareAffirmation(message)) {
      for (const mark of entry?.marks ?? []) carried.add(mark);
      for (const other of this.running.get(key) ?? []) {
        for (const mark of other.carried) carried.add(mark);
        for (const loop of other.loops) for (const mark of loop) carried.add(mark);
      }
    }
    const loops: Set<string>[] = [];
    const self = { carried, loops };
    const live = this.running.get(key) ?? new Set<typeof self>();
    live.add(self);
    this.running.set(key, live);
    let closed = false;
    return {
      carried,
      open: () => {
        const set = new Set(carried);
        loops.push(set);
        return set;
      },
      close: () => {
        if (closed) return;
        closed = true;
        live.delete(self);
        if (live.size === 0 && this.running.get(key) === live) this.running.delete(key);
        const marks = new Set(carried);
        for (const loop of loops) for (const mark of loop) marks.add(mark);
        this.record(key, marks, closesAtOpen);
      },
    };
  }

  /** What `key`'s last turn ran under (for tests and diagnostics). */
  last(key: string): ReadonlySet<string> {
    return new Set(this.chats.get(key)?.marks ?? []);
  }

  private record(key: string, marks: Set<string>, closesAtOpen: number): void {
    const entry = this.chats.get(key);
    // Another turn of this chat closed while this one ran: keep its marks too.
    if (entry && entry.closed > closesAtOpen) for (const mark of entry.marks) marks.add(mark);
    this.chats.delete(key);
    this.chats.set(key, { marks, closed: ++this.closes });
    while (this.chats.size > this.limit) {
      const oldest = this.chats.keys().next().value as string;
      this.chats.delete(oldest);
    }
  }
}

/**
 * The chat a turn belongs to: its channel, plus its own context key when it
 * has one (`site:<id>`, `brief:<id>`, a channel thread's key). The channel is
 * always part of it, so two channels never share a record.
 */
export function taintCarryKey(channel: string, contextKey?: string | null): string {
  return JSON.stringify([channel, contextKey ?? null]);
}
