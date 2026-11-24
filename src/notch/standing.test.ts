import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import type { MailThread } from './mail/thread.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import {
  NOTCH_AUTO_REPLY_MS, NOTCH_CHASE_WAIT_MIN_MS, attachNotchStanding, chaseAutoReply, chaseBy, chaseDay, chaseMail, chaseRequest, chaseSubject, eyeRequest, mailAutoReply,
  type StandingMail, type StandingPerson,
} from './standing.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

const SAM: StandingPerson = { name: 'Sam Rivers', address: 'sam@northwind.example', thread: { id: 'aaaaaaaaaaaaaaaa', subject: 'The contract' } };
const HOUR = 3_600_000;
/** A Monday at ten in the morning. */
const MONDAY = new Date(2026, 10, 16, 10, 0, 0).getTime();

const thread = (from: string, at: number, said = 'Yes, Thursday works for me.'): MailThread => ({
  id: 'aaaaaaaaaaaaaaaa', subject: 'The contract',
  messages: [{ from: { name: from === SAM.address ? 'Sam Rivers' : 'Anna Lund', address: from }, to: [], cc: [], at, text: said }],
});

function harness(options: {
  /** Whether the machine has no connection now. */
  offline?: () => boolean;
  people?: Record<string, StandingPerson | null>;
  find?: 'unreachable';
  send?: ({ ok: true } | { ok: false; why: string })[];
  paused?: () => boolean;
  waitMs?: number;
  owner?: string;
  db?: Database;
} = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = MONDAY;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const sent: { address: string; thread: string | null; subject: string; text: string }[] = [];
  const answers = [...(options.send ?? [])];
  let read: (threads: MailThread[]) => void = () => {};
  let looks = 0;
  /** A mail that arrives while the mailbox is being looked at. */
  let arriving: MailThread[] = [];
  const mail: StandingMail = {
    onRead(listener) { read = listener; },
    async find(who) {
      if (options.find === 'unreachable') throw new Error('the mailbox cannot be reached');
      const people = options.people ?? { sam: SAM, [SAM.address]: SAM };
      return people[who.toLowerCase()] ?? null;
    },
    async send(plan) { sent.push(plan); return answers.shift() ?? { ok: true }; },
    async look() { looks++; const came = arriving; arriving = []; if (came.length) read(came); },
    owner: () => options.owner ?? 'Vieri',
  };
  const eyes: boolean[] = [];
  const logs: string[] = [];
  let fired = 0;
  const standing = attachNotchStanding({
    inbox, db: options.db ?? new Database(':memory:'), mail, paused: options.paused, offline: options.offline, now: () => now, waitMs: options.waitMs,
    eye: (on) => { if (eyes.at(-1) !== on) eyes.push(on); },
    fired: () => { fired++; },
    log: (line) => logs.push(line),
  });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  /** Lets the clock run: what is on the notch for a while goes, and the next thing comes. */
  const pass = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      await settle();
      const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = Math.max(now, next.at);
      next.fn();
    }
    now = until;
    await settle();
  };
  const speak = async (words: string): Promise<string | null> => {
    const route = standing.route(words);
    route?.run();
    await settle();
    return route?.did ?? null;
  };
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  return {
    standing, sent, eyes, logs, line, said, pass, speak, reply, inbox,
    fired: () => fired, looks: () => looks,
    arrives: (...threads: MailThread[]) => { read(threads); },
    arriving: (...threads: MailThread[]) => { arriving = threads; },
    now: () => now, advance: (ms: number) => { now += ms; },
  };
}

describe('what is said that asks for an eye or a chase', () => {
  test('"tell me when Sam replies" asks for an eye, on a name or on an address', () => {
    for (const [said, who] of [
      ['Tell me when Sam replies', 'Sam'], ['tell me when sam@northwind.example replies.', 'sam@northwind.example'],
      ['Let me know when Sam writes back', 'Sam'], ['Hey Jarvis, tell me as soon as Anna answers', 'Anna'],
      ['Tell me when Sam Rivers gets back to me', 'Sam Rivers'], ['ping me when Leo emails me', 'Leo'],
    ] as const) expect(eyeRequest(said)).toEqual({ who });
    // Nobody is named: it is still an eye that is asked for, and it asks who.
    for (const said of ['Tell me when he replies', 'tell me when this answers', 'Let me know when they write back']) expect(eyeRequest(said)).toEqual({ who: '' });
    for (const no of ['Tell me a joke', 'When does Sam reply?', 'Tell me when the build is done', 'Reply to Sam', '']) expect(eyeRequest(no)).toBeNull();
  });

  test('"get Sam\'s answer by Friday" asks for a chase: who, what, about what, by when', () => {
    expect(chaseRequest("Get Sam's answer by Friday")).toEqual({ who: 'Sam', thing: 'answer', about: '', day: 'Friday' });
    expect(chaseRequest("get Anna's signature on the contract by tomorrow")).toEqual({ who: 'Anna', thing: 'signature', about: 'the contract', day: 'tomorrow' });
    expect(chaseRequest('Chase sam@northwind.example until it is done')).toEqual({ who: 'sam@northwind.example', thing: 'answer', about: '', day: '' });
    expect(chaseRequest('Get a reply from Leo about the invoice by next week')).toEqual({ who: 'Leo', thing: 'reply', about: 'the invoice', day: 'next week' });
    // It never fills in someone who was not named.
    expect(chaseRequest('Get the answer by Friday')).toMatchObject({ who: '' });
    expect(chaseRequest('get his reply')).toMatchObject({ who: '' });
    for (const no of ['Get me a coffee', 'Chase the dog', 'What is the answer?', 'Reply to Sam by Friday']) expect(chaseRequest(no)).toBeNull();
  });

  // The hardening audit, 17 November 2026: ordinary sentences were taken by
  // the notch and answered "Whose answer? Say the name." or chased a person
  // called "up". Where nobody is named and nobody is meant, the words are an
  // instruction like any other.
  test('a sentence that only looks like a chase or an eye goes on as an instruction', () => {
    for (const no of [
      'Get me the answer to question five',
      'Chase up the signature page in my downloads',
      'Get rid of the reply I drafted',
      'Get started on the answer for the board',
      'Chase down that signature file',
    ]) expect(chaseRequest(no)).toBeNull();
    for (const no of [
      'Let me know if the supplier responds',
      'Tell me when the server answers',
      'Let me know when my order gets back to me',
    ]) expect(eyeRequest(no)).toBeNull();
    // Put as a chase with nobody named, it is still one, and the notch asks whose.
    expect(chaseRequest('Chase him until he answers')).toMatchObject({ who: '' });
    expect(chaseRequest('Get their signature by Monday')).toMatchObject({ who: '', thing: 'signature', day: 'Monday' });
    expect(eyeRequest('Tell me when someone replies')).toEqual({ who: '' });
  });

  test('a day that was said is the next one that comes, at six in the evening', () => {
    expect(chaseDay('friday')).toBe('Friday');
    expect(chaseDay('Next Monday.')).toBe('Monday');
    expect(chaseDay('fri')).toBe('Friday');
    expect(chaseDay('tomorrow')).toBe('tomorrow');
    expect(chaseDay('soon')).toBe('');
    // From a Monday at ten.
    expect(new Date(chaseBy('Friday', MONDAY)).toString()).toContain('Fri Nov 20 2026 18:00');
    expect(new Date(chaseBy('tomorrow', MONDAY)).toString()).toContain('Tue Nov 17 2026 18:00');
    // The same day of the week is next week's, not today.
    expect(new Date(chaseBy('Monday', MONDAY)).toString()).toContain('Mon Nov 23 2026 18:00');
    expect(new Date(chaseBy('next week', MONDAY)).toString()).toContain('Mon Nov 23 2026 18:00');
  });

  test('the two mails a chase sends are short, plain, and say the day', () => {
    const chase = { name: 'Sam Rivers', about: 'the contract', day: 'Friday', thread: 'aaaaaaaaaaaaaaaa' };
    expect(chaseMail(chase, 0, 'Vieri')).toBe('Hi Sam,\n\nA quick nudge on the contract: could you get back to me by Friday?\n\nThanks,\nVieri');
    expect(chaseMail(chase, 1, 'Vieri')).toBe('Hi Sam,\n\nFollowing up on my note below. Could you let me know by Friday?\n\nThanks,\nVieri');
    // With nothing said about what, and no thread to write in.
    expect(chaseMail({ name: 'Sam', about: '', day: 'tomorrow', thread: null }, 0, '')).toBe('Hi Sam,\n\nA quick nudge on this: could you get back to me tomorrow?\n\nThanks,');
    expect(chaseMail({ name: 'Sam', about: '', day: 'next week', thread: null }, 1, 'Vieri')).toContain('Following up on my last mail. Could you let me know early next week?');
    expect(chaseSubject({ about: 'the contract', subject: '' })).toBe('The contract');
    expect(chaseSubject({ about: '', subject: '' })).toBe('Following up');
    expect(chaseSubject({ about: 'the contract', subject: 'Q3 numbers' })).toBe('Q3 numbers');
  });
});

describe('keep an eye on this', () => {
  // The plan's test, step 1: "Tell me when [your second address] replies." Reply. The eye fires once and leaves the list.
  test('an eye is kept, one of the notch\'s eyes turns citron, it fires once when the mail comes, and it is gone', async () => {
    const h = harness();
    expect(await h.speak('Tell me when Sam replies')).toBe('Keep an eye on mail from one person.');
    expect(h.said()).toBe('Eye on mail from Sam. I will tell you when Sam replies, even if it is covered.');
    expect(h.eyes).toEqual([false, true]);
    expect(h.standing.counts()).toEqual({ eyes: 1, chases: 0 });
    expect(h.standing.rows()).toEqual([{ kind: 'row', id: 'eyes', go: true, say: ['I keep an eye on ', { em: '1 thing' }, '.'] }]);
    await h.pass(9000);
    // Mail from somebody else is nothing to it. Nor is an old mail of Sam's, read again for another reason.
    h.arrives(thread('anna@lumen.example', h.now()), thread(SAM.address, h.now() - 3 * HOUR));
    await settle();
    expect(h.fired()).toBe(0);
    h.advance(20 * 60_000);
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    // The eye it kept opens wide, then it speaks.
    expect(h.fired()).toBe(1);
    expect(h.said()).toBe('Sam replied: “Yes, Thursday works for me.”');
    // It leaves the list at once, and stays citron until it has been said.
    expect(h.standing.counts().eyes).toBe(0);
    expect(h.eyes.at(-1)).toBe(true);
    await h.pass(12000);
    expect(h.eyes.at(-1)).toBe(false);
    // Once: a second mail from Sam is nothing to it any more.
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.fired()).toBe(1);
    expect(h.line()).toBeNull();
    // What a mail says is on the notch, and never in the log.
    expect(h.logs.join('\n')).not.toContain('Thursday');
    expect(h.logs.join('\n')).not.toContain('Sam');
  });

  test('it asks who when nobody was named, and says so when it does not know them or cannot reach the mail', async () => {
    const h = harness();
    await h.speak('Tell me when he replies');
    expect(h.said()).toBe('Who? Say the name, or the address.');
    await h.pass(8000);
    await h.speak('Tell me when Leo replies');
    expect(h.said()).toBe("I do not know Leo's address. Say it instead of the name.");
    expect(h.standing.counts().eyes).toBe(0);
    const away = harness({ find: 'unreachable' });
    await away.speak('Tell me when Sam replies');
    expect(away.said()).toBe('I cannot reach your mail right now, so I cannot do that.');
    expect(away.eyes).toEqual([false]);
  });

  test('one eye per person, and none on someone who is already being chased', async () => {
    const h = harness();
    await h.speak('Tell me when Sam replies');
    await h.pass(9000);
    await h.speak('Tell me when sam@northwind.example writes back');
    expect(h.said()).toBe('I already have an eye on that.');
    expect(h.standing.counts().eyes).toBe(1);
  });

  test('the list has a Stop for each, and with the last one stopped the eye is the notch\'s own again', async () => {
    const h = harness();
    await h.speak('Tell me when Sam replies');
    await h.pass(9000);
    h.inbox.present('eyes', (stage) => h.standing.open(stage, 'eyes'));
    await settle();
    expect(h.said()).toBe('What I keep an eye on');
    const blocks = (h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks;
    expect(blocks).toMatchObject([{ kind: 'row', lead: 'Mail', say: ['Mail from Sam, until Sam replies.'], buttons: [{ id: 'stop', label: 'Stop' }] }]);
    await h.reply('button', { row: (blocks[0] as Extract<NotchBlock, { kind: 'row' }>).id, button: 'stop' });
    expect(h.standing.counts().eyes).toBe(0);
    expect(h.eyes.at(-1)).toBe(false);
    expect(((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks[0] as { say: NotchPart[] }).say).toEqual(['Nothing right now. Say "tell me when Sam replies", and I will.']);
    // Stopped: the mail it was for is nothing to it.
    h.arrives(thread(SAM.address, h.now()));
    expect(h.fired()).toBe(0);
  });

  test('an eye outlives a restart', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.speak('Tell me when Sam replies');
    before.standing.stop();
    const after = harness({ db });
    // Citron from the start: it is still being kept.
    expect(after.eyes).toEqual([true]);
    after.arrives(thread(SAM.address, after.now()));
    await settle();
    expect(after.said()).toBe('Sam replied: “Yes, Thursday works for me.”');
  });

  test('with everything stopped no eye is taken on', async () => {
    const h = harness({ paused: () => true });
    await h.speak('Tell me when Sam replies');
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.standing.counts().eyes).toBe(0);
  });
});

describe('until it is done', () => {
  /** Starts a chase of Sam's answer and says yes to it. */
  async function started(h: ReturnType<typeof harness>, said = "Get Sam's answer on the contract by Friday"): Promise<void> {
    await h.speak(said);
    await h.reply('yes');
  }

  // The plan's test, step 2: "Start a chase. Its steps appear. When stuck, it gives choices. Reply, and it says done."
  test('what will be sent is shown before anything is: one yes is leave for these two mails and nothing else', async () => {
    const h = harness();
    expect(await h.speak("Get Sam's answer on the contract by Friday")).toBe('Chase one person for an answer.');
    expect(h.said()).toBe("I will get Sam's answer by Friday, and only come back if I am stuck. Go?");
    const sheet = h.line() as Extract<NotchLine, { kind: 'sheet' }>;
    expect(sheet).toMatchObject({ kind: 'sheet', yes: 'go' });
    expect(sheet.blocks).toEqual([
      // In the thread the talk is already in.
      { kind: 'paper', to: ['To ', { em: 'sam@northwind.example' }, '  ·  Re: The contract'], lines: [['Hi Sam,'], ['A quick nudge on the contract: could you get back to me by Friday?'], ['Thanks,'], ['Vieri']] },
      { kind: 'note', say: ['This goes now. If there is no answer, one short follow-up goes tomorrow. After that I ask you. Nothing else is sent.'] },
    ]);
    // Nothing has gone yet.
    expect(h.sent).toEqual([]);
    // The day is a word that can be changed, and the mail says the day it is changed to.
    await h.reply('word', { word: 'by', value: 'tomorrow' });
    expect(h.said()).toBe("I will get Sam's answer by tomorrow, and only come back if I am stuck. Go?");
    expect(JSON.stringify((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks)).toContain('could you get back to me tomorrow?');
    await h.reply('yes');
    expect(h.sent).toEqual([{
      address: 'sam@northwind.example', thread: 'aaaaaaaaaaaaaaaa', subject: 'The contract',
      text: 'Hi Sam,\n\nA quick nudge on the contract: could you get back to me tomorrow?\n\nThanks,\nVieri',
    }]);
    expect(h.said()).toBe("On it. I will come back when Sam's answer is in, or if I am stuck.");
    expect(h.standing.rows()).toEqual([{ kind: 'row', id: 'chases', go: true, say: ['I am chasing ', { em: '1 thing' }, ' until it is done.'] }]);
  });

  // A chase that changes hands (./people-jobs.ts): the prototype's "hand it over".
  test('handed to somebody it sends nothing more from here, it can come back with what they did, or be closed by them', async () => {
    const h = harness({ waitMs: 2 * 60_000 });
    await started(h);
    const mine = h.standing.handable();
    expect(mine.map((chase) => [chase.address, chase.state])).toEqual([['sam@northwind.example', 'on']]);
    const id = mine[0]!.id;
    expect(h.standing.hand(id, 'Leo')).toBe(true);
    expect(h.standing.chase(id)).toMatchObject({ state: 'handed' });
    expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('Handed to Leo. Leo took it.');
    // Not under way here any more: it cannot be handed twice, and it is not one that could be handed.
    expect(h.standing.hand(id, 'Anna')).toBe(false);
    expect(h.standing.handable()).toEqual([]);
    // Its follow-up is due, and does not go: it is somebody else's now.
    const before = h.sent.length;
    h.advance(10 * 60_000);
    await h.standing.tick();
    expect(h.sent.length).toBe(before);
    // Back, with what was done meanwhile, told as theirs. Under way again, and the next step is a whole wait off.
    expect(h.standing.back(id, [{ at: h.now(), text: 'Nudged Sam by email.' }], 'Leo')).toBe(true);
    const back = h.standing.chase(id)!;
    expect(back.state).toBe('on');
    expect(back.steps.slice(-2).map((step) => step.text)).toEqual(['Leo: Nudged Sam by email.', 'Back with you, with what Leo did.']);
    expect(back.nextAt).toBe(h.now() + 2 * 60_000);
    expect(h.standing.back(id, [], 'Leo')).toBe(false);
    // Handed again, and this time they finish it.
    expect(h.standing.hand(id, 'Leo')).toBe(true);
    expect(h.standing.closed(id, 'done', 'Leo')).toBe(true);
    expect(h.standing.chase(id)).toMatchObject({ state: 'done' });
    expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('Done. Leo closed it.');
    expect(h.standing.closed(id, 'done', 'Leo')).toBe(false);
  });

  test('a chase somebody handed over is taken on with its history, and starts like any other: its first mail goes from here', async () => {
    const h = harness();
    const job = { name: 'Dana Reyes', address: 'dana@acme.example', thing: 'answer' as const, about: 'the renewal', day: 'Friday', steps: [{ at: 5, text: 'Nudged Dana by email.' }], from: 'Sam' };
    const draft = h.standing.drafted(job)!;
    // Not kept, and nothing sent, until it is begun.
    expect(h.standing.chase(draft.id)).toBeNull();
    expect(h.sent).toEqual([]);
    expect(draft.steps.map((step) => step.text)).toEqual(['Sam: Nudged Dana by email.', 'Taken from Sam.']);
    // What is shown before it starts is what will go, to whom.
    expect(JSON.stringify(h.standing.blocks(draft))).toContain('dana@acme.example');
    expect(JSON.stringify(h.standing.blocks(draft))).toContain('A quick nudge on the renewal');
    const begun = await h.standing.begin(draft);
    expect(begun.ok).toBe(true);
    expect(h.sent.map((mail) => [mail.address, mail.thread])).toEqual([['dana@acme.example', null]]);
    expect(h.standing.chase(draft.id)).toMatchObject({ state: 'on', nudges: 1 });
    expect(h.standing.chase(draft.id)!.steps.map((step) => step.text)).toEqual(['Sam: Nudged Dana by email.', 'Taken from Sam.', 'Nudged Dana by email.']);
    // One watcher per person: a second one for the same address is not drafted.
    expect(h.standing.drafted(job)).toBeNull();
  });

  test('Esc sends nothing and starts nothing', async () => {
    const h = harness();
    await h.speak("Get Sam's answer by Friday");
    await h.reply('no');
    expect(h.sent).toEqual([]);
    expect(h.standing.counts().chases).toBe(0);
  });

  test('a quiet follow-up, then it comes back only because it is stuck, and each choice does what it says', async () => {
    const h = harness({ waitMs: 2 * 60_000 });
    await started(h);
    await h.pass(9000);
    // Not due yet: nothing goes.
    await h.standing.tick();
    expect(h.sent.length).toBe(1);
    h.advance(2 * 60_000);
    await h.standing.tick();
    // The outcome is looked for before every step.
    expect(h.looks()).toBe(1);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.text).toContain('Following up on my note below.');
    // A quiet step: written down, not announced.
    expect(h.line()).toBeNull();
    h.advance(2 * 60_000);
    await h.standing.tick();
    await settle();
    // No third mail. It asks.
    expect(h.sent.length).toBe(2);
    expect(h.said()).toBe('2 nudges and nothing from Sam. What now?');
    expect((h.line() as Extract<NotchLine, { kind: 'offer' }>).options).toEqual(['Call Sam', 'Wait until Monday', 'Let it go']);
    await h.reply('pick', { option: 'Wait until Monday', index: 1 });
    expect(h.said()).toBe('Waiting until Monday. Still on it.');
    expect(h.standing.counts().chases).toBe(1);
    await h.pass(7000);
    // Until Monday nothing more is asked or sent.
    h.advance(6 * HOUR);
    await h.standing.tick();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.sent.length).toBe(2);
    // On Monday it is stuck again, and asks again.
    h.advance(8 * 24 * HOUR);
    await h.standing.tick();
    await settle();
    expect(h.said()).toBe('2 nudges and nothing from Sam. What now?');
    await h.reply('pick', { option: 'Let it go', index: 2 });
    expect(h.said()).toBe('Dropped. I will not chase it.');
    expect(h.standing.counts().chases).toBe(0);
  });

  test('"Call Sam" hands it back, and nothing more is written to Sam', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    for (let i = 0; i < 2; i++) { h.advance(60_000); await h.standing.tick(); await settle(); }
    await h.reply('pick', { option: 'Call Sam', index: 0 });
    expect(h.said()).toBe('The call is yours. I have stopped writing to Sam.');
    h.advance(24 * HOUR);
    await h.standing.tick();
    expect(h.sent.length).toBe(2);
  });

  test('the answer comes: it says done, once, and sends nothing more', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    h.advance(30_000);
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.said()).toBe('Done. Sam answered.');
    expect(h.standing.counts().chases).toBe(0);
    await h.pass(9000);
    h.advance(10 * 60_000);
    await h.standing.tick();
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.sent.length).toBe(1);
    expect(h.line()).toBeNull();
    expect(h.standing.rows()).toEqual([{ kind: 'row', id: 'chases', go: true, say: ['Nothing left to chase. See what I did.'] }]);
  });

  // The hardening audit, 17 November 2026: Sam's mailbox answered the nudge by
  // itself a minute later, and the chase was over: "Done. Sam answered."
  test('their mailbox answering the nudge by itself is not their answer: the chase goes on', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    h.advance(40_000);
    h.arrives(thread(SAM.address, h.now(), 'Thank you for your email. I am out of the office until Monday with limited access to email.'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.standing.counts().chases).toBe(1);
    // The real answer, days later, ends it.
    h.advance(3 * 24 * HOUR);
    h.arrives(thread(SAM.address, h.now(), 'Back now. Yes, Thursday works for me.'));
    await settle();
    expect(h.said()).toBe('Done. Sam answered.');
  });

  test('the same for the follow-up: its automatic reply does not end the chase either', async () => {
    const h = harness({ waitMs: 10 * 60_000 });
    await started(h);
    await h.pass(9000);
    // No answer: the follow-up goes, long after the first mail.
    h.advance(10 * 60_000);
    await h.standing.tick();
    await settle();
    expect(h.sent.length).toBe(2);
    // A minute later the mailbox answers by itself.
    h.advance(50_000);
    h.arrives(thread(SAM.address, h.now(), 'Automatic reply: I am out of the office until Monday.'));
    await settle();
    expect(h.standing.counts().chases).toBe(1);
    expect(h.said()).not.toContain('Done.');
  });

  test('what reads like an automatic reply, and what does not', () => {
    for (const auto of [
      'I am out of the office until Monday.', 'Thank you for your message. I am currently away and will reply on my return.',
      'This is an automated response: I have limited access to email this week.', 'Sono fuori ufficio fino a lunedì.',
      'Ich bin nicht im Büro und antworte nächste Woche.', 'Je suis absent du bureau jusqu\'au 24.',
    ]) expect(mailAutoReply(auto)).toBe(true);
    expect(mailAutoReply('See you Thursday.', 'Automatic reply: The contract')).toBe(true);
    for (const real of ['Yes, Thursday works for me.', 'Signed and attached.', 'Can we move it to Friday?']) expect(mailAutoReply(real, 'The contract')).toBe(false);
    // A person who mentions having been away has still answered: only a mail that came right after the nudge is taken for the mailbox's own.
    const nudged = 1_000_000;
    const message = (at: number, text: string) => ({ from: { name: 'Sam Rivers', address: SAM.address }, to: [], cc: [], at, text });
    expect(chaseAutoReply(message(nudged + 60_000, 'I am out of the office until Monday.'), 'The contract', [nudged])).toBe(true);
    expect(chaseAutoReply(message(nudged + NOTCH_AUTO_REPLY_MS + 1, 'I was out of office last week. Yes, we can sign.'), 'The contract', [nudged])).toBe(false);
    expect(chaseAutoReply(message(nudged + 60_000, 'Yes, Thursday works for me.'), 'The contract', [nudged])).toBe(false);
    expect(chaseAutoReply(message(nudged + 60_000, 'I am out of the office until Monday.'), 'The contract', [])).toBe(false);
  });

  test('an answer that came a moment before the follow-up was due is found first: nothing is sent to someone who has answered', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    h.advance(60_000);
    // It is in the mailbox, and nobody has read it yet.
    h.arriving(thread(SAM.address, h.now()));
    await h.standing.tick();
    await settle();
    expect(h.sent.length).toBe(1);
    expect(h.said()).toBe('Done. Sam answered.');
  });

  test('an answer while it is stuck takes the question away', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    for (let i = 0; i < 2; i++) { h.advance(60_000); await h.standing.tick(); await settle(); }
    expect(h.said()).toBe('2 nudges and nothing from Sam. What now?');
    await h.reply('fold');
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.said()).toBe('Done. Sam answered.');
    await h.pass(9000);
    expect(h.inbox.waiting().length).toBe(0);
  });

  // The plan's test, step 6: "Stop the chase. No more nudges, ever."
  test('Stop in the list: no more nudges, ever, and the list says what was done', async () => {
    const h = harness({ waitMs: 60_000 });
    await started(h);
    await h.pass(9000);
    h.inbox.present('chases', (stage) => h.standing.open(stage, 'chases'));
    await settle();
    expect(h.said()).toBe('What I am chasing');
    let blocks = (h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks;
    expect(blocks).toMatchObject([
      { kind: 'row', say: ["Sam's answer, by Friday."], buttons: [{ id: 'stop', label: 'Stop' }] },
      { kind: 'row', lead: '10:00', say: ['Nudged Sam by email.'] },
    ]);
    await h.reply('button', { row: (blocks[0] as Extract<NotchBlock, { kind: 'row' }>).id, button: 'stop' });
    blocks = (h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks;
    expect(blocks).toMatchObject([
      { kind: 'row', say: ["Sam's answer. Dropped."] },
      { kind: 'row', say: ['Nudged Sam by email.'] },
      { kind: 'row', say: ['You stopped it.'] },
    ]);
    expect((blocks[0] as Extract<NotchBlock, { kind: 'row' }>).buttons).toBeUndefined();
    await h.reply('no');
    for (let i = 0; i < 5; i++) { h.advance(24 * HOUR); await h.standing.tick(); await settle(); }
    expect(h.sent.length).toBe(1);
    expect(h.line()).toBeNull();
    // Nor does a late answer bring it back.
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.line()).toBeNull();
  });

  test('a first mail that cannot be sent starts nothing, and says why', async () => {
    const h = harness({ send: [{ ok: false, why: 'the writing window did not open as expected' }] });
    await started(h);
    expect(h.said()).toBe('I could not send it: the writing window did not open as expected. Nothing was started.');
    expect(h.standing.counts().chases).toBe(0);
  });

  test('a follow-up that cannot be sent is said, with a way to try again', async () => {
    const h = harness({ waitMs: 60_000, send: [{ ok: true }, { ok: false, why: 'Gmail did not say it was sent' }, { ok: true }] });
    await started(h);
    await h.pass(9000);
    h.advance(60_000);
    await h.standing.tick();
    await settle();
    expect(h.said()).toBe('I could not send Sam the follow-up: Gmail did not say it was sent. What now?');
    expect((h.line() as Extract<NotchLine, { kind: 'offer' }>).options).toEqual(['Try again', 'Let it go']);
    await h.reply('pick', { option: 'Try again', index: 0 });
    await h.pass(6000);
    await h.standing.tick();
    expect(h.sent.length).toBe(3);
    expect(h.standing.counts().chases).toBe(1);
  });

  test('one watcher per person: a chase takes over from an eye, and a second chase of the same person is refused', async () => {
    const h = harness();
    await h.speak('Tell me when Sam replies');
    await h.pass(9000);
    await started(h);
    expect(h.standing.counts()).toEqual({ eyes: 0, chases: 1 });
    expect(h.eyes.at(-1)).toBe(false);
    await h.pass(9000);
    await h.speak("Get Sam's reply by tomorrow");
    expect(h.said()).toBe('I am already on that.');
    await h.pass(7000);
    await h.speak('Tell me when Sam replies');
    expect(h.said()).toBe('I am already chasing that. You will hear from me.');
  });

  test('with nobody named it asks whose, and to an address nobody has written from it writes a new mail', async () => {
    const h = harness({ people: { 'leo@acme.example': { name: 'Leo', address: 'leo@acme.example', thread: null } } });
    await h.speak('Get the answer by Friday');
    expect(h.said()).toBe('Whose answer? Say the name.');
    await h.pass(8000);
    await h.speak('Get a reply from leo@acme.example about the invoice by Friday');
    expect(((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).to).toEqual(['To ', { em: 'leo@acme.example' }, '  ·  The invoice']);
    await h.reply('yes');
    expect(h.sent[0]).toMatchObject({ address: 'leo@acme.example', thread: null, subject: 'The invoice' });
    expect(h.said()).toBe("On it. I will come back when Leo's reply is in, or if I am stuck.");
  });

  test('with everything stopped nothing is started and no step is taken', async () => {
    let paused = false;
    const h = harness({ waitMs: 60_000, paused: () => paused });
    await started(h);
    await h.pass(9000);
    paused = true;
    h.advance(10 * 60_000);
    await h.standing.tick();
    expect(h.sent.length).toBe(1);
    await h.speak("Get Sam's reply by tomorrow");
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    // Awake again: it goes on from where it was.
    paused = false;
    await h.pass(8000);
    await h.standing.tick();
    expect(h.sent.length).toBe(2);
  });

  test('how long it waits between its two mails comes from the day it is to be done by', async () => {
    const h = harness();
    await started(h, "Get Sam's answer by tomorrow");
    // Tomorrow evening is 32 hours off: a third of that is under the least it waits.
    h.advance(NOTCH_CHASE_WAIT_MIN_MS - 60_000);
    await h.standing.tick();
    expect(h.sent.length).toBe(1);
    h.advance(2 * 60_000);
    await h.standing.tick();
    expect(h.sent.length).toBe(2);
  });
});

// Undo on a receipt (./today.ts): a watch and a chase can be taken back from the list of what was done.
describe('what was started, in the list of what was done, with Undo', () => {
  const chase = async (h: ReturnType<typeof harness>): Promise<void> => { await h.speak("Get Sam's answer on the contract by Friday"); await h.reply('yes'); await h.pass(9000); };

  test('an eye and a chase are each a row from the moment they are started, and both can be taken back', async () => {
    const h = harness({ waitMs: 60_000 });
    const start = h.now();
    await h.speak('Tell me when Sam replies');
    await h.pass(9000);
    expect(h.standing.done(start)).toMatchObject([{ text: "Watching for Sam's reply", small: 'watching', undo: true }]);
    expect(h.standing.done(start)[0]!.id).toStartWith('eye:');
    // Asked for a later span, it is not in it.
    expect(h.standing.done(h.now() + 1)).toEqual([]);

    const c = harness({ waitMs: 60_000 });
    await chase(c);
    expect(c.standing.done(start)).toMatchObject([{ text: "Getting Sam's answer by Friday", small: 'on it', undo: true }]);
    expect(c.standing.done(start)[0]!.id).toStartWith('chase:');
  });

  test('Undo on an eye closes it: nothing is watched for, and the row is gone', async () => {
    const h = harness();
    const start = h.now();
    await h.speak('Tell me when Sam replies');
    await h.pass(9000);
    const [row] = h.standing.done(start);
    expect(text(h.standing.undo(row!.id) ?? [])).toBe("No longer watching for Sam's reply.");
    expect(h.standing.counts().eyes).toBe(0);
    expect(h.eyes.at(-1)).toBe(false);
    expect(h.standing.done(start)).toEqual([]);
    // A second Undo of the same row is nothing.
    expect(h.standing.undo(row!.id)).toBeNull();
    // And when Sam writes, nothing is said.
    h.arrives(thread(SAM.address, h.now() + 1000));
    await settle();
    expect(h.line()).toBeNull();
  });

  test('Undo on a chase stops it for good, and says that what went stays sent', async () => {
    const h = harness({ waitMs: 60_000 });
    const start = h.now();
    await chase(h);
    expect(h.sent).toHaveLength(1);
    const [row] = h.standing.done(start);
    expect(text(h.standing.undo(row!.id) ?? [])).toBe('Stopped. I will not write to Sam again. What I sent stays sent.');
    expect(h.standing.counts().chases).toBe(0);
    // The row stands as what it now is, with no Undo left on it.
    expect(h.standing.done(start)).toMatchObject([{ small: 'stopped', undo: false }]);
    expect(h.standing.undo(row!.id)).toBeNull();
    // Its steps say what happened.
    h.inbox.present('chases', (stage) => h.standing.open(stage, 'chases'));
    await settle();
    const blocks = (h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks;
    expect(blocks.map((block) => ('say' in block ? text(block.say as NotchPart[]) : ''))).toContain('You took it back.');
    await h.reply('no');
    // No more nudges, ever.
    for (let i = 0; i < 5; i++) { h.advance(24 * HOUR); await h.standing.tick(); await settle(); }
    expect(h.sent).toHaveLength(1);
  });

  test('a chase that is over is not taken back, and a row that is neither is nothing', async () => {
    const h = harness({ waitMs: 60_000 });
    const start = h.now();
    await chase(h);
    const [row] = h.standing.done(start);
    h.arrives(thread(SAM.address, h.now()));
    await settle();
    expect(h.standing.done(start)).toMatchObject([{ small: 'done', undo: false }]);
    expect(h.standing.undo(row!.id)).toBeNull();
    for (const id of ['job:1', 'agent:f1', 'eye:nothing', 'chase:nothing', '']) expect(h.standing.undo(id)).toBeNull();
  });
});

// The prototype: "I keep working here and hold what has to go out." / "Back online. 2 things I was holding went out."
describe('a follow-up that comes due with no connection', () => {
  const chase = async (h: ReturnType<typeof harness>): Promise<void> => { await h.speak("Get Sam's answer on the contract by Friday"); await h.reply('yes'); await h.pass(9000); };

  test('is held, not tried and called failed, and goes out when the connection is back', async () => {
    let offline = false;
    const h = harness({ waitMs: 60_000, offline: () => offline });
    await chase(h);
    expect(h.sent).toHaveLength(1);
    offline = true;
    h.advance(61_000);
    await h.standing.tick();
    await settle();
    // Nothing was sent, the mailbox was not even asked, and the chase does not ask what to do about it.
    expect(h.sent).toHaveLength(1);
    expect(h.looks()).toBe(0);
    expect(h.line()).toBeNull();
    expect(h.standing.counts().chases).toBe(1);
    // Still no connection at the next tick: still held, once.
    await h.standing.tick();
    expect(h.sent).toHaveLength(1);
    offline = false;
    expect(await h.standing.released()).toBe(1);
    expect(h.sent).toHaveLength(2);
    // What was held has gone: asked again, nothing is counted twice.
    expect(await h.standing.released()).toBe(0);
    expect(h.sent).toHaveLength(2);
  });

  test('with nothing held, nothing is counted, and nothing is sent early', async () => {
    const h = harness({ waitMs: 60_000, offline: () => false });
    await chase(h);
    expect(await h.standing.released()).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  test('one that was answered while there was no connection is not followed up when it is back', async () => {
    let offline = false;
    const h = harness({ waitMs: 60_000, offline: () => offline });
    await chase(h);
    offline = true;
    h.advance(61_000);
    await h.standing.tick();
    // Sam's answer is in the mailbox when it can be read again.
    h.arriving(thread(SAM.address, h.now()));
    offline = false;
    expect(await h.standing.released()).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  test('one that cannot be sent when the connection is back is not counted as gone out', async () => {
    let offline = false;
    const h = harness({ waitMs: 60_000, offline: () => offline, send: [{ ok: true }, { ok: false, why: 'Gmail did not take it' }] });
    await chase(h);
    offline = true;
    h.advance(61_000);
    await h.standing.tick();
    offline = false;
    expect(await h.standing.released()).toBe(0);
  });
});

