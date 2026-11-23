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
 *     One exception: whoever makes an organisation is signed in at the server
 *     their own machine runs without that line. Making it was the yes.
 *   - A pairing code is shown and typed on the notch. It is in no log, no
 *     list of what was asked, and no model sees it.
 *   - Not now is never no: a message or a question that was left alone waits
 *     in the count. One that was answered is never shown again.
 *
 * GETTING IN (src/peers/setup.ts, given as `setup`). Whoever makes an
 * organisation hosts it: "Make an organisation" starts its server on this
 * machine, and a row in Home turns it off and on. Whoever is invited gets
 * three things from the host (the address, a name, a password, shown once on
 * the host's notch) and "Join an organisation" takes the engine from that
 * address. Without `setup` the engine is one that was named by hand, at a
 * server somebody else runs, and none of that is offered.
 *
 * A REQUEST is the other thing that crosses: "Ask Leo's Pillow what changed
 * in the last deck." It is asked of the other person's Jarvis, not of the
 * person, and three things hold for it on the side that is asked:
 *
 *   - Nothing is done before the person there said yes. Their line is the
 *     engine's own question, and the request is opened only when that line
 *     is about to be shown, so that the yes is given to what is on the notch.
 *   - What is found is shown before it goes: "Send only that?". Only a yes
 *     sends it, and it sends exactly what was shown.
 *   - The work is reading and looking. Whatever would change the machine or
 *     reach somebody stops for an approval of its own (src/daemon/notch-peers.ts).
 */
import type { NotchInbox } from './inbox.ts';
import { attachNotchPeopleFiles, isFileNote } from './people-files.ts';
import type { PeerFileFound } from './people-files.ts';
import { NOTCH_NAME } from './name.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { NotchStageEnded } from './stage.ts';
import { peerLoginName } from '../peers/host.ts';
import { ENGINE_TARGET_SAID, peerServerAddress } from '../peers/install.ts';
import { PEER_READ_MS, engineErrorCode } from '../peers/link.ts';
import type { PeerDecision, PeerItem, PeerLink, PeerPerson, PeerRequest, PeerSent } from '../peers/link.ts';
import { PEER_FILE_WHAT_MAX, PEER_OPTIONS_MAX, PEER_OPTION_MAX, PEER_ORG_MAX, peerNoteRead, peerNoteText, peerPlain } from '../peers/notes.ts';
import type { PeerNote } from '../peers/notes.ts';
import type { PeerSetupLike, SetupHosted, SetupJoined, SetupStep } from '../peers/setup.ts';
import type { PeerRequestRow, PeerStore, PeerSentRow } from '../peers/store.ts';

const em = (text: string): NotchPart => ({ em: text });
const cap = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** The window in which something that is going to another person can be taken back. */
export const NOTCH_PEOPLE_FUSE_MS = 3000;
/** The longest name a person is given here. */
export const NOTCH_PEOPLE_NAME_MAX = 40;
/**
 * The most of a message that is said on one line. A longer one is opened to
 * be read: the notch shows about three lines of a sentence and fades the rest,
 * so anything that must be read whole and is longer than this goes on a sheet.
 */
export const NOTCH_PEOPLE_LINE_MAX = 140;
/** The most of the person's own words that the line shows while they go out. All of them go; the line has three lines. */
export const NOTCH_PEOPLE_GOING_MAX = 110;
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
/** How long the engine has to come back with its first question before the notch stops waiting on it. */
export const NOTCH_PEOPLE_ENGINE_WAIT_MS = 20_000;
/** The most of a request that can be read here. A longer one cannot be said yes to on the notch. */
export const NOTCH_PEOPLE_REQUEST_MAX = 2000;
/** The most of an answer that is shown before it goes, and so the most that goes. */
export const NOTCH_PEOPLE_ANSWER_MAX = 4000;
/** How often an answer is looked for while a request is out. */
export const NOTCH_PEOPLE_FOLLOW_MS = 5000;

export interface NotchPeopleDeps {
  inbox: NotchInbox;
  link: PeerLink;
  store: PeerStore;
  /** Opens a page in the person's own browser, on the machine the answer came from. False when it could not. */
  openPage(sidecarId: string | null, url: string): Promise<boolean>;
  /**
   * Does a request the person said yes to, and gives its answer as text
   * (src/daemon/notch-peers.ts). `from` is the owner's name for who asked.
   * Without it nothing can be done here, and a request that was said yes to
   * ends with a no.
   */
  work?: (request: { from: string; words: string }) => Promise<{ ok: true; answer: string } | { ok: false }>;
  /** Getting in: the engine put in place, and the server for whoever makes an organisation (src/peers/setup.ts). */
  setup?: PeerSetupLike;
  /**
   * Files between Pillows (./people-files.ts): a folder of the brain's own
   * to keep one in while it crosses, and how one that arrived is put where
   * the person finds it. Without it no file is offered and none is taken.
   */
  files?: {
    dir: string;
    save(name: string, bytes: Uint8Array): Promise<{ place: string; name: string } | null>;
    /** Hands a file that arrived to the notch, to be held like a dropped one. True when it was taken. */
    arrived?: (file: { name: string; bytes: Uint8Array; from: string; place: string | null }) => boolean;
    /** Looks on this laptop for the files that fit some words. Null when it cannot look. */
    find?: (words: string) => Promise<PeerFileFound[] | null>;
    /** Takes one of them from its folder. */
    open?: (place: PeerFileFound['place'], name: string, dir: string) => Promise<Uint8Array | null>;
    /** One bounded question to the model: which of the files is meant. */
    think?: (messages: { role: 'system' | 'user'; content: string }[], signal?: AbortSignal) => Promise<string>;
    /** The line that is remembered about a file the owner once had read. */
    known?: (place: PeerFileFound['place'], name: string) => string | null;
    paceMs?: number; retryMs?: number;
  };
  log?: (line: string) => void;
  now?: () => number;
  /** How long the engine has to come back with its first question. For tests; NOTCH_PEOPLE_ENGINE_WAIT_MS otherwise. */
  engineWaitMs?: number;
  /** For tests: no timer of its own. `tick` is then called by hand. */
  noClock?: boolean;
}

export interface NotchPeople {
  /** Home's row. Null while there is nothing to say about an organisation. */
  row(): NotchBlock | null;
  /** Home's rows: that one, and the server's when this machine runs it. */
  rows(): NotchBlock[];
  /** The organisation's sheet. Comes back when it is closed. */
  open(stage: NotchStage): Promise<void>;
  /** The server's row in Home: stops it when it is on, starts it when it is off. */
  server(stage: NotchStage): Promise<void>;
  /** Words the notch acts on itself: "tell Leo ...", "ask Leo ...", "show my organisation". */
  route(text: string): { did: string; run(): void } | null;
  /** The people by name, for reading back a name that was heard and is close to one of theirs. */
  names(): { name: string }[];
  /** Who a file can be sent to: nobody while files are not set up, or while nothing can go out. */
  fileTargets(): { id: string; name: string }[];
  /** Offers a file to one of them. False when that person is not there. */
  sendFile(to: string, file: { name: string; bytes: Uint8Array }): boolean;
  /** Every piece of every file that is crossing has gone. For tests. */
  filesIdle(): Promise<void>;
  /** Takes in what arrived. */
  look(): Promise<void>;
  /** Looks, and tells the person of a question that got no answer. */
  tick(): Promise<void>;
  stop(): void;
}

/** The beginning of a text, with a mark that it goes on, for a line that has no room for all of it. */
const beginning = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

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

/** What their machine is called when something is asked of it. */
const MACHINE = '(?:jarvis|pillow|laptop|computer|machine|mac|pc)';

/** Text for a sheet: line by line, each made readable, cut to `max` in all. */
export function peopleLines(text: string, max: number): string[] {
  const lines: string[] = [];
  let left = max;
  for (const raw of text.split(/\r?\n/)) {
    const line = peerPlain(raw, left);
    if (!line) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue; }
    lines.push(line);
    left -= line.length + 1;
    if (left <= 0) break;
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function attachNotchPeople(deps: NotchPeopleDeps): NotchPeople {
  const { inbox, link, store } = deps;
  const setup = deps.setup ?? null;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => { /* quiet */ });
  const engineWait = deps.engineWaitMs ?? NOTCH_PEOPLE_ENGINE_WAIT_MS;
  let looking: Promise<void> | null = null;
  let again = false;
  let refreshedAt = 0;
  /** Where each waiting arrival came from: an item is read again from the engine after a restart, never from here. */
  const timer = deps.noClock ? null : setInterval(() => { void tick(); }, NOTCH_PEOPLE_TICK_MS);
  (timer as { unref?: () => void } | null)?.unref?.();

  const person = (id: string): PeerPerson | null => link.people().find((one) => one.id === id) ?? null;
  const orgName = (): string | null => store.org();
  const others = (): PeerPerson[] => link.people();

  /**
   * Something that is on its way to the engine and usually takes no time.
   * When it takes longer than a moment, the notch says so, so that it is not
   * blank while a script still has it.
   */
  async function meanwhile<T>(stage: NotchStage, say: NotchPart[], going: Promise<T>): Promise<T> {
    let done = false;
    void stage.wait(400).then(() => { if (!done) stage.put({ id: stage.id(), kind: 'say', say, ms: 60_000, mood: 'work' }); }, () => { /* the stage ended */ });
    try { return await going; } finally { done = true; }
  }

  function sorry(sent: Extract<PeerSent, { ok: false }>): NotchPart[] {
    if (sent.why === 'signed_out') return ['You are signed out. Open your organisation in Home and sign in. It was not sent.'];
    if (sent.why === 'offline') return ['I have no line to the others now. It was not sent.'];
    // Handed to the line, and the line broke: it is not known, and is not called "not sent".
    if (sent.why === 'unknown') return ['The line broke while it went. I do not know whether it arrived.'];
    // The engine checks everything that goes to somebody whose request is open here, and this was not let through.
    if (sent.why === 'withheld') return ['Not sent: something they asked of me is still open here.'];
    if (sent.why === 'down') return ['I cannot reach the others now. It was not sent.'];
    return ['That could not be sent.'];
  }

  /** Files, when this brain was given somewhere to keep and to put them. */
  const files = deps.files ? attachNotchPeopleFiles({
    inbox, link, store, dir: deps.files.dir, save: deps.files.save, person, log, now,
    ...(deps.files.arrived ? { arrived: deps.files.arrived } : {}), ...(deps.files.find ? { find: deps.files.find } : {}), ...(deps.files.open ? { open: deps.files.open } : {}),
    ...(deps.files.think ? { think: deps.files.think } : {}), ...(deps.files.known ? { known: deps.files.known } : {}),
    news: (id, say, more) => news(id, say, say, { person: true, ms: 4200, ...(more?.who ? { who: more.who } : {}) }),
    ...(deps.files.paceMs !== undefined ? { paceMs: deps.files.paceMs } : {}), ...(deps.files.retryMs !== undefined ? { retryMs: deps.files.retryMs } : {}),
  }) : null;

  // --- signing in and connecting ---

  const hostOf = (address: string | null | undefined): string => { try { return new URL(address ?? '').host; } catch { return ''; } };
  /** A tunnel that puts a page of its own in front of a browser the first time it is visited. */
  const tunnelled = (address: string | null | undefined): boolean => /\.ngrok(-free)?\.(app|dev|io)$/i.test(hostOf(address).replace(/:\d+$/, ''));

  /**
   * Waiting on the engine, in view.
   *
   * A script that waits on the engine with nothing on the notch would leave
   * the notch blank and deaf: a tap goes to the script, which shows nothing.
   * So while the engine is waited on there is a line that says what for; Esc
   * on that line stops the waiting; and the engine has a fixed time to come
   * back with its first question. After a stop or that time the flow is
   * over: whatever the engine asks later is closed, unanswered.
   */
  function watch(stage: NotchStage) {
    let reached = false;
    let over = false;
    let wake: (why: 'stop' | 'late') => void = () => { /* nobody waits yet */ };
    const gone = new Promise<'stop' | 'late'>((resolve) => { wake = resolve; });
    return {
      gone,
      over: (): boolean => over || stage.ended(),
      /** The engine came back with something for the person. */
      reached(): void { reached = true; },
      /** A line that says what is waited for. Esc on it stops the waiting. */
      line(say: NotchPart[], mood: 'work' | 'look' = 'work'): void {
        const id = stage.id();
        stage.put({ id, kind: 'work', say, steps: 0, done: 0, mood });
        // Something else took the notch: the flow is over too, and what the engine asks later is closed.
        void stage.answer(id, ['stop', 'no']).then(() => { over = true; wake('stop'); }, () => { if (stage.ended()) over = true; });
      },
      /** Gives the engine this long to come back with its first question. */
      within(ms: number): void {
        void stage.wait(ms).then(() => { if (!reached && !over) { over = true; wake('late'); } }, () => { over = true; });
      },
    };
  }

  /** Signs in at the engine's server. True when signed in at the end. */
  async function signIn(stage: NotchStage): Promise<boolean> {
    if (link.account().signedIn) return true;
    let opened: boolean | null = null;
    let agreed = false;
    const waiting = watch(stage);
    waiting.line(['Reaching the server…']);
    waiting.within(engineWait);
    const call = link.call('account', { action: 'login' }, {
      server: async (decision) => {
        waiting.reached();
        if (waiting.over()) return null;
        const answer = await stage.offer(['Sign in at ', em(decision.host ?? 'the server'), '? What you send the others goes through it, sealed. It cannot be changed later.'], 'sign in');
        agreed = answer.act === 'yes';
        if (agreed) waiting.line(['Opening the sign-in page…']);
        return agreed ? { choice: 'yes' } : null;
      },
      page: async (decision) => {
        waiting.reached();
        if (waiting.over()) return null;
        opened = decision.url ? await deps.openPage(stage.from(), decision.url) : false;
        if (!opened) return null;
        waiting.line(tunnelled(decision.url) ? ['Sign in on the page I opened. The tunnel may ask you to press "Visit Site" first. I wait here.'] : ['Sign in on the page I opened. I wait here.']);
        return {};
      },
    }, NOTCH_PEOPLE_SIGN_IN_MS).then((result) => result.text, () => '');
    const text = await Promise.race([call, waiting.gone]);
    await link.refresh();
    if (link.account().signedIn || (text !== 'stop' && text !== 'late' && /^(Logged in:|Already logged in)/.test(text))) {
      await stage.say(['Signed in.'], 1600, { mark: 'check' });
      return true;
    }
    if (text === 'stop') await stage.say(opened ? ['I stopped waiting. If you finish on the page, you are signed in all the same.'] : ['Stopped. Nothing was signed in.'], 3400);
    else if (text === 'late') await stage.say(['I could not reach the server. Try again in a moment.'], 3200, { mood: 'sorry' });
    else if (opened === false) await stage.say(['I could not open the sign-in page on this machine.'], 3200, { mood: 'sorry' });
    else if (opened) await stage.say(['That did not sign in. Try again from Home.'], 3200, { mood: 'sorry' });
    // Said yes, and no page ever came: the server did not answer.
    else if (agreed) await stage.say(['I could not reach the server. Try again in a moment.'], 3200, { mood: 'sorry' });
    return false;
  }

  type Waiting = ReturnType<typeof watch>;

  /** "Connect with this device? Name them." The name the person types is the only name the device ever has here. */
  function nameThem(stage: NotchStage, named: { name: string; reached?: boolean }, waiting: Waiting) {
    return async (decision: PeerDecision): Promise<Record<string, unknown> | null> => {
      waiting.reached();
      if (waiting.over()) return null;
      named.reached = true;
      let say: NotchPart[] = ['The code matched. Name them.'];
      for (;;) {
        const id = stage.id();
        stage.put({
          id, kind: 'ask', say, placeholder: 'Their name, for example Leo', yes: 'connect', focus: true, stay: true, mood: 'look',
          blocks: [{ kind: 'note', say: decision.device ? ['The keys of that laptop were checked with the code. Its number begins ', em(decision.device.slice(0, 8)), '.'] : ['The keys of that laptop were checked with the code.'] }],
        });
        const answer = await stage.answer(id, ['ask', 'no']);
        if (answer.act !== 'ask') return { choice: 'reject' };
        const name = peopleName(answer.text ?? '');
        if (!name) { say = ['A name first. What do you call them?']; continue; }
        if (others().some((one) => one.name.toLowerCase() === name.toLowerCase() && one.id !== decision.device)) { say = ['You already call someone ', em(name), '. Another name.']; continue; }
        named.name = name;
        // The other side names this machine too, in its own time: said, and Esc stops the waiting.
        waiting.line(['Connecting with ', em(name), '…']);
        return { choice: 'accept', localName: name };
      }
    };
  }

  function ownDevice(stage: NotchStage, named: { name: string }, waiting: Waiting) {
    return async (): Promise<Record<string, unknown> | null> => {
      if (waiting.over()) return null;
      const answer = await stage.choose(['Is that another laptop of your own?'], ['Yes, mine', 'No']);
      if (answer.act !== 'pick') return null;
      waiting.line(['Connecting with ', em(named.name || 'it'), '…']);
      return answer.index === 0 ? { choice: 'own_device', label: named.name || 'My laptop' } : { choice: 'not_own_device' };
    };
  }

  /** What the engine said at the end of connecting, as a line. True when two machines are joined. */
  async function connected(stage: NotchStage, text: string, named: { name: string }, opener: boolean): Promise<boolean> {
    if (!/^Connected with\b/.test(text)) {
      if (/^The user did not enter a code/.test(text)) return false;
      const code = engineErrorCode(text);
      // The engine's own word for why, and nothing else of what it said: so that a failed connecting can be understood afterwards.
      log(`[notch] connecting ended without a connection (${code ?? 'no reason given'})`);
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
    await stage.say(opener && org ? [em(name), ' joined ', em(org), `. Your ${NOTCH_NAME}s can talk now.`] : ['Connected with ', em(name), `. Your ${NOTCH_NAME}s can talk now.`], 4000, { mood: 'proud', mark: 'check' });
    return true;
  }

  /** Makes a code for somebody to type, and waits until they did. */
  async function invite(stage: NotchStage): Promise<void> {
    if (!(await signIn(stage))) return;
    let code: string | null = null;
    const making = watch(stage);
    making.line(['Making a code…']);
    making.within(engineWait);
    const made = await Promise.race([
      link.call('connect', { action: 'open' }, { code_shown: async (decision) => { making.reached(); if (making.over()) return null; code = decision.code ?? null; return { choice: 'done' }; } }, 60_000).then((result) => result.text, () => ''),
      making.gone,
    ]);
    if (made === 'stop') { try { await link.call('connect', { action: 'cancel' }, {}, 15_000); } catch { /* it closes by itself */ } await stage.say(['Stopped. No code is open.'], 2400); return; }
    if (!code) {
      const why = made === 'late' ? 'not_connected' : engineErrorCode(made);
      await stage.say(why === 'not_connected' || why === 'not_logged_in' ? ['I have no line to the server now. Try again in a moment.'] : ['I could not make a code now.'], 3200, { mood: 'sorry' });
      return;
    }
    const named: { name: string; reached?: boolean } = { name: '' };
    const waiting = watch(stage);
    // Reached from the start: a code may be read out for as long as its window is open.
    waiting.reached();
    waiting.line(['Read them this code: ', em(code), '. They open their organisation and choose "Join with a code".'], 'look');
    const wait = link.call('connect', { action: 'wait' }, { connect: nameThem(stage, named, waiting), own_device: ownDevice(stage, named, waiting) }, NOTCH_PEOPLE_CODE_MS).then((result) => result.text, () => '');
    // Something else took the notch while the code was open: the window is closed with it. A code nobody can
    // be asked about must not stay usable.
    let ended = false;
    void stage.wait(NOTCH_PEOPLE_CODE_MS).then(() => { /* the window ran out by itself */ }, () => {
      if (ended) return;
      void link.call('connect', { action: 'cancel' }, {}, 15_000).catch(() => { /* it closes by itself */ });
      // Said when the notch is free again: somebody may be about to read that code out.
      news('people:code-closed', ['The code I showed is closed.'], ['Something else came up, so the code I showed is closed. Invite again when you are ready.'], { ms: 4200 });
    });
    const outcome = await Promise.race([wait, waiting.gone]);
    ended = true;
    if (outcome === 'stop' || outcome === 'late') {
      // The window is closed: nobody can use the code any more.
      try { await link.call('connect', { action: 'cancel' }, {}, 15_000); } catch { /* it closes by itself in ten minutes */ }
      await stage.say(named.reached ? ['I stopped waiting. Nothing was connected.'] : ['The code is closed. Nobody can use it now.'], 2600);
      return;
    }
    if (!named.reached && !/^Connected with\b/.test(outcome)) { await stage.say(['Nobody used the code. It is closed now.'], 3000); return; }
    await connected(stage, outcome, named, true);
  }

  /** Types the code somebody read out. */
  async function join(stage: NotchStage): Promise<void> {
    if (!(await signIn(stage))) return;
    const named = { name: '' };
    const waiting = watch(stage);
    waiting.line(['One moment…']);
    waiting.within(engineWait);
    const text = await Promise.race([
      link.call('connect', { action: 'code' }, {
        code_wanted: async () => {
          waiting.reached();
          if (waiting.over()) return null;
          const id = stage.id();
          stage.put({ id, kind: 'ask', say: ['Type the code they read to you.'], placeholder: 'like sam#12-3456', yes: 'join', focus: true, stay: true, mood: 'listen', blocks: [] });
          const answer = await stage.answer(id, ['ask', 'no']);
          const typed = answer.act === 'ask' ? (answer.text ?? '').trim() : '';
          if (!typed) return null;
          waiting.line(['Checking the code with their laptop…']);
          return { code: typed };
        },
        connect: nameThem(stage, named, waiting),
        own_device: ownDevice(stage, named, waiting),
      }, NOTCH_PEOPLE_CODE_MS).then((result) => result.text, () => ''),
      waiting.gone,
    ]);
    if (text === 'stop') { await stage.say(['I stopped waiting. Nothing was connected.'], 2600); return; }
    if (text === 'late') { await stage.say(['I have no line to the server now. Try again in a moment.'], 3200, { mood: 'sorry' }); return; }
    await connected(stage, text, named, false);
  }

  // --- getting in: making one here, joining one from its address ---

  /** Why the server, or the engine that goes with it, did not start. */
  function hostSorry(failed: Extract<SetupHosted, { ok: false }>): NotchPart[] {
    if (failed.why === 'address') return ['That address did not work for a tunnel. Try again with the one in your ngrok dashboard.'];
    if (failed.why === 'tools') return ['I cannot start the server: ', em(failed.missing ?? 'a program it needs'), ' is not installed on this laptop.'];
    if (failed.why === 'busy') return ['Something else already answers where the server would. Is another one running on this laptop?'];
    if (failed.why === 'tunnel') {
      // The tunnel program's own reason, by its number. The account's name is its own word, made readable.
      const account = failed.account ? peerPlain(failed.account, 40) : '';
      if (failed.code === '320') return account
        ? ['That address belongs to another ngrok account. ngrok on this laptop is signed in as ', em(account), '. Sign it in with the right authtoken and try again.']
        : ['That address belongs to another ngrok account than the one ngrok on this laptop is signed in to. Sign it in with the right authtoken and try again.'];
      if (failed.code === '108') return ['Another ngrok is already running on your account. Close it and try again.'];
      if (failed.code === '334') return ['That address already has a tunnel open somewhere else. Close that one and try again.'];
      if (failed.code === '105' || failed.code === '107' || failed.code === '4018') return ['ngrok on this laptop is not signed in to an account. Add your authtoken and try again.'];
      return failed.code ? ['ngrok would not open the tunnel at that address. It says ', em(`ERR_NGROK_${failed.code}`), '.'] : ['The tunnel did not come up at that address. Is ngrok signed in on this laptop?'];
    }
    if (failed.why === 'build') return ['The server is on, but I could not build the engine for this laptop.'];
    if (failed.why === 'engine') return ['The server is on, but the engine did not start on this laptop.'];
    if (failed.why === 'system') return ['There is no engine for this kind of machine yet.'];
    return ['I could not start the server.'];
  }

  function joinSorry(failed: Extract<SetupJoined, { ok: false }>): NotchPart[] {
    if (failed.why === 'no_build') return ['Their server has no engine for this kind of laptop yet. It is being built: try again in a few minutes.'];
    if (failed.why === 'system') return ['There is no engine for this kind of machine yet.'];
    if (failed.why === 'bad') return ['What came from that address is not the engine. Check the address with whoever made the organisation.'];
    if (failed.why === 'disk') return ['I could not put the engine on this laptop.'];
    if (failed.why === 'engine') return ['The engine did not start on this laptop.'];
    return ['I could not reach that address.'];
  }

  /**
   * The engine on this machine may still be signed in somewhere else: at the
   * server of an organisation it was in before. An engine has one server for
   * good, so the old one has to be left before the new one can be entered.
   * Leaving sets its keys and its people aside. That is asked, once.
   */
  async function elsewhere(stage: NotchStage, address: string): Promise<'clear' | 'stay' | 'failed'> {
    if (!setup) return 'clear';
    await link.refresh();
    const account = link.account();
    if (!account.signedIn || !account.server || account.server.toLowerCase() === hostOf(address).toLowerCase()) return 'clear';
    const answer = await stage.choose(['This laptop is still in an organisation at ', em(account.server), '. Leave it for this one? Its people here are set aside, not deleted.'], ['Leave it', 'Stay']);
    if (answer.act !== 'pick' || answer.index !== 0) return 'stay';
    if (!(await meanwhile(stage, ['Leaving…'], setup.fresh()))) return 'failed';
    // Who is signed in is read again before anything goes on: the engine that runs now knows nobody.
    await link.refresh();
    return 'clear';
  }

  /**
   * Signs in at the server this machine itself runs. No question and no
   * page: making the organisation was the yes, the server named must be this
   * machine's own, and the account is one that was made here a moment ago.
   */
  async function signInAsHost(stage: NotchStage, name: string): Promise<boolean> {
    if (!setup) return false;
    if (link.account().signedIn) return true;
    const mine = hostOf(setup.hosting().address);
    const login = peerLoginName(name);
    if (!login || !mine) return false;
    const made = await setup.myAccount(name);
    if (!made.ok) return false;
    const text = await link.call('account', { action: 'login' }, {
      server: async (decision) => {
        if ((decision.host ?? '').toLowerCase() !== mine.toLowerCase()) return null;
        // No key answers this, so no key can have come too soon. The link takes no yes before a line could have been read: it waits that long.
        await stage.wait(PEER_READ_MS + 100);
        return { choice: 'yes' };
      },
      page: async (decision) => (decision.url && (await setup.signIn(decision.url, login, made.password)) ? {} : null),
    }, NOTCH_PEOPLE_SIGN_IN_MS).then((result) => result.text, () => '');
    await link.refresh();
    return link.account().signedIn || /^(Logged in:|Already logged in)/.test(text);
  }

  /** Starts the server, and the engine with it, in view. `org`: it is being made now, under that name. */
  async function startHosting(stage: NotchStage, more: { org?: string; me: string; domain?: string }): Promise<boolean> {
    if (!setup) return false;
    const waiting = watch(stage);
    waiting.reached();
    const lines: Record<SetupStep, NotchPart[]> = {
      server: ['Starting your server and its tunnel…'],
      build: ['Building the engine for this laptop. The first time takes a minute…'],
      engine: ['Starting the engine…'],
    };
    const hosted = await Promise.race([setup.host(more.domain, (step) => { if (!waiting.over()) waiting.line(lines[step]); }), waiting.gone]);
    if (hosted === 'stop' || hosted === 'late') {
      // Stopped by the person: whatever came up goes down again.
      void setup.stopHost();
      if (!stage.ended()) await stage.say(['Stopped. The server is off.'], 2600);
      return false;
    }
    if (!hosted.ok) { await stage.say(hostSorry(hosted), 9000, { mood: 'sorry' }); return false; }
    const other = await elsewhere(stage, hosted.address);
    if (other !== 'clear') {
      void setup.stopHost();
      await stage.say(other === 'stay' ? ['Nothing changed. The new server is off again.'] : ['I could not leave the other organisation. The new server is off again.'], 3400, other === 'stay' ? {} : { mood: 'sorry' });
      return false;
    }
    if (!link.account().signedIn) {
      const signed = await meanwhile(stage, ['Signing you in…'], signInAsHost(stage, more.me));
      if (!signed) { await stage.say(['The server is on, but I could not sign you in at it. Open your organisation and try again.'], 4600, { mood: 'sorry' }); return false; }
    }
    if (more.org) store.setOrg(more.org);
    inbox.refresh();
    await stage.say(more.org ? [em(more.org), ' is made. Its server is on, at ', em(hostOf(hosted.address)), '.'] : ['Your server is on.'], 3600, { mood: 'proud', mark: 'check' });
    return true;
  }

  /** Asks for one thing to be typed, until it checks or the person leaves. */
  async function typed<T>(stage: NotchStage, first: NotchPart[], more: { placeholder: string; yes: string; note: NotchPart[]; again: NotchPart[] }, check: (text: string) => T | null): Promise<T | null> {
    let say = first;
    for (;;) {
      const id = stage.id();
      stage.put({ id, kind: 'ask', say, placeholder: more.placeholder, yes: more.yes, focus: true, stay: true, mood: 'look', blocks: [{ kind: 'note', say: more.note }] });
      const answer = await stage.answer(id, ['ask', 'no']);
      if (answer.act !== 'ask') return null;
      const got = check(answer.text ?? '');
      if (got !== null) return got;
      say = more.again;
    }
  }

  /** A tunnel's address, as it is typed by the one who hosts: reached safely, at its usual door. */
  const tunnelAddress = (text: string): string | null => {
    const address = peerServerAddress(text);
    return address && address.startsWith('https://') && !new URL(address).port ? address : null;
  };

  /** "Make an organisation": this machine becomes its host. */
  async function make(stage: NotchStage, name: string): Promise<boolean> {
    if (!setup) return false;
    const me = setup.myName() ?? await typed(stage, ['Your name in ', em(name)], {
      placeholder: 'for example Sam', yes: 'next',
      note: ['It is what the others see you as, and what their pairing codes begin with.'],
      again: ['A name with letters in it. Your name in ', em(name), '?'],
    }, (text) => { const one = peopleName(text); return one && peerLoginName(one) ? one : null; });
    if (!me) return false;
    let domain: string | undefined;
    if (!setup.hosting().address) {
      const address = await typed(stage, ['The address of your tunnel'], {
        placeholder: 'for example name.ngrok-free.app', yes: 'start',
        note: ['The server runs on this laptop, and the others reach it through your ngrok tunnel. Its address is in the ngrok dashboard, under Domains. It stays the address of this organisation.'],
        again: ['That is not an address like ', em('name.ngrok-free.app'), '. Again.'],
      }, tunnelAddress);
      if (!address) return false;
      domain = address;
    }
    return startHosting(stage, { org: name, me, ...(domain ? { domain } : {}) });
  }

  /** "Join an organisation", on a machine with no engine yet: its address, and its engine for this machine. */
  async function arrive(stage: NotchStage): Promise<boolean> {
    if (!setup) return false;
    let say: NotchPart[] = ['Join an organisation'];
    for (;;) {
      const address = await typed(stage, say, {
        placeholder: 'Its address, for example name.ngrok-free.app', yes: 'join',
        note: ['Whoever made it gives you three things: its address, your name there, and a password.'],
        again: ['That is not an address like ', em('name.ngrok-free.app'), '. Again.'],
      }, peerServerAddress);
      if (!address) return false;
      const waiting = watch(stage);
      waiting.reached();
      waiting.line(['Getting the engine from ', em(hostOf(address)), '…']);
      const joined = await Promise.race([setup.join(address), waiting.gone]);
      if (joined === 'stop' || joined === 'late') { if (!stage.ended()) await stage.say(['Stopped.'], 2000); return false; }
      if (!joined.ok) {
        // Not reached: most often a letter of the address, or a server that is off. It can be typed again.
        if (joined.why === 'unreachable') { say = ['I could not reach ', em(hostOf(address)), '. Is their server on? The address again.']; continue; }
        await stage.say(joinSorry(joined), 4600, { mood: 'sorry' });
        return false;
      }
      const other = await elsewhere(stage, address);
      if (other !== 'clear') { await stage.say(other === 'stay' ? ['Nothing changed.'] : ['I could not leave the other organisation.'], 2800, other === 'stay' ? {} : { mood: 'sorry' }); return false; }
      // The name of an organisation that was left here before is not this one's: theirs arrives when the two are joined.
      store.setMeta('org', null);
      inbox.refresh();
      return true;
    }
  }

  /**
   * The host invites: an account is made for the person, and the three
   * things they need are shown once. The password is on the notch and
   * nowhere else: in no log, in no list, and it is not kept.
   */
  async function inviteAsHost(stage: NotchStage): Promise<void> {
    if (!setup) return;
    const hosting = setup.hosting();
    if (hosting.state !== 'on' || !hosting.address) { await stage.say(['Your server is off. Start it first: nobody can join while it is off.'], 3600, { mood: 'sorry' }); return; }
    let name = '';
    let password = '';
    let say: NotchPart[] = ['Who do you invite?'];
    for (;;) {
      const one = await typed(stage, say, {
        placeholder: 'Their name, for example Leo', yes: 'invite',
        note: ['I make them a name and a password at your server. You give them those, and they join.'],
        again: ['A name with letters in it. Who do you invite?'],
      }, (text) => { const got = peopleName(text); return got && peerLoginName(got) ? got : null; });
      if (!one) return;
      const made = await meanwhile(stage, ['Making their account…'], setup.account(one));
      if (made.ok) { name = one; password = made.password; break; }
      if (made.why !== 'taken') { await stage.say(['I could not make the account now.'], 3200, { mood: 'sorry' }); return; }
      // They are in already: a laptop that was set up anew, most often. A new password lets them in again, and
      // the old one stops working. Or it is somebody else of the same name.
      const again = await stage.choose(['Someone called ', em(one), ' is in this organisation already. Give them a new password?'], ['New password', 'Another name']);
      if (again.act !== 'pick') return;
      if (again.index === 0) {
        const fresh = await meanwhile(stage, ['Making a new password…'], setup.newPassword(one));
        if (!fresh.ok) { await stage.say(['I could not make a new password now.'], 3200, { mood: 'sorry' }); return; }
        name = one; password = fresh.password; break;
      }
      say = ['Another name, then. Who do you invite?'];
    }
    const ready = setup.built();
    const id = stage.id();
    stage.put({
      id, kind: 'sheet', say: ['For ', em(name), ': three things'], mood: 'look', stay: true, no: 'close',
      blocks: [
        { kind: 'row', lead: '1', say: [em(hostOf(hosting.address))], small: 'The address.' },
        { kind: 'row', lead: '2', say: [em(peerLoginName(name) ?? name)], small: 'Their name there.' },
        { kind: 'row', lead: '3', say: [em(password)], small: 'Their password. Shown this once: I do not keep it.' },
        { kind: 'note', say: [`On their ${NOTCH_NAME}: Home, "Join an organisation", then the address. They sign in with the name and the password. When they have, make the code here.`] },
        // Which kinds of laptop can join now: the others' engines are still being built.
        ...(ready.length < 5 ? [{ kind: 'note' as const, say: [ready.length ? `They can join now from: ${ready.map((one) => ENGINE_TARGET_SAID[one]).join(', ')}. The engines for the other kinds of laptop are still being built.` : 'The engines for the other kinds of laptop are still being built. Give it a few minutes.'] }] : []),
        { kind: 'buttons', buttons: [{ id: 'code', label: 'They are in: make the code' }] },
      ],
    });
    const answer = await stage.answer(id, ['button', 'no', 'yes']);
    if (answer.act === 'button' && answer.button === 'code') await invite(stage);
  }

  /** The server's row in Home. */
  async function server(stage: NotchStage): Promise<void> {
    if (!setup) return;
    const hosting = setup.hosting();
    if (!hosting.address) return;
    if (hosting.state === 'starting') { await stage.say(['Your server is starting.'], 2400); return; }
    if (hosting.state === 'off') { await startHosting(stage, { me: setup.myName() ?? '' }); return; }
    const answer = await stage.choose(['Your server is on, at ', em(hostOf(hosting.address)), '. While it is off, nobody in ', em(orgName() ?? 'your organisation'), ' reaches anybody.'], ['Stop it', 'Leave it on']);
    if (answer.act !== 'pick' || answer.index !== 0) return;
    await meanwhile(stage, ['Stopping the server…'], setup.stopHost());
    inbox.refresh();
    await stage.say(['The server is off.'], 2400, { mark: 'check' });
  }

  /**
   * Takes somebody out of the organisation. It takes something away, so it
   * is asked: the question is the engine's own, put on the notch, and only
   * when it is about this very laptop. After it the two connect with a new
   * code before anything crosses again. Needed for a laptop that was set up
   * anew: its old self stays listed, and would be told things nobody gets.
   */
  async function removePerson(stage: NotchStage, who: PeerPerson): Promise<void> {
    const waiting = watch(stage);
    waiting.line(['One moment…']);
    waiting.within(engineWait);
    let said: boolean | null = null;
    const text = await Promise.race([
      link.call('contacts', { action: 'remove', contact: who.id }, {
        confirm: async (decision) => {
          waiting.reached();
          if (waiting.over()) return null;
          if (!/^collab: remove this contact\?/.test(decision.message) || !decision.message.includes(who.id)) return null;
          const answer = await stage.choose(['Remove ', em(who.name), ' from your organisation? To talk again you connect with a new code.'], ['Remove', 'Keep'], { who: who.name });
          if (answer.act !== 'pick') return null;
          said = answer.index === 0;
          if (said) waiting.line(['Removing ', em(who.name), '…']);
          return { choice: said ? 'yes' : 'no' };
        },
      }, 60_000).then((result) => result.text, () => ''),
      waiting.gone,
    ]);
    await link.refresh();
    inbox.refresh();
    if (said && !others().some((one) => one.id === who.id)) { await stage.say([em(who.name), ' is no longer in your organisation.'], 3000, { mark: 'check' }); return; }
    // Kept, stopped, or the question never came to be answered and the engine says nothing changed: nothing to add.
    if (said === false || text === 'stop' || stage.ended() || /^The user kept the contact/.test(text)) return;
    await stage.say(['I could not remove ', em(who.name), ' now.'], 3000, { mood: 'sorry' });
  }

  /** Leaving: the one thing here that is asked twice, because it takes something away. */
  async function leave(stage: NotchStage): Promise<boolean> {
    if (!setup) return false;
    const org = orgName();
    const hosts = !!setup.hosting().address;
    const answer = await stage.choose(
      hosts ? ['Leave ', em(org ?? 'this organisation'), '? Its server stops, and the people in it are set aside on this laptop.'] : ['Leave ', em(org ?? 'this organisation'), '? The people in it are set aside on this laptop. To come back you join again.'],
      ['Leave', 'Stay']);
    if (answer.act !== 'pick' || answer.index !== 0) return false;
    if (!(await meanwhile(stage, ['Leaving…'], setup.leave()))) { await stage.say(['I could not leave now.'], 3000, { mood: 'sorry' }); return false; }
    store.setMeta('org', null);
    await link.refresh();
    inbox.refresh();
    await stage.say(['Left. Nothing goes out and nothing comes in.'], 3000, { mark: 'check' });
    return true;
  }

  // --- the sheet ---

  function row(): NotchBlock | null {
    const account = link.account();
    const people = others();
    const org = orgName();
    const start = `${setup && !setup.canHost() ? 'Join' : 'Make'} an organisation, so your ${NOTCH_NAME}s can talk.`;
    // No engine on this machine yet: one comes with making an organisation, or with joining one.
    if (setup && !setup.engineReady()) return { kind: 'row', id: 'people', say: [start], go: true };
    if (account.engine !== 'up') return org ? { kind: 'row', id: 'people', say: [em(org), ': not reachable right now.'] } : null;
    if (!people.length) return { kind: 'row', id: 'people', say: org && setup ? [em(org), ': only you so far. Invite someone.'] : [start], go: true };
    return { kind: 'row', id: 'people', say: [em(org ?? 'Your organisation'), ': you and ', em(people.map((one) => one.name).join(', ')), '.'], go: true };
  }

  function rows(): NotchBlock[] {
    const main = row();
    const hosting = setup?.hosting();
    // The server's own row, for whoever hosts: it is theirs to turn off and on.
    const mine: NotchBlock | null = !hosting?.address || !orgName() ? null
      : hosting.state === 'on' ? { kind: 'row', id: 'people-server', say: ['Your server is ', em('on'), '.'], go: true }
        : hosting.state === 'starting' ? { kind: 'row', id: 'people-server', say: ['Your server is starting…'] }
          : { kind: 'row', id: 'people-server', say: ['Your server is ', em('off'), '. Start it?'], go: true };
    return [...(main ? [main] : []), ...(mine ? [mine] : [])];
  }

  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const account = link.account();
      const people = others();
      const org = orgName();
      const noEngine = !!setup && !setup.engineReady();
      if (!noEngine && account.engine !== 'up') { await stage.say(['I cannot reach the others right now.'], 2600, { mood: 'sorry' }); return; }
      if (noEngine || (!org && !people.length)) {
        // A machine that cannot run a server has one way in.
        if (setup && !setup.canHost()) {
          if (noEngine && !(await arrive(stage))) return;
          await join(stage);
          if (!others().length) return;
          continue;
        }
        const id = stage.id();
        stage.put({
          id, kind: 'ask', say: ['Make an organisation'], placeholder: 'Name it, for example Northwind', yes: 'make', focus: true, mood: 'look',
          blocks: [
            { kind: 'note', say: [setup ? `An organisation is the people whose ${NOTCH_NAME}s may talk to each other. Its server runs on this laptop, and you choose when it is on.` : `An organisation is the people whose ${NOTCH_NAME}s may talk to each other.`] },
            { kind: 'buttons', buttons: [{ id: 'join', label: setup ? 'Join one' : 'Join one with a code' }] },
          ],
        });
        const answer = await stage.answer(id, ['ask', 'button', 'no']);
        if (answer.act === 'button' && answer.button === 'join') {
          if (noEngine && !(await arrive(stage))) return;
          await join(stage);
          if (!others().length) return;
          continue;
        }
        if (answer.act !== 'ask') return;
        const name = peerPlain(answer.text ?? '', PEER_ORG_MAX);
        if (!name) continue;
        if (setup) { if (!(await make(stage, name))) return; continue; }
        store.setOrg(name);
        if (!(await signIn(stage))) return;
        continue;
      }
      const hosting = setup?.hosting();
      const hosts = !!hosting?.address;
      const id = stage.id();
      stage.put({
        id, kind: 'sheet', say: org ? [em(org), ', your organisation'] : ['Your organisation'], mood: 'look',
        blocks: [
          { kind: 'row', lead: 'You', say: ['This laptop'], small: 'You say yes or no to what is asked of it.' },
          ...people.map((one, at): NotchBlock => ({ kind: 'row', lead: one.name.charAt(0).toUpperCase(), say: [one.name], small: one.own ? 'Your own laptop.' : 'Connected by a code. Asks you every time.', buttons: [{ id: `remove${at}`, label: 'Remove', quiet: true }] })),
          ...(hosts ? [{ kind: 'row' as const, lead: 'S', say: ['Its server, on this laptop'], small: hosting!.state === 'on' ? `On, at ${hostOf(hosting!.address)}.` : hosting!.state === 'starting' ? 'Starting.' : 'Off. Nobody reaches anybody until it is on.' }] : []),
          ...(account.signedIn ? [] : [{ kind: 'note' as const, say: ['You are signed out. Nothing goes out and nothing comes in until you sign in.'] }]),
          { kind: 'buttons', buttons: [
            ...(account.signedIn ? [] : [{ id: 'signin', label: 'Sign in' }]),
            { id: 'invite', label: 'Invite someone' },
            { id: 'join', label: 'Join with a code' },
            ...(hosts && hosting!.state !== 'starting' ? [{ id: 'server', label: hosting!.state === 'on' ? 'Stop the server' : 'Start the server' }] : []),
            ...(setup ? [{ id: 'leave', label: 'Leave' }] : []),
          ] },
        ],
      });
      const answer = await stage.answer(id, ['button', 'no', 'yes']);
      if (answer.act !== 'button') return;
      if (answer.button === 'signin') {
        if (hosts && hosting!.state === 'on') {
          if (!(await meanwhile(stage, ['Signing you in…'], signInAsHost(stage, setup!.myName() ?? '')))) await stage.say(['I could not sign you in at your server.'], 3200, { mood: 'sorry' });
        } else await signIn(stage);
        continue;
      }
      if (answer.button === 'invite') { if (hosts) await inviteAsHost(stage); else await invite(stage); continue; }
      if (answer.button === 'join') { await join(stage); continue; }
      if (answer.button === 'server') { await server(stage); continue; }
      const out = /^remove(\d+)$/.exec(answer.button ?? '')?.[1];
      if (out !== undefined && people[Number(out)]) { await removePerson(stage, people[Number(out)]!); continue; }
      if (answer.button === 'leave') { if (await leave(stage)) return; continue; }
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
        const found = new RegExp(`^(?:(?:please|ok|okay|hey|jarvis|pillow|can you|could you|would you)[,\\s]+)*(tell|message|ping|ask)\\s+${escaped(name)}(?![\\p{L}\\p{N}'\u2019])([\\s,:]*)(.*)$`, 'iu').exec(said);
        if (!found) continue;
        const words = found[3]!.replace(/^that\s+/i, '').trim();
        // "Tell Leo and Anna ...", "tell Leo, Anna and Sam ...": more than one person is meant, and it is not
        // sent to the first of them with the others' names in it.
        if (/^(?:and|or|&|\+)(?:\s|$)/i.test(words)) return null;
        if (found[2]!.includes(',') && /^\p{Lu}[\p{L}'\u2019-]*\s*(?:,|(?:and|or)\b|&)/u.test(words)) return null;
        // "Message Leo on Slack ...", "ask Leo by email ...": another way to reach them was named. Not this one.
        if (/^(?:on|by|via|in|over|through|per)\s+(?:slack|e-?mail|mail|whatsapp|telegram|teams|discord|sms|text|phone|linkedin|signal|imessage|messenger|a call)\b/i.test(words)) return null;
        return { person: one, verb: found[1]!.toLowerCase(), words };
      }
    }
    return null;
  }

  function tell(to: PeerPerson, words: string): void {
    inbox.present('people-tell', async (stage) => {
      // Their own words: all of them go, and the line shows where they begin.
      const went = await stage.fuse(['Telling ', em(to.name), ': ', beginning(words, NOTCH_PEOPLE_GOING_MAX), ...(words.length > NOTCH_PEOPLE_GOING_MAX ? [] : ['…'])], NOTCH_PEOPLE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was sent.'], 2000); return; }
      // Nobody saw the line burn: what nobody may have seen does not go out.
      if (went === 'lost') return;
      const sent = await meanwhile(stage, ['Sending…'], link.tell(to.id, words));
      if (!sent.ok) { await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.sent({ id: sent.id, to: to.id, kind: 'tell', words });
      await stage.say(sent.delivered ? ['Sent to ', em(to.name), '. I will tell you when it is seen.'] : ['Sent. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 2800, { mark: 'check' });
    });
  }

  function ask(to: PeerPerson, asked: string, firstId?: string): void {
    const question = /[?]$/.test(asked) ? asked : `${asked.replace(/[.!\s]+$/, '')}?`;
    const options = peopleOptions(question).slice(0, PEER_OPTIONS_MAX);
    inbox.present('people-ask', async (stage) => {
      const went = await stage.fuse(['Asking ', em(to.name), ': ', beginning(question, NOTCH_PEOPLE_GOING_MAX), ' Answers: ', em(options.join(', ')), '.'], NOTCH_PEOPLE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was asked.'], 2000); return; }
      if (went === 'lost') return;
      const sent = await meanwhile(stage, ['Sending…'], link.tell(to.id, peerNoteText(question, { kind: 'ask', options })));
      if (!sent.ok) { await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.sent({ id: sent.id, to: to.id, kind: 'ask', words: question, options, ...(firstId ? { again: firstId } : {}) });
      await stage.say(firstId ? ['Asked again.'] : sent.delivered ? ['Asked ', em(to.name), '. I will tell you the answer.'] : ['Asked. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 2800, { mark: 'check' });
    });
  }

  /** Words that only lead up to what is said. */
  const LEAD = "(?:(?:please|ok|okay|hey|jarvis|pillow|can you|could you|would you|will you|i want you to|i need you to|i would like you to|i'd like you to)[,\\s]+)*";
  /** Verbs that ask for a thing to be brought here, and verbs that ask for it to be handed to me. */
  const BRING = '(?:get|fetch|grab|retrieve|bring|download|pull|copy|find)';
  const HAND = '(?:send|give|share|forward|pass|show)';
  /** A word that says the thing is a file. Needed when no laptop is named: "get the deck from Leo". */
  const FILE_WORD = /\b(?:files?|decks?|slides|presentations?|documents?|docs?|pdfs?|spreadsheets?|sheets?|numbers|reports?|contracts?|invoices?|pictures?|photos?|images?|screenshots?|recordings?|videos?|drafts?|proposals?|budgets?|notes|exports?)\b|\.[a-z0-9]{2,5}$/i;
  /** What somebody is asked "for" that is no file: "ask Leo's Pillow for an update". */
  const NO_FILE = /^(?:(?:an?|some|the|his|her|their|your)\s+)?(?:help|advice|feedback|update|answer|opinion|thoughts|views?|status|summary|time|permission|access|input|review|approval|confirmation|eta|hand|favou?r)\b/i;

  /** What is wanted, when words ask for a thing to be brought: "get me the Q3 numbers" gives "the Q3 numbers". */
  function brought(words: string): string | null {
    const found = new RegExp(`^${LEAD}(?:${BRING}(?:\\s+(?:me|us))?|${HAND}\\s+(?:me|us)|i\\s+(?:need|want)|i(?:'d| would)\\s+like)\\s+(.+)$`, 'iu').exec(words);
    if (!found) return null;
    const what = found[1]!.replace(/\s+(?:for me|to me|please)$/i, '').trim();
    // "Find out why ...", "get it restarted": a thing to do there, not a thing to bring here.
    if (!what || /^(?:out|what|how|why|when|where|whether|if|who|that|to|it)\b/i.test(what)) return null;
    return what;
  }

  /**
   * What is asked of somebody's laptop, or of their Pillow: whose, what, and
   * whether a file is asked for.
   *
   *   "ask Leo's Pillow what changed in the last deck"     something to do there
   *   "restart the server on Leo's laptop"                 something to do there
   *   "get me the Q3 numbers from Leo's laptop"            a file: "the Q3 numbers"
   *   "ask Leo's Pillow for the latest deck"               a file: "the latest deck"
   *   "can you go on Leos pc and fetch budget.xlsx"        a file: "budget.xlsx"
   *
   * Their laptop may be named anywhere in the sentence, and as speech is
   * written down: "Leos laptop", "Leo laptop". The owner, 22 November 2026:
   * "if i ask can you perform a certyain action in someone elses pillow it
   * fails to understand".
   */
  function requested(text: string): { person: PeerPerson; words: string; file: string | null } | null {
    const said = text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
    const people = others().slice().sort((a, b) => b.name.length - a.name.length);
    for (const one of people) {
      const first = one.name.split(' ')[0]!;
      const alone = people.filter((other) => other.name.split(' ')[0]!.toLowerCase() === first.toLowerCase()).length === 1;
      for (const name of alone && first !== one.name ? [one.name, first] : [one.name]) {
        const theirs = `(?<![\\p{L}\\p{N}])${escaped(name)}(?:'s|’s|s|')?\\s+${MACHINE}(?![\\p{L}\\p{N}])`;
        const found = new RegExp(`^(.*?)(?:\\b(?:from|on|in|at|off|of|to|into|onto|inside|through|via|using|with)\\s+)?${theirs}(.*)$`, 'iu').exec(said);
        if (!found) continue;
        let before = found[1]!.trim().replace(/[,;:]+$/, '').trim().replace(new RegExp(`^${LEAD}`, 'iu'), '').trim();
        let after = found[2]!.trim().replace(/^[,;:]+/, '').trim();
        // What stands before it and only points at the laptop is not part of what is asked.
        if (/^(?:ask|tell|have|get|make|let|go|look|check|search|open|log|hop|jump|connect|use|i want|i need|i'd like|i would like)?(?:\s+(?:on|in|at|into|to|onto))?$/i.test(before)) before = '';
        const askedFor = !before && /^for\s+/i.test(after);
        after = after.replace(/^(?:(?:and|then|to|please|for)\b[,\s]*)+/i, '').trim();
        const words = [before, after].filter(Boolean).join(' ').trim();
        const file = askedFor ? (NO_FILE.test(after) ? null : after) : brought(words);
        return { person: one, words, file };
      }
    }
    return null;
  }

  /** "Get the deck from Leo", "ask Leo to send me the Q3 numbers": a file of theirs, with no laptop named. */
  function fromPerson(text: string): { person: PeerPerson; file: string } | null {
    const said = text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
    const people = others().slice().sort((a, b) => b.name.length - a.name.length);
    for (const one of people) {
      const first = one.name.split(' ')[0]!;
      const alone = people.filter((other) => other.name.split(' ')[0]!.toLowerCase() === first.toLowerCase()).length === 1;
      for (const name of alone && first !== one.name ? [one.name, first] : [one.name]) {
        const them = `(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}'’])`;
        const found = new RegExp(`^${LEAD}${BRING}(?:\\s+(?:me|us))?\\s+(.+?)\\s+from\\s+${them}$`, 'iu').exec(said)
          ?? new RegExp(`^${LEAD}ask\\s+${them}\\s+(?:for|to\\s+(?:send|give|share|forward|pass)\\s+(?:me|us))\\s+(.+)$`, 'iu').exec(said);
        const what = found?.[1]?.replace(/\s+(?:for me|to me|with me|please)$/i, '').trim();
        // Only when the thing is named as a file: "ask Leo for his view" is a word to Leo.
        if (what && FILE_WORD.test(what)) return { person: one, file: what };
      }
    }
    return null;
  }

  function request(to: PeerPerson, words: string): void {
    const theirs = `${to.name}'s ${NOTCH_NAME}`;
    inbox.present('people-request', async (stage) => {
      const shown = beginning(words, NOTCH_PEOPLE_GOING_MAX);
      const went = await stage.fuse(['Asking ', em(theirs), ': ', /[.?!…]$/.test(shown) ? shown : `${shown}.`, ' ', em(to.name), ' must say yes there.'], NOTCH_PEOPLE_FUSE_MS, { mood: 'work' });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was asked.'], 2000); return; }
      if (went === 'lost') return;
      const sent = await meanwhile(stage, ['Sending…'], link.ask(to.id, words.slice(0, 120), words));
      if (!sent.ok) { await stage.say(sorry(sent), 3400, { mood: 'sorry' }); return; }
      store.request({ id: sent.id, dir: 'out', peer: to.id, words });
      following();
      await stage.say(sent.delivered ? ['Asked ', em(theirs), '. I will tell you what comes back.'] : ['Asked. It waits until ', em(`${to.name}'s`), ` ${NOTCH_NAME} is on.`], 2800, { mark: 'check' });
    });
  }

  function route(text: string): { did: string; run(): void } | null {
    const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
    if (/^(?:(?:please|ok|okay|hey|jarvis)[,\s]+)*(?:(?:make|create|start|set up|show|open)(?: me)? (?:an|my|our|the) organi[sz]ation|(?:my|our) organi[sz]ation|invite (?:someone|somebody)(?: to (?:my|our|the) organi[sz]ation)?|connect (?:with|to) (?:someone|somebody|another (?:jarvis|pillow))|join (?:an|the) organi[sz]ation)$/.test(said)) {
      return { did: 'Open the organisation.', run: () => { inbox.present('people', (stage) => open(stage)); } };
    }
    // What is asked of their Jarvis, or of their laptop, is a request: not a word to the person.
    const wanted = requested(text);
    if (wanted) {
      const theirs = `${wanted.person.name}'s ${NOTCH_NAME}`;
      // A file of theirs: their Pillow looks for it, and they say there whether it goes.
      const file = wanted.file && files ? peerPlain(wanted.file, PEER_FILE_WHAT_MAX) : '';
      if (file) return { did: `Ask ${theirs} for a file: ${file}`, run: () => files!.want(wanted.person, file) };
      const asked = cap(peerPlain(wanted.words, NOTCH_PEOPLE_SAY_MAX));
      if (!asked) return { did: `Ask ${theirs} something.`, run: () => { inbox.present('people-what', (stage) => stage.say(['Ask ', em(theirs), ' what? Say it after the name.'], 3200, { mood: 'confused' })); } };
      return { did: `Ask ${theirs}: ${asked}`, run: () => request(wanted.person, asked) };
    }
    const theirs = files ? fromPerson(text) : null;
    if (theirs) {
      const file = peerPlain(theirs.file, PEER_FILE_WHAT_MAX);
      if (file) return { did: `Ask ${theirs.person.name}'s ${NOTCH_NAME} for a file: ${file}`, run: () => files!.want(theirs.person, file) };
    }
    const to = addressed(text);
    if (!to) return null;
    if (/^['\u2019]s\b/i.test(to.words)) return null;
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
    const shown = peerPlain(words, NOTCH_PEOPLE_TEXT_MAX);
    inbox.add({
      id: `people:${item.id}`, subject: `people:${item.id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' asks: ', shown.length > 60 ? `${shown.slice(0, 59)}…` : shown],
      check: () => store.got(item.id)?.done !== true,
      play: async (stage) => {
        let pick: string | undefined;
        if (shown.length > NOTCH_PEOPLE_LINE_MAX) {
          // Too long for a line, which would fade its end away: a question is answered only when all of it can be read.
          const first = await stage.offer([em(from.name), ' asks you something. Read it?'], 'read', { who: from.name, mood: 'look' });
          if (first.act !== 'yes') return 'waits';
          const id = stage.id();
          stage.put({
            id, kind: 'sheet', say: [em(from.name), ' asks'], who: from.name, mood: 'look', stay: true, no: 'not now',
            blocks: [{ kind: 'paper', lines: [[shown]] }, { kind: 'buttons', buttons: options.map((label, at) => ({ id: `pick${at}`, label })) }],
          });
          const answer = await stage.answer(id, ['button', 'no']);
          const at = answer.act === 'button' ? /^pick(\d)$/.exec(answer.button ?? '')?.[1] : undefined;
          pick = at !== undefined ? options[Number(at)] : undefined;
        } else {
          const answer = await stage.choose([em(from.name), ' asks: ', shown], options, { who: from.name, mood: 'look' });
          pick = answer.act === 'pick' && typeof answer.index === 'number' ? options[answer.index] : undefined;
        }
        if (!pick) return 'waits';
        // It goes to another person, so it has the window to take it back, like anything that does: a pick
        // can be a slip of the hand, and one said aloud can be a word that was never said.
        const went = await stage.fuse(['Telling ', em(from.name), ': ', em(pick), '…'], NOTCH_PEOPLE_FUSE_MS, { mood: 'work', who: from.name });
        if (went === 'undo') { await stage.say(['Taken back. Nothing was sent.'], 2000); return 'waits'; }
        if (went === 'lost') return 'waits';
        const sent = await meanwhile(stage, ['Sending…'], link.tell(item.from, peerNoteText(pick, { kind: 'answer', pick }), { replyTo: item.id }));
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
      // Their question is taken back: it leaves, whether it was on the notch or in the count. Only the one
      // who asked it can take it back: the id must be of something that came from them.
      if (store.gotFrom(note.of) !== item.from || store.got(note.of)?.done) return;
      store.done(note.of);
      void link.seen(note.of);
      if (inbox.remove(`people:${note.of}`)) news(`people:back:${note.of}`, [em(from.name), ' took it back.'], [em(from.name), ' took it back.'], { who: from.name, ms: 2400 });
      return;
    }
    // The name of the organisation they were joined into. Taken when this machine has none; said by nothing:
    // "Connected with ..." was the line for it, and Home shows the name from now on.
    if (note.kind === 'org' && !orgName()) { store.setOrg(note.name); inbox.refresh(); }
  }

  // --- a request: what is asked of this machine ---

  /** The work on requests that were said yes to, by the request's id. Gone with the brain: a request cannot outlive it. */
  const working = new Map<string, Promise<void>>();
  /** The requests whose item is on the notch right now. */
  const onNotch = new Set<string>();

  /** "Sam asks me: ... Do it here?" The answer to the engine's own question about the request. */
  function approve(stage: NotchStage, from: PeerPerson, row: PeerRequestRow, waiting: Waiting) {
    return async (): Promise<Record<string, unknown> | null> => {
      waiting.reached();
      if (waiting.over()) return null;
      const whole = row.words.length <= NOTCH_PEOPLE_REQUEST_MAX;
      const words = peerPlain(row.words, NOTCH_PEOPLE_REQUEST_MAX);
      if (words.length <= NOTCH_PEOPLE_LINE_MAX && whole) {
        const answer = await stage.choose([em(from.name), ' asks me: ', /[.?!]$/.test(words) ? words : `${words}.`, ' Do it here?'], ['Do it', 'No'], { who: from.name, mood: 'look' });
        if (answer.act !== 'pick') return null;
        waiting.line(['One moment…']);
        return answer.index === 0 ? { choice: 'allow_once', resultCheck: true } : { choice: 'decline' };
      }
      const first = await stage.offer([em(from.name), ' asks me for something. Read it?'], 'read', { who: from.name, mood: 'look' });
      if (first.act !== 'yes') return null;
      const id = stage.id();
      // What cannot be read whole is not offered for a yes: only the no is there.
      stage.put({
        id, kind: 'sheet', say: [em(from.name), ' asks me'], who: from.name, mood: 'look', stay: true, no: 'not now', ...(whole ? { yes: 'do it', whole: true } : {}),
        blocks: [
          { kind: 'paper', lines: peopleLines(row.words, NOTCH_PEOPLE_REQUEST_MAX).map((line) => [line]) },
          ...(whole ? [] : [{ kind: 'note' as const, say: ['It goes on, and I cannot show the rest here. So I cannot do it from here.'] }]),
          { kind: 'buttons', buttons: [{ id: 'no', label: 'Say no' }] },
        ],
      });
      const answer = await stage.answer(id, ['yes', 'no', 'button']);
      const said = answer.act === 'yes' && whole ? { choice: 'allow_once', resultCheck: true } : answer.act === 'button' && answer.button === 'no' ? { choice: 'decline' } : null;
      if (said) waiting.line(['One moment…']);
      return said;
    };
  }

  /** "For Sam: ... Send only that?" The answer to the engine's own question about what is about to leave. */
  function sendOnly(stage: NotchStage, from: PeerPerson, answer: string, waiting: Waiting) {
    return async (): Promise<Record<string, unknown> | null> => {
      waiting.reached();
      if (waiting.over()) return null;
      const lines = answer.split('\n');
      if (lines.length === 1 && answer.length <= NOTCH_PEOPLE_LINE_MAX) {
        const said = await stage.choose(['For ', em(from.name), ': ', answer, ' Send only that?'], ['Send it', 'No'], { who: from.name, mood: 'look' });
        if (said.act !== 'pick') return null;
        waiting.line(['One moment…']);
        return said.index === 0 ? { choice: 'send' } : { choice: 'cancel' };
      }
      const first = await stage.offer(['I have the answer for ', em(from.name), '. Read it before it goes?'], 'read', { who: from.name, mood: 'look' });
      if (first.act !== 'yes') return null;
      const id = stage.id();
      stage.put({
        id, kind: 'sheet', say: ['For ', em(from.name), '. Send only that?'], who: from.name, mood: 'look', stay: true, no: 'not now', yes: 'send', whole: true,
        blocks: [{ kind: 'paper', lines: lines.map((line) => [line]) }, { kind: 'buttons', buttons: [{ id: 'no', label: 'Do not send' }] }],
      });
      const said = await stage.answer(id, ['yes', 'no', 'button']);
      const chosen = said.act === 'yes' ? { choice: 'send' } : said.act === 'button' && said.button === 'no' ? { choice: 'cancel' } : null;
      if (chosen) waiting.line(['One moment…']);
      return chosen;
    };
  }

  /** Begins the work on a request that was said yes to. */
  function begin(row: PeerRequestRow, from: PeerPerson): void {
    const job = (async () => {
      let done: { ok: true; answer: string } | { ok: false } = { ok: false };
      try { if (deps.work) done = await deps.work({ from: from.name, words: row.words }); } catch { done = { ok: false }; }
      // What goes is what is shown, so it is made into what can be shown here and now: readable lines, cut to size.
      const answer = done.ok ? peopleLines(done.answer, NOTCH_PEOPLE_ANSWER_MAX).join('\n') : '';
      // It was stopped, or taken back, while it was being found: it has ended, and what was found goes nowhere.
      if (answer && !store.requestState(row.id, 'ready', answer)) return;
      if (!answer && store.requestState(row.id, 'no')) {
        void link.refuse(row.id);
        if (!onNotch.has(row.id)) news(`people:could-not:${row.id}`, ['I could not find what ', em(from.name), ' asked for.'], ['I could not find what ', em(from.name), ' asked for. ', em(from.name), ' gets nothing back.'], { who: from.name });
      }
      // Its line left the notch meanwhile: it comes back with what was found.
      if (answer && !onNotch.has(row.id)) asked(row.id);
    })();
    working.set(row.id, job);
  }

  /** The item for a request that arrived. It plays from wherever the request stands. */
  function asked(taskId: string): void {
    const first = store.requestOf(taskId);
    const from = first ? person(first.peer) : null;
    if (!first || !from || first.dir !== 'in') return;
    const short = (text: string): string => { const plain = peerPlain(text, 61); return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain; };
    inbox.add({
      id: `people:req:${taskId}`, subject: `people:req:${taskId}`, class: 'person', speaks: true,
      title: () => {
        const row = store.requestOf(taskId);
        return row?.state === 'ready' ? ['The answer for ', em(from.name), ' is ready.'] : row?.state === 'working' ? ['Finding the answer for ', em(from.name), '.'] : [em(from.name), ' asks me: ', short(first.words)];
      },
      check: () => { const row = store.requestOf(taskId); return !!row && row.state !== 'done' && row.state !== 'no'; },
      play: async (stage) => {
        onNotch.add(taskId);
        try {
          const ended = (): void => { if (first.item) { store.done(first.item); void link.seen(first.item); } };
          let row = store.requestOf(taskId);
          if (!row) return 'settled';
          if (row.state === 'new') {
            const waiting = watch(stage);
            waiting.line(['Opening what ', em(from.name), ' asks…']);
            waiting.within(engineWait);
            const opened = await Promise.race([link.open(taskId, { request: approve(stage, from, row, waiting) }), waiting.gone]);
            // Esc while it opens is not now. What the engine asks later is closed, and the request stays to be opened again.
            if (opened === 'closed' || opened === 'stop') return 'waits';
            if (opened === 'failed' || opened === 'late') { await stage.say(['I cannot take that up right now. It waits for you.'], 3000, { mood: 'sorry' }); return 'waits'; }
            if (opened === 'gone') { store.requestState(taskId, 'no'); ended(); await stage.say([em(from.name), ' took it back.'], 2400, { who: from.name }); return 'settled'; }
            if (opened === 'declined') { store.requestState(taskId, 'no'); ended(); await stage.say(['Told ', em(from.name), ' no. Nothing was touched.'], 3000, { who: from.name }); return 'settled'; }
            store.requestState(taskId, 'working');
            begin(row, from);
          }
          row = store.requestOf(taskId);
          if (row?.state === 'working') {
            const job = working.get(taskId);
            if (!job) {
              // The brain was started anew in the middle of it: nothing is being done, and its hold on the request went with it.
              store.requestState(taskId, 'no'); ended();
              // Whether the other side could be told depends on whether the engine was started anew too.
              const told = await link.refuse(taskId);
              await stage.say(told ? ['I was stopped in the middle of what ', em(from.name), ' asked. I told ', em(from.name), ' no.'] : ['I was stopped in the middle of what ', em(from.name), ' asked. Nothing was sent.'], 3600, { mood: 'sorry' });
              return 'settled';
            }
            const waitId = stage.id();
            stage.put({ id: waitId, kind: 'work', say: ['Finding the answer for ', em(from.name), '…'], steps: 0, done: 0, mood: 'work', who: from.name });
            const stopped = stage.answer(waitId, ['stop', 'no']).then(() => 'stop' as const, () => 'left' as const);
            const how = await Promise.race([job.then(() => 'found' as const), stopped]);
            if (how === 'left') return 'waits';
            if (how === 'stop') {
              // Stopped by the person: nothing of it is sent, whatever is found later.
              store.requestState(taskId, 'no'); ended(); void link.refuse(taskId);
              await stage.say(['Stopped. Told ', em(from.name), ' no. Nothing left this laptop.'], 3200, { who: from.name });
              return 'settled';
            }
          }
          row = store.requestOf(taskId);
          if (row?.state === 'no') { ended(); await stage.say(['I could not find that. ', em(from.name), ' gets nothing back.'], 3200, { mood: 'sorry', who: from.name }); return 'settled'; }
          if (row?.state !== 'ready' || !row.answer) return 'settled';
          const sending = watch(stage);
          sending.line(['Getting it ready for ', em(from.name), '…']);
          sending.within(engineWait);
          const finished = await Promise.race([link.finish(taskId, row.answer, { result: sendOnly(stage, from, row.answer, sending) }), sending.gone]);
          if (finished === 'closed' || finished === 'stop') return 'waits';
          if (finished === 'failed' || finished === 'late') { await stage.say(['I could not send it now. It waits for you.'], 3000, { mood: 'sorry' }); return 'waits'; }
          if (finished === 'sent') { store.requestState(taskId, 'done'); ended(); await stage.say(['Sent. Only that left this laptop.'], 3200, { mark: 'check', who: from.name }); return 'settled'; }
          store.requestState(taskId, 'no');
          ended();
          if (finished === 'gone') { await stage.say([em(from.name), ' took it back. Nothing was sent.'], 2800, { who: from.name }); return 'settled'; }
          // The engine was started anew since the yes: it does not hold the request any more, and nothing can be sent for it.
          if (finished === 'lost') { await stage.say(['I lost hold of what ', em(from.name), ' asked when I was started anew. Nothing was sent.'], 3600, { mood: 'sorry', who: from.name }); return 'settled'; }
          // Kept back, or closed too often to be asked again: the other side is told no, with nothing of this machine's.
          void link.refuse(taskId);
          await stage.say(['Told ', em(from.name), ' no. Nothing left this laptop.'], 3000, { who: from.name });
          return 'settled';
        } finally {
          onNotch.delete(taskId);
        }
      },
    });
  }

  // --- a request: what this machine asked ---

  /** The answer to something this machine asked: said, or opened to be read. */
  function answer(row: PeerRequestRow, from: PeerPerson): void {
    const theirs = `${from.name}'s ${NOTCH_NAME}`;
    const key = `answer:${row.id}`;
    store.take(key, row.peer);
    inbox.add({
      id: `people:${key}`, subject: `people:${key}`, class: 'person', speaks: true,
      title: () => [em(theirs), ' answered.'],
      check: () => store.got(key)?.done !== true,
      play: async (stage) => {
        const lines = peopleLines(row.answer ?? '', NOTCH_PEOPLE_ANSWER_MAX);
        if (lines.length === 1 && lines[0]!.length <= NOTCH_PEOPLE_LINE_MAX) {
          const said = await stage.offer([em(theirs), ': ', lines[0]!], 'ok', { who: from.name, mood: 'look' });
          if (said.act !== 'yes') return 'waits';
        } else {
          const first = await stage.offer([em(theirs), ' answered. Read it?'], 'read', { who: from.name, mood: 'look' });
          if (first.act !== 'yes') return 'waits';
          await stage.sheet([em(theirs)], [{ kind: 'note', say: ['You asked: ', peerPlain(row.words, 200)] }, { kind: 'paper', lines: lines.map((line) => [line]) }], { who: from.name });
        }
        store.done(key);
        return 'settled';
      },
    });
  }

  /** Looks at what became of what this machine asked. */
  async function follow(): Promise<void> {
    const open = store.openRequests('out');
    if (!open.length || link.account().engine !== 'up') return;
    let all: PeerRequest[];
    try { all = await link.requests(); } catch { return; }
    for (const row of open) {
      const from = person(row.peer);
      const end = all.find((one) => one.id === row.id && one.dir === 'out' && one.peer === row.peer)?.end ?? null;
      if (!from) continue;
      if (!end) {
        if (row.nudgedAt === null && now() - row.at >= NOTCH_PEOPLE_ASK_WAIT_MS) unanswered(row, from);
        continue;
      }
      inbox.remove(`people:late:${row.id}`);
      if (end.how === 'answered') {
        // What they wrote is kept as text and shown as text. Nothing is done with it.
        if (store.requestState(row.id, 'done', end.text.slice(0, NOTCH_PEOPLE_ANSWER_MAX * 2))) answer(store.requestOf(row.id)!, from);
        continue;
      }
      if (!store.requestState(row.id, 'no') || end.how === 'cancelled') continue;
      const theirs = `${from.name}'s`;
      const say: NotchPart[] = end.how === 'expired' ? [em(from.name), ' did not answer in time. It is closed.']
        : end.how === 'failed' && end.said ? [em(`${theirs} ${NOTCH_NAME}`), ' could not do it.']
          : end.how === 'declined' ? [em(from.name), ' said no. Nothing left ', em(theirs), ' laptop.']
            // It was taken up and nothing was sent: kept back there, or not found. This machine cannot tell which.
            : ['Nothing came back from ', em(`${theirs} ${NOTCH_NAME}`), '. Nothing left ', em(theirs), ' laptop.'];
      news(`people:end:${row.id}`, say, say, { person: true, who: from.name, ms: 4200 });
    }
  }

  /** A request that is out too long: its asker is told once. */
  function unanswered(row: PeerRequestRow, to: PeerPerson): void {
    store.requestNudged(row.id);
    inbox.add({
      id: `people:late:${row.id}`, subject: `people:late:${row.id}`, class: 'rest', speaks: true,
      title: () => [em(to.name), ' has not answered.'],
      check: () => { const kept = store.requestOf(row.id); return !!kept && kept.state === 'new'; },
      play: async (stage) => {
        const said = await stage.choose([em(to.name), ' has not answered. Wait, or take it back?'], ['Wait', 'Take it back'], { who: to.name });
        if (said.act !== 'pick') return 'waits';
        if (said.index === 0) { await stage.say(['It waits. I will tell you what comes back.'], 3000); return 'settled'; }
        if (!(await link.takeBack(row.id))) { await stage.say(['I could not take it back now.'], 3000, { mood: 'sorry' }); return 'waits'; }
        store.requestState(row.id, 'no');
        await stage.say(['Taken back. ', em(to.name), ' will not be asked.'], 2800);
        return 'settled';
      },
    });
  }

  /** While something is out, its answer is looked for often: nothing announces it. */
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  function following(): void {
    if (deps.noClock || followTimer) return;
    followTimer = setTimeout(() => {
      followTimer = null;
      void follow().finally(() => { if (store.openRequests('out').length) following(); });
    }, NOTCH_PEOPLE_FOLLOW_MS);
    (followTimer as { unref?: () => void }).unref?.();
  }

  async function lookNow(): Promise<void> {
    if (link.account().engine !== 'up' || !link.account().signedIn) return;
    let items: PeerItem[];
    try { items = await link.unread(); } catch { log('[notch] what arrived from the others could not be read'); return; }
    for (const item of items) {
      // What belongs to something this machine asked (a result, a no, a note of progress) is read with the
      // request itself (`follow`). Here it is only marked as taken in, so that it is not listed for ever.
      if (item.kind !== 'message' && item.kind !== 'task_request' && item.kind !== 'task_cancel') { void link.seen(item.id); continue; }
      const known = store.got(item.id);
      if (known?.done) { void link.seen(item.id); continue; }
      if (known && (inbox.has(`people:${item.id}`) || (item.task !== null && inbox.has(`people:req:${item.task}`)))) continue;
      let from = person(item.from);
      if (!from && now() - refreshedAt > NOTCH_PEOPLE_TICK_MS) { refreshedAt = now(); await link.refresh(); from = person(item.from); }
      // From a device that has no name here: not somebody the owner connected with. Left where it is.
      if (!from) continue;
      store.take(item.id, item.from);
      if (item.kind === 'task_cancel') {
        // They took their request back: it leaves, wherever it stood. Work that is under way sends nothing.
        const row = item.task ? store.requestOf(item.task) : null;
        if (row && row.dir === 'in' && row.peer === item.from && store.requestState(row.id, 'no')) {
          if (inbox.remove(`people:req:${row.id}`) || working.has(row.id)) news(`people:back:${row.id}`, [em(from.name), ' took it back.'], [em(from.name), ' took it back.'], { who: from.name, ms: 2400 });
          if (row.item) store.done(row.item);
        }
        store.done(item.id);
        void link.seen(item.id);
        continue;
      }
      if (item.kind === 'task_request') {
        if (!item.task) { store.done(item.id); continue; }
        // Kept as what can be read, line by line: the words that are shown are the words that are worked on.
        // One longer than can be read here is kept a little past the limit, so that it is known to be too long.
        store.request({ id: item.task, dir: 'in', peer: item.from, words: peopleLines(item.text, NOTCH_PEOPLE_REQUEST_MAX + 200).join('\n'), item: item.id });
        asked(item.task);
        continue;
      }
      const { words, note } = peerNoteRead(item.text);
      if (isFileNote(note)) {
        if (files) {
          // An offer that is already on the notch, or in the count, is not put there twice.
          if (note.kind !== 'file' || !inbox.has(`people:file:${note.id}`)) await files.note(item, from, note, words);
          // Pieces come many at a time, and more than one look takes in: looked again until none is left.
          if (note.kind === 'file-part') again = true;
        } else if (note.kind === 'file') message(item, from, words);
        else { store.done(item.id); void link.seen(item.id); }
        continue;
      }
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
        // Every sending of the question is taken back: it may have been asked again.
        let back: PeerSent = { ok: false, why: 'refused' };
        for (const id of store.sendings(sent.id)) {
          const one = await link.tell(to.id, peerNoteText('Taken back.', { kind: 'back', of: id }));
          if (one.ok || !back.ok) back = one;
        }
        if (!back.ok) { await stage.say(sorry(back), 3200, { mood: 'sorry' }); return 'waits'; }
        store.mark(sent.id, 'back');
        await stage.say(['Taken back. ', em(to.name), ' will not be asked.'], 2800);
        return 'settled';
      },
    });
  }

  async function tick(): Promise<void> {
    await look();
    await follow();
    for (const sent of store.unanswered(now() - NOTCH_PEOPLE_ASK_WAIT_MS)) late(sent);
  }

  if (store.openRequests('out').length) following();
  /** After the brain was started anew: what waited for the person waits again, once the people are known. */
  let restored = false;
  function restore(): void {
    if (restored || !others().length) return;
    restored = true;
    for (const row of store.openRequests('in')) if (row.state !== 'new') asked(row.id);
    files?.restore();
    for (const key of store.waiting()) {
      if (!key.startsWith('answer:')) continue;
      const row = store.requestOf(key.slice('answer:'.length));
      const from = row ? person(row.peer) : null;
      if (row && from && row.state === 'done') answer(row, from);
    }
  }
  link.onArrival(() => { void look(); });
  link.onChange(() => { restore(); inbox.refresh(); void look(); });
  // The server went on or off: Home's row for it says so.
  setup?.onChange(() => { inbox.refresh(); });

  return {
    row, rows, open, server, route, look, tick,
    names: () => others().map((one) => ({ name: one.name })),
    fileTargets: () => (files && link.account().engine === 'up' && link.account().signedIn ? others().map((one) => ({ id: one.id, name: one.name })) : []),
    sendFile(to, file) { const one = person(to); if (!files || !one) return false; files.send(one, file); return true; },
    filesIdle: () => files?.idle() ?? Promise.resolve(),
    stop() { if (timer) clearInterval(timer); if (followTimer) clearTimeout(followTimer); },
  };
}
