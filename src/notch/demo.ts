/**
 * Canned moments for the notch, played by the brain through the same path a
 * real one takes: this module only calls NotchSurface, and listens to the
 * answers that come back from the page.
 *
 * It exists so the surface can be tried by hand before anything real feeds it
 * (`jarvis notch demo <moment>`). Every sentence here is sample data. No moment
 * reads or changes anything outside the notch.
 *
 * One moment plays at a time. Starting another replaces the one running.
 */
import type { NotchAnswer, NotchSurface } from './surface.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart, NotchWord } from './protocol.ts';
import { NOTCH_BIRTHS, NOTCH_GESTURES, NOTCH_LIPS, NOTCH_MOODS } from './protocol.ts';

/** Thrown inside a moment when another takes its place. */
class Replaced extends Error {}

export interface NotchDemoClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: NotchDemoClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type LineExtras = Partial<Pick<NotchLine, 'mood' | 'mark' | 'who' | 'src' | 'arrive'>>;

/** How long past its time a line is waited for before the script goes on without the page's word. */
const LATE = 1500;

/** What a moment's script works with. */
class Stage {
  private n = 0;
  private stopped = false;
  private readonly timers = new Set<unknown>();
  private readonly waiters = new Set<{ take(answer: NotchAnswer): boolean; fail(): void }>();
  /**
   * Answers nobody was waiting for when they came. Two can arrive back to
   * back (a word changed, then yes), and the script is between two waits
   * when the second lands: it must still be there when the script asks.
   */
  private readonly unheard: NotchAnswer[] = [];
  private readonly openWaiters = new Set<{ done(): void; fail(): void }>();

  constructor(readonly surface: NotchSurface, private readonly clock: NotchDemoClock, private readonly name: string) {}

  /** A fresh id for the next line of this moment. */
  id(): string {
    return `demo-${this.name}-${++this.n}`;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const waiter of [...this.waiters]) waiter.fail();
    for (const waiter of [...this.openWaiters]) waiter.fail();
  }

  heard(answer: NotchAnswer): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.take(answer)) return;
    }
    this.unheard.push(answer);
    if (this.unheard.length > 50) this.unheard.shift();
  }

  wasOpened(): void {
    for (const waiter of [...this.openWaiters]) waiter.done();
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new Replaced()); return; }
      const timer = this.clock.setTimeout(() => {
        this.timers.delete(timer);
        if (this.stopped) reject(new Replaced()); else resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  /** The next answer about the line `id`, of one of `acts` when given. */
  answer(id: string, acts?: NotchAnswerAct[]): Promise<NotchAnswer> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new Replaced()); return; }
      const wanted = (answer: NotchAnswer): boolean => answer.id === id && (!acts || acts.includes(answer.act));
      const kept = this.unheard.findIndex(wanted);
      if (kept >= 0) { resolve(this.unheard.splice(kept, 1)[0]!); return; }
      const waiter = {
        take: (answer: NotchAnswer): boolean => {
          if (!wanted(answer)) return false;
          this.waiters.delete(waiter);
          resolve(answer);
          return true;
        },
        fail: (): void => { this.waiters.delete(waiter); reject(new Replaced()); },
      };
      this.waiters.add(waiter);
    });
  }

  /** The next click on the resting notch. */
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new Replaced()); return; }
      const waiter = {
        done: (): void => { this.openWaiters.delete(waiter); resolve(); },
        fail: (): void => { this.openWaiters.delete(waiter); reject(new Replaced()); },
      };
      this.openWaiters.add(waiter);
    });
  }

  /**
   * A result line. Comes back when it has left the notch: when the page says
   * so, or a little after its time if no page is there to say it.
   */
  async say(parts: NotchPart[], ms: number, extras: LineExtras = {}): Promise<void> {
    const id = this.id();
    this.surface.show({ id, kind: 'say', say: parts, ms, ...extras });
    await Promise.race([this.answer(id, ['done', 'yes']), this.wait(ms + LATE)]);
  }

  /** An offer. Comes back with what the person did with it. */
  offer(parts: NotchPart[], yes: string, extras: LineExtras & { fold?: number } = {}): Promise<NotchAnswer> {
    const id = this.id();
    this.surface.show({ id, kind: 'offer', say: parts, yes, ...extras });
    return this.answer(id, ['yes', 'no', 'fold']);
  }

  /** A row of choices. Comes back with the pick, or with no or fold. */
  choose(parts: NotchPart[], options: string[], extras: LineExtras = {}): Promise<NotchAnswer> {
    const id = this.id();
    this.surface.show({ id, kind: 'offer', say: parts, options, ...extras });
    return this.answer(id, ['pick', 'no', 'fold']);
  }

  /** A send with its window. True when it went out, false when it was taken back. */
  async send(parts: NotchPart[], ms: number, extras: LineExtras = {}): Promise<boolean> {
    const id = this.id();
    this.surface.show({ id, kind: 'send', say: parts, ms, ...extras });
    const answer = await Promise.race([this.answer(id, ['done', 'undo']), this.wait(ms + LATE)]);
    return answer?.act !== 'undo';
  }

  /**
   * Work in `steps` steps, one every `per` ms. Comes back with how many were
   * done: all of them, or fewer if the person asked it to stop.
   */
  async work(parts: NotchPart[], steps: number, per: number, extras: LineExtras & { canTalk?: boolean; from?: number } = {}): Promise<number> {
    const id = this.id();
    const { from = 0, ...rest } = extras;
    let stopAsked = false;
    this.answer(id, ['stop']).then(() => { stopAsked = true; }, () => {});
    this.surface.show({ id, kind: 'work', say: parts, steps, done: from, ...rest });
    for (let done = from + 1; done <= steps; done++) {
      await this.wait(per);
      if (stopAsked) return done - 1;
      this.surface.update(id, { done });
    }
    await this.wait(Math.min(per, 300));
    return stopAsked ? steps - 1 : steps;
  }
}

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options, ...more } });

const TONE2 = {
  firmly: ['firm', 'hard', 'strong', 'direct', 'blunt', 'tough', 'angry', 'serious'],
  politely: ['polite', 'nice', 'kind', 'soft', 'gentle', 'friendly', 'smile', 'calm'],
};
const TONE3 = {
  warm: ['friendly', 'kind', 'nice', 'soft', 'casual'],
  short: ['brief', 'quick', 'terse', 'direct', 'fast'],
  formal: ['polite', 'official', 'proper', 'serious', 'business'],
};
const SCHEDULES = ['Monday at 9:00', 'Monday at 14:00', 'Friday at 16:00', 'day at 9:00'];
const happy: LineExtras = { mood: 'happy', mark: 'check' };

type Moment = (s: Stage) => Promise<void>;

/** The reply to Marco, in each tone. `{when}` is where the time goes. */
const DRAFT: Record<string, string[]> = {
  warm: ['Hi Marco,', 'Sorry for the slow reply. The latest deck is attached.', 'Does {when} still work for you? Happy to walk you through it.', 'Sam'],
  short: ['Hi Marco,', 'Deck attached. {when} works for me.', 'Sam'],
  formal: ['Dear Marco,', 'Apologies for the delay. Please find the latest deck attached.', 'I can confirm {when} for our call.', 'Kind regards, Sam'],
};

function draftBlocks(tone: string, when: string): NotchBlock[] {
  const time = word('when', when, ['Thursday at 10:00', 'Thursday at 15:00', 'Friday at 10:00'], { label: 'Time', read: 'dayTime' });
  const lines = (DRAFT[tone] ?? DRAFT.warm!).map((text): NotchPart[] => {
    const at = text.indexOf('{when}');
    return at < 0 ? [text] : [text.slice(0, at), time, text.slice(at + '{when}'.length)];
  });
  return [
    { kind: 'paper', to: ['To ', em('Marco Bianchi'), '  ·  Re: Deck for Thursday?'], lines, file: { name: 'Deck, November.pdf', size: '2.4 MB' } },
    { kind: 'note', say: ['Not sent yet. Tone ', word('tone', tone, ['warm', 'short', 'formal'], { label: 'Tone', syn: TONE3 })] },
  ];
}

const MOMENTS: Record<string, Moment> = {
  /** A birth, the morning line, the count, and a sheet whose rows change. */
  async morning(s) {
    s.surface.act({ birth: 'run' });
    await s.wait(1400);
    let waiting = 2;
    s.surface.setCount(waiting);
    const first = await s.offer(['Morning. ', em('2 jobs'), ' done overnight. ', em('2'), ' need you.'], 'show');
    if (first.act !== 'yes') return;
    let day = 'Friday';
    const rows: Record<string, NotchBlock> = {
      nora: { kind: 'row', id: 'nora', lead: 'Nora', say: ['replied to 4 new leads'], small: '07:10', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
      otto: { kind: 'row', id: 'otto', lead: 'Otto', say: ['filed 2 invoices'], small: '07:32', buttons: [{ id: 'undo-otto', label: 'Undo', quiet: true }] },
      pay: {
        kind: 'row', id: 'pay', lead: 'Otto',
        say: ['wants to pay Brightline ', em('$1,200'), ' on ', word('day', day, ['Friday', 'Monday', 'today'], { label: 'Day', read: 'day' })],
        buttons: [{ id: 'pay', label: 'Pay', key: 1 }, { id: 'notyet', label: 'Not yet', key: 2 }],
      },
      lang: {
        kind: 'row', id: 'lang', lead: 'Nora', say: ['needs one thing. Reply to Lumen Studio in which language?'],
        buttons: [{ id: 'en', label: 'English' }, { id: 'it', label: 'Italian' }],
      },
    };
    const blocks = (): NotchBlock[] => [rows.nora!, rows.otto!, rows.pay!, rows.lang!];
    const id = s.id();
    s.surface.show({ id, kind: 'sheet', say: ['Overnight'], blocks: blocks(), mood: 'careful' });
    const settle = (row: string, lead: string, say: NotchPart[]): void => {
      rows[row] = { kind: 'row', id: row, lead, say };
      waiting = Math.max(0, waiting - 1);
      s.surface.setCount(waiting);
      s.surface.update(id, { blocks: blocks() });
    };
    for (;;) {
      const answer = await s.answer(id);
      if (answer.act === 'no') return;
      if (answer.act === 'word' && answer.word === 'day' && answer.value) day = answer.value;
      if (answer.act !== 'button') continue;
      if (answer.button === 'pay') settle('pay', 'Otto', ['will pay Brightline ', em('$1,200'), ` on ${day}. You get the receipt.`]);
      if (answer.button === 'notyet') settle('pay', 'Otto', ['is holding the Brightline payment until you say so.']);
      if (answer.button === 'en') settle('lang', 'Nora', ['will reply to Lumen Studio in ', em('English'), '.']);
      if (answer.button === 'it') settle('lang', 'Nora', ['will reply to Lumen Studio in ', em('Italian'), '.']);
      if (answer.button === 'undo') {
        rows.nora = { kind: 'row', id: 'nora', lead: 'Nora', say: ['took her 4 replies back. They are in your drafts.'], small: '07:10' };
        s.surface.update(id, { blocks: blocks() });
      }
      if (answer.button === 'undo-otto') {
        rows.otto = { kind: 'row', id: 'otto', lead: 'Otto', say: ['took the 2 invoices back out. Nothing was sent.'], small: '07:32' };
        s.surface.update(id, { blocks: blocks() });
      }
    }
  },

  /** A draft on paper with lit words, a send with its fuse, a check, a follow-up. */
  async mail(s) {
    const first = await s.offer(['You have not replied to ', em('Marco'), '. I drafted a reply.'], 'show', { src: 'mail' });
    if (first.act !== 'yes') return;
    let tone = 'warm';
    let when = 'Thursday at 10:00';
    const id = s.id();
    s.surface.show({ id, kind: 'sheet', say: ['Reply to ', em('Marco')], blocks: draftBlocks(tone, when), yes: 'send' });
    for (;;) {
      const answer = await s.answer(id);
      if (answer.act === 'no') return;
      if (answer.act === 'yes') break;
      if (answer.act !== 'word' || !answer.value) continue;
      if (answer.word === 'when') when = answer.value;
      // A new tone is a new letter, so the paper is written again.
      if (answer.word === 'tone') {
        tone = answer.value;
        s.surface.update(id, { blocks: draftBlocks(tone, when) });
      }
    }
    if (!(await s.send(['Sending to ', em('Marco'), '…'], 4200))) {
      await s.say(['Held. It stays in your drafts until you say so.'], 3000);
      return;
    }
    await s.say(['Sent to ', em('Marco'), '.'], 2400, happy);
    if (tone === 'warm') return;
    const always = await s.offer(['Always use a ', em(tone), ' tone with Marco?'], 'yes', { mood: 'curious' });
    if (always.act === 'yes') await s.say(['Remembered.'], 2400, happy);
  },

  /** Two lit words in one sentence: click them, or type your own. */
  async chase(s) {
    let howLong = 'once';
    const id = s.id();
    s.surface.show({
      id, kind: 'offer', yes: 'draft',
      say: ['Acme is ', em('9 days'), ' late on invoice 114. Chase ',
        word('tone', 'politely', ['politely', 'firmly'], { label: 'Tone', syn: TONE2 }), ', ',
        word('long', howLong, ['once', 'until it is paid'], { label: 'How long' }), '?'],
    });
    for (;;) {
      const answer = await s.answer(id);
      if (answer.act === 'no' || answer.act === 'fold') return;
      if (answer.act === 'word' && answer.word === 'long' && answer.value) howLong = answer.value;
      if (answer.act === 'yes') break;
    }
    if (howLong === 'once') {
      await s.say(['Reminder drafted. It is in your Gmail drafts.'], 3200, happy);
    } else {
      await s.say(['On it. I will come back when ', em('the payment of invoice 114'), ' is in, or if I am stuck.'], 4400, { mood: 'proud', mark: 'check' });
    }
  },

  /** Choices, then a send. */
  async slot(s) {
    const pick = await s.choose([em('Anna'), ' asked to move Thursday. Offer a slot?'], ['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30']);
    if (pick.act !== 'pick' || !pick.option) return;
    if (await s.send(['Offering ', em(pick.option), ' to Anna…'], 3400)) {
      await s.say(['Offered ', em(pick.option), ' to Anna.'], 2800, happy);
    } else {
      await s.say(['Nothing was offered.'], 2400);
    }
  },

  /** Work step by step, a stop with three ways on, then a new agent. */
  async sheets(s) {
    const first = await s.offer([em('9'), ' payouts left to paste. Shall I finish?'], 'finish', { src: 'sheets' });
    if (first.act !== 'yes') return;
    let done = await s.work(['Pasting payouts'], 9, 520, { mood: 'track', canTalk: true });
    while (done < 9) {
      const next = await s.choose(['Stopped at ', em(`${done} of 9`), '. What now?'], ['Go on', 'Undo it', 'Leave it']);
      if (next.act !== 'pick') return;
      if (next.option === 'Undo it') {
        await s.work(['Undoing my paste'], done, 260, { mood: 'work' });
        await s.say(['Undone. The sheet is as you left it.'], 2600);
        return;
      }
      if (next.option === 'Leave it') {
        await s.say([`Left at ${done} of 9.`], 2400);
        return;
      }
      done = await s.work(['Pasting payouts'], 9, 520, { mood: 'track', canTalk: true, from: done });
    }
    const again = await s.offer(
      ['Done. Do this every ', word('when', 'Monday at 9:00', SCHEDULES, { label: 'Schedule', read: 'sched' }), '?'], 'yes', happy);
    if (again.act !== 'yes') return;
    s.surface.act({ gesture: 'wink' });
    await s.say(
      ['Meet ', word('name', 'Tony', ['Tony', 'Mara', 'Enzo', 'Livia', 'Ada'], { label: 'Name', free: true }),
        ', a new agent. The first time, it shows you before it acts.'],
      7000, { mood: 'proud', mark: 'check' });
  },

  /** Something broke: an urgent arrival, a speaker, the red dot. */
  async fail(s) {
    const first = await s.offer([em('Otto'), ' stopped. Stripe wants you to sign in again.'], 'sign in',
      { mood: 'worried', mark: 'fail', who: 'Otto', arrive: 'urgent' });
    if (first.act !== 'yes') return;
    await s.work(['Opening Stripe sign-in'], 3, 620);
    await s.say([em('Otto'), ' is back. Nothing was missed.'], 3000, happy);
  },

  /** A result that only informs, then a promise kept, with a window to stop it. */
  async quiet(s) {
    await s.say([em('Nora'), ' replied to a new lead, ', em('Orbit Labs'), '.'], 3800, { mood: 'look', mark: 'check', who: 'Nora', arrive: 'hop' });
    await s.wait(900);
    if (await s.send(['17:00. I promised ', em('Anna'), ' the pricing. Sending it…'], 5200, { arrive: 'hop' })) {
      await s.say(['Sent to ', em('Anna'), ', as I said I would.'], 2800, happy);
    } else {
      await s.say(['Held. It stays in your drafts until you say so.'], 3000);
    }
  },

  /** A call: things are held on the edge, then a follow-up, then a round. */
  async call(s) {
    await s.say(['On a call. I hold everything until you are done.'], 3000, { mood: 'focus' });
    s.surface.act({ mood: 'focus' });
    await s.wait(1600);
    s.surface.act({ park: 1 });
    await s.wait(2400);
    s.surface.act({ park: 2 });
    await s.wait(2600);
    s.surface.act({ park: 0, gesture: 'wake' });
    await s.wait(1900);
    const first = await s.offer(['Call ended. ', em('3 actions'), ' came out of it. Follow-up drafted.'], 'show');
    if (first.act === 'yes') {
      const id = s.id();
      s.surface.show({
        id, kind: 'sheet', say: ['After the call with ', em('Anna')], yes: 'send',
        blocks: [
          { kind: 'paper', to: ['To ', em('Anna Rossi'), '  ·  Next steps'], lines: [['Hi Anna,'], ['Thanks for today. As agreed, pricing for 5 seats follows this week and the contract can start on 1 December.'], ['Sam']] },
          { kind: 'row', say: ['Send pricing for 5 seats'], small: 'Nora' },
          { kind: 'row', say: ['Draft the contract for 1 December'], small: 'you' },
          { kind: 'row', say: ['Book the kickoff call'], small: 'Jarvis' },
        ],
      });
      const answer = await s.answer(id, ['yes', 'no']);
      if (answer.act === 'yes' && await s.send(['Sending to ', em('Anna'), '…'], 3600)) {
        await s.say(['Sent. I held ', em('2 things'), ' during the call.'], 3400, happy);
      }
    }
    s.surface.rest();
    s.surface.setCount(2);
    // The round: a click on the resting notch goes through what waited.
    await s.opened();
    const add = await s.offer([em('In Gmail:'), ' ', em('Marco'), ' replied: Thursday works. Add it to your calendar?'], 'add', { src: 'mail' });
    s.surface.setCount(1);
    if (add.act === 'yes') await s.say(['Added. Thursday at 10:00 with Marco.'], 2600, happy);
    const demo = await s.choose([em('Orbit Labs'), ' asked for a demo. Offer a slot?'], ['Thursday at 16:00', 'Friday at 11:00']);
    s.surface.setCount(0);
    if (demo.act === 'pick' && demo.option) await s.say(['Offered ', em(demo.option), ' to Orbit Labs.'], 2600, happy);
    await s.say(['That is everything.'], 2400, { mood: 'happy' });
  },

  /** Not sure who was meant, then the end of the day. */
  async unsure(s) {
    let who = 'Anna Rossi';
    const id = s.id();
    s.surface.show({
      id, kind: 'offer', yes: 'yes', mood: 'confused',
      say: ['I heard "send the notes to Ana". Is that ', word('who', who, ['Anna Rossi', 'Ana Lima'], { label: 'Who', free: true }), '?'],
    });
    s.surface.act({ gesture: 'shrug' });
    for (;;) {
      const answer = await s.answer(id);
      if (answer.act === 'no' || answer.act === 'fold') return;
      if (answer.act === 'word' && answer.value) who = answer.value;
      if (answer.act === 'yes') break;
    }
    if (await s.send(['Sending the notes to ', em(who), '…'], 3400)) await s.say(['Sent to ', em(who), '.'], 2600, happy);
    await s.wait(900);
    let when = 'tomorrow at 9:00';
    const evening = s.id();
    s.surface.show({
      id: evening, kind: 'offer', yes: 'move', mood: 'sleepy',
      say: [em('1 thing'), " slipped today: Anna's contract. Move it to ",
        word('when', when, ['tomorrow at 9:00', 'Friday at 9:00', 'next week'], { label: 'Move to', read: 'dayTime' }), '?'],
    });
    for (;;) {
      const answer = await s.answer(evening);
      if (answer.act === 'no' || answer.act === 'fold') return;
      if (answer.act === 'word' && answer.value) when = answer.value;
      if (answer.act === 'yes') break;
    }
    await s.say(['Moved to ', em(when), '.'], 2800, { mood: 'sleepy', mark: 'check' });
  },

  /** Opening Jarvis: the text field, a sheet that opens another, and the way back. */
  async home(s) {
    const home = (): string => {
      const id = s.id();
      s.surface.show({
        id, kind: 'ask', say: [], yes: 'go', placeholder: 'Try: every Monday send Leo the Stripe numbers',
        blocks: [
          { kind: 'row', id: 'see', say: ['I see ', em('your desktop'), '.'], go: true },
          { kind: 'row', id: 'waiting', say: [em('2 things'), ' wait for you.'], go: true },
          { kind: 'row', id: 'done', say: [em('2 jobs'), ' done today.'], go: true },
          { kind: 'row', id: 'agents', say: [em('2 agents'), ' on duty.'], go: true },
          { kind: 'row', id: 'team', say: [em('Northwind'), ': you and ', em('Leo'), '.'], go: true },
          { kind: 'buttons', buttons: ['Memory', 'Goals', 'Connections', 'Dashboard', 'Give me a file'].map((label) => ({ id: label.toLowerCase(), label, quiet: true })) },
        ],
      });
      return id;
    };
    let id = home();
    for (;;) {
      const answer = await s.answer(id);
      if (answer.act === 'no') return;
      if (answer.act === 'ask' && answer.text) {
        await s.say([], 860, { mood: 'think' });
        await s.say(['You asked: ', em(answer.text), '. In this demo I only show that I heard it.'], 4200);
        return;
      }
      if (answer.act === 'button' && answer.button === 'memory') {
        // A long sheet: more than fits, so it scrolls.
        const memory = s.id();
        const things = [
          'Marco prefers a short tone.', 'Anna is at Orbit Labs since March.', 'Invoices go out on the 1st.', 'Brightline is paid on Fridays.',
          'The deck lives in the shared drive.', 'Calls with Anna are on Thursdays.', 'Leo covers support on Mondays.', 'Stripe payouts land on Tuesdays.',
          'Lumen Studio writes in Italian.', 'Acme pays late, usually by 9 days.', 'Pricing is per seat, 5 seats minimum.', 'The contract template is version 4.',
          'Nora answers new leads within the hour.', 'Otto files invoices every evening.', 'You do not take calls before 9:00.', 'Friday afternoons are kept free.',
          'The kickoff call takes 30 minutes.', 'Receipts are forwarded to the accountant.', 'Orbit Labs asked for a demo twice.', 'The newsletter goes out every other week.',
        ];
        s.surface.show({
          id: memory, kind: 'sheet', say: ['What I remember'],
          blocks: [
            ...things.map((text, i): NotchBlock => ({ kind: 'row', say: [text], small: `${i + 1}` })),
            { kind: 'note', say: ['You can tell me to forget any of these.'] },
          ],
        });
        await s.answer(memory, ['no']);
        id = home();
        continue;
      }
      if (answer.act === 'go' && answer.row === 'agents') {
        const agents = s.id();
        s.surface.show({
          id: agents, kind: 'sheet', say: ['Your agents'],
          blocks: [
            { kind: 'row', lead: 'Nora', say: ['Replies to new leads within the hour. ', word('nora', 'tells you after', ['asks first', 'tells you after', 'acts alone'], { label: 'Freedom' })] },
            { kind: 'row', lead: 'Otto', say: ['Files invoices and lines up payments. ', word('otto', 'asks first', ['asks first', 'tells you after', 'acts alone'], { label: 'Freedom' })] },
            { kind: 'note', say: ['Their workflows live in the dashboard. Here you see what they do and how free they are.'] },
          ],
        });
        // Closing the second sheet goes back to the first, as Esc would.
        await s.answer(agents, ['no']);
        id = home();
      }
    }
  },

  /** Speaking: words appear as they are heard, a thought, then what was understood. */
  async talk(s) {
    const id = s.id();
    const words = 'Every Monday send Leo the Stripe numbers'.split(' ');
    s.surface.show({ id, kind: 'listen', say: [], heard: '', mood: 'listen' });
    for (let i = 1; i <= words.length; i++) {
      await s.wait(210);
      s.surface.update(id, { heard: words.slice(0, i).join(' ') });
    }
    await s.wait(500);
    await s.say([], 860, { mood: 'think' });
    const made = await s.offer(
      ['Every ', word('when', 'Monday at 9:00', SCHEDULES, { label: 'Schedule', read: 'sched' }), ', send ',
        word('who', 'Leo', ['Leo', 'Marco', 'Anna'], { label: 'Person', free: true }), ' the Stripe numbers.'],
      'make agent');
    if (made.act === 'yes') await s.say(['Made. It shows you the first one before it sends.'], 3200, { mood: 'proud', mark: 'check' });
  },

  /** A file is handed over: the mouth, the gulp, a question about it, the answer. */
  async drop(s) {
    s.surface.act({ mouth: 'open' });
    await s.wait(1500);
    s.surface.act({ mouth: 'over' });
    await s.wait(1100);
    s.surface.act({ mouth: 'gulp' });
    await s.say(['Got ', em('Call with Anna.m4a'), '.'], 900, { mood: 'happy' });
    const id = s.id();
    const asks = ['List the action points', 'Summarise it', 'Who said what'];
    s.surface.show({
      id, kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask about it', mood: 'curious',
      blocks: [
        { kind: 'file', icon: 'audio', name: 'Call with Anna.m4a', meta: 'Audio · 11.2 MB · 24 min' },
        { kind: 'buttons', buttons: asks.map((label, i) => ({ id: `ask${i}`, label, key: i + 1 })) },
      ],
    });
    const answer = await s.answer(id, ['button', 'ask', 'no']);
    if (answer.act === 'no') return;
    const asked = answer.act === 'ask' ? (answer.text ?? asks[0]!) : (asks[Number(answer.button?.slice(3) ?? 0)] ?? asks[0]!);
    await s.say(['Reading ', em('Call with Anna.m4a'), '…'], 1500, { mood: 'read' });
    const sheet = s.id();
    s.surface.show({
      id: sheet, kind: 'sheet', say: [em('Call with Anna.m4a')], yes: 'remember',
      blocks: [{
        kind: 'paper', numbered: true, to: ['You asked: ', em(asked)],
        lines: [
          ['Send pricing for 5 seats on the Pro plan. Owner: Nora.'],
          ['The contract can start on 1 December. Owner: you.'],
          ['Book the kickoff call. Owner: Jarvis.'],
        ],
      }],
    });
    const kept = await s.answer(sheet, ['yes', 'no']);
    if (kept.act === 'yes') await s.say(['Remembered.'], 2400, happy);
  },

  /** The watching eye, then sleep and waking. */
  async eye(s) {
    s.surface.act({ eye: true });
    await s.say(['Eye on ', em('invoice 114'), '. I will tell you when ', em('it is paid'), ', even if it is covered.'], 4000, { mood: 'look', mark: 'check' });
    await s.wait(2600);
    s.surface.act({ gesture: 'pop' });
    const thanks = await s.offer([em('Acme'), ' paid invoice 114: ', em('$1,200.00'), '. Draft a thank-you?'], 'draft', { mood: 'happy' });
    s.surface.act({ eye: false });
    if (thanks.act === 'yes') await s.say(['Drafted. It is in your Gmail drafts.'], 2800, happy);
    await s.wait(700);
    await s.say(['Going to sleep. I see nothing until you wake me.'], 2600, { mood: 'sleepy' });
    s.surface.act({ lip: 'zip' });
    await s.wait(900);
    s.surface.act({ mood: 'closed' });
    await s.wait(3200);
    s.surface.act({ gesture: 'wake', mood: 'idle' });
    await s.say(['Awake. Watching again.'], 1800);
  },

  /** Every face, every move, every way of being born, one after another. */
  async faces(s) {
    for (const mood of NOTCH_MOODS) {
      await s.say([`${mood}.`], 1500, { mood });
    }
    for (const gesture of NOTCH_GESTURES) {
      await s.wait(350);
      s.surface.act({ gesture });
      await s.say([`${gesture}.`], 1300);
    }
    for (const lip of NOTCH_LIPS) {
      await s.wait(350);
      s.surface.act({ lip });
      await s.wait(1700);
    }
    for (const birth of NOTCH_BIRTHS) {
      s.surface.act({ birth });
      await s.wait(2400);
    }
  },

  /** The widest sentence the notch holds: it wraps to two lines. */
  async wide(s) {
    const answer = await s.offer(
      [em('Leo'), ' wants Nora to answer new leads without asking you first, as she already does for him. Let her ',
        word('how', 'act alone', ['act alone', 'tell you after', 'keep asking'], { label: 'Freedom' }), ' on your leads too?'],
      'yes', { who: 'Leo', arrive: 'right' });
    if (answer.act === 'yes') await s.say(['Done. Nora acts alone on your leads from now on.'], 3200, happy);
  },
};

export interface NotchDemo {
  /** The moments that can be played, in the order they are meant to be tried. */
  names(): string[];
  /** Plays a moment in place of the one running. False when there is none by that name. */
  play(name: string): boolean;
  /** Stops the moment running, and rests the notch. */
  stop(): void;
  /** The moment running now, or null. */
  running(): string | null;
}

export function createNotchDemo(
  surface: NotchSurface,
  options: { clock?: NotchDemoClock; log?: (line: string) => void } = {},
): NotchDemo {
  const clock = options.clock ?? realClock;
  const log = options.log ?? ((line: string) => console.log(line));
  let stage: Stage | null = null;
  let playing: string | null = null;
  surface.onAnswer((answer: NotchAnswer) => { stage?.heard(answer); });
  surface.onOpen(() => { stage?.wasOpened(); });
  const end = (): void => {
    stage?.stop();
    stage = null;
    playing = null;
  };
  return {
    names: () => Object.keys(MOMENTS),
    play(name) {
      const moment = Object.hasOwn(MOMENTS, name) ? MOMENTS[name] : undefined;
      if (!moment) return false;
      end();
      const mine = new Stage(surface, clock, name);
      stage = mine;
      playing = name;
      // A clean start: nothing left over from the moment before.
      surface.act({ park: 0, eye: false, mouth: 'shut', mood: 'idle' });
      surface.setCount(0);
      surface.rest();
      moment(mine).then(
        () => {
          if (stage !== mine) return;
          stage = null;
          playing = null;
          if (surface.current().line) surface.rest();
        },
        (error: unknown) => {
          if (error instanceof Replaced) return;
          if (stage === mine) { stage = null; playing = null; }
          log(`[notch] the demo moment "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
      return true;
    },
    stop() {
      end();
      surface.act({ park: 0, eye: false, mouth: 'shut' });
      surface.rest();
    },
    running: () => playing,
  };
}
