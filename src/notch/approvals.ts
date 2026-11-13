/**
 * Approvals on the notch: one line, one yes.
 *
 * Every pending approval the product holds becomes an item in the inbox
 * (./inbox.ts). Nothing about approving is decided here. The yes goes through
 * the one decision function every surface uses (daemon/approval-decision.ts),
 * so "decided once" and every refusal it makes hold for the notch as they do
 * for the dashboard.
 *
 * A key approves whatever the notch can show whole: a shell command, a file
 * write, a delete, an install, a message, stopping an agent. The rule a
 * spoken yes follows (roles/authority.ts: nothing destructive by voice) is
 * not applied here, by the owner's decision of 13 November 2026: a key press
 * is not a word that may have been misheard, the line names the action, and
 * the fuse gives three seconds to take it back. A destructive request is
 * shown with a careful face, and that is all that marks it.
 *
 * Three things a key does not approve. The line says why, and yes on it
 * opens the dashboard:
 *
 *   - a payment. Never (approvalDashboardOnly).
 *   - a request that needs on-screen review (the same function): the product
 *     refuses it from every surface but the dashboard.
 *   - a sentence longer than three lines of the notch, or one that could
 *     be a look-alike. The rule of every surface smaller than
 *     the dashboard: what cannot be read whole is not offered for a yes.
 *
 * A yes is not acted on at once. A fuse burns first, and Esc takes it back:
 * that is the undo window. The approval stays pending for all of it, so
 * nothing has to be undone: if the fuse is taken back, or the page goes away
 * before it has burnt, nothing was ever decided. If the dashboard decides in
 * the meantime, the decision function says so and the notch passes that on.
 *
 * Esc is a no. It denies the request through the same decision function, so
 * it is gone from the notch, the dashboard and the count, and the agent that
 * asked is told no. That holds for every line here, the ones a key cannot
 * approve included: a payment can be refused from anywhere. (Esc inside the
 * fuse is different: it takes back the yes just given, and the offer is
 * there again.)
 *
 * A line left alone until it folds is not a no. It goes back to the count,
 * and comes round again. Looking away decides nothing.
 *
 * The approvals are found by looking, once a second, the way the tray and
 * the toast find them: nothing in the product announces them to listeners.
 */
import { approvalIntentParts, boundedApprovalLabel, toastColumns, toastLookAlike } from '../authority/approval-delivery.ts';
import { approvalDashboardOnly, approvalIntentFromContext, approvalNeedsClick, executionState } from '../authority/approval.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { ApprovalDecisionOutcome } from '../daemon/approval-decision.ts';
import { impactFromCategory } from '../roles/authority.ts';
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** How long the fuse burns between a yes and the decision. */
export const NOTCH_APPROVAL_FUSE_MS = 3000;
/** How often the pending approvals are looked at. */
export const NOTCH_APPROVAL_LOOK_MS = 1000;
/** An approval older than this when first seen joins the count without speaking up. */
const FRESH_MS = 60_000;

/**
 * The most columns of an action's sentence the notch offers for a yes: three
 * lines of ordinary text beside the eyes and the hint. The notch grows a line
 * at a time and breaks a long path or URL where the line ends, so nothing of
 * a sentence this long is hidden (measured in the page with commands, paths,
 * URLs and runs with no space at all, up to 240 columns). Past three lines it
 * is no longer a line to answer at a glance, and the dashboard is the place.
 * Measured as the toast measures, so a character of unknown width counts as
 * not fitting.
 */
export const NOTCH_APPROVABLE_COLUMNS = 200;
/** The most of a sentence a line shows when it is not shown whole. */
const SHOWN_COLUMNS = 100;

/**
 * How the notch may answer a request: `key` when yes approves it, otherwise
 * why it must be approved in the dashboard.
 */
export type NotchApprovalWay = 'key' | 'sheet' | 'payment' | 'too_long' | 'look_alike';

/**
 * The longest exact sentence that is shown as it is, on one line. Anything
 * longer, and anything that has to be reviewed on screen, is shown as a
 * sentence in plain words with the exact action under it (way `sheet`).
 * Decided by the owner on 13 November 2026: a person should be asked "Look up
 * where Steam is installed?", not shown a registry query.
 */
export const NOTCH_PLAIN_LINE_COLUMNS = 60;
/** The most of an exact action a sheet shows whole. Past this the dashboard is the place. */
export const NOTCH_SHEET_COLUMNS = 3000;
/** How long an approval's sheet stays up unanswered before it goes back to the count. */
export const NOTCH_APPROVAL_SHEET_MS = 30_000;
/** How long the plain words are waited for before the line is shown without them. */
export const NOTCH_APPROVAL_WORDS_MS = 4000;

/** What is asked when nobody could say it in plain words: by what kind of thing it is. */
export function notchApprovalFallback(request: Pick<ApprovalRequest, 'action_category'>): string {
  switch (request.action_category) {
    case 'execute_command': return 'Run a command on this computer?';
    case 'control_app': return 'Do this in an app on your screen?';
    case 'access_browser': return 'Do this in the browser?';
    case 'write_data': return 'Write or change a file?';
    case 'delete_data': return 'Delete something?';
    case 'install_software': return 'Install or remove software?';
    case 'modify_settings': return 'Change a setting?';
    case 'send_email': return 'Send an email?';
    case 'send_message': return 'Send a message?';
    case 'spawn_agent': return 'Hand this to another agent?';
    case 'terminate_agent': return 'Stop an agent?';
    default: return 'Allow this?';
  }
}

/** Whether the call carries any argument at all. One that cannot be read counts as carrying some. */
function hasArguments(request: Pick<ApprovalRequest, 'tool_arguments'>): boolean {
  try {
    const args: unknown = JSON.parse(request.tool_arguments);
    return !(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0);
  } catch {
    return true;
  }
}

/**
 * The exact action, for the paper under the plain words. For a command it is
 * the gate's own sentence, which holds every character of it. For an action
 * on screen that sentence is only "review this", so the tool and each of its
 * arguments are written out as they will be used.
 */
export function notchApprovalExact(request: ApprovalRequest): string[] {
  // The model's own one-line intent is the whole of what it declared.
  if (request.tool_name === 'request_approval') return [notchApprovalSentence(request)];
  const gate = approvalIntentFromContext(request);
  const onScreen = approvalNeedsClick(request);
  // A sentence the tool's own gate wrote for a card holds the action whole
  // (a command with every character of it): it is the exact action.
  if (gate && !onScreen) return [notchApprovalSentence(request)];
  // An action on screen: the gate's sentence says what is acted on (the
  // element's label, the app, what it may send or delete), and the arguments
  // say with what. Both are shown. A tool with no sentence of its own is
  // never shown by its name alone: its arguments are what is approved.
  // (With no arguments at all its name is the whole of it.)
  if (!gate && !onScreen && !hasArguments(request)) return [notchApprovalSentence(request)];
  const lines = gate ? [notchApprovalSentence(request), request.tool_name] : [request.tool_name];
  try {
    const args: unknown = JSON.parse(request.tool_arguments);
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        // Text of several lines (a poem to type, a note to write) is shown as
        // its lines, under the name of what it is.
        const parts = text.split(/\r\n|\r|\n/);
        if (parts.length === 1) lines.push(`${key}: ${text}`);
        else lines.push(`${key}:`, ...parts);
      }
    }
  } catch { /* arguments that are not an object are shown as they are */
    lines.push(request.tool_arguments);
  }
  return lines;
}

/** What the request will do, as one line, whole: the sentence the dashboard card leads with. */
export function notchApprovalSentence(request: ApprovalRequest): string {
  const { action } = approvalIntentParts(request);
  return boundedApprovalLabel(action, action.length);
}

export function notchApprovalWay(request: ApprovalRequest): NotchApprovalWay {
  const only = approvalDashboardOnly(request);
  if (only === 'payment') return 'payment';
  // Measured as one run of text: where its lines break is not part of how
  // long it is. (A carriage return inside a poem once counted as a character
  // of unknown width, and sent the poem to the dashboard as "too long".)
  const exact = notchApprovalExact(request).join(' ').replace(/\s+/g, ' ').trim();
  // Letters that pass for other letters are not shown here at all: the
  // dashboard marks them, a line and a sheet cannot.
  if (toastLookAlike(exact)) return 'look_alike';
  const columns = toastColumns(exact);
  // Still unmeasurable: something in it has no width a person would see.
  if (columns === null || columns > NOTCH_SHEET_COLUMNS) return 'too_long';
  // What has to be reviewed on screen is reviewed on the notch, which is on
  // that screen: plain words, and the exact action under them.
  if (only === 'click_only') return 'sheet';
  // The model's own one-line intent is already plain words.
  if (request.tool_name === 'request_approval') return columns > NOTCH_APPROVABLE_COLUMNS ? 'sheet' : 'key';
  // A tool that wrote no sentence of its own would be a line with its name
  // and nothing else ("Write file?"): it is a sheet, with its arguments.
  if (approvalIntentFromContext(request) === null && hasArguments(request)) return 'sheet';
  return columns > NOTCH_PLAIN_LINE_COLUMNS ? 'sheet' : 'key';
}

/** A sentence cut for a line that only points at the dashboard, with a mark that it was cut. */
function shortened(sentence: string): string {
  const points = [...sentence];
  return points.length <= SHOWN_COLUMNS ? sentence : `${points.slice(0, SHOWN_COLUMNS - 1).join('').trimEnd()}…`;
}

export interface NotchApprovalDeps {
  approvalManager: {
    getPending(): ApprovalRequest[];
    getRequest(requestId: string): ApprovalRequest | null;
  };
  /** Approves through the product's own decision function, as the notch. */
  approve(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Denies through the same function, as the notch. */
  deny(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Opens the dashboard on the machine whose notch was answered. */
  openDashboard?: (sidecarId: string | null) => void;
  /**
   * What the request would do, as one question in plain words ("Look up where
   * Steam is installed?"). Asked of something that sees only the tool and its
   * arguments, never the conversation. Null when it cannot say.
   */
  describe?: (request: ApprovalRequest) => Promise<string | null>;
  /**
   * Whether an instruction the person gave on the notch is stopped at this
   * request right now. Then it does not fold and its sheet does not time
   * out: it is the one thing they are waiting on, and if it left the notch
   * there would be nothing left to say yes to.
   */
  mine?: (requestId: string) => boolean;
  now?: () => number;
  fuseMs?: number;
  wordsMs?: number;
  sheetMs?: number;
  clock?: { setTimeout(fn: () => void, ms: number): unknown };
  log?: (line: string) => void;
}

export interface NotchApprovals {
  /** Looks at the pending approvals now, and brings the inbox in line with them. */
  sync(): void;
  /** The item id an approval has in the inbox. */
  itemId(requestId: string): string;
  /**
   * The person is waiting on this one: an instruction they gave on the notch
   * has stopped for it. It takes the notch now, whatever is on it.
   */
  raise(requestId: string): void;
}

const em = (text: string): NotchPart => ({ em: text });

/** One sentence, with its last full stop taken off so another mark can follow. */
const bare = (sentence: string): string => sentence.replace(/[.\s]+$/u, '');

export function attachNotchApprovals(inbox: NotchInbox, deps: NotchApprovalDeps): NotchApprovals {
  const now = deps.now ?? Date.now;
  const fuseMs = deps.fuseMs ?? NOTCH_APPROVAL_FUSE_MS;
  const log = deps.log ?? ((line: string) => console.log(line));
  const itemId = (requestId: string): string => `approval:${requestId}`;
  /** Approvals that have an item, by request id. */
  const known = new Set<string>();
  /**
   * Approvals the person has said yes to on the notch, from that yes until
   * the notch has said what came of it. If one is decided somewhere else in
   * that time, the line does not just leave: its own script finds out and
   * says so.
   */
  const answering = new Set<string>();

  /** The plain words for a request, once somebody has said them. Null: nobody could. */
  const words = new Map<string, string | null>();
  const preparing = new Map<string, Promise<void>>();
  const wordsMs = deps.wordsMs ?? NOTCH_APPROVAL_WORDS_MS;
  const sheetMs = deps.sheetMs ?? NOTCH_APPROVAL_SHEET_MS;
  const after = deps.clock ? (fn: () => void, ms: number) => deps.clock!.setTimeout(fn, ms) : (fn: () => void, ms: number) => setTimeout(fn, ms);

  /** Has the plain words fetched for a request that will be shown with them. Never waits longer than `wordsMs`. */
  function prepare(request: ApprovalRequest): Promise<void> {
    const describe = deps.describe;
    if (!describe || words.has(request.id) || notchApprovalWay(request) !== 'sheet') return Promise.resolve();
    const running = preparing.get(request.id);
    if (running) return running;
    const made = new Promise<void>((resolve) => {
      let settled = false;
      const done = (said: string | null): void => {
        if (settled) return;
        settled = true;
        words.set(request.id, said);
        preparing.delete(request.id);
        resolve();
      };
      after(() => done(null), wordsMs);
      describe(request).then(
        (said) => done(said && said.trim() ? said.trim() : null),
        (error: unknown) => {
          log(`[notch] an approval could not be put in plain words: ${error instanceof Error ? error.message : String(error)}`);
          done(null);
        },
      );
    });
    preparing.set(request.id, made);
    return made;
  }

  /** The question a request is asked with: its plain words, or what kind of thing it is. */
  const question = (request: ApprovalRequest): string => words.get(request.id) ?? notchApprovalFallback(request);

  const pendingRequest = (requestId: string): ApprovalRequest | null => {
    const request = deps.approvalManager.getRequest(requestId);
    return request && request.status === 'pending' ? request : null;
  };

  /** What happened to a request the notch did not get to decide. */
  const decidedElsewhere = (requestId: string): NotchPart[] => {
    const request = deps.approvalManager.getRequest(requestId);
    if (!request) return ['That request is gone.'];
    if (request.status === 'denied') return ['Already denied. Nothing was run.'];
    if (request.status === 'expired') return ['It expired before you answered. Nothing was run.'];
    return ['Already decided in the dashboard.'];
  };

  async function play(requestId: string, stage: NotchStage): Promise<NotchItemEnd> {
    // Each time round: the offer, then the fuse. Taking the fuse back returns
    // to the offer, which is where it came from.
    for (;;) {
      const request = pendingRequest(requestId);
      if (!request) return 'settled';
      const sentence = notchApprovalSentence(request);
      const way = notchApprovalWay(request);
      if (way !== 'key') {
        // The reason first, then the thing itself, with nothing after it: a
        // line that wraps must not start with a stray full stop.
        const shown = em(bare(shortened(sentence)));
        if (way === 'sheet') return await playSheet(request, stage);
        const why: NotchPart[] = way === 'payment'
          ? ['A payment. I never take that on a key: ', shown]
          : way === 'too_long'
            ? ['Too long to show whole here, so it is approved in the dashboard: ', shown]
            : ['Some of its letters could be look-alikes, so it is approved in the dashboard: ', shown];
        const answer = await stage.offer(why, 'open', { mood: 'careful' });
        if (answer.act === 'no') return refuse(requestId, stage);
        if (answer.act !== 'yes') return 'waits';
        deps.openDashboard?.(stage.from());
        await stage.say(['It is open in the dashboard.'], 1800);
        return 'waits';
      }

      // The one thing that marks a request that cannot be taken back once it
      // has run: a careful face.
      const destructive = impactFromCategory(request.action_category) === 'destructive';
      const waitedOn = deps.mine?.(requestId) === true;
      const answer = await stage.offer([`${bare(sentence)}?`], 'approve', { ...(destructive ? { mood: 'careful' as const } : {}), ...(waitedOn ? { fold: 0 } : {}) });
      if (answer.act === 'no') return refuse(requestId, stage);
      // Left alone until it folded: it waits, and comes round again.
      if (answer.act !== 'yes') return 'waits';
      answering.add(requestId);
      try {
        const fuse = await stage.fuse([`${bare(sentence)}…`], fuseMs, { mood: 'work' });
        if (fuse === 'undo') continue;
        // Nobody saw the fuse burn out: the yes is not acted on.
        if (fuse === 'lost') return 'waits';
        return await decide(requestId, stage);
      } finally {
        answering.delete(requestId);
      }
    }
  }

  /**
   * A request asked in plain words, with the exact action on a sheet of paper
   * under them, so that what is approved is on screen at the moment of the
   * yes. Yes burns the fuse and decides. Esc is no. A click somewhere else is
   * neither: the sheet stays, and goes back to the count if left alone.
   */
  async function playSheet(first: ApprovalRequest, stage: NotchStage): Promise<NotchItemEnd> {
    const requestId = first.id;
    for (;;) {
      const request = pendingRequest(requestId);
      if (!request) return 'settled';
      const asked = question(request);
      const destructive = impactFromCategory(request.action_category) === 'destructive';
      const id = stage.id();
      stage.put({
        id, kind: 'sheet', say: [asked], yes: 'approve', stay: true, ...(destructive ? { mood: 'careful' as const } : {}),
        blocks: [
          { kind: 'paper', lines: notchApprovalExact(request).map((line): NotchPart[] => [line]) },
          { kind: 'note', say: ['Under the question is exactly what will be done.'] },
        ],
      });
      // Opened before anybody had worded it: the question is the kind of
      // thing it is, and becomes the plain words when they are in. The exact
      // action under it does not change.
      if (deps.describe && !words.has(requestId)) {
        void prepare(request).then(() => {
          if (!stage.ended() && words.get(requestId)) stage.surface.update(id, { say: [words.get(requestId)!] });
        });
      }
      // One the person's own instruction is stopped at stays until it is answered.
      const waitedOn = deps.mine?.(requestId) === true;
      const left = waitedOn ? new Promise<null>(() => {}) : stage.wait(sheetMs).then(() => null);
      left.catch(() => {});
      const answer = await Promise.race([stage.answer(id, ['yes', 'no']), left]);
      // Left alone: it waits, and comes round again.
      if (!answer) return 'waits';
      if (answer.act === 'no') return refuse(requestId, stage);
      answering.add(requestId);
      try {
        // In the words that were on the sheet when yes was given.
        const said = words.get(requestId) ?? asked;
        const fuse = await stage.fuse([`${bare(said.replace(/\?+$/, ''))}…`], fuseMs, { mood: 'work' });
        if (fuse === 'undo') continue;
        if (fuse === 'lost') return 'waits';
        return await decide(requestId, stage);
      } finally {
        answering.delete(requestId);
      }
    }
  }

  /**
   * Esc on the line: no. The request is denied, and nothing more is said
   * about it: the notch shakes its head and goes on to what is next, so a
   * row of them can be turned down one key each.
   */
  async function refuse(requestId: string, stage: NotchStage): Promise<NotchItemEnd> {
    answering.add(requestId);
    try {
      await deps.deny(requestId);
    } catch (error) {
      log(`[notch] an approval could not be denied: ${error instanceof Error ? error.message : String(error)}`);
      await stage.say(['That did not go through. It still waits.'], 2600, { mood: 'sorry', mark: 'fail' });
      return 'waits';
    } finally {
      answering.delete(requestId);
    }
    // Denied here, or already decided somewhere else: either way it no longer waits.
    stage.surface.act({ gesture: 'shake' });
    return 'settled';
  }

  /** The fuse has burnt: decide, and say what came of it. */
  async function decide(requestId: string, stage: NotchStage): Promise<NotchItemEnd> {
    let outcome: ApprovalDecisionOutcome;
    try {
      outcome = await deps.approve(requestId);
    } catch (error) {
      log(`[notch] an approval could not be decided: ${error instanceof Error ? error.message : String(error)}`);
      await stage.say(['That did not go through. It still waits.'], 2600, { mood: 'sorry', mark: 'fail' });
      return 'waits';
    }

    switch (outcome.status) {
      case 'already_decided':
        await stage.say(decidedElsewhere(requestId), 2600);
        return 'settled';
      case 'needs_dashboard':
        await stage.say(['That one is approved in the dashboard.'], 2600, { mood: 'careful' });
        return 'waits';
      case 'held':
        await stage.say([outcome.state === 'paused'
          ? 'Jarvis is paused, so this waits. Wake me, then say yes again.'
          : 'Jarvis was stopped, so this cannot be approved.'], 3200, { mood: 'careful' });
        return 'waits';
      case 'denied':
        return 'settled';
      case 'approved': {
        if (outcome.error) {
          await stage.say(['Approved, but it could not be started.'], 3000, { mood: 'sorry', mark: 'fail' });
          return 'settled';
        }
        // Run by whoever was waiting for the answer, not here: an agent in
        // the middle of its work, or a workflow that now goes on.
        if (!outcome.executed) {
          await stage.say(['Approved.'], 1800, { mood: 'happy', mark: 'check' });
          return 'settled';
        }
        const state = executionState(outcome.request);
        if (state === 'committed') {
          await stage.say(['Done.'], 1800, { mood: 'happy', mark: 'check' });
        } else if (state === 'blocked') {
          await stage.say(['Approved, but it was not run. The dashboard says why.'], 3200, { mood: 'careful', mark: 'fail' });
        } else if (state === 'unknown') {
          await stage.say(['Approved, but I cannot tell whether it happened. Check before asking again.'], 3600, { mood: 'worried', mark: 'fail' });
        } else {
          await stage.say(['Approved, but it failed.'], 3000, { mood: 'sorry', mark: 'fail' });
        }
        return 'settled';
      }
    }
  }

  function item(request: ApprovalRequest, raised = false): NotchItem {
    const requestId = request.id;
    return {
      ...(raised ? { urgent: true } : {}),
      id: itemId(requestId),
      subject: itemId(requestId),
      // An agent stopped in the middle of its work is a running clock: it
      // gives up waiting after a while. The rest can wait.
      class: request.execution_mode === 'inline' ? 'clock' : 'rest',
      // What was already waiting when the notch came up joins the count
      // quietly, as the toast leaves a backlog alone.
      speaks: raised || now() - request.created_at < FRESH_MS,
      title: () => {
        const current = deps.approvalManager.getRequest(requestId) ?? request;
        return [words.get(requestId) ?? shortened(notchApprovalSentence(current))];
      },
      check: () => pendingRequest(requestId) !== null,
      play: (stage) => play(requestId, stage),
    };
  }

  function sync(): void {
    let pending: ApprovalRequest[];
    try {
      pending = deps.approvalManager.getPending();
    } catch (error) {
      log(`[notch] the pending approvals could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const ids = new Set(pending.map((request) => request.id));
    // Oldest first, so the count's order is the order they were asked in.
    for (const request of [...pending].sort((a, b) => a.created_at - b.created_at)) {
      if (known.has(request.id)) continue;
      known.add(request.id);
      arrive(request, false);
    }
    for (const requestId of [...known]) {
      if (ids.has(requestId) || answering.has(requestId)) continue;
      known.delete(requestId);
      words.delete(requestId);
      // Decided, expired or withdrawn somewhere else: the line leaves by itself.
      inbox.remove(itemId(requestId));
    }
  }

  function raise(requestId: string): void {
    const request = pendingRequest(requestId);
    if (!request || inbox.showing() === itemId(requestId)) return;
    known.add(requestId);
    arrive(request, true);
  }

  /**
   * Puts a request in the inbox, once its plain words are there (or were not
   * to be had in time). Until then whatever is on the notch stays on it.
   */
  function arrive(request: ApprovalRequest, raised: boolean): void {
    const add = (): void => {
      // Decided while its words were being found, or already on the notch.
      if (!pendingRequest(request.id) || !known.has(request.id) || inbox.showing() === itemId(request.id)) return;
      inbox.add(item(request, raised));
    };
    // One that will not speak up (it was already waiting when the notch came
    // up) is not worded now: that would be a model call for every old
    // request at every start. It is worded when it is opened.
    const speaks = raised || now() - request.created_at < FRESH_MS;
    if (!speaks || !deps.describe || words.has(request.id) || notchApprovalWay(request) !== 'sheet') { add(); return; }
    void prepare(request).then(add);
  }

  return { sync, itemId, raise };
}
