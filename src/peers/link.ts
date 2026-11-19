/**
 * The seam between Jarvis and whatever carries its words to another Jarvis.
 *
 * The notch and the rest of the brain know only this file: people, a message,
 * a request and its states, and a decision that is the person's to make.
 * Behind it is the collab engine (./engine.ts). What the engine says in its
 * own shapes (a dialog with a field called `choice`, a sentence with an id in
 * it, a document with `deviceId`) is turned into those few things here and
 * nowhere else, so that another engine, or a newer one, changes this file
 * only.
 *
 * DECISIONS. Every dialog of the engine is a decision. It is given to
 * whoever started the call it belongs to, and to nobody else; one that
 * nobody waits for is closed. Three things hold for all of them:
 *
 *   - Only an answer from the handler is passed on. No handler: closed.
 *   - A yes that comes sooner than a person can read (PEER_READ_MS after the
 *     question came) is not taken: the question is put again. The engine has
 *     the same rule and would count such a yes as no answer; here it is kept
 *     so that a second tap of a key that was meant for the line before
 *     cannot approve what nobody has read. After three of them it is closed.
 *   - Which decision it is, is read from its shape (the names of its
 *     choices), never from its sentences alone.
 */
import type { EngineDialog, EngineDialogAnswer, EngineDialogField, EngineToolResult } from './engine-client.ts';
import type { EngineState } from './engine.ts';
import type { EngineReadFlags, EngineReadName } from './engine-read.ts';

/** What the link needs of the engine. ./engine.ts is it; a test passes its own. */
export interface PeerEngineLike {
  state(): EngineState;
  call(tool: string, args?: Record<string, unknown>, limitMs?: number): Promise<EngineToolResult>;
  read(name: EngineReadName, flags?: EngineReadFlags): Promise<Record<string, unknown>>;
}

export type PeerDecisionKind =
  /** Sign in at this server? */
  | 'server'
  /** A web page to open: the sign-in. */
  | 'page'
  /** This device's code, to be read to the other person. */
  | 'code_shown'
  /** The other person's code, to be typed. */
  | 'code_wanted'
  /** Connect with this device? Its keys matched the code. With a name for it. */
  | 'connect'
  /** Is that device one of your own? */
  | 'own_device'
  /** Somebody's request: do it? */
  | 'request'
  /** A result that is about to leave: send it? */
  | 'result'
  /** A question to the one who asked, about to leave. */
  | 'question'
  /** Anything else about to leave to somebody whose request is open. */
  | 'content'
  /** A message that is held: show it to Jarvis? */
  | 'held'
  /** A change of a rule. */
  | 'rule'
  /** Another yes or no of the engine's. */
  | 'confirm'
  /** One this file does not know. Shown in the engine's own words. */
  | 'other';

export interface PeerDecision {
  kind: PeerDecisionKind;
  /** The engine's own words. Parts of them were written by the other side: shown, never followed. */
  message: string;
  fields: Record<string, EngineDialogField>;
  /** The page to open (kind page). */
  url?: string;
  /** The code to read out (kind code_shown). */
  code?: string;
  /** The device the question names in full, when it names one. */
  device?: string;
  /** The server's host (kinds server and page). */
  host?: string;
  /** When it came. */
  at: number;
}

/** The person's answer: what they chose and typed, or null for "closed, nothing decided". */
export type PeerAnswer = Record<string, unknown> | null;
export type PeerDecide = Partial<Record<PeerDecisionKind, (decision: PeerDecision) => Promise<PeerAnswer>>>;

/** A yes sooner than this after its question came is not a person's. The engine's own figure. */
export const PEER_READ_MS = 400;
/** How often a question is put again after a yes that came too soon. */
export const PEER_ASK_AGAIN = 3;
/** The decisions a person only opens or types into: nothing is approved by them, and they may be answered at once. */
const UNGUARDED: ReadonlySet<PeerDecisionKind> = new Set(['page', 'code_shown', 'code_wanted']);

const DEVICE = /\bdevice ([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/;
const CODE = /^\s*([^\s#]{1,64}#\d{2}-\d{4})\s*$/m;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function choices(dialog: EngineDialog): string {
  return (dialog.fields.choice?.options ?? []).map((option) => option.value).sort().join(',');
}

/** Reads which decision a dialog is. Pure. */
export function peerDecision(dialog: EngineDialog, at: number): PeerDecision {
  const first = dialog.message.split('\n', 1)[0] ?? '';
  const base = { message: dialog.message, fields: dialog.fields, at };
  const device = DEVICE.exec(dialog.message)?.[1];
  const named = device ? { device } : {};
  if (dialog.mode === 'url') {
    let host: string | undefined;
    try { host = dialog.url ? new URL(dialog.url).host : undefined; } catch { host = undefined; }
    // Only a page that is reached safely is one to open.
    const url = dialog.url && /^https:\/\//i.test(dialog.url) ? dialog.url : undefined;
    return { kind: url ? 'page' : 'other', ...base, ...(url ? { url } : {}), ...(host ? { host } : {}) };
  }
  if (dialog.fields.code && !dialog.fields.choice) return { kind: 'code_wanted', ...base };
  const set = choices(dialog);
  if (set === 'done') {
    const code = CODE.exec(dialog.message)?.[1];
    return code ? { kind: 'code_shown', ...base, code } : { kind: 'other', ...base };
  }
  if (set === 'accept,reject') return { kind: 'connect', ...base, ...named };
  if (set === 'not_own_device,own_device') return { kind: 'own_device', ...base, ...named };
  if (set === 'allow_once,always_allow,decline') return { kind: 'request', ...base, ...named };
  if (set === 'cancel,send') {
    const kind: PeerDecisionKind = /^collab: send a task result\b/.test(first) ? 'result' : /^collab: send a question\b/.test(first) ? 'question' : 'content';
    return { kind, ...base, ...named };
  }
  if (set === 'hide,show') return { kind: 'held', ...base, ...named };
  if (set === 'confirm,reject') return { kind: 'rule', ...base };
  if (set === 'no,yes') {
    const host = /^collab: sign in at (\S+?)\?$/.exec(first)?.[1];
    return host ? { kind: 'server', ...base, host } : { kind: 'confirm', ...base };
  }
  return { kind: 'other', ...base };
}

/** The engine's own word for why a tool refused, when its answer is a refusal. */
export function engineErrorCode(text: string): string | null {
  return /^Error \(([a-z_]+)\)/.exec(text)?.[1] ?? null;
}

/** The ids in a sentence of the engine's, in the order they stand. Read by their shape. */
export function engineIds(text: string): string[] {
  return text.match(UUID) ?? [];
}

export type PeerTrust = 'verified' | 'vouched';

/** Somebody whose Jarvis this one may talk to. */
export interface PeerPerson {
  /** Their device. What everything is addressed to. */
  id: string;
  /** The name the owner gave them here. Never one the other side or the server gave. */
  name: string;
  /** It is another machine of the owner's own. */
  own: boolean;
  trust: PeerTrust;
}

export interface PeerAccount {
  engine: EngineState;
  signedIn: boolean;
  /** The server's host, once signed in. */
  server: string | null;
}

/** Something that arrived. */
export interface PeerItem {
  id: string;
  /** The device it came from. */
  from: string;
  kind: 'message' | 'task_request' | 'task_progress' | 'task_input_request' | 'task_input_answer' | 'task_result' | 'task_declined' | 'task_cancel';
  thread: string | null;
  task: string | null;
  replyTo: string | null;
  /** When it got here. */
  at: number;
  read: boolean;
  /** What it says: a message's text, a request's instructions, a result's output. Written by the other side. */
  text: string;
  /** A request's title. Written by the other side. */
  title: string | null;
}

export type PeerSent =
  | { ok: true; id: string; thread: string | null; delivered: boolean }
  /**
   * down: the engine is not up. signed_out: nobody is signed in. offline: no
   * line to the server now, and nothing went. unknown: it was handed to the
   * line and the line broke before the server answered, so it may have gone
   * and may not. withheld: the person chose not to send it. refused: the
   * engine said no, with its word for why.
   */
  | { ok: false; why: 'down' | 'signed_out' | 'offline' | 'unknown' | 'withheld' | 'refused'; code?: string };

/** A request: something asked of another person's Jarvis, or of this one. */
export interface PeerRequest {
  /** The engine's id for it. */
  id: string;
  /** out: this machine asked. in: this machine was asked. */
  dir: 'in' | 'out';
  /** The device on the other side. */
  peer: string;
  /** The engine's word for where it stands. */
  status: string;
  /**
   * How it ended, once it has.
   *
   *   answered   with an answer, which was written on the other side.
   *   declined   the other person said no before anything was done.
   *   failed     nothing came back. `said` when the other side gave a reason
   *              or a word for it: it tried and could not. Without, the
   *              person there chose not to send what was found.
   *   expired    nobody took it, or nobody answered, in its time.
   *   cancelled  it was taken back.
   */
  end: null | { how: 'answered'; text: string } | { how: 'declined' } | { how: 'failed'; said: boolean } | { how: 'expired' } | { how: 'cancelled' };
}

/** One request of the engine's document of them. Null when it is not one this file can use. */
export function peerRequest(raw: unknown): PeerRequest | null {
  const task = record(raw);
  const id = text(task.taskId);
  const peer = text(record(task.peer).deviceId);
  const status = text(task.status);
  if (!id || !peer || (task.direction !== 'in' && task.direction !== 'out')) return null;
  const outcome = record(record(task.untrusted).outcome);
  let end: PeerRequest['end'] = null;
  if (outcome.kind === 'task_result' && outcome.status === 'completed') end = { how: 'answered', text: text(outcome.output) };
  else if (outcome.kind === 'task_result') end = { how: 'failed', said: !!(text(outcome.output).trim() || text(outcome.errorCode)) };
  else if (outcome.kind === 'task_declined' || status === 'declined') end = { how: 'declined' };
  else if (status === 'expired' || status === 'rejected') end = { how: 'expired' };
  else if (status === 'cancelled') end = { how: 'cancelled' };
  // The other side went away in the middle of it: no result will follow.
  else if (status === 'failed' && record(task.state).reason === 'lost') end = { how: 'failed', said: true };
  // "completed" or "failed" with nothing yet: the word and the answer come separately. Not ended until the answer is here.
  return { id, dir: task.direction, peer, status, end };
}

/**
 * What became of opening a request that arrived.
 *
 *   running   the person said yes: it may be done now. `checked`: what it
 *             gives back is shown to the person before it goes.
 *   declined  the person said no, and the other side was told.
 *   closed    nothing was decided: it can be opened again.
 *   gone      it ended before it was opened (taken back, ran out).
 *   failed    the engine could not open it now.
 */
export type PeerOpened = 'running' | 'declined' | 'closed' | 'gone' | 'failed';
/** sent: the answer went. kept: the person chose not to send it. closed: nothing decided. over: no more chances to send. gone: the request ended meanwhile. lost: the engine no longer holds it. */
export type PeerFinished = 'sent' | 'kept' | 'closed' | 'over' | 'gone' | 'lost' | 'failed';

/**
 * The engine's words for "it was handed to the line and the line broke": the
 * message may have gone. Tried once more under the same key, and said to be
 * not known when that fails too. Never said to be "not sent".
 */
const UNSURE: ReadonlySet<string> = new Set(['net_send_timeout', 'net_connection_lost', 'task_timeout']);
/** Its words for "there is no line, nothing went". */
const OFFLINE: ReadonlySet<string> = new Set(['not_connected', 'net_not_connected', 'task_not_connected', 'task_recipient_offline']);
/**
 * Its words for "this request is no longer held here": it ended, or the
 * engine was started anew and lost its hold on it. Read with and without the
 * `task_` the engine puts before the codes of its request layer.
 */
const HELD_NO_MORE: ReadonlySet<string> = new Set(['no_task', 'task_no_task', 'task_final', 'task_task_final', 'lease_lost', 'task_lease_lost', 'no_handle', 'task_no_handle', 'handle_closed', 'task_handle_closed']);

const KINDS: ReadonlySet<string> = new Set(['message', 'task_request', 'task_progress', 'task_input_request', 'task_input_answer', 'task_result', 'task_declined', 'task_cancel']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** One item of the engine's inbox document. Null when it is not one this file can use. */
export function peerItem(raw: unknown): PeerItem | null {
  const item = record(raw);
  const payload = record(item.payload);
  const from = text(record(item.from).deviceId);
  const kind = text(item.kind);
  if (item.direction !== 'in' || !text(item.itemId) || !from || !KINDS.has(kind)) return null;
  const said = kind === 'message' ? payload.text
    : kind === 'task_request' ? payload.instructions
      : kind === 'task_progress' ? payload.note
        : kind === 'task_input_request' ? payload.question
          : kind === 'task_input_answer' ? payload.answer
            : kind === 'task_result' ? payload.output
              : kind === 'task_declined' ? payload.reason : '';
  return {
    id: text(item.itemId), from, kind: kind as PeerItem['kind'],
    thread: orNull(item.threadId), task: orNull(item.taskId), replyTo: orNull(item.replyTo),
    at: typeof item.receivedAt === 'number' ? item.receivedAt : 0,
    read: item.read === true,
    text: text(said),
    title: kind === 'task_request' ? orNull(payload.title) : null,
  };
}

/** The people in the engine's contacts document: the ones that can be used, each with the owner's own name for them. */
export function peerPeople(document: Record<string, unknown>): PeerPerson[] {
  const people: PeerPerson[] = [];
  for (const raw of Array.isArray(document.contacts) ? document.contacts : []) {
    const contact = record(raw);
    const id = text(contact.deviceId);
    const trust = contact.trust;
    if (!id || contact.status !== 'active' || (trust !== 'verified' && trust !== 'vouched')) continue;
    // Only a name the owner typed. One without it cannot be spoken to by name, and is left out.
    const name = text(contact.localName).trim() || text(contact.ownDevice).trim();
    if (!name) continue;
    people.push({ id, name, own: !!text(contact.ownDevice), trust });
  }
  return people;
}

interface Calling { decide: PeerDecide }

export interface PeerLinkOptions {
  now?: () => number;
  log?: (line: string) => void;
  readMs?: number;
}

export class PeerLink {
  private engine: PeerEngineLike | null = null;
  private readonly calling: Calling[] = [];
  private known: PeerPerson[] = [];
  private signedIn = false;
  private server: string | null = null;
  private arrivalListeners: (() => void)[] = [];
  private changeListeners: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly options: PeerLinkOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The engine this link speaks through. Its dialogs, notices and states are given to the three methods below. */
  attach(engine: PeerEngineLike): void { this.engine = engine; }

  /** The engine's `onDialog`. */
  readonly dialog = async (dialog: EngineDialog): Promise<EngineDialogAnswer> => {
    const decision = peerDecision(dialog, this.now());
    // The newest call that names its kind: an older one may have outlived the script that made it (a sign-in
    // waits for the browser for minutes), and what it would answer with is gone.
    const handler = this.calling.map((call) => call.decide[decision.kind]).reverse().find((one) => !!one);
    if (!handler) return { action: 'cancel' };
    for (let tries = 0; tries < PEER_ASK_AGAIN; tries++) {
      const answer = await handler(decision);
      if (answer === null) return { action: 'cancel' };
      if (UNGUARDED.has(decision.kind) || this.now() - decision.at >= (this.options.readMs ?? PEER_READ_MS)) return { action: 'accept', content: answer };
    }
    return { action: 'cancel' };
  };

  /** The engine's `onNotice`. */
  readonly notice = (method: string): void => {
    if (method !== 'notifications/claude/channel') return;
    for (const listener of this.arrivalListeners) { try { listener(); } catch { /* a listener's own fault */ } }
  };

  /** The engine's `onState`. */
  readonly engineState = (state: EngineState): void => {
    if (state === 'up') void this.refresh();
    else this.changed();
  };

  /** Something arrived. What it is, is then read (`unread`). */
  onArrival(listener: () => void): void { this.arrivalListeners.push(listener); }
  /** Who is signed in, who the people are, or whether the engine is up, changed. */
  onChange(listener: () => void): void { this.changeListeners.push(listener); }

  account(): PeerAccount {
    return { engine: this.engine?.state() ?? 'stopped', signedIn: this.signedIn, server: this.server };
  }

  people(): PeerPerson[] { return this.known.slice(); }

  /** Reads again who is signed in and who the people are. */
  async refresh(): Promise<void> {
    if (!this.engine) return;
    try {
      const account = record((await this.engine.read('status')).account);
      this.signedIn = account.loggedIn === true;
      let host: string | null = null;
      try { host = typeof account.serverUrl === 'string' ? new URL(account.serverUrl).host : null; } catch { host = null; }
      this.server = host;
      this.known = peerPeople(await this.engine.read('contacts'));
    } catch {
      this.options.log?.('[peers] the people could not be read');
    }
    this.changed();
  }

  /**
   * Calls a tool of the engine. `decide` answers the decisions the call may
   * raise, by kind: one that is not named there is closed.
   */
  async call(tool: string, args: Record<string, unknown> = {}, decide: PeerDecide = {}, limitMs?: number): Promise<EngineToolResult> {
    if (!this.engine) throw new Error('no engine');
    const mine: Calling = { decide };
    this.calling.push(mine);
    try {
      return await this.engine.call(tool, args, limitMs);
    } finally {
      const at = this.calling.indexOf(mine);
      if (at >= 0) this.calling.splice(at, 1);
    }
  }

  /** What arrived and was not read yet, the oldest first. */
  async unread(): Promise<PeerItem[]> {
    if (!this.engine) return [];
    const document = await this.engine.read('inbox', { unread: true, limit: 50 });
    return (Array.isArray(document.items) ? document.items : []).map(peerItem).filter((item): item is PeerItem => !!item);
  }

  /**
   * Notes that the person has seen an item. The engine's own tool for it:
   * what it answers (the item again, in prose) is not used.
   */
  async seen(itemId: string): Promise<void> {
    if (!engineIds(itemId).length) return;
    try { await this.call('inbox', { action: 'read', item: itemId }, {}, 15_000); } catch { /* still unread there: it is asked about again, and known here by its id */ }
  }

  /** Sends a message to a person. `replyTo` makes it an answer to something that arrived. */
  async tell(to: string, words: string, more: { replyTo?: string; decide?: PeerDecide } = {}): Promise<PeerSent> {
    if (!this.engine || this.engine.state() !== 'up') return { ok: false, why: 'down' };
    // The same key on both tries: the engine then sends the same message once, however often it is asked.
    const args = { to, text: words, ...(more.replyTo ? { replyTo: more.replyTo } : {}), idempotencyKey: crypto.randomUUID() };
    let result: EngineToolResult;
    let code: string | null = null;
    for (let tries = 0; ; tries++) {
      try {
        result = await this.call('send_message', args, more.decide ?? {}, 60_000);
      } catch {
        return tries === 0 ? { ok: false, why: 'down' } : { ok: false, why: 'unknown' };
      }
      code = engineErrorCode(result.text);
      if (tries === 0 && code !== null && UNSURE.has(code)) continue;
      break;
    }
    if (result.failed || code) {
      if (code === 'not_logged_in') return { ok: false, why: 'signed_out' };
      if (code !== null && UNSURE.has(code)) return { ok: false, why: 'unknown', code };
      if (code !== null && OFFLINE.has(code)) return { ok: false, why: 'offline', code };
      return { ok: false, why: 'refused', ...(code ? { code } : {}) };
    }
    if (/^Not sent\b/.test(result.text)) return { ok: false, why: 'withheld' };
    const [id, thread] = engineIds(result.text);
    if (!id || !/^Message\b/.test(result.text)) return { ok: false, why: 'refused' };
    return { ok: true, id, thread: thread ?? null, delivered: /^Message (already )?delivered\b/.test(result.text) };
  }

  /** Asks another person's Jarvis for something. The person there says yes or no to it. */
  async ask(to: string, title: string, words: string): Promise<PeerSent> {
    if (!this.engine || this.engine.state() !== 'up') return { ok: false, why: 'down' };
    const args = { to, title, instructions: words, idempotencyKey: crypto.randomUUID() };
    let result: EngineToolResult;
    let code: string | null = null;
    for (let tries = 0; ; tries++) {
      try {
        result = await this.call('send_task', args, {}, 60_000);
      } catch {
        return tries === 0 ? { ok: false, why: 'down' } : { ok: false, why: 'unknown' };
      }
      code = engineErrorCode(result.text);
      if (tries === 0 && code !== null && UNSURE.has(code)) continue;
      break;
    }
    if (result.failed || code) {
      if (code === 'not_logged_in') return { ok: false, why: 'signed_out' };
      if (code !== null && UNSURE.has(code)) return { ok: false, why: 'unknown', code };
      if (code !== null && OFFLINE.has(code)) return { ok: false, why: 'offline', code };
      return { ok: false, why: 'refused', ...(code ? { code } : {}) };
    }
    if (/^Not sent\b/.test(result.text)) return { ok: false, why: 'withheld' };
    const [id, thread] = engineIds(result.text);
    if (!id || !/^Task\b/.test(result.text)) return { ok: false, why: 'refused' };
    return { ok: true, id, thread: thread ?? null, delivered: /\(delivered\)/.test(result.text) };
  }

  /** The requests the engine knows of, both ways. */
  async requests(): Promise<PeerRequest[]> {
    if (!this.engine) return [];
    const document = await this.engine.read('tasks', { limit: 50 });
    return (Array.isArray(document.tasks) ? document.tasks : []).map(peerRequest).filter((one): one is PeerRequest => !!one);
  }

  /**
   * Opens a request that arrived. The engine then asks the person whether it
   * may be done: `decide.request` is that question, and only its answer lets
   * the request run.
   */
  async open(id: string, decide: PeerDecide): Promise<PeerOpened> {
    if (!this.engine || this.engine.state() !== 'up') return 'failed';
    let result: EngineToolResult;
    try { result = await this.call('open_task', { task: id }, decide); } catch { return 'failed'; }
    const code = engineErrorCode(result.text);
    if (code === 'task_approval_dismissed') return 'closed';
    if (code !== null && HELD_NO_MORE.has(code)) return 'gone';
    if (result.failed || code) return 'failed';
    // Read from the engine's first line only: what follows it quotes the request, which the other side wrote.
    const first = result.text.split('\n', 1)[0] ?? '';
    if (/^Task \S+ from .* is running\b/.test(first)) return 'running';
    if (/^The user declined task\b/.test(first) || /^Task \S+ from .* was declined by this device's policy\b/.test(first)) return 'declined';
    if (/^That task request already ended\b/.test(first)) return 'gone';
    return 'failed';
  }

  /**
   * Gives a request its answer. The engine shows the person what is about
   * to leave: `decide.result` is that question, and only a yes sends it.
   */
  async finish(id: string, answer: string, decide: PeerDecide): Promise<PeerFinished> {
    if (!this.engine || this.engine.state() !== 'up') return 'failed';
    let result: EngineToolResult;
    try { result = await this.call('task_update', { task: id, action: 'complete', text: answer }, decide); } catch { return 'failed'; }
    const code = engineErrorCode(result.text);
    if (/^Task \S+ completed: result sent\b/.test(result.text)) return 'sent';
    if (/^Nothing was sent\b/.test(result.text)) {
      if (/refused too many checks/.test(result.text)) return 'over';
      return /chose not to send/.test(result.text) ? 'kept' : 'closed';
    }
    // The engine was started anew since the request was opened: it is not held any more, and cannot be answered.
    if (code === 'no_handle' || code === 'task_no_handle' || code === 'handle_closed' || code === 'task_handle_closed') return 'lost';
    if ((code !== null && HELD_NO_MORE.has(code)) || /\b(cancelled|expired)\b/.test(result.text)) return 'gone';
    return 'failed';
  }

  /** Ends a request that arrived without an answer: nothing of this machine's goes back. */
  async refuse(id: string): Promise<boolean> {
    if (!this.engine || this.engine.state() !== 'up') return false;
    try {
      const result = await this.call('task_update', { task: id, action: 'fail' }, {}, 30_000);
      return !result.failed && !engineErrorCode(result.text);
    } catch { return false; }
  }

  /** Takes back a request this machine made. */
  async takeBack(id: string): Promise<boolean> {
    if (!this.engine || this.engine.state() !== 'up') return false;
    try {
      const result = await this.call('task_control', { action: 'cancel', task: id }, {}, 30_000);
      return !result.failed && !engineErrorCode(result.text);
    } catch { return false; }
  }

  private changed(): void {
    for (const listener of this.changeListeners) { try { listener(); } catch { /* a listener's own fault */ } }
  }
}
