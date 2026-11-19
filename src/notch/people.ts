/**
 * Your organisation: the people whose Jarvises may talk to each other.
 *
 * The prototype (v15, "Your organisation"): Home has a row for it; a sheet
 * lists who is in it; "Tell Leo the review moved" goes to his notch and
 * "Leo saw it." comes back; "Ask Leo: Thursday or Friday?" reaches him as a
 * line he answers with one key. This file is those scenes on the real thing.
 *
 * What carries the words is the collab engine behind src/peers/link.ts. Two
 * machines are joined by a code that one reads to the other, and each then
 * names the other. So an organisation here is: a name the first of them
 * gave it, and the people this machine was joined with. There is no list
 * kept anywhere else, no admin and no invitation by mail yet.
 *
 * The rules (docs/peers/README.md states them with their numbers):
 *
 *   - Saying is approval. "Tell Leo ..." goes with a window to take it back
 *     and no question. Nothing is sent that the person did not say, except
 *     three small notes: "seen" when they pressed ok on a message, the pick
 *     when they answered a question, and the organisation's name when
 *     somebody joined.
 *   - What another person wrote is shown, word for word, and nothing else is
 *     done with it. No model reads it and nothing runs on it.
 *   - A decision of the engine (sign in here? connect with this device?) is
 *     put on the notch as one line, and only the key pressed there answers it.
 *   - A pairing code is shown and typed on the notch. It is in no log, no
 *     list of what was asked, and no model sees it.
 *   - Not now is never no: a message or a question that was left alone waits
 *     in the count. One that was answered is never shown again.
 */
import type { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { NotchStageEnded } from './stage.ts';
import { engineErrorCode } from '../peers/link.ts';
import type { PeerDecision, PeerItem, PeerLink, PeerPerson, PeerSent } from '../peers/link.ts';
import { PEER_OPTIONS_MAX, PEER_OPTION_MAX, PEER_ORG_MAX, peerNoteRead, peerNoteText, peerPlain } from '../peers/notes.ts';
import type { PeerNote } from '../peers/notes.ts';
import type { PeerStore, PeerSentRow } from '../peers/store.ts';

const em = (text: string): NotchPart => ({ em: text });
const cap = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** The window in which something that is going to another person can be taken back. */
export const NOTCH_PEOPLE_FUSE_MS = 3000;
/** The longest name a person is given here. */
export const NOTCH_PEOPLE_NAME_MAX = 40;
/** The most of a message that is said on one line. A longer one is opened to be read. */
export const NOTCH_PEOPLE_LINE_MAX = 140;
/** The most of a message that is taken in at all. */
export const NOTCH_PEOPLE_TEXT_MAX = 2000;
/** The most that is sent as one message from the notch. */
export const NOTCH_PEOPLE_SAY_MAX = 600;
/** How long a question is out before its asker is told that no answer came. */
export const NOTCH_PEOPLE_ASK_WAIT_MS = 10 * 60_000;
/** How often what arrived is looked for when nothing announced it. */
export const NOTCH_PEOPLE_TICK_MS = 30_000;
/** How long signing in, and waiting for a code to be used, may take: a little more than the engine gives each. */
export const NOTCH_PEOPLE_SIGN_IN_MS = 6 * 60_000;
export const NOTCH_PEOPLE_CODE_MS = 12 * 60_000;

export interface NotchPeopleDeps {
  inbox: NotchInbox;
  link: PeerLink;
  store: PeerStore;
  /** Opens a page in the person's own browser, on the machine the answer came from. False when it could not. */
  openPage(sidecarId: string | null, url: string): Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
  /** For tests: no timer of its own. `tick` is then called by hand. */
  noClock?: boolean;
}

export interface NotchPeople {
  /** Home's row. Null while there is nothing to say about an organisation. */
  row(): NotchBlock | null;
  /** The organisation's sheet. Comes back when it is closed. */
  open(stage: NotchStage): Promise<void>;
  /** Words the notch acts on itself: "tell Leo ...", "ask Leo ...", "show my organisation". */
  route(text: string): { did: string; run(): void } | null;
  /** The people by name, for reading back a name that was heard and is close to one of theirs. */
  names(): { name: string }[];
  /** Takes in what arrived. */
  look(): Promise<void>;
  /** Looks, and tells the person of a question that got no answer. */
  tick(): Promise<void>;
  stop(): void;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A name as it is kept: letters, digits, spaces and a few marks, nothing that could be taken for words to act on. */
export function peopleName(text: string): string {
  return peerPlain(text, NOTCH_PEOPLE_NAME_MAX).replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * The answers a question carries, read off its words by rule.
 *
 *   "the review on Thursday or Friday?"     Thursday, Friday, Neither
 *   "this week or next week?"               This week, Next week, Neither
 *   "is the deck ready?"                    Yes, No
 *
 * Around the last "or", as many words are taken on its left as stand on its
 * right. A right side longer than four words is not a pair of answers: the
 * question is then one to say yes or no to.
 */
export function peopleOptions(question: string): string[] {
  const plain = question.replace(/[?.!\s]+$/, '');
  const at = plain.toLowerCase().lastIndexOf(' or ');
  if (at > 0) {
    const right = plain.slice(at + 4).trim().split(/\s+/).filter(Boolean);
    const before = plain.slice(0, at).trim().split(/\s+/).filter(Boolean);
    if (right.length >= 1 && right.length <= 4 && before.length >= right.length) {
      const left = before.slice(-right.length).join(' ').replace(/^[,;:]+|[,;:]+$/g, '');
      const options = [left, right.join(' ')].map((one) => cap(peerPlain(one, PEER_OPTION_MAX)));
      if (options.every(Boolean) && options[0]!.toLowerCase() !== options[1]!.toLowerCase()) return [...options, 'Neither'];
    }
  }
  return ['Yes', 'No'];
}

interface Addressed { person: PeerPerson; verb: string; words: string }

export function attachNotchPeople(deps: NotchPeopleDeps): NotchPeople {
  const { inbox, link, store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => { /* quiet */ });
  let looking: Promise<void> | null = null;
  let again = false;
  let refreshedAt = 0;
  /** Where each waiting arrival came from: an item is read again from the engine after a restart, never from here. */
  const timer = deps.noClock ? null : setInterval(() => { void tick(); }, NOTCH_PEOPLE_TICK_MS);
  (timer as { unref?: () => void } | null)?.unref?.();

  const person = (id: string): PeerPerson | null => link.people().find((one) => one.id === id) ?? null;
  const orgName = (): string | null => store.org();
  const others = (): PeerPerson[] => link.people();

  function sorry(sent: Extract<PeerSent, { ok: false }>): NotchPart[] {
    if (sent.why === 'signed_out') return ['You are signed out. Open your organisation in Home and sign in. It was not sent.'];
    if (sent.why === 'offline') return ['I have no line to the others now. It was not sent.'];
    if (sent.why === 'withheld') return ['Not sent.'];
    if (sent.why === 'down') return ['I cannot reach the others now. It was not sent.'];
    return ['That could not be sent.'];
  }

  // --- signing in and connecting ---

  /** Signs in at the engine's server. True when signed in at the end. */
  async function signIn(stage: NotchStage): Promise<boolean> {
    if (link.account().signedIn) return true;
    let opened: boolean | null = null;
    let waitId: string | null = null;
    const call = link.call('account', { action: 'login' }, {
      server: async (decision) => {
        const answer = await stage.offer(['Sign in at ', em(decision.host ?? 'the server'), '? What you send the others goes through it, sealed. It cannot be changed later.'], 'sign in');
        return answer.act === 'yes' ? { choice: 'yes' } : null;
      },
      page: async (decision) => {
        opened = decision.url ? await deps.openPage(stage.from(), decision.url) : false;
        if (!opened) return null;
        waitId = stage.id();
        stage.put({ id: waitId, kind: 'work', say: ['Sign in on the page I opened. I wait here.'], steps: 0, done: 0, mood: 'work' });
        return {};
      },
    }, NOTCH_PEOPLE_SIGN_IN_MS);
    let text = '';
    try { text = (await call).text; } catch (error) { if (error instanceof NotchStageEnded) throw error; }
    await link.refresh();
    if (link.account().signedIn || /^(Logged in:|Already logged in)/.test(text)) {
      await stage.say(['Signed in.'], 1600, { mark: 'check' });
      return true;
    }
    if (opened === false) await stage.say(['I could not open the sign-in page on this machine.'], 3200, { mood: 'sorry' });
    else if (opened) await stage.say(['That did not sign in. Try again from Home.'], 3200, { mood: 'sorry' });
    return false;
  }

  /** "Connect with this device? Name them." The name the person types is the only name the device ever has here. */
  function nameThem(stage: NotchStage, named: { name: string; reached?: boolean }) {
    return async (decision: PeerDecision): Promise<Record<string, unknown> | null> => {
      named.reached = true;
      let say: NotchPart[] = ['The code matched. Name them.'];
      for (;;) {
        const id = stage.id();
        stage.put({
          id, kind: 'ask', say, placeholder: 'Their name, for example Leo', yes: 'connect', focus: true, mood: 'look',
          blocks: [{ kind: 'note', say: decision.device ? ['The keys of that laptop were checked with the code. Its number begins ', em(decision.device.slice(0, 8)), '.'] : ['The keys of that laptop were checked with the code.'] }],
        });
        const answer = await stage.answer(id, ['ask', 'no']);
        if (answer.act !== 'ask') return { choice: 'reject' };
        const name = peopleName(answer.text ?? '');
        if (!name) { say = ['A name first. What do you call them?']; continue; }
        if (others().some((one) => one.name.toLowerCase() === name.toLowerCase() && one.id !== decision.device)) { say = ['You already call someone ', em(name), '. Another name.']; continue; }
        named.name = name;
        const waitId = stage.id();
        stage.put({ id: waitId, kind: 'work', say: ['Connecting with ', em(name), '…'], steps: 0, done: 0, mood: 'work' });
        return { choice: 'accept', localName: name };
      }
    };
  }

  function ownDevice(stage: NotchStage, named: { name: string }) {
    return async (): Promise<Record<string, unknown> | null> => {
      const answer = await stage.choose(['Is that another laptop of your own?'], ['Yes, mine', 'No']);
      if (answer.act !== 'pick') return null;
      return answer.index === 0 ? { choice: 'own_device', label: named.name || 'My laptop' } : { choice: 'not_own_device' };
    };
  }

  /** What the engine said at the end of connecting, as a line. True when two machines are joined. */
  async function connected(stage: NotchStage, text: string, named: { name: string }, opener: boolean): Promise<boolean> {
    if (!/^Connected with\b/.test(text)) {
      if (/^The user did not enter a code/.test(text)) return false;
      const code = engineErrorCode(text);
      if (code === 'not_connected' || code === 'not_logged_in') await stage.say(['I have no line to the server now. Try again in a moment.'], 3200, { mood: 'sorry' });
      else await stage.say(opener ? ['That did not connect. Make a new code and try again.'] : ['That did not connect. Ask for a new code and try again.'], 3600, { mood: 'sorry' });
      return false;
    }
    await link.refresh();
    const org = orgName();
    const name = named.name;
    // The organisation's name is the first thing to cross.
    const joined = others().find((one) => one.name === name);
    if (opener && org && joined) void link.tell(joined.id, peerNoteText(`Organisation: ${org}`, { kind: 'org', name: org }));
    await stage.say(opener && org ? [em(name), ' joined ', em(org), '. Your Jarvises can talk now.'] : ['Connected with ', em(name), '. Your Jarvises can talk now.'], 4000, { mood: 'proud', mark: 'check' });
    return true;
  }

  /** Makes a code for somebody to type, and waits until they did. */
  async function invite(stage: NotchStage): Promise<void> {
    if (!(await signIn(stage))) return;
    let code: string | null = null;
    let text = '';
    try {
      text = (await link.call('connect', { action: 'open' }, { code_shown: async (decision) => { code = decision.code ?? null; return { choice: 'done' }; } }, 60_000)).text;
    } catch (error) { if (error instanceof NotchStageEnded) throw error; }
    if (!code) {
      const why = engineErrorCode(text);
      await stage.say(why === 'not_connected' || why === 'not_logged_in' ? ['I have no line to the server now. Try again in a moment.'] : ['I could not make a code now.'], 3200, { mood: 'sorry' });
      return;
    }
    const named: { name: string; reached?: boolean } = { name: '' };
    const waitId = stage.id();
    stage.put({ id: waitId, kind: 'work', say: ['Read them this code: ', em(code), '. They open their organisation and choose "Join with a code".'], steps: 0, done: 0, mood: 'look' });
    let stopped = false;
    const stop = stage.answer(waitId, ['stop', 'no']).then(async () => {
      stopped = true;
      // The window is closed: nobody can use the code any more.
      try { await link.call('connect', { action: 'cancel' }, {}, 15_000); } catch { /* it closes by itself in ten minutes */ }
    }, () => { /* the stage ended, or another line took its place */ });
    let outcome = '';
    try {
      outcome = (await link.call('connect', { action: 'wait' }, { connect: nameThem(stage, named), own_device: ownDevice(stage, named) }, NOTCH_PEOPLE_CODE_MS)).text;
    } catch (error) { if (error instanceof NotchStageEnded) throw error; }
    void stop;
    if (stopped) { await stage.say(['The code is closed. Nobody can use it now.'], 2600); return; }
    if (!named.reached && !/^Connected with\b/.test(outcome)) { await stage.say(['Nobody used the code. It is closed now.'], 3000); return; }
    await connected(stage, outcome, named, true);
  }

  /** Types the code somebody read out. */
  async function join(stage: NotchStage): Promise<void> {
    if (!(await signIn(stage))) return;
    const named = { name: '' };
    let text = '';
    try {
      text = (await link.call('connect', { action: 'code' }, {
        code_wanted: async () => {
          const id = stage.id();
          stage.put({ id, kind: 'ask', say: ['Type the code they read to you.'], placeholder: 'like sam#12-3456', yes: 'join', focus: true, mood: 'listen', blocks: [] });
          const answer = await stage.answer(id, ['ask', 'no']);
          const typed = answer.act === 'ask' ? (answer.text ?? '').trim() : '';
          if (!typed) return null;
          const waitId = stage.id();
          stage.put({ id: waitId, kind: 'work', say: ['Checking the code with their laptop…'], steps: 0, done: 0, mood: 'work' });
          return { code: typed };
        },
        connect: nameThem(stage, named),
        own_device: ownDevice(stage, named),
      }, NOTCH_PEOPLE_CODE_MS)).text;
    } catch (error) { if (error instanceof NotchStageEnded) throw error; }
    await connected(stage, text, named, false);
  }

  // --- the sheet ---

  function row(): NotchBlock | null {
    const account = link.account();
    const people = others();
    const org = orgName();
    if (account.engine !== 'up') return org ? { kind: 'row', id: 'people', say: [em(org), ': not reachable right now.'] } : null;
    if (!people.length) return { kind: 'row', id: 'people', say: ['Make an organisation, so your Jarvises can talk.'], go: true };
    return { kind: 'row', id: 'people', say: [em(org ?? 'Your organisation'), ': you and ', em(people.map((one) => one.name).join(', ')), '.'], go: true };
  }

  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const account = link.account();
      const people = others();
      const org = orgName();
      if (account.engine !== 'up') { await stage.say(['I cannot reach the others right now.'], 2600, { mood: 'sorry' }); return; }
      if (!org && !people.length) {
        const id = stage.id();
        stage.put({
          id, kind: 'ask', say: ['Make an organisation'], placeholder: 'Name it, for example Northwind', yes: 'make', focus: true, mood: 'look',
          blocks: [
            { kind: 'note', say: ['An organisation is the people whose Jarvises may talk to each other.'] },
            { kind: 'buttons', buttons: [{ id: 'join', label: 'Join one with a code' }] },
          ],
        });
        const answer = await stage.answer(id, ['ask', 'button', 'no']);
        if (answer.act === 'button' && answer.button === 'join') { await join(stage); if (!others().length) return; continue; }
        if (answer.act !== 'ask') return;
        const name = peerPlain(answer.text ?? '', PEER_ORG_MAX);
        if (!name) continue;
        store.setOrg(name);
        if (!(await signIn(stage))) return;
        continue;
      }
      const id = stage.id();
      stage.put({
        id, kind: 'sheet', say: org ? [em(org), ', your organisation'] : ['Your organisation'], mood: 'look',
        blocks: [
          { kind: 'row', lead: 'You', say: ['This laptop'], small: 'You say yes or no to what is asked of it.' },
          ...people.map((one): NotchBlock => ({ kind: 'row', lead: one.name.charAt(0).toUpperCase(), say: [one.name], small: one.own ? 'Your own laptop.' : 'Connected by a code. Asks you every time.' })),
          ...(account.signedIn ? [] : [{ kind: 'note' as const, say: ['You are signed out. Nothing goes out and nothing comes in until you sign in.'] }]),
          { kind: 'buttons', buttons: [
            ...(account.signedIn ? [] : [{ id: 'signin', label: 'Sign in' }]),
            { id: 'invite', label: 'Invite someone' },
            { id: 'join', label: 'Join with a code' },
          ] },
        ],
      });
      const answer = await stage.answer(id, ['button', 'no', 'yes']);
      if (answer.act !== 'button') return;
      if (answer.button === 'signin') { await signIn(stage); continue; }
      if (answer.button === 'invite') { await invite(stage); continue; }
      if (answer.button === 'join') { await join(stage); continue; }
      return;
    }
  }

  // --- telling and asking ---

  /** Whose name stands after "tell", and what follows it. */
  function addressed(text: string): Addressed | null {
    const said = text.trim().replace(/\s+/g, ' ');
    // The longest name first, so that "Leo Rossi" is not taken for "Leo" and the rest for words.
    const people = others().slice().sort((a, b) => b.name.length - a.name.length);
    for (const one of people) {
      const first = one.name.split(' ')[0]!;
      const alone = people.filter((other) => other.name.split(' ')[0]!.toLowerCase() === first.toLowerCase()).length === 1;
      for (const name of alone && first !== one.name ? [one.name, first] : [one.name]) {
        const found = new RegExp(`^(?:(?:please|ok|okay|hey|jarvis|can you|could you|would you)[,\\s]+)*(tell|message|ping|ask)\\s+${escaped(name)}(?![\\p{L}\\p{N}'])[\\s,:]*(.*)$`, 'iu').exec(said);
        if (found) return { person: one, verb: found[1]!.toLowerCase(), words: found[2]!.replace(/^that\s+/i, '').trim() };
      }
    }
    return null;
  }

  function tell(to: PeerPerson, words: string): void {
    inbox.present('people-tell', async (stage) => {
      const went = await stage.fuse(['Telling ', em(to.name), ': ', words, '…'], NOTCH_PEOPLE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was sent.'], 2000); return; }
      // Nobody saw the line burn: what nobody may have seen does not go out.
      if (went === 'lost') return;
      const sent = await link.tell(to.id, words);
      if (!sent.ok) { await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.sent({ id: sent.id, to: to.id, kind: 'tell', words });
      await stage.say(sent.delivered ? ['Sent to ', em(to.name), '. I will tell you when it is seen.'] : ['Sent. It waits until ', em(`${to.name}'s`), ' Jarvis is on.'], 2800, { mark: 'check' });
    });
  }

  function ask(to: PeerPerson, asked: string, firstId?: string): void {
    const question = /[?]$/.test(asked) ? asked : `${asked.replace(/[.!\s]+$/, '')}?`;
    const options = peopleOptions(question).slice(0, PEER_OPTIONS_MAX);
    inbox.present('people-ask', async (stage) => {
      const went = await stage.fuse(['Asking ', em(to.name), ': ', question, ' One key answers: ', em(options.join(', ')), '.'], NOTCH_PEOPLE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was asked.'], 2000); return; }
      if (went === 'lost') return;
      const sent = await link.tell(to.id, peerNoteText(question, { kind: 'ask', options }));
      if (!sent.ok) { await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.sent({ id: sent.id, to: to.id, kind: 'ask', words: question, options, ...(firstId ? { again: firstId } : {}) });
      await stage.say(firstId ? ['Asked again.'] : sent.delivered ? ['Asked ', em(to.name), '. I will tell you the answer.'] : ['Asked. It waits until ', em(`${to.name}'s`), ' Jarvis is on.'], 2800, { mark: 'check' });
    });
  }

  function route(text: string): { did: string; run(): void } | null {
    const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
    if (/^(?:(?:please|ok|okay|hey|jarvis)[,\s]+)*(?:(?:make|create|start|set up|show|open)(?: me)? (?:an|my|our|the) organi[sz]ation|(?:my|our) organi[sz]ation|invite (?:someone|somebody)(?: to (?:my|our|the) organi[sz]ation)?|connect (?:with|to) (?:someone|somebody|another jarvis)|join (?:an|the) organi[sz]ation)$/.test(said)) {
      return { did: 'Open the organisation.', run: () => { inbox.present('people', (stage) => open(stage)); } };
    }
    const to = addressed(text);
    if (!to) return null;
    // What is asked of their Jarvis, or of their laptop, is a request: not a word to the person.
    if (/^'s\b/i.test(to.words)) return null;
    const words = cap(peerPlain(to.words, NOTCH_PEOPLE_SAY_MAX));
    if (!words) {
      return { did: `Tell ${to.person.name} something.`, run: () => { inbox.present('people-what', (stage) => stage.say([cap(to.verb), ' ', em(to.person.name), ' what? Say it after the name.'], 3200, { mood: 'confused' })); } };
    }
    if (to.verb === 'ask' || /\sor\s/i.test(words)) return { did: `Ask ${to.person.name}: ${words}`, run: () => ask(to.person, words) };
    return { did: `Tell ${to.person.name}: ${words}`, run: () => tell(to.person, words) };
  }

  // --- what arrives ---

  /** News that is said once: somebody saw it, somebody answered, somebody joined. */
  function news(id: string, title: NotchPart[], say: NotchPart[], more: { person?: boolean; who?: string; ms?: number } = {}): void {
    inbox.add({
      id, subject: id, class: more.person ? 'person' : 'rest', speaks: true, once: true,
      title: () => title,
      play: async (stage) => { await stage.say(say, more.ms ?? 3200, { mark: 'check', ...(more.who ? { who: more.who } : {}) }); return 'settled'; },
    });
  }

  function message(item: PeerItem, from: PeerPerson, words: string): void {
    const shown = peerPlain(words, NOTCH_PEOPLE_TEXT_MAX);
    inbox.add({
      id: `people:${item.id}`, subject: `people:${item.id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ': ', shown.length > 60 ? `${shown.slice(0, 59)}…` : shown],
      check: () => store.got(item.id)?.done !== true,
      play: async (stage) => {
        if (shown.length > NOTCH_PEOPLE_LINE_MAX) {
          const first = await stage.offer([em(from.name), ' wrote to you. Read it?'], 'read', { who: from.name, mood: 'look' });
          if (first.act !== 'yes') return 'waits';
          await stage.sheet([em(from.name)], [{ kind: 'paper', lines: [[shown]] }], { who: from.name });
        } else {
          const answer = await stage.offer([em(from.name), ': ', shown], 'ok', { who: from.name, mood: 'look' });
          if (answer.act !== 'yes') return 'waits';
        }
        store.done(item.id);
        // "Seen" goes back because they pressed ok on it. It is the only thing that goes.
        void link.tell(item.from, peerNoteText('Seen.', { kind: 'seen' }), { replyTo: item.id });
        void link.seen(item.id);
        await stage.say(['Seen.'], 900, { who: from.name });
        return 'settled';
      },
    });
  }

  function question(item: PeerItem, from: PeerPerson, words: string, options: string[]): void {
    const shown = peerPlain(words, NOTCH_PEOPLE_LINE_MAX * 2);
    inbox.add({
      id: `people:${item.id}`, subject: `people:${item.id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' asks: ', shown.length > 60 ? `${shown.slice(0, 59)}…` : shown],
      check: () => store.got(item.id)?.done !== true,
      play: async (stage) => {
        const answer = await stage.choose([em(from.name), ' asks: ', shown], options, { who: from.name, mood: 'look' });
        const pick = answer.act === 'pick' && typeof answer.index === 'number' ? options[answer.index] : undefined;
        if (!pick) return 'waits';
        const sent = await link.tell(item.from, peerNoteText(pick, { kind: 'answer', pick }), { replyTo: item.id });
        if (!sent.ok) { await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' }); return 'waits'; }
        store.done(item.id);
        void link.seen(item.id);
        await stage.say(['Told ', em(from.name), ': ', em(pick), '.'], 2600, { mark: 'check', who: from.name });
        return 'settled';
      },
    });
  }

  /** Something that was sent got an answer of its own kind. `replyTo` names it. */
  function answered(item: PeerItem, from: PeerPerson, note: PeerNote): void {
    const sent = item.replyTo ? store.sentTo(item.replyTo, item.from) : null;
    if (note.kind === 'seen') {
      if (sent && store.mark(sent.id, 'seen') && sent.kind === 'tell') news(`people:seen:${sent.id}`, [em(from.name), ' saw it.'], [em(from.name), ' saw it.'], { who: from.name, ms: 2400 });
      return;
    }
    if (note.kind === 'answer') {
      // Only one of the answers that were offered is an answer. Anything else is somebody else's words.
      const pick = sent?.kind === 'ask' ? sent.options.find((one) => one.toLowerCase() === note.pick.toLowerCase()) : undefined;
      if (!sent || !pick || !store.mark(sent.id, 'answered', pick)) return;
      inbox.remove(`people:late:${sent.id}`);
      const say: NotchPart[] = pick === 'Neither' ? [em(from.name), ': neither works.'] : [em(from.name), ' says ', em(pick), '.'];
      news(`people:answer:${sent.id}`, say, say, { person: true, who: from.name, ms: 4200 });
      return;
    }
    if (note.kind === 'back') {
      // Their question is taken back: it leaves, whether it was on the notch or in the count.
      if (!item.replyTo || store.got(item.replyTo)?.done) return;
      store.done(item.replyTo);
      if (inbox.remove(`people:${item.replyTo}`)) news(`people:back:${item.replyTo}`, [em(from.name), ' took it back.'], [em(from.name), ' took it back.'], { who: from.name, ms: 2400 });
      return;
    }
    // The name of the organisation they were joined into. Taken when this machine has none; said by nothing:
    // "Connected with ..." was the line for it, and Home shows the name from now on.
    if (note.kind === 'org' && !orgName()) { store.setOrg(note.name); inbox.refresh(); }
  }

  async function lookNow(): Promise<void> {
    if (link.account().engine !== 'up' || !link.account().signedIn) return;
    let items: PeerItem[];
    try { items = await link.unread(); } catch { log('[notch] what arrived from the others could not be read'); return; }
    for (const item of items) {
      if (item.kind !== 'message') continue;
      const known = store.got(item.id);
      if (known?.done) { void link.seen(item.id); continue; }
      if (known && inbox.has(`people:${item.id}`)) continue;
      let from = person(item.from);
      if (!from && now() - refreshedAt > NOTCH_PEOPLE_TICK_MS) { refreshedAt = now(); await link.refresh(); from = person(item.from); }
      // From a device that has no name here: not somebody the owner connected with. Left where it is.
      if (!from) continue;
      store.take(item.id, item.from);
      const { words, note } = peerNoteRead(item.text);
      if (note && note.kind !== 'ask') {
        answered(item, from, note);
        store.done(item.id);
        void link.seen(item.id);
      } else if (note) question(item, from, words, note.options);
      else message(item, from, words);
    }
  }

  function look(): Promise<void> {
    if (looking) { again = true; return looking; }
    looking = (async () => {
      try {
        do { again = false; await lookNow(); } while (again);
      } finally { looking = null; }
    })();
    return looking;
  }

  /** A question that is out too long: its asker is told once, and says what becomes of it. */
  function late(sent: PeerSentRow): void {
    const to = person(sent.to);
    if (!to) return;
    store.nudged(sent.id);
    inbox.add({
      id: `people:late:${sent.id}`, subject: `people:late:${sent.id}`, class: 'rest', speaks: true,
      title: () => [em(to.name), ' has not answered.'],
      check: () => { const row = store.sentTo(sent.id, sent.to); return !!row && (row.state === 'sent' || row.state === 'seen'); },
      play: async (stage) => {
        const answer = await stage.choose([em(to.name), ' has not answered. Ask again, or take it back?'], ['Ask again', 'Wait', 'Take it back'], { who: to.name });
        if (answer.act !== 'pick') return 'waits';
        if (answer.index === 0) { inbox.after(() => ask(to, sent.words, sent.id)); return 'settled'; }
        if (answer.index === 1) { await stage.say(['It waits. I will tell you when ', em(to.name), ' answers.'], 3000); return 'settled'; }
        const back = await link.tell(to.id, peerNoteText('Taken back.', { kind: 'back' }), { replyTo: sent.id });
        if (!back.ok) { await stage.say(sorry(back), 3200, { mood: 'sorry' }); return 'waits'; }
        store.mark(sent.id, 'back');
        await stage.say(['Taken back. ', em(to.name), ' will not be asked.'], 2800);
        return 'settled';
      },
    });
  }

  async function tick(): Promise<void> {
    await look();
    for (const sent of store.unanswered(now() - NOTCH_PEOPLE_ASK_WAIT_MS)) late(sent);
  }

  link.onArrival(() => { void look(); });
  link.onChange(() => { inbox.refresh(); void look(); });

  return {
    row, open, route, look, tick,
    names: () => others().map((one) => ({ name: one.name })),
    stop() { if (timer) clearInterval(timer); },
  };
}
