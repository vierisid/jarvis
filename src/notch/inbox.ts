/**
 * What waits for the person, and whose turn it is on the notch.
 *
 * Everything real that wants the person's answer is an item here: an
 * approval, a promise about to be kept, a question, a failure to be told.
 * The inbox decides when each is on the notch. Its rules are the notch's
 * manners, and they are the same for every kind of item:
 *
 *   - One item per subject. A second about the same thing takes the first's
 *     place: it does not stand beside it.
 *   - The count is how many wait, not counting the one on the notch.
 *   - An item speaks up once, when it arrives, and only if the notch is free
 *     then. Otherwise it joins the count and says nothing. Two exceptions:
 *     one that arrived while no notch was up speaks when one comes up, and
 *     one that is urgent (a window to act in is already running) takes the
 *     notch from whatever has it.
 *   - A line that is turned down, or left alone until it folds, goes back to
 *     the count. Not now is never no.
 *   - Yes at rest starts a round: what waits is gone through one by one, a
 *     person first, then what runs on a clock, then the rest, each once. A
 *     round ends on the list of what still waits.
 *   - Before an item is shown it is asked whether it is still true. One that
 *     is not leaves the count without a word.
 *   - Something the person started and is waiting on (an instruction that is
 *     running) gets the notch back after an urgent thing took it.
 *
 * An item plays itself: it is a small script on a stage (./stage.ts), so what
 * a yes means stays with the thing that knows (an approval decides itself
 * through the product's own decision function, and so on). The inbox never
 * learns what any item is about.
 */
import type { NotchBlock, NotchPart } from './protocol.ts';
import { NotchStage, NotchStageEnded, realNotchClock } from './stage.ts';
import type { NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';

/** Who or what is waiting: this is the order of a round. */
export type NotchItemClass = 'person' | 'clock' | 'rest';

const RANK: Record<NotchItemClass, number> = { person: 0, clock: 1, rest: 2 };

/** What became of an item after it was on the notch. */
export type NotchItemEnd = 'settled' | 'waits';

export interface NotchItem {
  /** Names the item. Stable for as long as the thing it stands for exists. */
  id: string;
  /** What it is about. Only one item per subject waits. */
  subject: string;
  class: NotchItemClass;
  /** Speaks up when it arrives, if the notch is free. Without this it only joins the count. */
  speaks?: boolean;
  /**
   * It cannot wait for the notch to be free: a window to act in is already
   * running. It takes the place of whatever is on the notch, which goes back
   * to the count.
   */
  urgent?: boolean;
  /** Said once and then gone, whatever the person does: news, not a question. */
  once?: boolean;
  /**
   * The person started it (they asked, or are speaking): its first line can
   * be answered at once, with none of the moment a line that came by itself
   * is given.
   */
  asked?: boolean;
  /**
   * It is under way and the person is waiting on it: when something urgent
   * takes its place on the notch, it gets the notch back when that is over.
   */
  returns?: boolean;
  /** One line for the list of what waits. */
  title(): NotchPart[];
  /** Is it still true? Asked each time before it is shown. */
  check?(): boolean | Promise<boolean>;
  /**
   * Plays the item on the notch. `unasked` says it is speaking up by itself
   * and not in a round. Comes back `settled` when it no longer waits, `waits`
   * when it goes back to the count.
   */
  play(stage: NotchStage, how: { unasked: boolean }): Promise<NotchItemEnd>;
}

export interface NotchInboxOptions {
  clock?: NotchClock;
  log?: (line: string) => void;
  /** Something else has the notch for now (the demo). Nothing here shows or answers while it does. */
  busy?: () => boolean;
  /** What yes at rest opens when nothing waits. */
  home?: (stage: NotchStage) => Promise<void>;
}

interface Entry {
  item: NotchItem;
  /** Arrival order. Kept when an item is replaced by another on the same subject. */
  seq: number;
  /** It would have spoken up when it arrived, but no notch was up to speak on. */
  missed?: boolean;
}

interface Round {
  /** Ids already shown in this round: each item once. */
  seen: Set<string>;
}

interface Playing {
  /** Null for what is not an item: home, and the list of what waits. */
  entry: Entry | null;
  stage: NotchStage;
  round: Round | null;
  /** What the script asked to have played when it has ended. */
  then?: Entry;
}

export class NotchInbox {
  private entries: Entry[] = [];
  private seq = 0;
  private plays = 0;
  private playing: Playing | null = null;
  private shownCount = -1;
  private readonly holds = new Set<string>();
  private opener: (() => boolean) | null = null;
  private readonly clock: NotchClock;
  private readonly log: (line: string) => void;

  constructor(private readonly surface: NotchSurface, private readonly options: NotchInboxOptions = {}) {
    this.clock = options.clock ?? realNotchClock;
    this.log = options.log ?? ((line) => console.log(line));
    surface.onAnswer((answer, from) => { this.playing?.stage.heard(answer, from); });
    surface.onOpen(() => { this.opened(); });
    surface.onHello(() => { this.cameUp(); });
  }

  /**
   * Something new waits. An item on the same subject is replaced; if that one
   * was on the notch, the new one takes its turn there.
   */
  add(item: NotchItem): void {
    const at = this.entries.findIndex((entry) => entry.item.subject === item.subject || entry.item.id === item.id);
    let entry: Entry;
    let wasPlaying: Playing | null = null;
    if (at >= 0) {
      const old = this.entries[at]!;
      entry = { item, seq: old.seq };
      this.entries[at] = entry;
      // Whoever was going to hand the notch back to the old one hands it to this one.
      if (this.playing?.then === old) this.playing.then = entry;
      if (this.playing?.entry === old) wasPlaying = this.halt();
    } else {
      entry = { item, seq: ++this.seq };
      this.entries.push(entry);
    }
    if (wasPlaying) {
      this.start(entry, { unasked: wasPlaying.round === null }, wasPlaying.round);
      return;
    }
    if (item.speaks && this.free()) { this.start(entry, { unasked: true }, null); return; }
    if (item.speaks && item.urgent && this.playing && this.canShow()) {
      // A yes that is burning its fuse is not interrupted: the urgent thing
      // speaks the moment that is over.
      if (this.playing.stage.burning()) { entry.missed = true; this.pushCount(); return; }
      const was = this.halt();
      this.start(entry, { unasked: true }, null);
      // The notch goes back to what was waited on: the thing just replaced if
      // it is such a thing, otherwise whatever that one was going to hand back to.
      const back = was?.entry?.item.returns ? was.entry : was?.then;
      if (back && back !== entry && this.entries.includes(back) && this.playing?.entry === entry) this.playing.then = back;
      return;
    }
    // No notch was up, or everything was held: it gets its say when that ends.
    if (item.speaks && (this.surface.listening() === 0 || this.holds.size > 0)) entry.missed = true;
    this.pushCount();
  }

  /**
   * A notch has come up, or a hold has ended. Of what arrived in the
   * meantime, one gets its say now: an urgent one first, then the oldest.
   * The others had the same chance and are in the count.
   */
  private cameUp(): void {
    this.shownCount = -1;
    if (!this.free()) { this.pushCount(); return; }
    const missed = this.entries.filter((entry) => entry.missed).sort((a, b) => Number(b.item.urgent ?? false) - Number(a.item.urgent ?? false) || a.seq - b.seq);
    for (const entry of missed) entry.missed = false;
    const first = missed[0];
    if (first) { this.start(first, { unasked: true }, null); return; }
    this.pushCount();
  }

  /** Nothing forbids showing: no hold, nothing else has the notch, and a page is up. */
  private canShow(): boolean {
    return this.holds.size === 0 && !this.options.busy?.() && this.surface.listening() > 0;
  }

  /** The thing `id` stood for is over (decided elsewhere, gone, done). True if it was waiting. */
  remove(id: string): boolean {
    const at = this.entries.findIndex((entry) => entry.item.id === id);
    if (at < 0) return false;
    const [entry] = this.entries.splice(at, 1);
    if (this.playing?.entry === entry) {
      // The line leaves by itself. In a round, the next one comes.
      const was = this.halt();
      if (was?.round && this.next(was.round)) return true;
    }
    this.pushCount();
    return true;
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.item.id === id);
  }

  /** What waits, in the order a round would take it. Includes the one on the notch. */
  waiting(): NotchItem[] {
    return this.ordered().map((entry) => entry.item);
  }

  /** The number beside the eyes: what waits, not counting what is on the notch. */
  count(): number {
    const shown = this.playing?.entry;
    return this.entries.length - (shown && this.entries.includes(shown) ? 1 : 0);
  }

  /** The id of the item on the notch now, or null. */
  showing(): string | null {
    return this.playing?.entry?.item.id ?? null;
  }

  /**
   * Keeps everything in the count for as long as `reason` holds: nothing
   * speaks up, and what is on the notch goes back to waiting.
   */
  hold(reason: string): void {
    this.holds.add(reason);
    if (this.playing) {
      this.halt();
      this.pushCount();
    }
  }

  release(reason: string): void {
    if (!this.holds.delete(reason)) return;
    if (this.holds.size === 0) this.cameUp();
  }

  /**
   * While set, a yes or a click at rest goes to `opener` first. If it answers
   * true the inbox does nothing more with it. This is how "asleep" wakes.
   */
  setOpener(opener: (() => boolean) | null): void {
    this.opener = opener;
  }

  /** Says the count again, whatever was said before. For after something else had the notch. */
  refresh(): void {
    this.shownCount = -1;
    this.pushCount();
  }

  /** Puts a script that is not an item on the notch, if the notch is free. True if it started. */
  present(name: string, script: (stage: NotchStage) => Promise<void>): boolean {
    if (this.playing || this.options.busy?.() || this.surface.current().line) return false;
    this.run({ entry: null, stage: this.stage(name, false), round: null }, async (stage) => {
      await script(stage);
      return 'waits';
    });
    return true;
  }

  private free(): boolean {
    return !this.playing && this.canShow() && this.surface.current().line === null;
  }

  private ordered(): Entry[] {
    return [...this.entries].sort((a, b) => RANK[a.item.class] - RANK[b.item.class] || a.seq - b.seq);
  }

  private stage(name: string, unasked: boolean): NotchStage {
    // The play number keeps the ids of one showing apart from those of the
    // next: an answer to the first must never be taken for one to the second.
    const safe = name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    return new NotchStage(this.surface, this.clock, `${safe}-${++this.plays}`, { prefix: 'item', unasked });
  }

  private start(entry: Entry, how: { unasked: boolean }, round: Round | null): void {
    entry.missed = false;
    this.run({ entry, stage: this.stage(entry.item.id, how.unasked && entry.item.asked !== true), round }, async (stage) => {
      if (entry.item.check && !(await entry.item.check())) return 'gone';
      if (stage.ended()) throw new NotchStageEnded();
      return entry.item.play(stage, how);
    });
  }

  private run(playing: Playing, script: (stage: NotchStage) => Promise<NotchItemEnd | 'gone'>): void {
    this.playing = playing;
    this.pushCount();
    script(playing.stage).then(
      (end) => { this.finished(playing, end); },
      (error: unknown) => {
        // Cut short by something else taking the notch: it has not had its say.
        if (error instanceof NotchStageEnded) { this.finished(playing, 'cut'); return; }
        const what = playing.entry ? `"${playing.entry.item.id}"` : 'a notch script';
        this.log(`[notch] ${what} failed on the notch: ${error instanceof Error ? error.message : String(error)}`);
        this.finished(playing, 'waits');
      },
    );
  }

  /** `cut`: its stage was ended under it. Any other end is the script's own conclusion. */
  private finished(playing: Playing, end: NotchItemEnd | 'gone' | 'cut'): void {
    const entry = playing.entry;
    // What the script concluded holds, whoever has the notch by now: an item
    // that settled is out of the count, and news that was said is not said
    // again. Only one that was cut short keeps its place.
    const over = end === 'settled' || end === 'gone' || (end === 'waits' && entry?.item.once === true);
    if (entry && over) {
      const at = this.entries.indexOf(entry);
      if (at >= 0) this.entries.splice(at, 1);
    }
    // Halted, or replaced: whoever did that has already said what comes next.
    if (this.playing !== playing) {
      if (entry && over) this.pushCount();
      return;
    }
    this.playing = null;
    playing.stage.stop();
    // What comes next takes the line's place directly. Going back to the eyes
    // in between would make the notch shrink and grow again for nothing.
    if (playing.round && this.next(playing.round)) return;
    const then = playing.then;
    if (then && this.entries.includes(then) && this.holds.size === 0) {
      this.start(then, { unasked: false }, null);
      return;
    }
    this.clear(playing.stage);
    // Something that could not speak while this was up (it arrived during a
    // fuse) speaks now.
    if (this.entries.some((waiting) => waiting.missed)) { this.cameUp(); return; }
    this.pushCount();
  }

  /** Takes what is playing off the notch, now. Returns what it was. */
  private halt(): Playing | null {
    const playing = this.playing;
    if (!playing) return null;
    this.playing = null;
    playing.stage.stop();
    this.clear(playing.stage);
    return playing;
  }

  /** Back to the eyes, if the line still on the notch is this stage's. */
  private clear(stage: NotchStage): void {
    const line = this.surface.current().line;
    if (line && stage.owns(line.id)) this.surface.rest();
  }

  private opened(): void {
    if (this.options.busy?.()) return;
    if (this.playing) { this.playing.stage.wasOpened(); return; }
    if (this.surface.current().line) return;
    if (this.opener?.()) return;
    if (this.holds.size > 0) return;
    if (this.entries.length > 0 && this.next({ seen: new Set() })) return;
    const home = this.options.home;
    if (home) this.present('home', home);
  }

  /** Shows what a round shows next. False when the round is over with nothing left to show. */
  private next(round: Round): boolean {
    if (this.holds.size > 0) return false;
    const entry = this.ordered().find((candidate) => !round.seen.has(candidate.item.id));
    if (entry) {
      round.seen.add(entry.item.id);
      this.start(entry, { unasked: false }, round);
      return true;
    }
    if (this.entries.length === 0) return false;
    this.list();
    return true;
  }

  /** Where a round ends: what still waits, each a row that can be opened. */
  private list(): void {
    const entries = this.ordered();
    const blocks: NotchBlock[] = entries.map((entry) => ({ kind: 'row', id: entry.item.id, say: entry.item.title(), go: true }));
    const n = entries.length;
    const playing: Playing = { entry: null, stage: this.stage('waiting', false), round: null };
    this.run(playing, async (stage) => {
      const answer = await stage.sheet([n === 1 ? '1 thing still waits' : `${n} things still wait`], blocks);
      // Opening a row plays that item, once this script has ended: only one
      // thing is on the notch at a time.
      if (answer.act === 'go') playing.then = this.entries.find((entry) => entry.item.id === answer.row);
      return 'waits';
    });
  }

  private pushCount(): void {
    if (this.options.busy?.()) return;
    const count = this.count();
    if (count === this.shownCount) return;
    this.shownCount = count;
    this.surface.setCount(count);
  }
}
