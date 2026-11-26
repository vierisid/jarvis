import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import type { MailThread } from './mail/thread.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import {
  NOTCH_AUTO_REPLY_MS, NOTCH_CHASE_FUSE_MS, NOTCH_CHASE_WAIT_MIN_MS, attachNotchStanding, chaseAutoReply, chaseBy, chaseDay, chaseMail, chaseRequest, chaseSubject, eyeRequest, mailAutoReply,
  type StandingMail, type StandingPerson,
} from './standing.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

/** A "What now?" that can send a mail is a sheet: the mail on paper, yes to send it, and the other answers as buttons. */
const whatNow = (line: NotchLine | null): { yes: string; buttons: string[]; paper: string[] } => {
  const sheet = line as Extract<NotchLine, { kind: 'sheet' }>;
  const blocks = sheet?.kind === 'sheet' ? sheet.blocks : [];
  return {
    yes: sheet?.kind === 'sheet' ? String(sheet.yes ?? '') : '',
    buttons: blocks.flatMap((block) => (block.kind === 'buttons' ? block.buttons.map((button) => button.label) : [])),
    paper: blocks.flatMap((block) => (block.kind === 'paper' ? block.lines.map((parts) => text(parts)) : [])),
  };
};

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
  send?: ({ ok: true } | { ok: false; why: string; pressed?: boolean; since?: number })[];
  /** What the mailbox says each time it is asked whether a mail that may have gone did. */
  went?: (boolean | null)[];
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
  const wentAnswers = [...(options.went ?? [])];
  /** Each time the mailbox was asked whether a mail went: which mail, and since when. */
  const asked: { text: string; thread: string | null; since: number }[] = [];
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
    async went(plan, since) { asked.push({ text: plan.text, thread: plan.thread, since }); return wentAnswers.length > 1 ? wentAnswers.shift()! : wentAnswers.length === 1 ? wentAnswers[0]! : false; },
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
    standing, sent, asked, eyes, logs, line, said, pass, speak, reply, inbox,
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
    // The fuse burns out with somebody there to see it. Nothing burns when it is refused at once.
    if (h.line()?.kind === 'send') await h.reply('done');
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
      { kind: 'note', say: ['This goes now. If there is no answer, this follow-up goes tomorrow:'] },
      // README 116: both mails are shown before it starts. Of the second, the sheet only said that one would go.
      { kind: 'paper', to: ['To ', { em: 'sam@northwind.example' }, '  ·  the follow-up'], lines: [['Hi Sam,'], ['Following up on my note below. Could you let me know by Friday?'], ['Thanks,'], ['Vieri']] },
      { kind: 'note', say: ['After that I ask you. Nothing else is sent.'] },
    ]);
    // Nothing has gone yet.
    expect(h.sent).toEqual([]);
    // The day is a word that can be changed, and both mails say the day it is changed to.
    await h.reply('word', { word: 'by', value: 'tomorrow' });
    expect(h.said()).toBe("I will get Sam's answer by tomorrow, and only come back if I am stuck. Go?");
    expect(JSON.stringify((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks)).toContain('could you get back to me tomorrow?');
    expect(JSON.stringify((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks)).toContain('Could you let me know tomorrow?');
    await h.reply('yes');
    // README 22: a yes is not acted on at once. A fuse burns, and nothing has gone while it does.
    expect(h.line()).toMatchObject({ kind: 'send', ms: NOTCH_CHASE_FUSE_MS });
    expect(h.said()).toBe('Sending Sam the first mail…');
    expect(h.sent).toEqual([]);
    expect(h.standing.counts().chases).toBe(0);
    await h.reply('done');
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
    // Back, with what was done meanwhile, told as theirs. Not under way again by itself: it asks what now.
    await h.pass(9000);
    expect(h.standing.back(id, [{ at: h.now(), text: 'Nudged Sam by email.' }], 'Leo')).toBe(true);
    const back = h.standing.chase(id)!;
    expect(back.state).toBe('stuck');
    expect(back.stuck).toEqual({ kind: 'back', from: 'Leo' });
    expect(back.steps.slice(-2).map((step) => step.text)).toEqual(['Leo: Nudged Sam by email.', 'Back with you, with what Leo did.']);
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
    // Taking it is a yes to a mail: the same fuse burns before it goes.
    let begun: Awaited<ReturnType<typeof h.standing.begin>> | null = null;
    h.inbox.present('take', async (stage) => { begun = await h.standing.begin(draft, stage); });
    await settle();
    expect(h.said()).toBe('Sending Dana the first mail…');
    expect(h.sent).toEqual([]);
    await h.reply('done');
    expect(begun).toMatchObject({ ok: true });
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

  // README 22. The first mail went the moment yes was pressed: there was nothing to take back.
  test('Esc while the fuse burns takes the yes back: nothing is sent, and the sheet is up again', async () => {
    const h = harness();
    await h.speak("Get Sam's answer on the contract by Friday");
    await h.reply('yes');
    expect(h.line()).toMatchObject({ kind: 'send' });
    await h.reply('undo');
    expect(h.sent).toEqual([]);
    expect(h.standing.counts().chases).toBe(0);
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'go' });
    expect(h.said()).toBe("I will get Sam's answer by Friday, and only come back if I am stuck. Go?");
    // And a yes after that is a yes like the first.
    await h.reply('yes');
    await h.reply('done');
    expect(h.sent.length).toBe(1);
    expect(h.standing.counts().chases).toBe(1);
  });

  test('a fuse nobody saw burn out sends nothing and starts nothing', async () => {
    const h = harness();
    await h.speak("Get Sam's answer on the contract by Friday");
    await h.reply('yes');
    await h.pass(NOTCH_CHASE_FUSE_MS + 5000);
    expect(h.sent).toEqual([]);
    expect(h.standing.counts().chases).toBe(0);
  });

  test('what would refuse a chase is said before any fuse burns', async () => {
    let paused = false;
    const h = harness({ paused: () => paused });
    await h.speak("Get Sam's answer on the contract by Friday");
    paused = true;
    await h.reply('yes');
    expect(h.line()?.kind).not.toBe('send');
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.sent).toEqual([]);
  });

  // A peer hands a chase back (./people-jobs.ts). It was under way again at once, and a wait later
  // its follow-up went from the owner's mailbox with nobody having said so.
  describe('handed back by whoever took it', () => {
    async function handedBack(h: ReturnType<typeof harness>): Promise<string> {
      await started(h);
      await h.pass(9000);
      const id = h.standing.handable()[0]!.id;
      h.standing.hand(id, 'Leo');
      h.standing.back(id, [{ at: h.now(), text: 'Called Sam. No answer.' }], 'Leo');
      await settle();
      return id;
    }

    test('it asks what now, and sends nothing however long it is left', async () => {
      const h = harness({ waitMs: 60_000 });
      const id = await handedBack(h);
      expect(h.said()).toBe("Leo handed Sam's answer back. What now?");
      // The follow-up a yes would send is on the sheet, word for word.
      expect(whatNow(h.line())).toEqual({ yes: 'send it', buttons: ['Wait until Monday', 'Let it go'], paper: ['Hi Sam,', 'Following up on my note below. Could you let me know by Friday?', 'Thanks,', 'Vieri'] });
      h.advance(48 * HOUR);
      await h.standing.tick();
      await settle();
      expect(h.sent.length).toBe(1);
      expect(h.standing.chase(id)).toMatchObject({ state: 'stuck', nudges: 1 });
    });

    test('"Send the follow-up" burns a fuse, and then the follow-up that was shown goes', async () => {
      const h = harness({ waitMs: 60_000 });
      const id = await handedBack(h);
      await h.reply('yes');
      expect(h.line()).toMatchObject({ kind: 'send', ms: NOTCH_CHASE_FUSE_MS });
      expect(h.said()).toBe('Sending Sam the follow-up…');
      expect(h.sent.length).toBe(1);
      await h.reply('done');
      await settle();
      expect(h.looks()).toBe(1);
      expect(h.sent.length).toBe(2);
      expect(h.sent[1]!.text).toContain('Following up on my note below.');
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', nudges: 2, stuck: null });
    });

    test('Esc in that fuse sends nothing, and the question is still there', async () => {
      const h = harness({ waitMs: 60_000 });
      const id = await handedBack(h);
      await h.reply('yes');
      await h.reply('undo');
      expect(h.said()).toBe('Taken back. Nothing was sent.');
      expect(h.sent.length).toBe(1);
      expect(h.standing.chase(id)).toMatchObject({ state: 'stuck' });
      expect(h.inbox.has(`chase-stuck-${id}`)).toBe(true);
    });

    test('with everything stopped, "send it" burns no fuse and sends nothing', async () => {
      let paused = false;
      const h = harness({ waitMs: 60_000, paused: () => paused });
      await handedBack(h);
      paused = true;
      await h.reply('yes');
      expect(h.line()?.kind).not.toBe('send');
      expect(h.said()).toBe('Everything is stopped. Wake me first.');
      expect(h.sent.length).toBe(1);
    });

    test('"Wait until Monday" says that the follow-up goes then, and "Let it go" ends it', async () => {
      const h = harness({ waitMs: 60_000 });
      const id = await handedBack(h);
      await h.reply('button', { button: 'monday' });
      expect(h.said()).toBe('Waiting until Monday. If nothing has come by then, the follow-up goes.');
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', stuck: null });
      const other = harness({ waitMs: 60_000 });
      const dropped = await handedBack(other);
      await other.reply('button', { button: 'drop' });
      expect(other.standing.chase(dropped)).toMatchObject({ state: 'dropped' });
    });

    test('with both mails gone already there is no follow-up to offer', async () => {
      const h = harness({ waitMs: 60_000 });
      await started(h);
      await h.pass(9000);
      h.advance(60_000);
      await h.standing.tick();
      const id = h.standing.handable()[0]!.id;
      expect(h.standing.chase(id)!.nudges).toBe(2);
      h.standing.hand(id, 'Leo');
      h.standing.back(id, [], 'Leo');
      await settle();
      expect(h.said()).toBe("Leo handed Sam's answer back. What now?");
      expect((h.line() as Extract<NotchLine, { kind: 'offer' }>).options).toEqual(['Call Sam', 'Wait until Monday', 'Let it go']);
    });
  });

  // A stuck chase asked its question from memory only. After a restart it asked nothing, could not
  // be answered, and "I am already on that" met every new chase of that person.
  describe('stuck, and the brain restarts', () => {
    test('the question is asked again, as it was: why it was stuck is kept', async () => {
      const db = new Database(':memory:');
      const h = harness({ db, waitMs: 60_000, send: [{ ok: true }, { ok: false, why: 'the thread did not open', pressed: false }, { ok: true }] });
      await started(h);
      await h.pass(9000);
      h.advance(60_000);
      await h.standing.tick();
      await settle();
      expect(h.said()).toBe('I could not send Sam the follow-up: the thread did not open. What now?');
      h.standing.stop();
      const again = harness({ db, waitMs: 60_000 });
      await settle();
      expect(again.said()).toBe('I could not send Sam the follow-up: the thread did not open. What now?');
      expect(whatNow(again.line())).toMatchObject({ yes: 'try again', buttons: ['Let it go'] });
      await again.reply('button', { button: 'drop' });
      expect(again.standing.counts().chases).toBe(0);
    });

    test('one that was handed back asks its own question again', async () => {
      const db = new Database(':memory:');
      const h = harness({ db, waitMs: 60_000 });
      await started(h);
      await h.pass(9000);
      const id = h.standing.handable()[0]!.id;
      h.standing.hand(id, 'Leo');
      h.standing.back(id, [], 'Leo');
      h.standing.stop();
      const again = harness({ db, waitMs: 60_000 });
      await settle();
      expect(again.said()).toBe("Leo handed Sam's answer back. What now?");
    });

    test('a table from before the reason was kept is given the column, and its stuck chase still asks', async () => {
      const db = new Database(':memory:');
      db.run(`CREATE TABLE notch_chases (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, thing TEXT NOT NULL,
        about TEXT NOT NULL, day TEXT NOT NULL, by_at INTEGER NOT NULL, thread TEXT, subject TEXT NOT NULL, state TEXT NOT NULL,
        nudges INTEGER NOT NULL, next_at INTEGER NOT NULL, steps TEXT NOT NULL, updated_at INTEGER NOT NULL
      )`);
      db.run("INSERT INTO notch_chases VALUES ('c1', 1, 'Sam Rivers', 'sam@northwind.example', 'answer', '', 'Friday', 2, NULL, '', 'stuck', 2, 0, '[]', 1)");
      const h = harness({ db });
      await settle();
      expect(h.said()).toBe('2 nudges and nothing from Sam. What now?');
      expect(h.standing.chase('c1')).toMatchObject({ state: 'stuck', stuck: null });
    });
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
    const h = harness({ send: [{ ok: false, why: 'the writing window did not open as expected', pressed: false }] });
    await started(h);
    expect(h.said()).toBe('I could not send it: the writing window did not open as expected. Nothing was started.');
    expect(h.standing.counts().chases).toBe(0);
  });

  test('a follow-up that cannot be sent is said, with a way to try again', async () => {
    const h = harness({ waitMs: 60_000, send: [{ ok: true }, { ok: false, why: 'the thread did not open', pressed: false }, { ok: true }] });
    await started(h);
    await h.pass(9000);
    h.advance(60_000);
    await h.standing.tick();
    await settle();
    expect(h.said()).toBe('I could not send Sam the follow-up: the thread did not open. What now?');
    // What "try again" sends is on the sheet.
    expect(whatNow(h.line())).toEqual({ yes: 'try again', buttons: ['Let it go'], paper: ['Hi Sam,', 'Following up on my note below. Could you let me know by Friday?', 'Thanks,', 'Vieri'] });
    await h.reply('yes');
    // README 22: "Try again" is a yes to a mail, and had no fuse.
    expect(h.line()).toMatchObject({ kind: 'send', ms: NOTCH_CHASE_FUSE_MS });
    expect(h.said()).toBe('Sending Sam the follow-up…');
    expect(h.sent.length).toBe(2);
    // Nothing was pressed the first time: there is nothing to look for.
    expect(h.asked).toEqual([]);
    await h.reply('done');
    await settle();
    expect(h.sent.length).toBe(3);
    expect(h.standing.counts().chases).toBe(1);
  });

  test('Esc in the fuse of "try again" sends nothing, and the question is still there', async () => {
    const h = harness({ waitMs: 60_000, send: [{ ok: true }, { ok: false, why: 'the thread did not open', pressed: false }] });
    await started(h);
    await h.pass(9000);
    h.advance(60_000);
    await h.standing.tick();
    await settle();
    await h.reply('yes');
    await h.reply('undo');
    expect(h.said()).toBe('Taken back. Nothing was sent.');
    expect(h.sent.length).toBe(2);
    expect(h.standing.handable()[0]).toMatchObject({ state: 'stuck' });
  });

  // The review of 26 November 2026. Send was pressed and nothing confirmed the mail: it was said
  // "could not be sent" and "Nothing was started", and the next try sent the same mail again.
  describe('a mail that may have gone', () => {
    const UNSURE = { ok: false as const, why: 'Gmail did not confirm it went. Look in the thread before trying again', pressed: true, since: MONDAY - 5000 };

    /** A chase whose follow-up was pressed and not confirmed, with its question up. */
    async function followUpUnsure(h: ReturnType<typeof harness>): Promise<string> {
      await started(h);
      await h.pass(9000);
      h.advance(60_000);
      await h.standing.tick();
      await settle();
      return h.standing.handable()[0]!.id;
    }

    test('the follow-up: it is said that it may have gone, not that it could not be sent, and when to look from is kept', async () => {
      const db = new Database(':memory:');
      const h = harness({ db, waitMs: 60_000, send: [{ ok: true }, UNSURE] });
      const id = await followUpUnsure(h);
      expect(h.said()).toBe('The follow-up to Sam may have gone: Gmail did not confirm it. What now?');
      expect(whatNow(h.line())).toMatchObject({ yes: 'try again', buttons: ['Let it go'] });
      expect(h.standing.chase(id)).toMatchObject({ state: 'stuck', nudges: 1, stuck: { kind: 'send', unsure: { since: MONDAY - 5000 } } });
      expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('The follow-up may have gone: Gmail did not confirm it.');
      // It is the same question after a restart, with the same moment to look from.
      h.standing.stop();
      const again = harness({ db, waitMs: 60_000 });
      await settle();
      expect(again.said()).toBe('The follow-up to Sam may have gone: Gmail did not confirm it. What now?');
      expect(again.standing.chase(id)!.stuck).toEqual({ kind: 'send', why: UNSURE.why, unsure: { since: MONDAY - 5000 } });
    });

    test('"try again" looks first: a mail that is there is counted, and nothing is sent a second time', async () => {
      const h = harness({ waitMs: 60_000, send: [{ ok: true }, UNSURE], went: [true] });
      const id = await followUpUnsure(h);
      await h.reply('yes');
      expect(h.asked).toEqual([{ thread: 'aaaaaaaaaaaaaaaa', since: MONDAY - 5000, text: 'Hi Sam,\n\nFollowing up on my note below. Could you let me know by Friday?\n\nThanks,\nVieri' }]);
      expect(h.said()).toBe('It had gone: it is in your mail. I did not send it again. Still on it.');
      expect(h.sent.length).toBe(2);
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', nudges: 2, stuck: null });
      expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('No answer yet. Sent a short follow-up.');
    });

    test('"try again" when it is not there: then the fuse, and then it is sent', async () => {
      const h = harness({ waitMs: 60_000, send: [{ ok: true }, UNSURE, { ok: true }], went: [false] });
      const id = await followUpUnsure(h);
      await h.reply('yes');
      expect(h.asked).toHaveLength(1);
      expect(h.line()).toMatchObject({ kind: 'send', ms: NOTCH_CHASE_FUSE_MS });
      expect(h.sent.length).toBe(2);
      await h.reply('done');
      await settle();
      expect(h.sent.length).toBe(3);
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', nudges: 2 });
    });

    test('"try again" when the mailbox cannot say: nothing is sent, and the question stays', async () => {
      const h = harness({ waitMs: 60_000, send: [{ ok: true }, UNSURE], went: [null] });
      const id = await followUpUnsure(h);
      await h.reply('yes');
      expect(h.said()).toBe('I cannot see whether it went, so I am not sending it again. Look in your mail, or ask me again in a moment.');
      expect(h.sent.length).toBe(2);
      expect(h.standing.chase(id)).toMatchObject({ state: 'stuck' });
    });

    test('a send that does not say whether it was pressed is one that may have gone', async () => {
      const h = harness({ waitMs: 60_000, send: [{ ok: true }, { ok: false, why: 'the page did not answer' }] });
      await followUpUnsure(h);
      expect(h.said()).toBe('The follow-up to Sam may have gone: Gmail did not confirm it. What now?');
    });

    test('the first mail: it is not "Nothing was started". The chase is kept, asks, and looks before it sends again', async () => {
      const h = harness({ send: [UNSURE], went: [true] });
      await started(h);
      expect(h.said()).toBe('The first mail to Sam may have gone: Gmail did not confirm it. I ask you what now.');
      // Kept: a second chase of Sam is refused while this one asks, so the same mail is not sent by another way.
      expect(h.standing.counts().chases).toBe(1);
      const id = h.standing.handable()[0]!.id;
      expect(h.standing.chase(id)).toMatchObject({ state: 'stuck', nudges: 0, stuck: { kind: 'send', unsure: { since: MONDAY - 5000 } } });
      await h.pass(9000);
      await h.speak("Get Sam's answer on the contract by Friday");
      expect(h.said()).toBe('I am already on that.');
      await h.pass(9000);
      // Its question came while the notch was saying so: the clock puts it up once the notch is free.
      await h.standing.tick();
      await settle();
      expect(h.said()).toBe('The first mail to Sam may have gone: Gmail did not confirm it. What now?');
      expect(whatNow(h.line()).paper).toEqual(['Hi Sam,', 'A quick nudge on the contract: could you get back to me by Friday?', 'Thanks,', 'Vieri']);
      await h.reply('yes');
      expect(h.asked.map((one) => one.since)).toEqual([MONDAY - 5000]);
      expect(h.sent.length).toBe(1);
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', nudges: 1 });
      expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('Nudged Sam by email.');
    });

    test('the first mail, not there after all: sent again as the first mail, and written down as that', async () => {
      const h = harness({ waitMs: 60_000, send: [UNSURE, { ok: true }], went: [false] });
      await started(h);
      await h.pass(9000);
      await h.standing.tick();
      await settle();
      const id = h.standing.handable()[0]!.id;
      await h.reply('yes');
      expect(h.said()).toBe('Sending Sam the first mail…');
      await h.reply('done');
      await settle();
      expect(h.sent.map((mail) => mail.text.includes('A quick nudge'))).toEqual([true, true]);
      expect(h.standing.chase(id)).toMatchObject({ state: 'on', nudges: 1 });
      expect(h.standing.chase(id)!.steps.at(-1)!.text).toBe('Nudged Sam by email.');
    });

    test('taken back, or let go: it is not said that nothing was sent', async () => {
      const h = harness({ send: [UNSURE] });
      await started(h);
      const id = h.standing.handable()[0]!.id;
      expect(text(h.standing.undo(`chase:${id}`) ?? [])).toBe('Stopped. I will not write to Sam again. The mail that may have gone is not taken back.');
      const other = harness({ send: [UNSURE] });
      await started(other);
      await other.pass(9000);
      await other.standing.tick();
      await settle();
      await other.reply('button', { button: 'drop' });
      expect(other.said()).toBe('Dropped. I will not chase it. The mail that may have gone is not taken back.');
    });

    test('a chase taken from somebody whose first mail may have gone is a chase here, and says so', async () => {
      const h = harness({ send: [UNSURE] });
      const draft = h.standing.drafted({ name: 'Dana Reyes', address: 'dana@acme.example', thing: 'answer', about: 'the renewal', day: 'Friday', steps: [], from: 'Sam' })!;
      let begun: Awaited<ReturnType<typeof h.standing.begin>> | null = null;
      h.inbox.present('take', async (stage) => { begun = await h.standing.begin(draft, stage); });
      await settle();
      await h.reply('done');
      expect(begun).toMatchObject({ ok: true, unsure: true });
      expect(h.standing.chase(draft.id)).toMatchObject({ state: 'stuck', nudges: 0 });
      // The taker's second yes cannot send it again: one for that person is not drafted while this one asks.
      expect(h.standing.drafted({ name: 'Dana Reyes', address: 'dana@acme.example', thing: 'answer', about: 'the renewal', day: 'Friday', steps: [], from: 'Sam' })).toBeNull();
    });
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
    await h.reply('done');
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
  const chase = async (h: ReturnType<typeof harness>): Promise<void> => { await h.speak("Get Sam's answer on the contract by Friday"); await h.reply('yes'); await h.reply('done'); await h.pass(9000); };

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
  const chase = async (h: ReturnType<typeof harness>): Promise<void> => { await h.speak("Get Sam's answer on the contract by Friday"); await h.reply('yes'); await h.reply('done'); await h.pass(9000); };

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

