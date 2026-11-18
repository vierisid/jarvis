/**
 * Asking Jarvis on the notch: typed in Home, or spoken while the talk keys are
 * held. Both become the same thing here, one instruction, and go the same way:
 *
 *   heard  ->  claimed in the ledger  ->  one stored turn (or one memory)  ->  the answer
 *
 * One router: what was typed and what was heard enter at the same function
 * (`run`), which either writes a memory ("Remember that...") or submits a turn
 * through the product's own turn store. One history: every turn goes into the
 * notch's one conversation, which the dashboard lists like any other.
 *
 * An instruction that is under way is an item in the inbox (./inbox.ts), so
 * the notch's manners hold for it too. It plays itself according to where it
 * is: the words while they are heard, the work while it runs, the answer when
 * there is one. It is written down in the ledger (./ledger.ts) at every step,
 * and the ledger is what decides whether it may run: only a row that is
 * `heard` can be claimed, and only once. So a recording that was turned away
 * cannot run, whatever arrives late.
 *
 * Nothing is spoken. An answer is one line. A long one is a sheet, which stays
 * until it is closed, and comes back after a restart if it was not.
 */
import type { BriefChatEvent, BriefTurnRef, BriefTurnState } from '../brief/contracts.ts';
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchAskRow, NotchAskSource, NotchAskState, NotchLedger } from './ledger.ts';
import type { NotchBlock, NotchButton, NotchPart } from './protocol.ts';
import type { NotchQuietHome } from './quiet.ts';
import { NotchStageEnded } from './stage.ts';
import type { NotchStage } from './stage.ts';
import { whereQuestion, type NotchPointDuring, type NotchPointed } from './point.ts';

/** How long the words that were heard stay on the notch before they are acted on. Esc in that time turns them away. */
export const NOTCH_HEARD_MS = 900;
/** The longest answer that is said as one line. Anything longer, or in several paragraphs, opens as a sheet. */
export const NOTCH_ONE_LINE_CHARS = 140;
/** The most of an answer a sheet carries. The whole of it is in the dashboard. */
export const NOTCH_SHEET_CHARS = 6000;
export const NOTCH_SHEET_LINES = 60;
/** How many instructions the ledger's sheet lists. */
export const NOTCH_LEDGER_ROWS = 40;

/** How long the last answer is offered again at the top of Home. */
export const NOTCH_LAST_ANSWER_MS = 10 * 60_000;

export const NOTCH_NOT_CAUGHT = 'I did not catch that.';
const WAITING_FOR_YES = 'Waiting for your yes.';
const NOT_SAVED = 'Not saved.';
/** A memory whose question was cut off by something else: the person never got to answer it. */
const NOT_SAVED_CUT = 'I did not save that: something came up while I was asking. Say it again.';
const WAITING_FOR_CHAT = 'Waiting for another chat to finish.';

/** Why nothing was caught, for the ledger and for the one case where the sentence says more. */
export type NotchMissReason = 'silence' | 'too_little' | 'failed' | 'no_stt' | 'too_long';

/** The product's turn store, as the notch uses it. */
/**
 * Something that goes with the words of an instruction: the picture of what
 * was circled on the screen and what was read there (./look.ts), or a file
 * dropped on the notch (./drop.ts). It travels as an attachment of the turn,
 * so the model reads it as outside content.
 */
export interface NotchAskFile {
  kind: 'document' | 'image' | 'screenshot';
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** What the door throws when the files of an instruction could not be kept with it. `why` is said to the person. */
export class NotchFilesNotKept extends Error {
  constructor(readonly why: string) { super(why); }
}

export interface NotchTurnDoor {
  /** Whether a turn can be taken now. False while the brain is starting or draining. */
  ready(): boolean;
  /** The id of the notch's conversation, made when there is none. */
  conversation(): string;
  /**
   * Starts a stored turn, with its files when it has any. Throws with a
   * `status` of 409 when the conversation already has one, and a
   * NotchFilesNotKept when the files could not be kept: then nothing was
   * started.
   */
  submit(turn: BriefTurnRef & { text: string; files?: NotchAskFile[] }): void | Promise<void>;
  cancel(turn: BriefTurnRef): void;
  onEvent(listener: (event: BriefChatEvent) => void): () => void;
  /** Where a turn stands now, and its whole stored reply. Null when there is no such turn. */
  look(turn: BriefTurnRef): { state: BriefTurnState; text: string; error?: { code: string; message: string } } | null;
  /**
   * Writes one line into the conversation after a turn that did not finish,
   * so that the next turn's model does not take the unanswered request for
   * something still to be done.
   */
  mark?(turn: BriefTurnRef, text: string): void;
}

/** What "Remember that..." comes back with. */
export type NotchRemembered =
  | { ok: true; said: string; understood: string }
  | { ok: false; why: string };

export interface NotchAsksDeps {
  ledger: NotchLedger;
  /** The turn store. A function, because the daemon builds it after the notch. */
  turns(): NotchTurnDoor | null;
  /** Whether a model is set up to answer. */
  modelReady(): boolean;
  /** Everything is stopped (Esc twice): nothing new is started. */
  paused?: () => boolean;
  /**
   * Writes one thing to memory and reads it back. With `confirm` it first
   * asks, showing the fact as it would be saved, and writes nothing on a no.
   */
  remember?: (what: string, sentence: string, askId: string, confirm?: (fact: string) => Promise<boolean>) => Promise<NotchRemembered>;
  /** One sentence saying what the instruction was taken to mean. Null when it cannot be said. */
  understand?: (text: string) => Promise<string | null>;
  /**
   * "Where is…?" (./point.ts): finds it in what the window in front says
   * about itself, and points at it on the screen. Null when the words are not
   * such a question, or the window has no answer: then they run as any other
   * instruction.
   */
  point?: ((question: string, during?: NotchPointDuring) => Promise<NotchPointed | null>) & {
    /** Whether these words would go on with a walk that stopped before its end ("go on", "and now?"). */
    goesOn?: (text: string) => boolean;
  };
  /**
   * Words the notch acts on itself, with no model and no turn (./teach.ts):
   * "Watch me", "done" while it watches, "run it on nine rows", "undo that".
   * Null when they are an instruction like any other. `did` is what the
   * ledger says was done; `run` does it, and shows what it shows by itself.
   */
  side?: (text: string, how?: NotchAskHow) => { did: string; run(): void } | null;
  /** Home's row about the jobs Jarvis was shown, when there are any, and the sheet it opens. */
  learned?: { row(): NotchBlock | null; open(stage: NotchStage): Promise<void> };
  /**
   * What stands (pass 11): the agents, what is chased until it is done, and
   * what an eye is kept on. Each row leads to its list by its id.
   */
  standing?: { rows(): NotchBlock[]; open(stage: NotchStage, row: string): Promise<void> };
  /**
   * The assistant has carried out an instruction that began at `since`. What
   * it built that runs by itself is the agents' to take in (pass 11): the
   * notch switches it on and names it, and nobody is sent to the dashboard.
   */
  afterTurn?: (since: number) => void;
  /** Takes back what a job of today pasted: the Undo on its row in Home. */
  undoJob?: (jobId: string) => void;
  /** An approval this instruction's turn is waiting for should take the notch now. */
  raiseApproval?: (approvalId: string) => void;
  /**
   * Whether a call is being listened to and written down (./call.ts). What
   * is said to the notch then is turned away at the first key: the
   * microphone is the call's. On a call that is not listened to, the talk
   * keys work as ever.
   */
  callHeard?: () => boolean;
  /** How long the person's hands have been still, in milliseconds (./presence.ts). 0 while they move, or when it is not known. */
  stillFor?: () => number;
  /** The instruction ended while one of its approvals was still unanswered: it is asked no more. */
  withdrawApproval?: (approvalId: string) => void;
  /** A small sign that the notch heard and will not act (a shake), for when no line can be shown. */
  attention?: () => void;
  /** What was said was made out: the notch nods as it takes it. */
  nod?: () => void;
  /** The pointer is leaving for a thing: the lip leans toward it (0 to 1 along the lower edge). */
  reach?: (aim: number) => void;
  /**
   * A question about where something is has been answered: by pointing at
   * it on the screen (true), or not (false: nothing to point at was found,
   * and it went on as any other question). Day one, which teaches it, asks.
   */
  pointed?: (shown: boolean) => void;
  /**
   * Nothing was made out of what was said. True when that is another part's
   * to answer (day one, waiting to hear the person for the first time): then
   * nothing is said about it here.
   */
  unheard?: (why: NotchMissReason) => boolean;
  openDashboard?: (sidecarId: string | null) => void;
  /** Rows for Home, under the text field: what was done today. */
  today?: () => NotchBlock[];
  /** Where the person is and whether Jarvis is looking: Home's row about it, and the sheet it opens (where.ts). */
  see?: { row(): NotchBlock; open(stage: NotchStage): Promise<void> };
  /**
   * Replies to mail that are prepared and waiting for the owner's word
   * (mail/notch.ts): Home's row about them, when there are any, and what it
   * opens. They wait here so that they never stand between the owner and the
   * text field.
   */
  mail?: { row(): NotchBlock | null; open(stage: NotchStage): Promise<void> };
  /** The person's quiet hours (quiet.ts): Home's line about them and its button, and what a change there does. */
  quiet?: NotchQuietHome;
  /**
   * The quiet links at the foot of Home (pass 12): Memory, Connections,
   * Settings, the dashboard. `press` opens what a link leads to and comes
   * back with whether Home is to be drawn again after it (`stay`) or is over
   * (`leave`). Null when the button is not one of these.
   */
  more?: { buttons(): NotchButton[]; press(stage: NotchStage, button: string): Promise<'stay' | 'leave' | null> };
  heardMs?: number;
  log?: (line: string) => void;
}

/**
 * How long the hands have to have been still, before an answer came and all
 * the while it was on the notch, for it to count as said to nobody. It is
 * then said once more when the hands are on again.
 */
export const NOTCH_ANSWER_UNSEEN_STILL_MS = 2 * 60_000;

export interface NotchAsks {
  /**
   * The person's hands are on again. An answer that came while they were
   * off, and was on the notch with nobody there, is said again now.
   */
  handsOn(): void;
  /** Something was typed, or asked about files that go with it. Comes back with the instruction's id. */
  typed(text: string, files?: NotchAskFile[]): string;
  /** The talk keys went down: a recording has begun. Comes back with the instruction's id. */
  listen(talkId: string): string;
  /**
   * The keys came up: the recording is being made into words. False when the
   * instruction is no longer waiting for them (it was turned away while the
   * keys were still held): then the recording need not be transcribed at all.
   */
  released(talkId: string): boolean;
  /**
   * The words. `cut` when listening stopped by itself at the limit: what was
   * heard may end in the middle of a sentence, so it is asked about first.
   */
  words(talkId: string, text: string, more?: { cut?: boolean; files?: NotchAskFile[] }): void;
  /** Nothing was caught. */
  nothing(talkId: string, why: NotchMissReason): void;
  /** The recording was thrown away where it was made. */
  dropped(talkId: string): void;
  /** One line that is not about an instruction (the microphone is muted, and the like). */
  tell(parts: NotchPart[], mood?: 'careful' | 'confused' | 'sorry'): void;
  /** What yes at rest opens when nothing waits: the text field, and today under it. */
  home(stage: NotchStage): Promise<void>;
  /** After a start: closes what the last run left open, and brings back answers nobody closed. */
  resume(): void;
  /** Whether `approvalId` belongs to a turn started here that is still running. */
  mine(approvalId: string): boolean;
  /** Looks up what is running in the turn store, and concludes what has ended there. */
  reconcile(): void;
  stop(): void;
}

/** How some words came: typed or spoken, and when the typing was sent or the talk keys went down. */
export interface NotchAskHow {
  source: NotchAskSource;
  at: number;
}

interface Live {
  id: string;
  source: NotchAskSource;
  /** When it was made: the typing was sent, or the talk keys went down. */
  at: number;
  phase: NotchAskState;
  heard: string;
  /** What it is doing now, as one sentence. */
  activity: string | null;
  turn: BriefTurnRef | null;
  /** The reply since the last thing that was done: the answer, once the turn ends. */
  segment: string;
  whole: string;
  answer: string | null;
  /** Something was done in this turn (an activity was recorded): what "Done." may be said of. */
  didSomething?: boolean;
  note: string | null;
  missed: NotchMissReason | null;
  /** Listening stopped by itself at the limit: the words are asked about before they are acted on. */
  cut?: boolean;
  /** When it began to be carried out. */
  began?: number;
  /** What goes with the words: what was circled on the screen, a file that was dropped. */
  files?: NotchAskFile[];
  /** The person asked for it to stop. What has no turn to cancel yet ends by this. */
  stopAsked?: boolean;
  /**
   * The way to something is being shown on the screen, one click at a time
   * (./point.ts). Calling this takes it off the screen. Unlike a turn, a walk
   * waits on the person, so it does not stand in the way of what they ask
   * next: a new question ends it.
   */
  walk?: () => void;
  /** It ended because something else took its place: nothing is said about it. */
  silent?: boolean;
  /** Its answer was on the notch while nobody was there, and waits for their hands to be on again. */
  unread?: boolean;
  /** And it has been said a second time, for them: not a third. */
  reread?: boolean;
  approvals: Set<string>;
  waiters: Set<() => void>;
}

const em = (text: string): NotchPart => ({ em: text });

/** A promise that may lose a race and then fail when the stage ends: its failure is nobody's. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export function shortened(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const points = [...one];
  return points.length <= max ? one : `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * "Remember that Anna prefers calls." comes back as "Anna prefers calls".
 * Null for anything that is not a plain request to remember one thing.
 */
export function rememberSentence(text: string): string | null {
  const match = /^\s*(?:please\s+|jarvis[,\s]+|per favore\s+)?(?:remember|ricorda(?:ti)?)[,:]?\s+(?:that\s+|this:\s*|che\s+)?(.+?)\s*$/is.exec(text);
  if (!match) return null;
  const what = match[1]!.replace(/[.!\s]+$/, '').trim();
  // "Remember to call Anna" is a job, not a fact, and a question is not one either.
  if (!what || /^(to|di)\s/i.test(what) || what.endsWith('?')) return null;
  // Something tied to a time ("I have a meeting tomorrow at 3") is not a
  // fact to keep for good: saved as one it would be believed next month, and
  // nothing would remind anybody. It goes to the agent like any other ask.
  if (REMEMBER_TIMED.test(what)) return null;
  return [...what].length < 3 ? null : what;
}

const REMEMBER_TIMED = new RegExp([
  '\\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week|weekend|month)|next (week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\\b',
  '\\b(on|by|until|before|after) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|the \\d{1,2}(st|nd|rd|th)?)\\b',
  '\\bat \\d{1,2}([:.]\\d{2})?\\s?(am|pm|o\'clock)?\\b',
  '\\bin \\d+ (minutes?|hours?|days?|weeks?)\\b',
  '\\b(oggi|stasera|stanotte|domani|dopodomani|ieri|settimana prossima|alle \\d{1,2})\\b',
].join('|'), 'i');

/** An answer as plain lines: the marks a model writes for a web page are taken out. */
export function plainLines(answer: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of answer.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    let line = raw;
    if (!fenced) {
      line = line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        // A link keeps its address, unless its words are the address.
        .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_all, words: string, address: string) => (words.trim() === address ? address : `${words} (${address})`))
        // Bold and italic marks, and only those: `2 * 3 * 4` and `__init__`
        // are not emphasis, and are left as they are.
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1')
        .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
      // A table: its ruler row is dropped, and a row reads across with dots.
      if (/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line)) continue;
      if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join(' · ');
    }
    line = line.replace(/\s+$/, '');
    if (!line.trim()) continue;
    lines.push(line);
  }
  return lines;
}

/** How an answer is shown: said as one line, or opened as a sheet. */
export function answerShape(answer: string): { kind: 'line'; text: string } | { kind: 'sheet'; lines: string[]; cut: boolean } {
  const lines = plainLines(answer);
  if (lines.length === 0) return { kind: 'line', text: 'Done.' };
  if (lines.length === 1 && [...lines[0]!].length <= NOTCH_ONE_LINE_CHARS) return { kind: 'line', text: lines[0]!.trim() };
  // Two short sentences on two lines are still one thing to read at a glance.
  if (lines.length === 2 && lines.every((line) => !/^\s*(•|\d+[.)])\s/.test(line))) {
    const joined = `${lines[0]!.trim()} ${lines[1]!.trim()}`;
    if ([...joined].length <= NOTCH_ONE_LINE_CHARS) return { kind: 'line', text: joined };
  }
  const kept: string[] = [];
  let used = 0;
  let cut = false;
  for (const line of lines) {
    const points = [...line];
    if (kept.length >= NOTCH_SHEET_LINES || used + points.length > NOTCH_SHEET_CHARS) { cut = true; break; }
    kept.push(line);
    used += points.length;
  }
  if (kept.length === 0) { kept.push(`${[...lines[0]!].slice(0, NOTCH_SHEET_CHARS - 1).join('')}…`); cut = true; }
  return { kind: 'sheet', lines: kept, cut };
}

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The one word that says how an instruction ended, for the ledger's list. */
export function ledgerWord(row: Pick<NotchAskRow, 'state' | 'kind'>): string {
  switch (row.state) {
    case 'done': return row.kind === 'remember' ? 'remembered' : 'done';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    case 'dismissed': return 'turned away';
    case 'missed': return 'not caught';
    case 'refused': return 'not started';
    case 'running': return 'running';
    default: return 'heard';
  }
}

/** One instruction, in full, as the blocks of a sheet. */
export function ledgerDetail(row: NotchAskRow): NotchBlock[] {
  const blocks: NotchBlock[] = [];
  const said = row.heard || 'Nothing was caught.';
  blocks.push({ kind: 'row', lead: row.source === 'spoken' ? 'Heard' : 'Typed', say: [said], small: clock(row.createdAt) });
  if (row.understood) blocks.push({ kind: 'row', lead: 'Understood', say: [row.understood] });
  if (row.did.length > 0) blocks.push({ kind: 'row', lead: 'Did', say: [row.did.join(' ')] });
  const end = row.state === 'running' ? 'Still running.'
    : row.state === 'dismissed' ? 'Turned away before it ran. Nothing was done.'
      : row.state === 'missed' ? 'Nothing was caught, so nothing was done.'
        : row.state === 'refused' ? `Not started. ${row.note ?? ''}`.trim()
          : row.state === 'stopped' ? 'Stopped by you.'
            : row.state === 'failed' ? `Failed. ${row.note ?? ''}`.trim()
              : null;
  if (end) blocks.push({ kind: 'row', lead: 'Ended', say: [end] });
  if (row.answer) {
    const shape = answerShape(row.answer);
    blocks.push({ kind: 'paper', lines: (shape.kind === 'line' ? [shape.text] : shape.lines).map((line): NotchPart[] => [line]) });
  }
  return blocks;
}

export function attachNotchAsks(inbox: NotchInbox, deps: NotchAsksDeps): NotchAsks {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ledger = deps.ledger;
  const heardMs = deps.heardMs ?? NOTCH_HEARD_MS;
  const live = new Map<string, Live>();
  const byTalk = new Map<string, string>();
  const byTurn = new Map<string, Live>();
  let unlisten: (() => void) | null = null;
  let tells = 0;
  // Old rows go: the ledger is a record of what was asked, not an archive.
  try { ledger.prune(); } catch (error) { log(`[notch] the ledger could not be pruned: ${error instanceof Error ? error.message : String(error)}`); }

  const itemId = (id: string): string => `ask:${id}`;

  function make(id: string, source: NotchAskSource, phase: NotchAskState, heard: string): Live {
    const ask: Live = {
      id, source, at: Date.now(), phase, heard, activity: null, turn: null, segment: '', whole: '', answer: null, note: null, missed: null,
      approvals: new Set(), waiters: new Set(),
    };
    live.set(id, ask);
    return ask;
  }

  /**
   * Brings up again the approvals an instruction waits on. Not more often
   * than every fifteen seconds for one approval, and three times at most: an
   * approval the person looked at and left open is not pushed at them.
   */
  const raisedAgain = new Map<string, { at: number; times: number }>();
  function raiseAgain(ask: Live): void {
    if (ask.activity !== WAITING_FOR_YES || !deps.raiseApproval) return;
    for (const approvalId of ask.approvals) {
      const before = raisedAgain.get(approvalId);
      if (before && (before.times >= 3 || Date.now() - before.at < 15_000)) continue;
      raisedAgain.set(approvalId, { at: Date.now(), times: (before?.times ?? 0) + 1 });
      deps.raiseApproval(approvalId);
    }
  }

  /** Something about `ask` changed: whoever is drawing it draws it again, and if nobody is, it gets its say. */
  function bump(ask: Live, fresh = false): void {
    const waiters = [...ask.waiters];
    ask.waiters.clear();
    for (const wake of waiters) wake();
    if (!live.has(ask.id)) return;
    if (inbox.showing() === itemId(ask.id)) return;
    inbox.add(item(ask, fresh));
  }

  const changed = (ask: Live): Promise<'changed'> => new Promise((resolve) => { ask.waiters.add(() => resolve('changed')); });

  function forget(ask: Live): void {
    live.delete(ask.id);
    if (ask.turn) byTurn.delete(ask.turn.turnId);
    for (const [talkId, id] of byTalk) if (id === ask.id) byTalk.delete(talkId);
  }

  /** Takes an instruction that has not run off the notch for good. */
  function turnAway(ask: Live, note: string): void {
    if (!ledger.dismiss(ask.id, note)) return;
    ask.phase = 'dismissed';
    const waiters = [...ask.waiters];
    ask.waiters.clear();
    for (const wake of waiters) wake();
    inbox.remove(itemId(ask.id));
    forget(ask);
  }

  /** Only one instruction is on its way at a time: a new one takes the place of any that has not run yet. */
  function replaceEarlier(note: string): void {
    for (const ask of [...live.values()]) {
      if (ask.phase === 'listening' || ask.phase === 'transcribing' || ask.phase === 'heard') turnAway(ask, note);
    }
  }

  /**
   * A walk that is waiting for the person's click is over the moment they ask
   * for something else: it is taken off the screen and nothing is said about
   * it. Their new question is not told "I am still on the last thing".
   */
  function endWalks(): void {
    for (const ask of [...live.values()]) {
      if (ask.phase !== 'running' || !ask.walk) continue;
      const stop = ask.walk;
      ask.walk = undefined;
      ask.silent = true;
      ask.phase = 'stopped';
      ledger.finish(ask.id, 'stopped');
      // Nothing is said about it, so nothing is left to be seen: left unseen,
      // it came back after every restart as "Stopped. What was already done
      // stays done.", one line for each walk that a next question had ended.
      ledger.seen(ask.id);
      stop();
      inbox.remove(itemId(ask.id));
      forget(ask);
      const waiters = [...ask.waiters];
      ask.waiters.clear();
      for (const wake of waiters) wake();
    }
  }

  function door(): NotchTurnDoor | null {
    const turns = deps.turns();
    if (turns && !unlisten) unlisten = turns.onEvent(onTurnEvent);
    return turns;
  }

  function refuse(ask: Live, note: string): void {
    if (ledger.refused(ask.id, note)) { ask.phase = 'refused'; ask.note = note; } else sync(ask);
  }

  /** The ledger is the truth: when a move there did not happen, take what it says. */
  function sync(ask: Live): void {
    const row = ledger.get(ask.id);
    ask.phase = row?.state ?? 'dismissed';
  }

  /**
   * The one way in. Typed words and heard words arrive here alike. It claims
   * the row, and only then starts anything.
   */
  async function run(ask: Live, stage?: NotchStage): Promise<void> {
    if (ask.phase !== 'heard') return;
    ask.began ??= Date.now();
    if (deps.paused?.()) { refuse(ask, 'Everything is stopped. Wake me first.'); return; }
    // Words the notch acts on itself. No model is asked, so none is needed,
    // and what is running does not stand in their way: "done" is said while
    // a showing runs, "undo that" after a job. They are claimed like anything
    // else, so they too happen once.
    const side = !ask.files?.length ? deps.side?.(ask.heard, { source: ask.source, at: ask.at }) ?? null : null;
    if (side) {
      if (!ledger.claim(ask.id, 'notch')) { sync(ask); return; }
      ledger.did(ask.id, side.did);
      ledger.finish(ask.id, 'done', { answer: side.did });
      ledger.seen(ask.id);
      ask.phase = 'done';
      // What it set off shows itself: this instruction has no line of its own.
      ask.silent = true;
      // It runs when the line that carried these words has left the notch: what it opens (the settings, a
      // sheet, day one) cannot take the notch from under that line, and was refused, so nothing opened.
      inbox.after(() => {
        try { side.run(); } catch (error) {
          log(`[notch] something the notch does itself failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      return;
    }
    if (!deps.modelReady()) { refuse(ask, 'no_model'); return; }
    const running = [...live.values()].find((other) => other !== ask && other.phase === 'running');
    if (running) { refuse(ask, `I am still on the last thing: ${shortened(running.heard, 60)}`); return; }

    const what = deps.remember ? rememberSentence(ask.heard) : null;
    if (what) {
      if (!ledger.claim(ask.id, 'remember')) { sync(ask); return; }
      ask.phase = 'running';
      ask.activity = 'Writing it to memory.';
      let result: NotchRemembered;
      // What was heard can be misheard, and a memory is believed later: a
      // spoken one is shown as it would be saved and takes one yes. A typed
      // one is the person's own letters, and is saved as written.
      const confirm = ask.source === 'spoken' && stage
        ? async (fact: string): Promise<boolean> => (await stage.offer(['Remember: ', em(fact), '?'], 'remember', { fold: 0 })).act === 'yes'
        : undefined;
      try {
        result = await deps.remember!(what, ask.heard, ask.id, confirm);
      } catch (error) {
        // Something took the notch while the question was up: nothing was
        // saved, and the person never got to answer. That is said when the
        // notch is theirs again: said to nobody, it sat in the count as
        // "Stopped" and showed nothing when it was opened.
        if (error instanceof NotchStageEnded) {
          ledger.finish(ask.id, 'failed', { note: NOT_SAVED_CUT });
          ask.phase = 'failed';
          ask.note = NOT_SAVED_CUT;
          throw error;
        }
        log(`[notch] a memory could not be written: ${error instanceof Error ? error.message : String(error)}`);
        result = { ok: false, why: 'It could not be written to memory. Nothing was saved.' };
      }
      if (!result.ok && result.why === NOT_SAVED) {
        // The person said no: nothing was written, and nothing more is said.
        ledger.finish(ask.id, 'stopped', { note: NOT_SAVED });
        ledger.seen(ask.id);
        ask.phase = 'stopped';
        ask.note = NOT_SAVED;
        return;
      }
      if (result.ok) {
        ledger.understood(ask.id, result.understood);
        ledger.did(ask.id, 'Wrote it to memory.');
        ask.answer = result.said;
        ledger.finish(ask.id, 'done', { answer: result.said });
        ask.phase = 'done';
      } else {
        ask.note = result.why;
        ledger.finish(ask.id, 'failed', { note: result.why });
        ask.phase = 'failed';
      }
      return;
    }

    const turns = door();
    if (!turns || !turns.ready()) { refuse(ask, 'I am still starting up. Ask again in a moment.'); return; }
    let ref: BriefTurnRef;
    try {
      ref = { conversationId: turns.conversation(), turnId: `notch-${ask.id}`, requestId: `notch-${ask.source}-${ask.id}` };
    } catch (error) {
      log(`[notch] the notch's conversation could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      refuse(ask, 'The conversation could not be opened.');
      return;
    }
    if (!ledger.claim(ask.id, 'turn', ref)) { sync(ask); return; }
    ask.phase = 'running';
    ask.turn = ref;
    ask.activity = null;
    byTurn.set(ref.turnId, ask);
    /** Starts the turn. From here on the store says how it goes. */
    const start = async (): Promise<void> => {
      try {
        await turns.submit({ ...ref, text: ask.heard, ...(ask.files?.length ? { files: ask.files } : {}) });
        // Kept with the turn now: not held here as well.
        ask.files = undefined;
      } catch (error) {
        const busy = (error as { status?: unknown } | null)?.status === 409;
        const note = error instanceof NotchFilesNotKept
          ? error.why
          : busy
            ? 'Its conversation is busy with something sent from the dashboard. Ask again when that is done.'
            : 'It could not be started.';
        log(`[notch] an instruction could not be started: ${error instanceof Error ? error.message : String(error)}`);
        byTurn.delete(ref.turnId);
        ask.note = note;
        ledger.finish(ask.id, 'failed', { note });
        ask.phase = 'failed';
        return;
      }
      const understand = deps.understand;
      if (understand) {
        // Beside the turn, never in its way: the turn does not wait for it.
        void understand(ask.heard).then(
          (understood) => { if (understood) ledger.understood(ask.id, understood); },
          () => {},
        );
      }
    };
    // "Where is…?" is answered by pointing, from what the window in front says
    // about itself. Only when that has no answer does the question become a
    // turn like any other. A question that carries what was circled is about
    // that, not about where something is. The window is read beside the line
    // that says so, not in its way: it can be stopped like anything running.
    const point = deps.point;
    // "Go on" after a walk that stopped before its end is that walk again, from where the person is.
    if (point && !ask.files?.length && (whereQuestion(ask.heard) || point.goesOn?.(ask.heard) === true)) {
      ask.activity = 'Looking for it in the window.';
      const stop = new AbortController();
      ask.walk = () => stop.abort();
      void (async () => {
        let pointed: NotchPointed | null = null;
        try {
          pointed = await point(ask.heard, {
            signal: stop.signal,
            // One step of the way is being shown: the line says which, for as long as its click is waited for.
            step: (said) => { if (ask.phase === 'running') { ask.activity = said; bump(ask); } },
            toward: (aim) => { if (ask.phase === 'running') deps.reach?.(aim); },
          });
        } catch (error) {
          log(`[notch] a "where is" could not be answered by pointing: ${error instanceof Error ? error.message : String(error)}`);
        }
        ask.walk = undefined;
        if (ask.phase !== 'running') return;
        // A walk that stopped before its end is not "shown": what is said and kept says how far it came.
        const whole = pointed?.ok === true && (pointed.ended === undefined || pointed.ended === 'shown' || pointed.ended === 'finished' || pointed.ended === 'there');
        const some = pointed?.ok === true && (whole || (pointed.steps ?? 0) > 0);
        if (!ask.stopAsked && pointed?.ok !== 'stopped') { try { deps.pointed?.(some); } catch { /* a sign, and nothing depends on it */ } }
        if (ask.stopAsked || pointed?.ok === 'stopped') {
          // Taken off the screen by something that was not Esc (a line was drawn round something): nothing is said.
          if (!ask.stopAsked) ask.silent = true;
          byTurn.delete(ref.turnId);
          ledger.finish(ask.id, 'stopped');
          // Ended without a word: nothing is left to be seen of it.
          if (ask.silent) ledger.seen(ask.id);
          ask.phase = 'stopped';
        } else if (pointed?.ok === true) {
          byTurn.delete(ref.turnId);
          const steps = pointed.steps ?? 0;
          ledger.did(ask.id, whole ? 'Showed it on the screen.' : steps > 0 ? `Showed ${steps} ${steps === 1 ? 'step' : 'steps'} on the screen, then stopped before the end.` : 'Could not show it on the screen.');
          ask.answer = pointed.said;
          ledger.finish(ask.id, 'done', { answer: ask.answer });
          ask.phase = 'done';
        } else if (pointed) {
          byTurn.delete(ref.turnId);
          ask.note = pointed.why;
          ledger.finish(ask.id, 'failed', { note: ask.note });
          ask.phase = 'failed';
        } else {
          ask.activity = null;
          await start();
        }
        bump(ask);
      })();
      return;
    }
    await start();
  }

  function onTurnEvent(event: BriefChatEvent): void {
    const ask = byTurn.get(event.turnId);
    if (!ask || ask.phase !== 'running') return;
    const payload = event.payload;
    if (payload.kind === 'delta') {
      ask.segment += payload.text;
      ask.whole += payload.text;
      return;
    }
    if (payload.kind === 'activity') {
      // What is said after the last thing that was done is the answer. What
      // was said before it was an acknowledgment.
      ask.segment = '';
      if (payload.activity.phase !== 'started') return;
      ask.activity = payload.activity.summary;
      ledger.did(ask.id, payload.activity.summary);
      ask.didSomething = true;
      bump(ask);
      return;
    }
    if (payload.kind === 'approval') {
      if (payload.status !== 'pending') {
        // Answered: the work goes on, or the turn says why it does not.
        if (ask.activity === WAITING_FOR_YES) { ask.activity = null; bump(ask); }
        return;
      }
      ask.approvals.add(payload.approvalId);
      ask.activity = WAITING_FOR_YES;
      raisedAgain.set(payload.approvalId, { at: Date.now(), times: 0 });
      deps.raiseApproval?.(payload.approvalId);
      bump(ask);
      return;
    }
    if (payload.kind === 'status') {
      // Behind another chat's turn: the brain answers one at a time.
      const queued = payload.state === 'queued';
      if (queued !== (ask.activity === WAITING_FOR_CHAT)) { ask.activity = queued ? WAITING_FOR_CHAT : null; bump(ask); }
      return;
    }
    if (payload.kind !== 'terminal') return;
    conclude(ask, payload.state, ask.segment.trim() || ask.whole.trim(), payload.error);
    bump(ask);
  }

  function conclude(ask: Live, state: 'completed' | 'failed' | 'cancelled', text: string, error?: { code: string; message: string }): void {
    const turn = ask.turn;
    if (turn) byTurn.delete(turn.turnId);
    // What it was still asking for is asked no more: a yes given later would
    // run one step with nothing behind it.
    for (const approvalId of ask.approvals) {
      try { deps.withdrawApproval?.(approvalId); } catch { /* it was answered meanwhile */ }
    }
    ask.approvals.clear();
    if (turn && state !== 'completed') {
      try {
        deps.turns()?.mark?.(turn, state === 'cancelled'
          ? '(The owner stopped this request before it finished. It is over: do not continue it unless they ask again.)'
          : '(This request did not finish. It is over: do not continue it unless the owner asks again.)');
      } catch (failure) {
        log(`[notch] the conversation could not be told a turn was over: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    }
    if (state === 'completed') {
      // "Done." is said of something that was done. A turn that ended with no words and did nothing (a
      // provider's hiccup) is not that.
      ask.answer = text || (ask.didSomething ? 'Done.' : 'I have no answer for that. Ask me again.');
      ledger.finish(ask.id, 'done', { answer: ask.answer });
      ask.phase = 'done';
      try { deps.afterTurn?.(ask.began ?? Date.now() - 10 * 60_000); } catch (failure) {
        log(`[notch] what a turn built could not be looked at: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    } else if (state === 'cancelled') {
      ledger.finish(ask.id, 'stopped');
      ask.phase = 'stopped';
    } else {
      ask.note = error?.code === 'interrupted'
        ? 'I restarted in the middle of it. Nothing is tried again.'
        : (error?.message ?? 'It could not finish.');
      ledger.finish(ask.id, 'failed', { note: ask.note });
      ask.phase = 'failed';
    }
  }

  const workSay = (ask: Live): NotchPart[] =>
    ask.activity ? [ask.activity] : ['On it: ', em(shortened(ask.heard, 80))];

  function title(ask: Live): NotchPart[] {
    const words = em(shortened(ask.heard || '…', 60));
    switch (ask.phase) {
      case 'running': return ['Working on: ', words];
      case 'done': return ['The answer to: ', words];
      case 'failed': return ['It failed: ', words];
      case 'stopped': return ['Stopped: ', words];
      default: return ['You said: ', words];
    }
  }

  function item(ask: Live, fresh: boolean): NotchItem {
    return {
      id: itemId(ask.id),
      subject: itemId(ask.id),
      class: 'person',
      speaks: true,
      // The person has just asked: it takes the notch. Later news of it waits its turn.
      urgent: fresh,
      // The person started it, so its first line can be answered at once.
      asked: true,
      returns: true,
      title: () => title(ask),
      play: (stage) => play(ask, stage),
    };
  }

  async function play(ask: Live, stage: NotchStage): Promise<NotchItemEnd> {
    let listenId: string | null = null;
    let listenEsc: Promise<'esc'> | null = null;
    let workId: string | null = null;
    for (;;) {
      if (ask.source === 'typed' && ask.phase === 'heard') {
        // Words the notch acts on itself show what they set off, not a line of work.
        if (!ask.files?.length && !deps.paused?.() && deps.side?.(ask.heard, { source: ask.source, at: ask.at })) {
          await run(ask, stage);
          continue;
        }
        // Typed words need not be shown back. The work shows at once, and it starts under it.
        workId = stage.id();
        stage.put({ id: workId, kind: 'work', say: workSay(ask), steps: 0, done: 0, mood: 'work' });
        await run(ask, stage);
        continue;
      }
      switch (ask.phase) {
        case 'listening': case 'transcribing': case 'heard': {
          // Once the keys are up the line says so: nothing more is being heard.
          const over = ask.phase !== 'listening';
          if (listenId === null) {
            listenId = stage.id();
            stage.put({ id: listenId, kind: 'listen', say: [], heard: ask.heard, mood: 'listen', ...(over ? { over: true } : {}) });
            listenEsc = quiet(stage.answer(listenId, ['no']).then(() => 'esc' as const));
          } else {
            stage.surface.update(listenId, { heard: ask.heard, ...(over ? { over: true } : {}) });
          }
          const waits: Promise<'esc' | 'changed' | 'go'>[] = [listenEsc!, changed(ask)];
          // The words stay for a moment before they are acted on.
          if (ask.phase === 'heard') waits.push(quiet(stage.wait(heardMs).then(() => 'go' as const)));
          const what = await Promise.race(waits);
          if (what === 'esc') {
            turnAway(ask, 'You turned it away.');
            return 'settled';
          }
          if (what === 'go' && ask.phase === 'heard') {
            // Listening stopped by itself after a minute. What was heard may
            // end in the middle of a sentence ("delete the old ones, but
            // not..."), so it is shown whole and takes a yes. It used to be
            // thrown away, the whole minute of it.
            if (ask.cut) {
              const id = stage.id();
              listenId = null;
              stage.put({
                id, kind: 'sheet', say: ['I stopped listening after a minute. Go on with what I heard?'], yes: 'go on', stay: true,
                blocks: [{ kind: 'paper', lines: plainLines(ask.heard).map((line): NotchPart[] => [line]) }],
              });
              const answer = await stage.answer(id, ['yes', 'no']);
              if (answer.act !== 'yes') {
                turnAway(ask, 'It ran past a minute, and you turned it away.');
                return 'settled';
              }
              // Only the yes takes the mark off. If something urgent takes the
              // notch while the question is up, this item is played again
              // from the top: with the mark already off it would have shown
              // the words for a moment and run them, with no yes given.
              ask.cut = false;
              if (ask.phase !== 'heard') continue;
            }
            await run(ask, stage);
          }
          continue;
        }
        case 'running': {
          let id = workId;
          if (id === null) {
            id = stage.id();
            stage.put({ id, kind: 'work', say: workSay(ask), steps: 0, done: 0, mood: 'work' });
            // The work line is up afresh and says it waits for a yes: what
            // it waits for is brought up again. After everything was stopped
            // and woken, or after a call, the work line came back alone and
            // the approval it spoke of never got its turn.
            raiseAgain(ask);
          } else {
            stage.surface.update(id, { say: workSay(ask) });
          }
          workId = null;
          const stop = quiet(stage.answer(id, ['stop']).then(() => 'stop' as const));
          while (ask.phase === 'running') {
            const what = await Promise.race([stop, changed(ask)]);
            if (what === 'stop') {
              ask.stopAsked = true;
              ask.walk?.();
              if (ask.turn) {
                try { deps.turns()?.cancel(ask.turn); } catch (error) {
                  log(`[notch] a turn could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
              // The store says "cancelled" as it stops it. If it did not, do not wait for ever.
              if (ask.phase === 'running') await Promise.race([changed(ask), quiet(stage.wait(4000))]);
              break;
            }
            if (ask.phase === 'running') stage.surface.update(id, { say: workSay(ask) });
          }
          if (ask.phase === 'running') return 'waits';
          continue;
        }
        case 'done': {
          // The notch did it itself, and what it set off has its own line.
          if (ask.silent) { ledger.seen(ask.id); forget(ask); return 'settled'; }
          const shape = answerShape(ask.answer ?? '');
          if (shape.kind === 'line' && /\?\s*$/.test(shape.text)) {
            // Jarvis asked something back. A question is not a result that
            // leaves by itself: it waits for the reply, typed here or spoken.
            const id = stage.id();
            stage.put({
              id, kind: 'ask', say: [], yes: 'answer', placeholder: 'Answer here, or hold the keys and speak', mood: 'curious',
              blocks: [{ kind: 'row', say: [shape.text] }],
            });
            const reply = await stage.answer(id, ['ask', 'no']);
            if (stage.surface.listening() === 0) return 'waits';
            ledger.seen(ask.id);
            forget(ask);
            const said = reply.act === 'ask' ? (reply.text ?? '').trim() : '';
            if (said) typed(said);
            return 'settled';
          }
          // How long the hands had been still when the answer came: asked before it is shown.
          const stillBefore = deps.stillFor?.() ?? 0;
          if (shape.kind === 'line') {
            const ms = Math.min(12_000, Math.max(3200, 2400 + 60 * [...shape.text].length));
            await stage.say([shape.text], ms);
          } else {
            const blocks: NotchBlock[] = [{ kind: 'paper', lines: shape.lines.map((line): NotchPart[] => [line]) }];
            if (shape.cut) blocks.push({ kind: 'note', say: ['The rest is in the dashboard, in the chat called Notch.'] });
            if (deps.openDashboard) blocks.push({ kind: 'buttons', buttons: [{ id: 'dashboard', label: 'Open the dashboard', quiet: true }] });
            const id = stage.id();
            // It stays until it is closed on purpose: a click meant for another app does not close it.
            stage.put({ id, kind: 'sheet', say: ['You asked: ', em(shortened(ask.heard, 70))], blocks, mood: 'read', stay: true });
            for (;;) {
              const answer = await stage.answer(id, ['no', 'button']);
              if (answer.act === 'no') break;
              deps.openDashboard?.(stage.from());
            }
          }
          // Shown to nobody is not shown: it comes round again.
          if (stage.surface.listening() === 0) return 'waits';
          // A line that came and went while the hands were off the machine
          // (still for minutes before it came, and still all the while it
          // was up) was read by nobody: a ten-minute job ended, said so for
          // a few seconds to an empty chair, and was marked seen. It waits
          // in the count, and is said once more when the hands are on again.
          if (shape.kind === 'line' && !ask.reread && stillBefore >= NOTCH_ANSWER_UNSEEN_STILL_MS && (deps.stillFor?.() ?? 0) > stillBefore) {
            ask.unread = true;
            return 'waits';
          }
          ledger.seen(ask.id);
          forget(ask);
          return 'settled';
        }
        case 'failed': case 'stopped': {
          // A memory the person said no to: nothing was done, nothing is said.
          if (ask.note === NOT_SAVED || ask.silent) { ledger.seen(ask.id); forget(ask); return 'settled'; }
          if (ask.phase === 'stopped') await stage.say(['Stopped. What was already done stays done.'], 2600, { mood: 'careful' });
          else await stage.say([ask.note ?? 'That did not work.'], 5200, { mood: 'sorry', mark: 'fail' });
          if (stage.surface.listening() === 0) return 'waits';
          ledger.seen(ask.id);
          forget(ask);
          return 'settled';
        }
        case 'missed': {
          const more = ask.missed === 'no_stt' ? ' Speech-to-text is not set up yet: add a key in the dashboard.'
            : ask.missed === 'too_long' ? ' That was longer than I can take in one go.'
              // Not the person's fault, and saying it again will not help.
              : ask.missed === 'failed' ? ' Speech-to-text is not answering: check its key in the dashboard.' : '';
          await stage.say([NOTCH_NOT_CAUGHT + more], more ? 5200 : 2400, { mood: 'confused' });
          forget(ask);
          return 'settled';
        }
        case 'refused': {
          if (ask.note === 'no_model') {
            const answer = await stage.offer(['No model is set up yet, so I cannot answer. Finish setup in the dashboard.'], 'open', { mood: 'careful' });
            if (answer.act === 'yes') deps.openDashboard?.(stage.from());
          } else {
            await stage.say([ask.note ?? 'That could not be started.'], 4200, { mood: 'careful' });
          }
          forget(ask);
          return 'settled';
        }
        default:
          forget(ask);
          return 'settled';
      }
    }
  }

  function begin(ask: Live): void {
    // A question Jarvis asked back, still on the notch: what is said or typed
    // now is its answer, and the question has been seen.
    for (const other of [...live.values()]) {
      if (other === ask || other.phase !== 'done' || inbox.showing() !== itemId(other.id)) continue;
      ledger.seen(other.id);
      forget(other);
      inbox.remove(itemId(other.id));
    }
    inbox.add(item(ask, true));
  }

  /** The ledger as a sheet: the list, and one instruction in full when its row is opened. */
  async function showLedger(stage: NotchStage): Promise<void> {
    for (;;) {
      const rows = ledger.asked(NOTCH_LEDGER_ROWS);
      const blocks: NotchBlock[] = rows.length === 0
        ? [{ kind: 'note', say: ['Nothing asked yet. Hold ', { key: 'talk' }, ' and speak, or type above.'] }]
        : rows.map((row): NotchBlock => ({
          kind: 'row', id: row.id, lead: clock(row.createdAt), go: true,
          say: [shortened(row.heard || 'Nothing was caught.', 90)], small: ledgerWord(row),
        }));
      const n = rows.length;
      const answer = await stage.sheet([n === 0 ? 'What you asked' : n === 1 ? 'What you asked: 1 thing' : `What you asked: the last ${n}`], blocks);
      if (answer.act !== 'go' || !answer.row) return;
      const row = ledger.get(answer.row);
      if (!row) continue;
      await stage.sheet([row.source === 'spoken' ? 'You said' : 'You typed'], ledgerDetail(row));
    }
  }

  async function home(stage: NotchStage): Promise<void> {
    for (;;) {
      const id = stage.id();
      const today = deps.today?.() ?? [];
      // The last answer stays one step away for a while: a one-line answer
      // is on the notch for seconds, and may have gone by unread.
      const last = ledger.asked(1)[0];
      const recent = last && last.answer && last.endedAt !== null && Date.now() - last.endedAt < NOTCH_LAST_ANSWER_MS ? last : null;
      const mailRow = deps.mail?.row() ?? null;
      const learnedRow = deps.learned?.row() ?? null;
      const standingRows = deps.standing?.rows() ?? [];
      stage.put({
        id, kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask, or tell me what to do', mood: 'listen', focus: true,
        blocks: [
          ...(recent ? [{ kind: 'row' as const, id: 'last', lead: 'Last answer', say: [shortened(recent.answer ?? '', 90)], go: true }] : []),
          ...(mailRow ? [mailRow] : []),
          ...(deps.see ? [deps.see.row()] : []),
          ...(learnedRow ? [learnedRow] : []),
          ...standingRows,
          ...today,
          ...(deps.quiet ? [deps.quiet.note()] : []),
          { kind: 'buttons', buttons: [{ id: 'asked', label: 'What you asked', quiet: true }, ...(deps.quiet ? [deps.quiet.button()] : []), ...(deps.more?.buttons() ?? [])] },
        ],
      });
      const answer = await stage.answer(id, ['ask', 'no', 'button', 'go', 'word']);
      if (answer.act === 'no') return;
      // The quiet hours, changed where they are shown: Home is drawn again with what they are now.
      if (answer.act === 'word') { deps.quiet?.word(answer.word ?? '', answer.value ?? ''); continue; }
      if (answer.act === 'button' && deps.quiet?.press(answer.button ?? '')) continue;
      if (answer.act === 'button' && deps.more) {
        const went = await deps.more.press(stage, answer.button ?? '');
        if (went === 'leave') return;
        if (went === 'stay') continue;
      }
      if (answer.act === 'go' && answer.row === 'last' && recent) {
        const again = stage.id();
        stage.put({ id: again, kind: 'sheet', say: [recent.source === 'spoken' ? 'You said' : 'You typed'], blocks: ledgerDetail(recent), stay: true });
        await stage.answer(again, ['no']);
        continue;
      }
      if (answer.act === 'go' && answer.row === 'see' && deps.see) {
        await deps.see.open(stage);
        continue;
      }
      if (answer.act === 'go' && answer.row === 'mail' && deps.mail) {
        await deps.mail.open(stage);
        continue;
      }
      if (answer.act === 'go' && answer.row === 'learned' && deps.learned) {
        await deps.learned.open(stage);
        continue;
      }
      if (answer.act === 'go' && answer.row && deps.standing && standingRows.some((row) => row.kind === 'row' && row.id === answer.row)) {
        await deps.standing.open(stage, answer.row);
        continue;
      }
      // Undo on a row of today: the taking back takes the notch from here.
      if (answer.act === 'button' && answer.button === 'undo' && answer.row?.startsWith('job:') && deps.undoJob) {
        deps.undoJob(answer.row.slice(4));
        return;
      }
      if (answer.act === 'ask') {
        const text = (answer.text ?? '').trim();
        if (!text) continue;
        // The instruction takes the notch from here on: this script ends under it.
        typed(text);
        return;
      }
      if (answer.act === 'button' && answer.button === 'asked') await showLedger(stage);
    }
  }

  function typed(text: string, files?: NotchAskFile[]): string {
    endWalks();
    replaceEarlier('Something was typed in its place.');
    const id = crypto.randomUUID();
    ledger.open(id, 'typed', text);
    const ask = make(id, 'typed', 'heard', text);
    if (files?.length) ask.files = files;
    begin(ask);
    return id;
  }

  /**
   * The end of a turn is heard as an event. If that event is ever lost the
   * instruction would stand as running for good, and every later one would
   * be refused. So what is running is looked up in the turn store once a
   * minute, and concluded from what the store says.
   */
  function reconcile(): void {
    for (const ask of [...live.values()]) {
      if (ask.phase !== 'running' || !ask.turn) continue;
      let seen: ReturnType<NotchTurnDoor['look']> = null;
      try { seen = deps.turns()?.look(ask.turn) ?? null; } catch { seen = null; }
      if (!seen || seen.state === 'queued' || seen.state === 'running') continue;
      conclude(ask, seen.state, ask.segment.trim() || seen.text.trim(), seen.error);
      bump(ask);
    }
  }
  const watch = setInterval(reconcile, 60_000);
  (watch as { unref?: () => void }).unref?.();

  const ofTalk = (talkId: string): Live | null => {
    const id = byTalk.get(talkId);
    return id ? live.get(id) ?? null : null;
  };

  return {
    typed,
    home,
    handsOn() {
      for (const ask of [...live.values()]) {
        if (!ask.unread) continue;
        ask.unread = false;
        ask.reread = true;
        bump(ask, true);
      }
    },
    listen(talkId) {
      // Said where nothing can be done with it: it is turned away now, at
      // the first key, not after it was said and not when Jarvis next wakes.
      if (deps.paused?.()) {
        const refused = crypto.randomUUID();
        ledger.open(refused, 'spoken');
        ledger.refused(refused, 'Everything is stopped. Wake me first.');
        deps.attention?.();
        return refused;
      }
      // A call is being listened to: the microphone is the call's, and what
      // is said goes into its notes. Turned away now, with a shake. On a call
      // that is not listened to the keys work as ever (the owner, 18 November
      // 2026: "if I decline that, then I should be able to use the speech to
      // text if I wanted to"): the call's hold lets through what the person
      // starts themselves (./inbox.ts, `heldBack`).
      if (deps.callHeard?.()) {
        const refused = crypto.randomUUID();
        ledger.open(refused, 'spoken');
        ledger.refused(refused, 'I was listening to your call, and take nothing else while I do.');
        deps.attention?.();
        return refused;
      }
      endWalks();
      const running = [...live.values()].find((other) => other.phase === 'running');
      if (running) {
        const refused = crypto.randomUUID();
        ledger.open(refused, 'spoken');
        ledger.refused(refused, `I am still on the last thing: ${shortened(running.heard, 60)}`);
        deps.attention?.();
        return refused;
      }
      replaceEarlier('A new recording took its place.');
      const id = crypto.randomUUID();
      ledger.open(id, 'spoken');
      byTalk.set(talkId, id);
      begin(make(id, 'spoken', 'listening', ''));
      return id;
    },
    released(talkId) {
      const ask = ofTalk(talkId);
      if (!ask || !ledger.transcribing(ask.id)) return false;
      ask.phase = 'transcribing';
      bump(ask);
      return true;
    },
    words(talkId, text, more) {
      const ask = ofTalk(talkId);
      // Turned away while the words were being made: they are dropped here, unread.
      if (!ask) return;
      if (!ledger.heard(ask.id, text)) { sync(ask); bump(ask); return; }
      ask.phase = 'heard';
      ask.heard = text;
      // It nods as it takes the words. Not for words cut short: those are asked about first.
      if (!more?.cut) { try { deps.nod?.(); } catch { /* a sign, and nothing depends on it */ } }
      if (more?.cut) ask.cut = true;
      if (more?.files?.length) ask.files = more.files;
      bump(ask);
    },
    nothing(talkId, why) {
      const ask = ofTalk(talkId);
      if (!ask) return;
      let taken = false;
      try { taken = deps.unheard?.(why) === true; } catch { taken = false; }
      if (taken) { turnAway(ask, 'Nothing was made out, and it was answered elsewhere.'); return; }
      if (!ledger.missed(ask.id, why)) { sync(ask); bump(ask); return; }
      ask.phase = 'missed';
      ask.missed = why;
      // Nothing was made out: it shakes, as it does for anything it could not take.
      try { deps.attention?.(); } catch { /* a sign, and nothing depends on it */ }
      bump(ask);
    },
    dropped(talkId) {
      const ask = ofTalk(talkId);
      if (ask) turnAway(ask, 'The recording was thrown away.');
    },
    tell(parts, mood = 'careful') {
      const id = `ask-tell-${++tells}`;
      inbox.add({
        id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
        title: () => parts,
        play: async (stage) => { await stage.say(parts, 3600, { mood }); return 'settled'; },
      });
    },
    mine(approvalId) {
      for (const ask of live.values()) if (ask.phase === 'running' && ask.approvals.has(approvalId)) return true;
      return false;
    },
    resume() {
      const turns = door();
      for (const row of ledger.unfinished()) {
        if (live.has(row.id)) continue;
        // Without the turn store nothing can be said about a turn: leave it for the next call.
        if (row.state === 'running' && row.kind === 'turn' && !turns) continue;
        if (row.state !== 'running') {
          // It never ran, and now it never will.
          ledger.dismiss(row.id, 'I restarted before it ran.');
          // If its words were already in, the person is told: they said
          // something and nothing came of it.
          if (row.heard.trim() && Date.now() - row.createdAt < 15 * 60_000) {
            const parts: NotchPart[] = ['I restarted before I started on: ', em(shortened(row.heard, 70)), '. Say it again.'];
            const id = `ask-lost-${row.id}`;
            inbox.add({
              id, subject: id, class: 'person', speaks: true, once: true, asked: true,
              title: () => parts,
              play: async (stage) => { await stage.say(parts, 6000, { mood: 'sorry' }); return 'settled'; },
            });
          }
          continue;
        }
        const ref = row.conversationId && row.turnId && row.requestId
          ? { conversationId: row.conversationId, turnId: row.turnId, requestId: row.requestId } : null;
        let seen: ReturnType<NotchTurnDoor['look']> = null;
        try { seen = ref && turns ? turns.look(ref) : null; } catch { seen = null; }
        if (seen?.state === 'completed') ledger.finish(row.id, 'done', { answer: seen.text.trim() || 'Done.' });
        else if (seen?.state === 'cancelled') ledger.finish(row.id, 'stopped');
        else if (seen && (seen.state === 'queued' || seen.state === 'running') && ref) {
          // Still going (the notch was attached again without a restart): follow it.
          const ask = make(row.id, row.source, 'running', row.heard);
          ask.turn = ref;
          ask.whole = seen.text;
          byTurn.set(ref.turnId, ask);
          inbox.add(item(ask, false));
        } else ledger.finish(row.id, 'failed', { note: 'I restarted in the middle of it. Nothing is tried again.' });
      }
      for (const row of ledger.unseen()) {
        if (live.has(row.id)) continue;
        const ask = make(row.id, row.source, row.state, row.heard);
        ask.answer = row.answer;
        ask.note = row.note;
        inbox.add(item(ask, false));
      }
    },
    stop() {
      clearInterval(watch);
      unlisten?.();
      unlisten = null;
    },
    reconcile,
  };
}
