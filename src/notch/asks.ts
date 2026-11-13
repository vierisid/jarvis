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
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** How long the words that were heard stay on the notch before they are acted on. Esc in that time turns them away. */
export const NOTCH_HEARD_MS = 900;
/** The longest answer that is said as one line. Anything longer, or in several paragraphs, opens as a sheet. */
export const NOTCH_ONE_LINE_CHARS = 140;
/** The most of an answer a sheet carries. The whole of it is in the dashboard. */
export const NOTCH_SHEET_CHARS = 6000;
export const NOTCH_SHEET_LINES = 60;
/** How many instructions the ledger's sheet lists. */
export const NOTCH_LEDGER_ROWS = 40;

export const NOTCH_NOT_CAUGHT = 'I did not catch that.';
const WAITING_FOR_YES = 'Waiting for your yes.';
const WAITING_FOR_CHAT = 'Waiting for another chat to finish.';

/** Why nothing was caught, for the ledger and for the one case where the sentence says more. */
export type NotchMissReason = 'silence' | 'too_little' | 'failed' | 'no_stt' | 'too_long';

/** The product's turn store, as the notch uses it. */
export interface NotchTurnDoor {
  /** Whether a turn can be taken now. False while the brain is starting or draining. */
  ready(): boolean;
  /** The id of the notch's conversation, made when there is none. */
  conversation(): string;
  /** Starts a stored turn. Throws with a `status` of 409 when the conversation already has one. */
  submit(turn: BriefTurnRef & { text: string }): void;
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
  /** Writes one thing to memory and reads it back. */
  remember?: (what: string, sentence: string, askId: string) => Promise<NotchRemembered>;
  /** One sentence saying what the instruction was taken to mean. Null when it cannot be said. */
  understand?: (text: string) => Promise<string | null>;
  /** An approval this instruction's turn is waiting for should take the notch now. */
  raiseApproval?: (approvalId: string) => void;
  /** The instruction ended while one of its approvals was still unanswered: it is asked no more. */
  withdrawApproval?: (approvalId: string) => void;
  /** A small sign that the notch heard and will not act (a shake), for when no line can be shown. */
  attention?: () => void;
  openDashboard?: (sidecarId: string | null) => void;
  /** Rows for Home, under the text field: what was done today. */
  today?: () => NotchBlock[];
  heardMs?: number;
  log?: (line: string) => void;
}

export interface NotchAsks {
  /** Something was typed. Comes back with the instruction's id. */
  typed(text: string): string;
  /** The talk keys went down: a recording has begun. Comes back with the instruction's id. */
  listen(talkId: string): string;
  /**
   * The keys came up: the recording is being made into words. False when the
   * instruction is no longer waiting for them (it was turned away while the
   * keys were still held): then the recording need not be transcribed at all.
   */
  released(talkId: string): boolean;
  /** The words. */
  words(talkId: string, text: string): void;
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

interface Live {
  id: string;
  source: NotchAskSource;
  phase: NotchAskState;
  heard: string;
  /** What it is doing now, as one sentence. */
  activity: string | null;
  turn: BriefTurnRef | null;
  /** The reply since the last thing that was done: the answer, once the turn ends. */
  segment: string;
  whole: string;
  answer: string | null;
  note: string | null;
  missed: NotchMissReason | null;
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
  const match = /^\s*(?:please\s+|jarvis[,\s]+)?remember\s+(?:that\s+)?(.+?)\s*$/is.exec(text);
  if (!match) return null;
  const what = match[1]!.replace(/[.!\s]+$/, '').trim();
  // "Remember to call Anna" is a job, not a fact, and a question is not one either.
  if (!what || /^to\s/i.test(what) || what.endsWith('?')) return null;
  return [...what].length < 3 ? null : what;
}

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
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
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

  const itemId = (id: string): string => `ask:${id}`;

  function make(id: string, source: NotchAskSource, phase: NotchAskState, heard: string): Live {
    const ask: Live = {
      id, source, phase, heard, activity: null, turn: null, segment: '', whole: '', answer: null, note: null, missed: null,
      approvals: new Set(), waiters: new Set(),
    };
    live.set(id, ask);
    return ask;
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
  async function run(ask: Live): Promise<void> {
    if (ask.phase !== 'heard') return;
    if (deps.paused?.()) { refuse(ask, 'Everything is stopped. Wake me first.'); return; }
    if (!deps.modelReady()) { refuse(ask, 'no_model'); return; }
    const running = [...live.values()].find((other) => other !== ask && other.phase === 'running');
    if (running) { refuse(ask, `I am still on the last thing: ${shortened(running.heard, 60)}`); return; }

    const what = deps.remember ? rememberSentence(ask.heard) : null;
    if (what) {
      if (!ledger.claim(ask.id, 'remember')) { sync(ask); return; }
      ask.phase = 'running';
      ask.activity = 'Writing it to memory.';
      let result: NotchRemembered;
      try {
        result = await deps.remember!(what, ask.heard, ask.id);
      } catch (error) {
        log(`[notch] a memory could not be written: ${error instanceof Error ? error.message : String(error)}`);
        result = { ok: false, why: 'It could not be written to memory. Nothing was saved.' };
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
    if (!turns || !turns.ready()) { refuse(ask, 'Jarvis is starting up. Ask again in a moment.'); return; }
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
    try {
      turns.submit({ ...ref, text: ask.heard });
    } catch (error) {
      const busy = (error as { status?: unknown } | null)?.status === 409;
      const note = busy
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
      ask.answer = text || 'Done.';
      ledger.finish(ask.id, 'done', { answer: ask.answer });
      ask.phase = 'done';
    } else if (state === 'cancelled') {
      ledger.finish(ask.id, 'stopped');
      ask.phase = 'stopped';
    } else {
      ask.note = error?.code === 'interrupted'
        ? 'Jarvis restarted in the middle of it. Nothing is tried again.'
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
        // Typed words need not be shown back. The work shows at once, and it starts under it.
        workId = stage.id();
        stage.put({ id: workId, kind: 'work', say: workSay(ask), steps: 0, done: 0, mood: 'work' });
        await run(ask);
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
          if (what === 'go' && ask.phase === 'heard') await run(ask);
          continue;
        }
        case 'running': {
          let id = workId;
          if (id === null) {
            id = stage.id();
            stage.put({ id, kind: 'work', say: workSay(ask), steps: 0, done: 0, mood: 'work' });
          } else {
            stage.surface.update(id, { say: workSay(ask) });
          }
          workId = null;
          const stop = quiet(stage.answer(id, ['stop']).then(() => 'stop' as const));
          while (ask.phase === 'running') {
            const what = await Promise.race([stop, changed(ask)]);
            if (what === 'stop') {
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
          const shape = answerShape(ask.answer ?? '');
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
          ledger.seen(ask.id);
          forget(ask);
          return 'settled';
        }
        case 'failed': case 'stopped': {
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
    inbox.add(item(ask, true));
  }

  /** The ledger as a sheet: the list, and one instruction in full when its row is opened. */
  async function showLedger(stage: NotchStage): Promise<void> {
    for (;;) {
      const rows = ledger.recent(NOTCH_LEDGER_ROWS);
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
      stage.put({
        id, kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask, or tell me what to do', mood: 'listen', focus: true,
        blocks: [
          ...today,
          { kind: 'buttons', buttons: [{ id: 'asked', label: 'What you asked', quiet: true }] },
        ],
      });
      const answer = await stage.answer(id, ['ask', 'no', 'button', 'go']);
      if (answer.act === 'no') return;
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

  function typed(text: string): string {
    replaceEarlier('Something was typed in its place.');
    const id = crypto.randomUUID();
    ledger.open(id, 'typed', text);
    begin(make(id, 'typed', 'heard', text));
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
    words(talkId, text) {
      const ask = ofTalk(talkId);
      // Turned away while the words were being made: they are dropped here, unread.
      if (!ask) return;
      if (!ledger.heard(ask.id, text)) { sync(ask); bump(ask); return; }
      ask.phase = 'heard';
      ask.heard = text;
      bump(ask);
    },
    nothing(talkId, why) {
      const ask = ofTalk(talkId);
      if (!ask) return;
      if (!ledger.missed(ask.id, why)) { sync(ask); bump(ask); return; }
      ask.phase = 'missed';
      ask.missed = why;
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
          ledger.dismiss(row.id, 'Jarvis restarted before it ran.');
          // If its words were already in, the person is told: they said
          // something and nothing came of it.
          if (row.heard.trim() && Date.now() - row.createdAt < 15 * 60_000) {
            const parts: NotchPart[] = ['Jarvis restarted before it started on: ', em(shortened(row.heard, 70)), '. Say it again.'];
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
        } else ledger.finish(row.id, 'failed', { note: 'Jarvis restarted in the middle of it. Nothing is tried again.' });
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
