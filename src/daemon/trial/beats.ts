/**
 * The room beats of the trial: what Jarvis and the founder actually DO
 * together, in a fixed order, without the conversation ever stopping.
 *
 * This is beats 06 onward of the trial spec. It attaches to the seam the
 * opening left behind (`conclude_opening` in `conductor.ts`) and it is the
 * second half of the same conversation, not a phase that follows it.
 *
 * ── D41, and what "deeper" turned out to mean ──
 *
 * The first live run of the whole arc worked and was too fast: it did not feel
 * like enough effort had gone in. The cause was structural and it was here.
 * Every beat's completion condition was "one write landed", so the model was
 * handed the next beat's brief the instant it got its first yes. A beat that
 * should have been several minutes of real work with the founder collapsed
 * into one proposal and one nod, six times.
 *
 * So a beat now completes when the ROOM'S work is finished, and the missing
 * piece is refused IN CODE rather than requested in a prompt, for the same
 * reason the authority ceiling is: a model under time pressure takes the first
 * yes. `create_goals` will not write a tree with no starting numbers on it,
 * `create_tasks` will not write a board where nothing has been chosen as
 * first, `set_daily_rhythm` will not set half a day, `propose_workflow` will
 * not propose a flow with no line it must never cross, the workflows beat does
 * not close on one flow, and `set_authority` will not grant a level with no
 * carve-out. Every one of those refusals is a sentence telling the model what
 * to go and ask the founder, and every one of them ends in another real row in
 * their vault. None of them is a pause or a longer speech.
 *
 * ── The one structural idea, and the thing most likely to be undone ──
 *
 * THIS IS A LEDGER, NOT A DRIVER (D17). Nothing here sends a message, decides
 * a turn, or waits for one. It records which beats have happened, holds the
 * one proposal currently on the founder's screen, and hands the model a short
 * private brief through TOOL RESULTS at the moment it finishes a beat. The
 * model keeps the floor from the first word of the opening to the last word of
 * the finale; there is no point at which the conductor hands off to a stepper,
 * and if one ever appears here the design is broken.
 *
 * The order is fixed (D16) and is psychological, not technical: prove it
 * listened, build momentum with small things, then ask for the heavy
 * commitment, then negotiate power once the founder can see what it is for.
 * `beatIsOpen` enforces it by refusing a beat whose predecessors have not
 * happened, and the refusal is written as a sentence the model can act on
 * rather than an error.
 *
 * ── The seventh beat is not in ROOM_BEATS ──
 *
 * D16.1's `memory` beat is not a stop and is never opened as a room. It is
 * `remember`, in conductor.ts, running continuously from the first sentence of
 * the opening to the last sentence of the finale. It needs nothing here except
 * not to be broken.
 *
 * ── Every write is proposed before it lands (D18, D22) ──
 *
 * Each beat is a `propose_*` that writes nothing and puts the proposal on the
 * founder's screen, and a separate commit tool that writes. The commit refuses
 * when nothing has been proposed. Realtime auto-approves every tool call
 * outside a destructive blocklist, so the founder's spoken yes is NOT a
 * security gate and nothing here pretends otherwise: what the split buys is
 * that nothing reaches the vault the founder has not seen first, and that the
 * blast radius of the whole session is six narrow, non-destructive writes.
 * The one place a spoken word could have done real damage, the authority
 * level, is clamped in code (`clampAuthorityLevel`) and not by a promise in a
 * prompt.
 */

import { createCommitment, getUpcoming, findCommitments, type Commitment, type CommitmentPriority } from '../../vault/commitments.ts';
import { createGoal, findGoals, updateGoalScore } from '../../vault/goals.ts';
import type { Goal } from '../../goals/types.ts';
import { parseRelativeDate } from '../../voice/parse-date.ts';
import type { LLMTool } from '../../llm/provider.ts';
import type { RoomKey } from '../../voice/intent.ts';
import {
  checkWorkspacePlan,
  createWorkspace,
  defaultWorkspacePath,
  describeSurvey,
  readInside,
  resolveFounderFolder,
  surveyFolder,
  writeRevision,
} from './founder-files.ts';
import { detectHostShape, folderCandidates, sayPath, type HostShape } from './host-paths.ts';

/** Vault `source` for everything the room beats write. Distinct from the
 *  opening's `trial_conductor` so the D38 debrief can tell "what it learned
 *  while you talked" from "what the two of you built". */
export const TRIAL_BEATS_SOURCE = 'trial_room_beats';

/**
 * The beats that are stops, in D16's order as amended by D44. `memory` is
 * D16's first beat and is deliberately absent from the list: it is not a stop,
 * it is `remember` running underneath all of these.
 *
 * `files` and `workspace` are D42 and D43. They came in on 26 August between
 * `authority` and `agents`, and D44 moved them to the FRONT the same day,
 * directly after the founder has described their company. The reversal is
 * recorded here rather than quietly applied, because the argument it overturns
 * was a good one and somebody will make it again.
 *
 * THE ARGUMENT FOR THE OLD PLACEMENT, which was mine: reading a founder's disk
 * is the most invasive thing in the trial, D16 puts authority sixth so that
 * power is negotiated before it is used, and asking for a folder at minute
 * three asks for the biggest thing on the least credit.
 *
 * WHY IT LOSES. The file read never depended on the authority beat and never
 * could have: it has its own approval, which names the folder, the file count
 * and six real filenames, and `start_reading` refuses without a spoken answer
 * to THAT card (D42). Authority governs what Jarvis may do UNATTENDED, which
 * is a different question from what a founder hands over deliberately while
 * watching. Sequencing them implied a dependency the code does not have.
 *
 * WHAT MOVING IT BUYS, and this is the whole point: every beat below `files`
 * used to be proposed out of ten minutes of talking. Now they are proposed out
 * of the company's own documents. "It was actually listening" (D16.2) becomes
 * "it already knows", and a founder is never asked to explain something Jarvis
 * has just read.
 *
 * WHAT IT COSTS, so it is not discovered later as a surprise: the ask is much
 * earlier and carries far less credit, so `filesBrief` does more work than any
 * other brief here, and the refusal path stops being an edge case. A founder
 * who says no at minute three spends the next forty in this same list, so
 * every brief below has a second arm that asks for what the files would have
 * answered. See `NO_FILES`.
 *
 * `agents` is still the finale (D15) and `handover` is still last. Moving the
 * file reader does not move the researcher: it is the only beat that keeps
 * working after the talking stops, and it has to be the one they leave on.
 */
export const ROOM_BEATS = [
  'files', 'workspace', 'goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents',
  'handover',
] as const;

export type RoomBeat = (typeof ROOM_BEATS)[number];

/** Which dashboard room each beat happens in, or null for the one beat that
 *  happens in no room. */
export const BEAT_ROOM: Record<RoomBeat, RoomKey | null> = {
  goals: 'goals',
  tasks: 'tasks',
  calendar: 'calendar',
  workflows: 'workflows',
  authority: 'authority',
  // Both file beats happen in `memory`, which is where what the reader finds
  // actually lands.
  //
  // D44 makes this the FIRST room the founder is led into, and D16.1 says they
  // are never SHOWN the memory room. The tension is real and it resolves like
  // this: D16.1 forbids the memory room as a TOUR STOP, a thing pointed at and
  // explained. Nothing is explained here. They are led there at the one moment
  // it is not a room but an event, the seconds when their own documents start
  // arriving in it, and the whole of D42 is that they watch a picture of their
  // company assemble without having typed it. A ticker they have been watching
  // out of the corner of their eye for two minutes becomes the thing on the
  // screen. `enterRoom` is a no-op on an unchanged room, so the pebble makes
  // one gesture across both beats rather than twitching twice.
  files: 'memory',
  workspace: 'memory',
  agents: 'agents',
  // The handover happens on the shell itself: the pebble that comes back, the
  // panel that opens on their own keystroke, the palette. There is no room to
  // lead them into and nothing to mark a door with, so neither gesture fires.
  handover: null,
};

export function beatIndex(beat: RoomBeat): number {
  return ROOM_BEATS.indexOf(beat);
}

/**
 * D32's trial ceiling, enforced here rather than trusted to the prompt.
 *
 * Level 7 is `send_email`, the first outward action that cannot be taken back,
 * and there is no card on file. Jarvis proposes 5 and the founder may pull it
 * down; 6 is allowed because it buys nothing 5 does not, and refusing a
 * founder who says "six, then" would be a strange hill. Seven and above does
 * not exist inside the 48 hours, whatever anyone says out loud.
 */
export const TRIAL_AUTHORITY_CEILING = 6;

/** What Jarvis asks for (D32). */
export const TRIAL_AUTHORITY_PROPOSED = 5;

export function clampAuthorityLevel(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return TRIAL_AUTHORITY_PROPOSED;
  return Math.min(Math.max(n, 1), TRIAL_AUTHORITY_CEILING);
}

/** The hour the morning brief lands, as a cron hour. Minutes are real: the
 *  goal rhythm gained a `morning_minute` for this, because a founder who says
 *  "half seven" and is given seven has been told a small lie about the one
 *  appointment tomorrow depends on. */
export function clampBriefHour(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 7;
  return Math.min(Math.max(n, 0), 23);
}

export function clampBriefMinute(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 59);
}

/* ─────────────────────────── proposals ─────────────────────────── */

export type KeyResultProposal = {
  title: string;
  measure?: string;
  /** Where it has to get to. Their number. */
  target?: string;
  /**
   * Where it is TODAY. D41: this is the one question in the goals beat the
   * founder has to stop and actually work out, and it is the difference
   * between a wish and something anything can be tracked against.
   * `create_goals` refuses without it on every key result.
   */
  today?: string;
};

export type GoalProposal = {
  beat: 'goals';
  objective: string;
  measure?: string;
  /** When the quarter is up, resolved. A quarter with no end is a mood. */
  deadline: number | null;
  deadlineLabel: string | null;
  keyResults: KeyResultProposal[];
  /**
   * The first real move, which lands as a milestone under one of the key
   * results. Without it the tree describes December and says nothing at all
   * about this week.
   */
  firstMove: { what: string; due: number | null; dueLabel: string | null; under: string } | null;
  /**
   * D44. True when the reader had landed something out of the founder's own
   * documents by the time this went up, so the card can say where it came
   * from. The whole claim the reorder makes is "it already knows", and a card
   * that still says "from what you told me" while Jarvis is quoting their
   * deck contradicts it on screen.
   */
  fromFiles?: boolean;
};

export type TaskProposal = {
  beat: 'tasks';
  tasks: {
    what: string;
    /** Resolved due date, or null when they said "sometime". */
    due: number | null;
    /** What the founder would call it: "was friday", "tomorrow", "thu". */
    dueLabel: string | null;
    priority: CommitmentPriority;
    late: boolean;
    /** Which key result or objective this one actually serves, if any. */
    toward?: string;
    /** The one thing they do first. Exactly one, and they choose it. */
    first: boolean;
  }[];
  /**
   * D44. True when the reader had landed something out of the founder's own
   * documents by the time this went up, so the card can say where it came
   * from. The whole claim the reorder makes is "it already knows", and a card
   * that still says "from what you told me" while Jarvis is quoting their
   * deck contradicts it on screen.
   */
  fromFiles?: boolean;
};

export type CalendarProposal = {
  beat: 'calendar';
  hour: number;
  minute: number;
  because?: string;
  /** The other end of the day: when the evening review runs. */
  eveningHour: number | null;
  /**
   * D44. True when the reader had landed something out of the founder's own
   * documents by the time this went up, so the card can say where it came
   * from. The whole claim the reorder makes is "it already knows", and a card
   * that still says "from what you told me" while Jarvis is quoting their
   * deck contradicts it on screen.
   */
  fromFiles?: boolean;
};

export type WorkflowProposal = {
  beat: 'workflows';
  name: string;
  runsWhen: string;
  steps: string[];
  never?: string;
  /** Set while the composer is building it, so the silence is legible. */
  building?: boolean;
  /**
   * D44. True when the reader had landed something out of the founder's own
   * documents by the time this went up, so the card can say where it came
   * from. The whole claim the reorder makes is "it already knows", and a card
   * that still says "from what you told me" while Jarvis is quoting their
   * deck contradicts it on screen.
   */
  fromFiles?: boolean;
};

export type AuthorityProposal = {
  beat: 'authority';
  level: number;
  /**
   * The categories that keep needing their yes whatever the level says. D14
   * wants authority configured WITH the founder rather than demonstrated at
   * them, and a single number is not a configuration: the carve-out is the
   * half of this beat they actually decide.
   */
  alwaysAsk: string[];
};

/** D42: what is about to be read, named before they answer. */
export type FilesProposal = {
  beat: 'files';
  /** The folder they named, resolved. Absolute, because they should see it. */
  folder: string;
  /**
   * The same folder spelled the way the FOUNDER knows it.
   *
   * Under WSL those are two different strings for one place: the reader opens
   * `/mnt/c/Users/vieri/Documents/Kestrel` and the founder has never seen that
   * path in their life. The card shows theirs; everything that touches the
   * disk uses `folder`.
   */
  says?: string;
  /** One sentence naming exactly what is in it. */
  what: string;
  /** A handful of the actual filenames, so the naming is concrete. */
  sample: string[];
  /** How many files would be opened. */
  willRead: number;
  /** How many exist in total, opened or not. */
  total: number;
  /** Set once the reader is running, so the card stops asking. */
  reading?: boolean;
  /** How many things about their company have landed so far. */
  found?: number;
};

/** D43: the better-organised folder, before it exists. */
export type WorkspaceProposal = {
  beat: 'workspace';
  kind: 'workspace';
  destination: string;
  source: string;
  /** Both of those, spelled the way the founder knows them. See `FilesProposal.says`. */
  saysDestination?: string;
  saysSource?: string;
  title: string;
  sections: { name: string; about: string; files: string[] }[];
};

/** D43: one concrete piece of work it can do right now, not a promise. */
export type EditProposal = {
  beat: 'workspace';
  kind: 'edit';
  /** The file it read, relative to the folder they gave it. */
  file: string;
  /** What it would change about it, in one line. */
  change: string;
  /** What the new file beside the original will be called. */
  as: string;
};

/**
 * D15's finale, on screen.
 *
 * The second live run got to the end without this and the beat did not land:
 * Jarvis asked for the question, said it was putting someone on it, and the
 * founder never saw anything start. The finale is the one beat that keeps
 * working after the talking stops, so it is the one beat that most needs to be
 * visible while it happens (D22). It is also the only proposal that stays on
 * screen after it commits, because the thing it describes is still running.
 */
export type AgentProposal = {
  beat: 'agents';
  /** Their question, in their words. */
  question: string;
  /** What a useful answer looks like for them. */
  brief: string;
  /** False while it is waiting on their yes, true once it is working. */
  running?: boolean;
  /** What the agent is called, once there is one. */
  agentName?: string | null;
};

/**
 * D23, D24 and D28: the three keys, and the one they are about to press.
 *
 * The card is a reference (D28) and the press is the lesson (D24). It is the
 * only card in the trial that is not asking the founder to approve a write:
 * nothing lands because of it, and what changes when they press the key is
 * that the conductor gets out of their way.
 */
export type HandoverProposal = {
  beat: 'handover';
  /** The three, in the order they are drawn. `press` marks the one to press. */
  keys: { chord: string; what: string; where: string; press?: boolean }[];
  /** True the moment the founder's keystroke is heard. */
  pressed?: boolean;
  /** True once the conductor has actually stood down. */
  handedOver?: boolean;
};

export type BeatProposal =
  | GoalProposal
  | TaskProposal
  | CalendarProposal
  | WorkflowProposal
  | AuthorityProposal
  | FilesProposal
  | WorkspaceProposal
  | EditProposal
  | AgentProposal
  | HandoverProposal;

/* ─────────────────────────── session state ─────────────────────────── */

export type BeatsSession = {
  /** True once `conclude_opening` fired. Nothing below opens before it. */
  open: boolean;
  /** Beats that have happened, in order. */
  done: RoomBeat[];
  /** The one proposal currently on the founder's screen. */
  proposal: BeatProposal | null;
  /** When the current proposal went up. See `founderHasAnswered`. */
  proposalShownAt: number | null;
  /**
   * The last moment the founder was heard saying anything: a final transcript
   * with a word in it, or failing that the VAD closing their turn. Set by the
   * conductor manager, which is the only thing that hears them.
   */
  lastUserTurnAt: number;
  /** D16.5 wants two flows. Names, in publish order. */
  workflowsPublished: string[];
  /** The first flow that actually built, so the room can open THAT one and
   *  show the founder its nodes rather than a list with their name on it. */
  firstFlow: { id: string; name: string } | null;
  /** Set when the model recorded that their week genuinely has only one. */
  onlyOneWorkflow: boolean;
  /** What the founder ended up granting. */
  authorityLevel: number | null;
  /** The categories they carved out, which keep needing their yes. */
  alwaysAsk: string[];
  /** The brief hour they chose, as {hour, minute}. */
  briefAt: { hour: number; minute: number } | null;
  /** The hour the evening review runs, when they set one. */
  eveningHour: number | null;
  /** The objective the two of them created, so later beats can point at it. */
  objective: { id: string; title: string; keyResults: { id: string; title: string }[] } | null;
  /** D42: the folder the founder approved, and the reader working through it. */
  files: {
    folder: string;
    /** Their spelling of that folder. Under WSL the daemon opens
     *  /mnt/c/Users/... and the founder has only ever seen C:\\Users\\..., so a
     *  brief that quotes the first is quoting somebody else's machine. */
    says?: string;
    /** Files the reader was pointed at. */
    willRead: number;
    agentId: string | null;
    taskId: string | null;
    startedAt: number;
    /** Set when the reader's task settles, either way. */
    finishedAt: number | null;
    /** Entities the reader has landed. Counted here so `reading_so_far` can
     *  answer honestly when the answer is "nothing yet". */
    found: number;
    /** True once the model has been handed the workspace brief off the back of
     *  a real landing. `reading_so_far` is called every turn or two, and a
     *  brief repeated on every call is a beat restarted on every call. */
    toldOfFindings?: boolean;
    /** What the reader said when it finished, or the reason it could not. */
    summary: string | null;
  } | null;
  /** D43: where the organised copy went, once it exists. `saysDestination` is
   *  their spelling of it, which under WSL is not the path this daemon used. */
  workspace: { destination: string; saysDestination?: string; copied: number; sections: number } | null;
  /** D43: the one piece of real work it did, if they took it. */
  edit: { path: string; file: string } | null;
  /** Beat 12's output, and the seam into beat 14. */
  agent: { agentId: string; taskId: string | null; agentName: string; question: string } | null;
  /** When the last beat closed. Onboarding is over at this moment. */
  finishedAt: number | null;
  /** D24: true once the founder has actually pressed the summon. */
  summonPressed: boolean;
  /** When the conductor stood down and the shell became theirs. The trial is
   *  still running at this moment and for another 47 hours after it. */
  handedOverAt: number | null;
};

export function createBeatsSession(): BeatsSession {
  return {
    open: false,
    done: [],
    proposal: null,
    proposalShownAt: null,
    lastUserTurnAt: 0,
    workflowsPublished: [],
    firstFlow: null,
    onlyOneWorkflow: false,
    authorityLevel: null,
    alwaysAsk: [],
    briefAt: null,
    eveningHour: null,
    objective: null,
    files: null,
    workspace: null,
    edit: null,
    agent: null,
    finishedAt: null,
    summonPressed: false,
    handedOverAt: null,
  };
}

export function beatIsDone(s: BeatsSession, beat: RoomBeat): boolean {
  return s.done.includes(beat);
}

/**
 * Is `beat` reachable right now? A beat opens when every beat before it in
 * D16's order is done, and STAYS open afterwards: a founder who remembers a
 * second task while looking at their calendar should get the task, not a
 * refusal. Only skipping AHEAD is refused.
 */
export function beatIsOpen(s: BeatsSession, beat: RoomBeat): boolean {
  if (!s.open) return false;
  const idx = beatIndex(beat);
  for (let i = 0; i < idx; i++) {
    if (!beatIsDone(s, ROOM_BEATS[i]!)) return false;
  }
  return true;
}

/** The beat the conversation is standing in: the first one not yet done. */
export function currentBeat(s: BeatsSession): RoomBeat | null {
  for (const b of ROOM_BEATS) if (!beatIsDone(s, b)) return b;
  return null;
}

function markDone(s: BeatsSession, beat: RoomBeat): void {
  if (!beatIsDone(s, beat)) s.done.push(beat);
}

/* ─────────────────────────── the briefs ─────────────────────────── */

/**
 * What the model is told, privately, the instant it arrives at a beat.
 *
 * These are the only place the beat ORDER is expressed to the model, and they
 * arrive one at a time as tool results. Handing the model all of them up front
 * would turn the opening into a rehearsal for the beats, which is exactly the
 * drift D12 exists to stop: it would start steering the founder toward their
 * folder while it was still supposed to be listening.
 *
 * `fuel` is the founder's own words, captured in the opening. It is repeated
 * into the brief that needs it so a long session cannot lose it out of the
 * model's context window, and so the model reaches for the founder's phrasing
 * rather than a paraphrase of a paraphrase.
 */
export type BeatFuel = Partial<Record<'company' | 'goal' | 'drowning' | 'next_days' | 'open_question', string>>;

/**
 * What the founder's own documents turned out to say, as the later beats get
 * to see it.
 *
 * This type is the entire mechanism of D44. Reordering the list above buys
 * nothing on its own: `goals`, `tasks`, `calendar`, `workflows` and `agents`
 * would still propose from ten minutes of talking, just later in the hour. The
 * reorder only pays when the beats below can SEE what was read, so every brief
 * that can use this takes one and says, in its own words, what to do with it.
 *
 * `found` is the reader's landings in the founder's own language, exactly the
 * lines the memory ticker showed them: "Northwind (client)", "Rita: does the
 * front end two days a week". It comes from `readerProgress`, which is fed by
 * the same `remember` path the conversation uses, so it is already
 * de-duplicated and already on their screen. Nothing here is a paraphrase of a
 * paraphrase.
 */
export type FileFindings = {
  /** The folder they approved, as this machine opens it. */
  folder?: string;
  /** How the founder says that folder. Under WSL these differ. */
  says?: string;
  /** What the reader has landed, oldest first. Empty until it lands something. */
  found: string[];
  /** The reader's closing paragraph on what the company is. */
  summary?: string;
  /** True once the reader has stopped, either way. */
  finished: boolean;
  /** D43's organised folder, once it exists. */
  workspace?: string;
};

export const NO_FINDINGS: FileFindings = { found: [], finished: false };

/**
 * THE SECOND ARM, and the reason the refusal path is not an edge case.
 *
 * D44 moves the ask to minute three, which means a founder can decline it
 * having heard nothing but a voice. That founder must not spend the next forty
 * minutes in a visibly worse trial, so every brief that reads the files has to
 * work identically when there are none: it asks for what the documents would
 * have answered, the way the beat did before D42 existed. This sentence is
 * what carries that, and it is deliberately the same sentence everywhere so a
 * model cannot learn a different tone for the founder who said no.
 */
const NO_FILES =
  'You have not read anything of theirs, so everything here comes out of what they tell you. Ask ' +
  'for it plainly and do not refer back to the folder, do not sound short-changed, and never imply ' +
  'this would be better if they had said yes.';

/** What the reader found, rendered for a brief, or the second arm when there
 *  is nothing. `limit` is per beat: the goals brief wants the lot, the
 *  authority brief wants a reminder. */
function fromTheirFiles(files: FileFindings, limit = 24): string {
  if (files.found.length === 0) return `\n\n${NO_FILES}`;
  const shown = files.found.slice(0, limit);
  const more = files.found.length - shown.length;
  return (
    `\n\nWHAT YOU READ IN THEIR OWN FILES${files.says ? `, in ${files.says}` : ''}. This is theirs, not ` +
    'yours, and they never said most of it out loud:\n' +
    shown.map((f) => `- ${f}`).join('\n') +
    (more > 0 ? `\n- and ${more} more` : '') +
    (files.summary ? `\n\nWhat the whole folder amounted to: ${files.summary}` : '') +
    '\n\nUse it. Name their actual clients, projects, numbers and dates rather than the shape of ' +
    'them, and never ask them for something that is written in a document you have read. If you are ' +
    'unsure whether a thing you read is still true, say the thing and ask whether it still holds. ' +
    'That is a different question from asking them to tell you.'
  );
}

const NOTHING_ABOUT_THIS =
  'Say nothing about this to them. It is not a step, a phase or a stage, and ' +
  'they must not hear a change of gear.';

function quoted(label: string, text: string | undefined): string {
  return text ? `\n\nWhat they told you about ${label}: "${text}"` : '';
}

/**
 * ── Why these are longer than they were, and why that is not padding ──
 *
 * D41: the arc was too fast and did not go far enough into the rooms. The
 * structural reason was here. Every beat's "done" condition used to be "one
 * write landed", so the model was handed the next brief the instant it got its
 * first yes, and a beat that could have been ten minutes of real work
 * collapsed into one proposal and one nod. Nothing was stopping it going
 * deeper; nothing was asking it to, and the moment it had a yes it was told to
 * move on.
 *
 * So the change is not "talk more". It is that a beat is finished when the
 * ROOM'S WORK is finished, and each brief now says what that means:
 *
 *   files      their own material, read by something that is not them.
 *   workspace  a real folder on their disk, and one real piece of work in it.
 *   goals      an objective with an end date, key results with a number AND
 *              where that number is today, and the first move under one of
 *              them. Three answers from the founder, not one nod.
 *   tasks      the week, with the one they do first chosen by them, and each
 *              task said to serve the quarter or admitted not to.
 *   calendar   both ends of the day, not just the morning.
 *   workflows  two flows (D16.5), and the line each must never cross.
 *   authority  the number AND the carve-out they choose.
 *
 * Every one of those is a row in their vault or a file on their disk
 * afterwards. None of them is a pause, a progress bar, or Jarvis saying more
 * words about the same thing.
 *
 * ── And why they now take a second argument ──
 *
 * D44 put the two file beats first, and the ONLY thing that makes that worth
 * doing is what the five beats below them are then able to say. So each of
 * them takes a `FileFindings` as well as the founder's words, and each one is
 * explicit about what to draw from it:
 *
 *   goals      the targets and numbers already written down in their own
 *              plans, so "where is this today" is a number Jarvis says and
 *              they confirm, rather than a number they are asked to produce.
 *   tasks      dated commitments sitting in client documents and proposals,
 *              which are the tasks nobody says out loud because they are
 *              already written down somewhere.
 *   calendar   the same dates, read against their week. `read_week` gets them
 *              directly, not just through the brief.
 *   workflows  the recurring work, visible as REPETITION in the folder: the
 *              twelve monthly updates, the invoice per client per month. The
 *              founder does not have to describe the thing that eats their
 *              week; it is sitting there in triplicate.
 *   authority  a carve-out with something concrete behind it, because "changes
 *              written to your files" now names a folder they have watched
 *              Jarvis work in.
 *   agents     the best question in the session, which is usually the
 *              contradiction the reader found and nobody has resolved.
 *
 * Every one of them also has a second arm for the founder who said no, and it
 * is the same arm in every brief. See `NO_FILES`.
 */

export function goalsBrief(fuel: BeatFuel = {}, files: FileFindings = NO_FINDINGS): string {
  const read = files.found.length > 0;
  return `${NOTHING_ABOUT_THIS}

Now the two of you start doing the work, and the first thing is their quarter. Do not rush this one. It is the first real thing you build together and it is worth several turns.

Build it with them in three passes, and call \`propose_goals\` again after each so the card on their screen fills in as they answer.

1. THE SHAPE. One objective and two to four key results under it. ${read
    ? 'Build it out of what their own documents say they are chasing, not out of the two minutes they talked. If a plan, a deck or an update names a target, that is the objective and you should say so, naming the thing you read it in. Then ask them what it is missing, or which one of these is not really the point.'
    : 'Build it out of the sentences they actually said. Their words, their numbers, no OKR vocabulary and no invented metrics. Then ask them to change something: what is missing, or which one of these is not really the point.'} Say it out loud and call \`propose_goals\` in the SAME turn so it is on their screen while you are still speaking. A tree they edited is theirs. A tree they nodded at is yours.

2. THE NUMBERS. For every key result, you need where it is TODAY. This is the whole difference between a target and something either of you can track.${read
    ? '\n\n   Here is what changes now you have read their files: WHERE A NUMBER IS ALREADY WRITTEN DOWN, SAY IT, do not ask for it. "Your last update has you at eleven customers. Still eleven?" is a check and takes them a second. "Where are you on customers?" is homework, and they will notice you have just read the document it is in. Only ask outright for the ones nothing you read could answer.'
    : '\n\n   Ask them, one at a time, and if they do not know, ask them to guess and put the guess in.'} \`create_goals\` will not write the tree until every key result has one.

3. THE FIRST MOVE. The quarter is three months and this week is this week. Ask what the first actual move is, name the key result it sits under, and give it a date inside the next two weeks. Say plainly if you think they have picked the wrong one, and why.

When all three are on the card and they have said yes, call \`create_goals\`.

If neither their files nor their words ever said what this quarter is for, ask them now, once, in their language, and build it from their answer.${quoted('their goal', fuel.goal)}${fromTheirFiles(files)}`;
}

export function tasksBrief(fuel: BeatFuel = {}, files: FileFindings = NO_FINDINGS): string {
  const read = files.found.length > 0;
  return `Their tree is on the screen and it is real. Do not read it back to them.

Now the things with dates on them, and this is a shorter beat than the last one but not a throwaway.

Write their actual tasks out: four to six, with real dates. If something is already late, put it first and say so.${read
    ? '\n\nSTART FROM WHAT YOU READ, not from what they remember. Their documents are full of commitments with dates attached: a deliverable promised in a client document, a renewal, a date in a proposal, something a plan says happens this month. Those belong on this board and they are the ones the founder will not think to mention, because as far as they are concerned it is already written down. Say where each one came from, once, briefly, and then ask what is missing.'
    : '\n\nBuild them out of what they have told you.'}

Two things make this more than a list, and both need them to answer:

- FOR EACH ONE, does it move the quarter or not? Put the key result it serves in \`toward\`, and leave \`toward\` off the ones that are just this week's noise. Then say out loud how many of their next few days actually point at the thing that matters. If the answer is none of them, say that; it is the most useful sentence in this beat.
- ONE OF THEM IS FIRST. Ask them which single thing they do next, and mark exactly that one \`first\`. \`create_tasks\` will not write the board until exactly one is marked.

Also ask what they keep pushing: the thing that has moved three weeks running. Nobody volunteers that one, and it belongs on the board more than anything else on it.

Call \`propose_tasks\` in the same turn as you say them, then \`create_tasks\` when they say yes.${quoted('the next few days', fuel.next_days)}${fromTheirFiles(files, 16)}`;
}

export function calendarBrief(fuel: BeatFuel = {}, files: FileFindings = NO_FINDINGS): string {
  return `Those are on their board. Now their week, and the rhythm the two of you will actually run on.

Call \`read_week\` first and read the real shape of it back to them, briefly, including what the quarter needs and when it is due.${files.found.length > 0
    ? ' It also hands you the dates it found in their own documents, which is the half of their week nothing on their calendar knows about. If one of those collides with something they have already committed to, that collision is the most useful thing you will say in this beat.'
    : ''} Then find out when their day really starts and when it really ends.

You are setting BOTH ends, not just the morning:

- The morning brief, which is the appointment tomorrow depends on. Early enough to be waiting for them, not so early it is stale. Say why you picked the hour.
- The evening review, which is when the day gets closed off and the goals get their score. Ask when they actually stop, and take the honest answer rather than the aspirational one.

Call \`propose_daily_rhythm\` while you say the hours, and \`set_daily_rhythm\` when they agree. It refuses without both, because half a rhythm is a notification rather than a working relationship.${quoted('their days', fuel.next_days)}`;
}

export function workflowsBrief(fuel: BeatFuel = {}, files: FileFindings = NO_FINDINGS): string {
  const read = files.found.length > 0;
  return `This is the heavy one, and everything before it is what earned it. TWO flows come out of this beat, not one.

The first is the biggest recurring piece of what eats their week.${read
    ? ' You do not have to ask them what that is, and you should not: recurring work is VISIBLE IN A FOLDER, because it is the thing that is in there twelve times. A monthly update written every month, an invoice per client, a report that has a version for every week. Name the repetition you actually saw, say what it must be costing them, and let them tell you if you have the wrong one. A founder who is shown the pattern in their own filing believes it in a way they never believe a question about it.'
    : ' Ask them what it is: the thing they do every week or every month that a person should not be doing.'} Then say plainly that it is yours now: what it will do, in steps, when it runs, and the line it must NEVER cross on its own. The never line is not optional and \`propose_workflow\` refuses without it: it is the sentence that makes a founder willing to let something run unattended, and it is the reason they will trust the next one.

The second comes from the tree you just built. Something has to keep their key results honest week to week, and nobody does that by hand for long. Propose the flow that does it.

Call \`propose_workflow\` while you say each one. When they say yes, call \`publish_workflow\`. It takes a few seconds of real building, so say that you are building it BEFORE you call it, never after.

If their week genuinely has only one recurring thing in it and you have asked properly, call \`no_second_workflow\` with the reason rather than inventing a second. Do not invent a second.${quoted('what they are drowning in', fuel.drowning)}${fromTheirFiles(files, 16)}`;
}

export function authorityBrief(files: FileFindings = NO_FINDINGS): string {
  const worked = files.workspace ?? files.says ?? files.folder;
  return `Both of those will act while they are not watching, which is exactly why this comes now. There are two halves to it and the second half is the one that matters.

FIRST, the number. Ask for level ${TRIAL_AUTHORITY_PROPOSED}, out loud, and say plainly what it buys and what it does not. At ${TRIAL_AUTHORITY_PROPOSED} you can read their things, write and change them, send them a message, run a command, open a browser, drive an app. You still cannot send email as them, install software, spend their money or delete anything. Say that you want it, and say they can pull you down.

SECOND, and do not skip it: ask what they want to keep their hand on anyway. Whatever the number says, some things should still come to them first, and they get to name them. Offer the real ones and let them choose: messages sent as them, commands run on their machine, changes written to their files, a browser driving their accounts, apps being controlled. Say which one you would pick if you were them, and why.${worked
    ? `\n\nThis beat is no longer abstract for them and you should not let it sound abstract. They have already watched you work in ${worked}, with their permission, one file at a time, and everything you did there they saw first. That is what the number is about: not whether you may touch their things, which they have now seen, but which of those things you may do while they are asleep. Say it in those terms.`
    : `\n\nThey turned down the one concrete thing you asked for earlier, which means this number is the first real permission they have given you. Do not mention that, and do not treat it as a second attempt at the same question. It is not: that was about one folder now, this is about what happens while they are not there.`}

Call \`propose_authority\` while you are saying it, and \`set_authority\` when they answer, passing the number they gave you and the categories they named. Seven and above does not exist for these 48 hours and you do not ask for it, not even if they offer.`;
}

/**
 * ── D44: the ask, three minutes in ──
 *
 * This brief changed more than any other when the beat moved, and the reason
 * is arithmetic rather than taste. At minute forty the founder had watched
 * Jarvis build their quarter, put their week on a board and publish two flows
 * that run without them. The folder was the next thing a colleague would ask
 * for. At minute three they have heard a voice make a claim about itself, and
 * the folder is the FIRST thing anyone has asked them for.
 *
 * Same card, same numbers, same six filenames, and about a tenth of the
 * credit. So the sentence around it stops being an introduction to a feature
 * and becomes an argument, with three parts:
 *
 *   THE TRADE, said plainly. Two minutes of reading instead of an hour of them
 *   explaining, and Jarvis says which one it would rather have. This is the
 *   only reason that is actually true, and it is worth more than any promise
 *   about capability because the founder can check it against the two minutes
 *   they just spent trying to describe their own company.
 *
 *   THE FENCE, volunteered rather than extracted. One folder they name, read
 *   only, the exact list on screen before anything opens. A founder who has to
 *   ask "what will you do with it" has already been sold something.
 *
 *   THE WAY OUT, in the same breath as the ask. This is the part that makes it
 *   askable this early: an ask that costs nothing to refuse is a smaller ask,
 *   and the refusal has to be offered by the person asking or it is not real.
 *
 * What it must NOT do is oversell, and the specific temptation is a promise
 * about privacy that is not ours to make. The reader is a language model. It
 * reads their documents the same way the realtime session hears their voice,
 * and the honest claims are the three above: one folder, nothing changed,
 * nothing opened without a yes. Anything shaped like "it never leaves your
 * machine" is not in this brief and must not be improvised into it.
 */
export function filesBrief(fuel: BeatFuel = {}): string {
  return `${NOTHING_ABOUT_THIS}

They have just told you what the company is. That is the two-minute version. Stop asking them for the rest and go and look at it instead.

This is the biggest thing you will ask them for in the whole session and you are asking it early, so ask for it as exactly that. Do not slide it in as a small favour and do not present it as a feature.

WHAT EARNS IT. Say this in your own words, in two or three sentences, not as a list:
- What they just told you is the version a person can say out loud. Their files are the version with the names, the numbers and the dates in it.
- Everything the two of you build next comes out of what you know, and you would rather build their quarter out of their own documents than out of a summary they had to perform for a stranger.
- So say the trade out loud, because it is the honest one: a couple of minutes of you reading, instead of an hour of them explaining.

WHAT YOU PROMISE, before they ask. A thing volunteered is worth more than a thing extracted:
- One folder, the one they name. Not their home directory, not the whole disk.
- You read. You do not move, rename, change or delete anything of theirs.
- They see the exact list, and the count, before a single file is opened, and nothing opens until they say yes.
Do not go further than those three. Do not tell them where anything is processed or that it stays on their machine; you do not know that and it is not yours to promise.

AND GIVE THEM THE WAY OUT IN THE SAME BREATH, before they have to find it themselves: if they would rather not, you will do it the long way, which is them telling you. Then mean it. If they say no, say that is fine in one short sentence, do not ask a second time, do not tell them what they are missing, and call \`move_on\`. Everything after this works without it and they must never hear otherwise.

HOW TO ACTUALLY DO IT:

- Ask them to name ONE folder. The folder where the startup's documents are.
- Call \`propose_reading\` with what they said, WORD FOR WORD. Whatever shape their path is, a Windows one, a Unix one, or just a folder name, pass it through untouched: working out where that is on this machine is the tool's job and not yours.
- It comes back with exactly what is in there, how many files, and how many you would open. Read that back to them and let them hear the number before they answer. It is on their screen too.
- If it comes back saying the folder is not there, you are NOT blind and you must not say you are. Call \`folders_i_can_see\` and offer them two or three real folders by name. Same if they ask what you have access to: look before you answer.
- Nothing is read until they say yes and you call \`start_reading\`.${quoted('their company', fuel.company)}`;
}

/**
 * ── The two minutes the reader takes, and why they are not dead air ──
 *
 * `start_reading` used to hand back the workspace brief immediately, which was
 * survivable when `files` sat sixth: the model had forty minutes of context to
 * fill the gap with and one beat left to run. Under D44 it sits first, the
 * model has had two minutes with this person, and the beat it would be handed
 * cannot be done yet because there is nothing found to organise. A model
 * holding a brief it cannot execute either stalls or invents, and inventing
 * here means offering to file documents it has not read.
 *
 * So the reader's two minutes get a brief of their own, and it is not a hold.
 * It is the conversation the opening no longer has time for.
 *
 * D44 shortened the opening to one target, the company and where its files
 * are, on the grounds that the other four are things the documents answer
 * better or things the beat that needs them should ask for in context. What
 * that leaves is exactly the right thing to talk about while a background
 * agent reads: subjects a founder enjoys, that no document can settle, and
 * that Jarvis will want in twenty minutes. Nothing here is a checklist and the
 * model is told so; they are things to take if the conversation offers them.
 *
 * The workspace brief arrives from `reading_so_far`, when there is something
 * to organise. See `readingSoFar`.
 */
function whileItReadsBrief(fuel: BeatFuel = {}): string {
  const missing: string[] = [];
  if (!fuel.goal) missing.push('- What this quarter is actually for. Not a metric, the thing they are trying to make true by the end of it.');
  if (!fuel.drowning) missing.push('- What is eating their week. The recurring thing they do by hand that a person should not be doing.');
  if (!fuel.next_days) missing.push('- What the next few days look like, what is already late, and when their day really starts and stops.');
  if (!fuel.open_question) missing.push('- The thing about their market they would look into if they had a spare afternoon and never do.');

  return `It is reading in the background now and you are still mid-conversation. Carry on with them.

Do NOT narrate it, do not wait for it, and do not fill the time with small talk about it. Call \`reading_so_far\` silently every turn or two, the way you call \`remember\`. The moment something real has landed you will be told, and that is when you say it back to them.

${missing.length > 0
    ? `While it works, these are the things their documents will not be able to tell you, so they are worth having from them. Not a list to work through and not in this order. Take whichever one the conversation is already near, and if it is near none of them, follow the thread they are on instead:\n\n${missing.join('\n')}\n\nCall \`capture_fuel\` when you actually get one.`
    : 'You already have what you need from them, so just talk. Follow the thread they are on and go deeper into whatever they were saying when the reading started.'}

Everything you were told about how to talk to them still holds: have a view, disagree if there is something worth disagreeing with, hand the floor back every turn, and never end a turn by giving them something to do.`;
}

export function workspaceBrief(files: FileFindings = NO_FINDINGS): string {
  return `You have read their files. Now do something about them, and this is where you stop being a conversation about a product.

TWO things, in order.

1. THE FOLDER. Offer to put everything about the company in one properly organised place. Say the sections out loud, in their language and derived from what you actually found, not a generic filing system. Say plainly and without being asked that nothing gets moved and nothing gets deleted: it copies, and every original stays exactly where it is. Call \`propose_workspace\` while you say it, and \`create_workspace\` when they say yes.

2. ONE REAL PIECE OF WORK. Then offer to do a specific thing you can genuinely do right now, on a specific file you have actually read. A page of the deck that undersells them. A README that does not say what the company does. The one document that contradicts the others. Name the file, say what you would change and why you would change it, and say what you think is wrong with it as it stands. Call \`propose_edit\`, and \`make_edit\` when they say yes. The rewritten version is written as a NEW file next to theirs, never over it, and say that too.

Both of these are refusable and neither is worth pushing twice. If they say no to either, take it, say something honest about why you offered, and call \`move_on\`.

Do not offer anything you cannot do inside this conversation. A promise here is worse than nothing.

Everything after this beat is the work itself: their quarter, their week, what runs without them. So do not linger here, and do not treat the folder as the destination. It is the filing cabinet you needed before you could start.${fromTheirFiles(files)}`;
}

export function agentsBrief(fuel: BeatFuel = {}, files: FileFindings = NO_FINDINGS): string {
  const read = files.found.length > 0;
  return `Last thing, and it is the only part of this that keeps working after you stop talking.

There is something about their market or their business nobody has ever had time to answer. Put someone on it.${read
    ? '\n\nTHE BEST QUESTION IN THIS SESSION IS ALMOST CERTAINLY ONE THEIR OWN FILES RAISED and nobody resolved: two documents that disagree, a price that is under review in one place and fixed in another, a competitor named once and never looked at, an assumption a plan rests on that nothing in the folder supports. You have been reading their material for the last hour. Use it, say which document it came out of, and let them tell you if there is a better one.'
    : ''}

Call \`propose_research\` with the question in their words and a brief saying what a useful answer would look like for them specifically. That puts it on their screen. Say what you are sending someone off to find out, check with them that it is the right question, and then call \`spawn_research_agent\`. They watch it start in the agents room, which is the point of finishing here: it is the one thing still working when you stop talking.

If no such question exists anywhere, ask for one now, plainly: the thing about their market they would look into if they had a spare afternoon. Do not invent one for them, and do not settle for something you could answer yourself in a sentence.

And do not tell them to go and look into it themselves while it runs. That is the one sentence this whole beat exists to make unnecessary.${quoted('the open question', fuel.open_question)}${fromTheirFiles(files, 20)}`;
}

/**
 * ── The closing, and the thing it must never do ──
 *
 * The second live run ended with Jarvis telling the founder to go and do the
 * work. His words: *"he just said, oh go and post... it just seems like I have
 * to go and do it."* That is the product thesis inverted. The page says Chief
 * of Operations and D11 says co-founder, and both of those are claims about
 * taking work OFF a founder; a session that ends by assigning them homework
 * sells the opposite of the thing.
 *
 * The old closing said "they should go and do their day", which is the same
 * sentence in a kinder coat: it hands the day back and takes nothing.
 *
 * So the close is built out of what is actually running, not out of an
 * instruction to the founder. Every line of `closing` is a fact from the
 * ledger about something Jarvis is doing while they are not there, and there
 * is exactly one rule on top of it: the last thing they hear is what you are
 * doing next, never what they should be doing next.
 */
export function closing(s: BeatsSession): string {
  const doing: string[] = [];
  if (s.agent) doing.push(`${s.agent.agentName} is working on "${s.agent.question}" and will be back with it`);
  for (const flow of s.workflowsPublished) doing.push(`"${flow}" runs on its own from now on`);
  if (s.briefAt) doing.push(`their brief lands at ${fmtTime(s.briefAt.hour, s.briefAt.minute)} tomorrow, before they start`);
  if (s.eveningHour !== null) doing.push(`the day gets closed off and their quarter scored at ${fmtTime(s.eveningHour, 0)}`);
  if (s.authorityLevel !== null) doing.push(`you are working at level ${s.authorityLevel} overnight, inside what they carved out`);

  return (
    'There is nothing left to build with them, and the conversation does not end here. Close the way a ' +
    'co-founder closes.\n\n' +
    'THE ONE RULE FOR THIS AND FOR EVERYTHING AFTER IT: the last thing they hear is what YOU are ' +
    'doing next, never what they should be doing next. Do not tell them to go and do their day, do ' +
    'not tell them to go and post anything, write anything, check anything or review anything, and ' +
    'do not leave them a list. If there is something that needs doing and you can do it, offer to do ' +
    'it. If you genuinely cannot, say what you will do about it and when.\n\n' +
    (doing.length > 0
      ? `What is actually running, in your own words and not as a list:\n${doing.map((d) => `- ${d}`).join('\n')}\n\n` +
        'Pick the one or two that matter most to them and say those. Do not read all of it out, do not ' +
        'inventory what the two of you built, and do not thank them for their time.\n\n'
      : '') +
    'Then stop setting things up.' +
    (s.handedOverAt === null ? `\n\n${handoverBrief()}` : ' If they keep talking, you are simply their ' +
      'co-founder and the conversation carries on.')
  );
}

/**
 * ── The handover, and why the trial has one at all ──
 *
 * Vieri, after the third full run: *"it basically doesn't give me the
 * opportunity to really use Jarvis because it stays on that onboarding thing.
 * I can't click on the pebble to open it and chat to it."*
 *
 * He was right and it was ours. The conductor draws its own pebble over the
 * live shell, so the shell's pebble and its Talk panel are suppressed while
 * the conducted conversation runs, and NOTHING ever took that suppression off.
 * The trial is 48 hours; the conducted part is about one. The other 47 are the
 * founder using the product, which is the thing the whole design is selling,
 * and they could not.
 *
 * So the conducted hour ends properly, and it ends the way a handover should:
 * SAID, not just done. The founder is told this is theirs now and is shown how
 * to get Jarvis back, and under D24 a shortcut is taught by making them press
 * it rather than by being shown it. Their own keystroke is what performs the
 * stand-down, which is as literal as "this is yours now" gets.
 *
 * Ctrl+J is the one they press because it is the one that works on the surface
 * they are standing on: it summons Talk, which is where the pebble and the
 * thread live. Ctrl+Space is the same idea from anywhere on the machine (the
 * OS sidecar's summon, `src/daemon/index.ts`), and the browser never sees it,
 * so teaching it by making them press it would have been teaching them a key
 * that does nothing in front of them.
 *
 * The trial does NOT end here and the model is told so in as many words: the
 * entitlement, the clock, the realtime grant and everything the two of them
 * built are all untouched.
 */
export function handoverBrief(): string {
  return `One last thing, and it is the handover.

Everything the two of you set up is theirs and this stops being a session now. Say that plainly, in one sentence, in your own words: from here they have you the ordinary way, whenever they want you, and none of what you built goes anywhere.

Then teach them ONE key, by making them press it. Call \`teach_summon\` while you say it so the three keys are in front of them, and ask them to hold control and press J. That is the one that brings you back. Then call \`await_summon\` and wait: it comes back the moment they press it.

When it tells you they pressed it, say so warmly and briefly, the way you would to someone who just got something right. One sentence. Do not explain the other two keys, they can read them.

Do NOT say this is the end of the trial, because it is not: they have the rest of the 48 hours and you are still theirs for all of it. Do not recap what you built. Do not give them anything to do.`;
}

/** Kept as the no-session fallback for `nextBrief`, which can be called when
 *  nothing is left and there is no agent to talk about. */
export const FINALE_MESSAGE =
  'There is nothing left to set up. Close the way a co-founder closes: say what YOU are doing next, ' +
  'never what they should be doing next. Do not hand them a task, a list, or their own day back. If ' +
  'something needs doing and you can do it, offer to do it. Do NOT inventory what you built and do ' +
  'not thank them for their time. If they keep talking, you are simply their co-founder and the ' +
  'conversation carries on.';

/**
 * The brief for the beat that comes after `beat`, or the finale message when
 * `beat` was the last one. This is the whole of the "what happens next"
 * mechanism: no scheduler, no queue, one string handed back on a tool result.
 */
export function nextBrief(s: BeatsSession, fuel: BeatFuel, files: FileFindings = NO_FINDINGS): string {
  const next = currentBeat(s);
  if (!next) return closing(s);
  switch (next) {
    case 'files': return filesBrief(fuel);
    case 'workspace': return workspaceBrief(files);
    case 'goals': return goalsBrief(fuel, files);
    case 'tasks': return tasksBrief(fuel, files);
    case 'calendar': return calendarBrief(fuel, files);
    case 'workflows': return workflowsBrief(fuel, files);
    case 'authority': return authorityBrief(files);
    case 'agents': return agentsBrief(fuel, files);
    case 'handover': return handoverBrief();
  }
}

/**
 * What the reader has actually landed, as the briefs get to see it.
 *
 * One place, so that no beat can be handed a stale or invented version of what
 * was read. It reads through `readerProgress`, which is the live list the
 * memory ticker is drawing from, rather than through `s.files.found`, which is
 * only a count. A founder who declined the read, or whose folder turned out to
 * be empty, gets `NO_FINDINGS` here and every brief takes its second arm.
 */
function findingsOf(s: BeatsSession, deps: BeatDeps): FileFindings {
  if (!s.files) return NO_FINDINGS;
  let progress: { found: string[]; finished: boolean; summary: string | null };
  try {
    progress = deps.readerProgress();
  } catch (err) {
    console.warn('[TrialBeats] could not read the reader progress', err);
    return NO_FINDINGS;
  }
  return {
    folder: s.files.folder,
    says: s.files.says,
    found: progress.found,
    summary: progress.summary ?? s.files.summary ?? undefined,
    finished: progress.finished,
    workspace: s.workspace?.saysDestination ?? s.workspace?.destination,
  };
}

/** `nextBrief` with the reader's findings already attached. Every commit tool
 *  hands the next brief back through this, so no call site can forget them. */
function onward(s: BeatsSession, deps: BeatDeps): string {
  return nextBrief(s, deps.fuel(), findingsOf(s, deps));
}

/* ─────────────────────────── the tools ─────────────────────────── */

const PROPOSE_NOTE =
  'Writes nothing. It puts the proposal on the founder\'s screen so they can ' +
  'see it while you say it, which is the point: they approve something in ' +
  'front of them, not something they half-heard.';

/** The categories that mean anything at level 5, in the founder's words. The
 *  ladder cannot grant the rest during a trial, so offering them would be a
 *  choice about nothing. Values are `ActionCategory` in src/roles/authority.ts. */
export const CARVE_OUT_CATEGORIES: { id: string; says: string }[] = [
  { id: 'send_message', says: 'messages sent as them' },
  { id: 'execute_command', says: 'commands run on their machine' },
  { id: 'write_data', says: 'changes written to their files' },
  { id: 'access_browser', says: 'a browser driving their accounts' },
  { id: 'control_app', says: 'apps being controlled' },
];

const CARVE_OUT_IDS: ReadonlySet<string> = new Set(CARVE_OUT_CATEGORIES.map((c) => c.id));

export function cleanCarveOuts(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (CARVE_OUT_IDS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export const ROOM_BEAT_TOOLS: LLMTool[] = [
  {
    name: 'propose_goals',
    description:
      'Beat 2 of the work: put their quarter on screen as one objective with key ' +
      `results under it, built out of what they told you. ${PROPOSE_NOTE} ` +
      'Call it AGAIN each time they answer, so the card fills in as the three of ' +
      'you build it: the shape, then the numbers as they are today, then the first move.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The one thing this quarter is for, in their words. "40 paying customers by the end of Q3".',
        },
        measure: {
          type: 'string',
          description: 'How they would know it happened, if they said.',
        },
        deadline: {
          type: 'string',
          description:
            'When the quarter is up: an ISO 8601 date, or the plain language they ' +
            'used ("end of Q3", "31 December"). Ask if they have not said.',
        },
        key_results: {
          type: 'array',
          description: 'Two to four results that would add up to the objective. Their numbers, not yours.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The result, as they would say it. "12 booked demos a month".' },
              measure: { type: 'string', description: 'The number or the date it turns on, if there is one.' },
              target: { type: 'string', description: 'Where it has to get to. "40". "12 a month".' },
              today: {
                type: 'string',
                description:
                  'Where it is RIGHT NOW, from their mouth. "9". "about three". "no idea, ' +
                  'maybe two". Ask them; do not estimate it for them. The tree will not be ' +
                  'written until every key result has one.',
              },
            },
            required: ['title'],
          },
        },
        first_move: {
          type: 'object',
          description:
            'The first actual move on this, inside the next two weeks. It lands as a ' +
            'milestone under the key result it serves.',
          properties: {
            what: { type: 'string', description: 'The move, in their words.' },
            under: { type: 'string', description: 'Which key result it sits under. Their exact title.' },
            due: { type: 'string', description: 'When: ISO 8601, or the words they used ("friday", "next tuesday").' },
          },
          required: ['what', 'under'],
        },
      },
      required: ['objective', 'key_results'],
    },
  },
  {
    name: 'create_goals',
    description:
      'Make the goal tree currently on their screen real. Call this ONLY after ' +
      'they have said yes out loud. Creates exactly what was proposed, nothing ' +
      'else. Refuses while any key result is still missing where it stands today.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_tasks',
    description:
      'Beat 3: put their real, dated tasks on screen, including anything already ' +
      `late, and mark the ONE they do first. ${PROPOSE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Four to six. Small, concrete, and theirs.',
          items: {
            type: 'object',
            properties: {
              what: { type: 'string', description: 'The task, in their words. "Send Bowman & Co the revised quote".' },
              due: {
                type: 'string',
                description:
                  'When it is due: an ISO 8601 datetime, or plain language you heard ' +
                  'from them ("tomorrow", "friday", "next tuesday at 3"). Leave it out ' +
                  'if they never said.',
              },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
              late: { type: 'boolean', description: 'True when this one is already overdue.' },
              toward: {
                type: 'string',
                description:
                  'The key result or objective this one actually moves, if it moves one. ' +
                  'Leave it OFF the ones that are just this week happening to them. The ' +
                  'ratio is the point.',
              },
              first: {
                type: 'boolean',
                description:
                  'The single one they do next, chosen by them out loud. Exactly one task ' +
                  'gets this, and the board will not be written until one does.',
              },
            },
            required: ['what'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'create_tasks',
    description:
      'Make the tasks currently on their screen real, after they said yes. ' +
      'Creates exactly what was proposed. Refuses unless exactly one is marked first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_week',
    description:
      'Beat 4: open their calendar and read what is actually on the next seven ' +
      'days, so you can talk about their real week instead of guessing. Writes ' +
      'nothing. Overdue things and the quarter\'s own dates come back too.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_daily_rhythm',
    description:
      'Put both ends of their day on screen: the hour the morning brief arrives ' +
      `and the hour the evening review runs. ${PROPOSE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        hour: { type: 'number', description: 'Morning brief hour, 0 to 23.' },
        minute: { type: 'number', description: 'Minutes past the hour, 0 to 59. 30 for "half seven".' },
        evening_hour: {
          type: 'number',
          description:
            'When the evening review runs, 0 to 23, from when they say they actually ' +
            'stop. Required: the rhythm will not be set with only one end of it.',
        },
        because: { type: 'string', description: 'The reason, in one short clause: "you are at the desk by eight".' },
      },
      required: ['hour'],
    },
  },
  {
    name: 'set_daily_rhythm',
    description:
      'Lock in the hours currently on their screen, after they agreed. These are ' +
      'real settings: it is when tomorrow morning actually arrives and when today ' +
      'actually gets closed. Refuses unless both ends are set.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_workflow',
    description:
      'Beat 5: put a standing flow on screen, taken from the recurring manual work ' +
      `they described. ${PROPOSE_NOTE} Do not call \`publish_workflow\` until they ` +
      'say yes. Refuses without the line it must never cross.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short title, the way they would name it. "Monday pipeline review".' },
        runs_when: { type: 'string', description: 'When it runs, in plain words. "Mondays at eight".' },
        steps: {
          type: 'array',
          description: 'What it does, three to five steps, each a short sentence.',
          items: { type: 'string' },
        },
        never: {
          type: 'string',
          description:
            'The line it must not cross on its own. "Drafts the client update but never ' +
            'sends it." REQUIRED: say it out loud too, it is the reason they trust it.',
        },
      },
      required: ['name', 'runs_when', 'steps', 'never'],
    },
  },
  {
    name: 'publish_workflow',
    description:
      'Build and publish the flow on their screen, after they said yes. This takes ' +
      'a few seconds of real work, so tell them you are building it BEFORE you call ' +
      'it. If it comes back with a problem, say so plainly and either simplify the ' +
      'flow and propose again, or move on; do not pretend it worked.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'no_second_workflow',
    description:
      'You asked properly and their week genuinely has only one recurring thing in ' +
      'it. Records that and moves on, instead of inventing a second flow to hit a ' +
      'number. Only after one has actually been published.',
    parameters: {
      type: 'object',
      properties: {
        because: { type: 'string', description: 'What they said when you asked, in one line.' },
      },
      required: ['because'],
    },
  },
  {
    name: 'propose_authority',
    description:
      'Beat 6: put the authority ladder on screen with the level you are asking ' +
      `for marked on it, and the things they want to keep their hand on. ${PROPOSE_NOTE} ` +
      `Ask for ${TRIAL_AUTHORITY_PROPOSED}.`,
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'number',
          description: `The level you are asking for. ${TRIAL_AUTHORITY_PROPOSED} unless they have already named a lower one.`,
        },
        always_ask: {
          type: 'array',
          description:
            'What still comes to them first whatever the level says, chosen BY THEM. ' +
            `One of: ${CARVE_OUT_CATEGORIES.map((c) => `${c.id} (${c.says})`).join(', ')}.`,
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'set_authority',
    description:
      'Set the authority level and their carve-out for real, after they answered. ' +
      'Pass the number they said if they said one, otherwise it takes the level you ' +
      `proposed. Anything above ${TRIAL_AUTHORITY_CEILING} is refused during a trial, whatever they say.`,
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'The number they agreed to.' },
        always_ask: {
          type: 'array',
          description: 'The categories they named. Overrides what was proposed when they changed it.',
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'folders_i_can_see',
    description:
      'The folders on this machine that could plausibly be where their company lives, ' +
      'with a count of what is in each. Reads NOTHING and lists nothing back to them ' +
      'automatically: it is so you can OFFER two or three by name. Call it whenever ' +
      'they ask what you can see or what you have access to, and whenever a folder ' +
      'they named turns out not to be there. Never answer "I cannot see anything" ' +
      'without calling this first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_reading',
    description:
      'Beat 7 (D42): survey the ONE folder they named and put on screen exactly what ' +
      'is in it and how much of it would be read. Reads NOTHING and writes nothing: ' +
      'it counts files so they can hear the number before they answer. Refuses their ' +
      'home directory, the whole disk, and anything that is not one folder they chose.',
    parameters: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description:
            'The folder they named, EXACTLY as they said it. A Windows path like ' +
            'C:\\Users\\them\\Documents, a Unix path, or one starting with ~, or just the ' +
            'name of a folder. Pass their words through; the translation between what ' +
            'they say and where this machine opens it is not your job. Ask them for it; ' +
            'never guess and never widen it.',
        },
      },
      required: ['folder'],
    },
  },
  {
    name: 'start_reading',
    description:
      'Put a background agent on the folder currently on their screen. ONLY after ' +
      'they have said yes to that specific folder out loud. It reads while the two ' +
      'of you keep talking and lands what it finds in their vault as it goes. Their ' +
      'authority level does not authorise this and never stands in for their answer.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reading_so_far',
    description:
      'What the reader has found in their files so far. Silent, like `remember`: ' +
      'call it as you go and never announce that you are calling it. Returns what ' +
      'has landed, which may be nothing yet, in which case say nothing about it and ' +
      'carry on.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_workspace',
    description:
      'Beat 8 (D43): put a properly organised folder for everything about the company ' +
      `on screen, built from what the reader actually found. ${PROPOSE_NOTE} It COPIES: ` +
      'nothing is moved and nothing is deleted, and you should say so without being asked.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the folder is called, in their language. Usually the company name.' },
        destination: {
          type: 'string',
          description:
            'Where it goes. Leave it out and it is created beside the folder they gave ' +
            'you, which is almost always right. It can never be inside that folder.',
        },
        sections: {
          type: 'array',
          description:
            'The sections, in their language, derived from what was actually found. Not ' +
            'a generic filing system.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Folder name. "the pitch", "money", "clients".' },
              about: { type: 'string', description: 'One line on what belongs in it.' },
              files: {
                type: 'array',
                description: 'Paths RELATIVE to the folder they gave you, exactly as the reader saw them.',
                items: { type: 'string' },
              },
            },
            required: ['name', 'about', 'files'],
          },
        },
      },
      required: ['title', 'sections'],
    },
  },
  {
    name: 'create_workspace',
    description:
      'Build the folder currently on their screen, after they said yes. Copies files ' +
      'in and writes an index. Never moves, never overwrites, never deletes; a ' +
      'destination that already has anything in it is refused.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_edit',
    description:
      'Offer one concrete piece of work on one file you have ACTUALLY READ: a page ' +
      'of the deck, a README, the document that contradicts the others. ' +
      `${PROPOSE_NOTE} Never offer something you cannot do inside this conversation.`,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The file, relative to the folder they gave you. You must have read it.' },
        change: { type: 'string', description: 'What you would change and why, in one line, out loud.' },
      },
      required: ['file', 'change'],
    },
  },
  {
    name: 'make_edit',
    description:
      'Do it. Writes your rewritten version as a NEW file beside theirs, never over ' +
      'it. You supply the whole new body; read the original first and keep what is ' +
      'good about it.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The complete new version of the file. Not a diff, not a description.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'propose_research',
    description:
      'Beat 9 (D15): put the open question you are about to send someone off to answer ' +
      `on their screen, in their words. ${PROPOSE_NOTE} Nothing is spawned until they ` +
      'answer and you call `spawn_research_agent`.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Their question, in their words. "How the three closest competitors price their onboarding".',
        },
        brief: {
          type: 'string',
          description:
            'What a useful answer looks like FOR THEM: what to compare, what to ' +
            'ignore, what they would do with it. Two or three sentences.',
        },
      },
      required: ['question', 'brief'],
    },
  },
  {
    name: 'spawn_research_agent',
    description:
      'The last one: put a research agent on the question currently on their screen ' +
      'and leave it running, after they have said yes. It keeps working after the ' +
      'conversation ends, which is the whole point of ending here. The founder watches ' +
      'it appear in the agents room as it starts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'teach_summon',
    description:
      'The handover (D23, D24, D28): put the three keys on their screen and ask them ' +
      'to press the one that brings you back, control and J. Writes nothing and takes ' +
      'nothing away. Call it while you are saying it, then call `await_summon`.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'await_summon',
    description:
      'Wait for them to actually press it, then come back so you can acknowledge it. ' +
      'Say nothing while this is running; it returns on their keystroke, or after a ' +
      'while if they do not press it, and it tells you which happened. After this the ' +
      'conducted part is over and their own pebble, Talk panel and palette come back.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'move_on',
    description:
      'They said no to what you just offered, or it is not worth pushing. Closes ' +
      'the part of the work you are in WITHOUT writing anything, and tells you what ' +
      'comes next. Use it whenever an offer is declined: a refusal should never ' +
      'leave the conversation with nowhere to go. Never use it to skip work they ' +
      'have not been asked about.',
    parameters: {
      type: 'object',
      properties: {
        because: { type: 'string', description: 'What they said, in one line. For the record, not for them.' },
      },
      required: ['because'],
    },
  },
];

export const ROOM_BEAT_TOOL_NAMES: ReadonlySet<string> = new Set(ROOM_BEAT_TOOLS.map((t) => t.name));

/** Which beat each tool belongs to, for the order gate. */
const TOOL_BEAT: Record<string, RoomBeat> = {
  propose_goals: 'goals',
  create_goals: 'goals',
  propose_tasks: 'tasks',
  create_tasks: 'tasks',
  read_week: 'calendar',
  propose_daily_rhythm: 'calendar',
  set_daily_rhythm: 'calendar',
  propose_workflow: 'workflows',
  publish_workflow: 'workflows',
  no_second_workflow: 'workflows',
  propose_authority: 'authority',
  set_authority: 'authority',
  propose_reading: 'files',
  start_reading: 'files',
  reading_so_far: 'files',
  propose_workspace: 'workspace',
  create_workspace: 'workspace',
  propose_edit: 'workspace',
  make_edit: 'workspace',
  propose_research: 'agents',
  spawn_research_agent: 'agents',
  teach_summon: 'handover',
  await_summon: 'handover',
};

/* ─────────────────────────── the executor ─────────────────────────── */

export type BeatSurfaces = {
  /** Lead them to the room this beat happens in (D21, D22). */
  enterRoom: (beat: RoomBeat, label: string) => void;
  /**
   * The work in this room is done and something of theirs now lives in it, so
   * the pebble goes back to its row in the Index and says what.
   *
   * D41's first axis is "more of the room actually shown: the founder should
   * come out knowing what that room is for and roughly where things live in
   * it". A tour would do that and is exactly what D12 and D16.1 forbid. This
   * is the same fact delivered as the gesture D21 already established, at the
   * one moment it means anything: they have just watched their own quarter
   * land in there, and the pebble goes and stands next to the door they will
   * use to come back to it.
   */
  roomIsTheirs: (beat: RoomBeat, label: string) => void;
  /** Something landed in that room; make it show now rather than on the poll. */
  refreshRoom: (room: RoomKey) => void;
  /**
   * Reach into the room the founder is standing in and open the thing that
   * just landed, by name.
   *
   * D41, one axis further. The pebble marking the door already says WHAT lives
   * in a room. It does not say how the thing works, and Vieri's verdict on the
   * third run was that the two objects nobody can read off a card are the goal
   * tree and the workflow: *"it never explains how goals work... it would be
   * good if it would actually press into the workflow, this specific workflow
   * that it creates, to showcase the different nodes."*
   *
   * The answer is not a tour, which D12 and D16.1 forbid and which this is not:
   * the subject is THEIR objective and THEIR flow, opened because they just
   * made it, and nothing else in the product is shown. It rides the room action
   * bus the rooms already have, so no room learns anything about the trial.
   */
  roomAction: (room: RoomKey, action: string, args: Record<string, unknown>) => void;
  /**
   * Walk the pebble across the parts of the thing that just landed, holding one
   * short line at each.
   *
   * The same D21 gesture that marks a door, aimed one level in. It costs the
   * beat a few seconds of showing rather than a paragraph of Jarvis talking,
   * which is the constraint: explaining must not become more sentences.
   */
  showParts: (parts: { anchor: string; label?: string }[], opts?: { room?: RoomKey; kind?: string }) => void;
  /** Put a proposal on the founder's screen, or take it off. */
  showProposal: (proposal: BeatProposal | null) => void;
  /** A proposal just became real: what landed, for the card's last frame. */
  proposalLanded: (beat: RoomBeat, summary: string) => void;
  /** Every beat that completes, for the live surface and the report. */
  beatComplete: (beat: RoomBeat, detail: Record<string, unknown>) => void;
};

export type BeatActions = {
  /** Compose + publish a flow. Returns a short human sentence, or throws.
   *  `flowId` is the built flow, so the room can open THAT one and show its
   *  nodes rather than a list row with its name on it. */
  publishWorkflow: (p: WorkflowProposal) => Promise<
    { ok: true; detail: string; flowId?: string } | { ok: false; detail: string }
  >;
  /** Persist both ends of the day into the goal rhythm. */
  setDailyRhythm: (morning: { hour: number; minute: number }, eveningHour: number) => void;
  /** Persist the authority level and the founder's carve-out. Returns what
   *  actually landed, since the level is clamped and the carve-out filtered. */
  setAuthority: (level: number, alwaysAsk: string[]) => { level: number; alwaysAsk: string[] };
  /**
   * D42. Put a background agent on a folder the founder approved. The reader's
   * tools are fenced to `folder` in code (see founder-files.ts); this only
   * starts it and never waits for it (D17).
   */
  startFolderReader: (opts: {
    folder: string;
    /** Paths the survey shortlisted, relative to the folder. */
    shortlist: string[];
    /** Whatever is known about the company, so it knows what it is looking for. */
    about: string;
  }) => Promise<{ agentId: string; taskId: string | null }>;
  /** What the reader has landed so far, and whether it has finished. */
  readerProgress: () => { found: string[]; finished: boolean; summary: string | null };
  /** Spawn the finale's research agent and leave it running. */
  spawnResearchAgent: (
    question: string,
    brief: string,
  ) => Promise<{ agentId: string; taskId: string | null; agentName: string }>;
  /** Onboarding is over. The conversation is not. */
  onFinished: (s: BeatsSession) => void;
  /**
   * D24. Resolve when the founder actually presses the summon, or when the
   * wait runs out. Never rejects: a handover that throws would leave the
   * conductor up, which is the bug this whole beat exists to fix.
   */
  awaitSummon: (timeoutMs: number) => Promise<'pressed' | 'timeout'>;
  /**
   * The conductor stands down and the ordinary shell comes back: its pebble,
   * its Talk panel, its palette. The trial itself does not end, and nothing
   * here touches the entitlement's clock, its state or its realtime grant.
   */
  standDown: (s: BeatsSession) => void;
};

export type BeatDeps = BeatSurfaces & BeatActions & {
  fuel: () => BeatFuel;
  now: () => number;
  /** The founder's home directory, so the folder fence has something to refuse
   *  against. Injected rather than read here so the tests are not run against
   *  whoever's machine they happen to be on. */
  home?: () => string;
  /**
   * Which machine this is: WSL, Windows, or Linux/macOS. Injected for the same
   * reason `home` is. The path translation in host-paths.ts is exactly the
   * kind of thing that works on the box it was written on and silently does
   * the wrong thing everywhere else, so the tests get to be all three.
   */
  host?: () => HostShape;
};

export type BeatToolResult = { message: string };

/**
 * Run one room-beat tool. Returns null when `name` is not one, so the caller
 * falls through to whatever else it exposes.
 *
 * Async because two of these do real work: the composer builds a flow with an
 * LLM, and the finale spawns a sub-agent. Everything else is a local write and
 * returns in the same tick.
 */
export async function executeBeatTool(
  s: BeatsSession,
  name: string,
  args: Record<string, unknown>,
  deps: BeatDeps,
): Promise<BeatToolResult | null> {
  // `move_on` belongs to whichever beat the conversation is standing in, so it
  // is not in TOOL_BEAT and is resolved here. It exists because a design where
  // every beat ends in a commit tool has no exit for a founder who says no: the
  // model would either never get the next brief or push the offer again. D43
  // requires both of its offers to be refusable without the conversation
  // stalling, and this is the thing that makes that true everywhere.
  if (name === 'move_on') {
    if (!s.open) return openingNotDone();
    return moveOn(s, args, deps);
  }

  // Not in TOOL_BEAT either, and for a reason worth writing down. Every other
  // tool here belongs to a beat and is refused until that beat is open, which
  // is right: a founder should not be asked for their disk during the goals
  // conversation. But "what can you see?" is a question a founder can ask at
  // any moment, it reads no file and names nothing outside their own account,
  // and the whole reason this exists is that the answer was once "nothing".
  // Gating it behind the files beat would reproduce that failure with a
  // politer sentence.
  if (name === 'folders_i_can_see') {
    if (!s.open) return openingNotDone();
    return whatCanYouSee(deps);
  }

  const beat = TOOL_BEAT[name];
  if (!beat) return null;

  // The order gate (D16). Written as an instruction, not an error: a model
  // that reads "not available" invents an apology to the founder, and a model
  // that reads "you are still in X, do X" simply carries on.
  if (!s.open) return openingNotDone();
  if (!beatIsOpen(s, beat)) {
    const now = currentBeat(s);
    // The one case worth spelling out, because under D44 it is the common one:
    // the model has reached ahead to their quarter while the reader is still
    // working. Telling it only "not yet" leaves it with nothing to do, which
    // is how a conversation stalls at minute four.
    const hint = now === 'workspace' && s.files && !beatIsDone(s, 'workspace')
      ? ' Their files are still being read. Keep talking to them and call `reading_so_far` as you go; ' +
        'it will hand you what comes next the moment there is something to say.'
      : ' Finish that with them first; this will open when it does.';
    return { message: `Not yet. You are in the ${now} part of the work, not ${beat}.${hint}` };
  }

  switch (name) {
    case 'propose_goals': return proposeGoals(s, args, deps);
    case 'create_goals': return createGoals(s, deps);
    case 'propose_tasks': return proposeTasks(s, args, deps);
    case 'create_tasks': return createTasks(s, deps);
    case 'read_week': return readWeek(s, deps);
    case 'propose_daily_rhythm': return proposeDailyRhythm(s, args, deps);
    case 'set_daily_rhythm': return setDailyRhythm(s, deps);
    case 'propose_workflow': return proposeWorkflow(s, args, deps);
    case 'publish_workflow': return publishWorkflow(s, deps);
    case 'no_second_workflow': return noSecondWorkflow(s, args, deps);
    case 'propose_authority': return proposeAuthority(s, args, deps);
    case 'set_authority': return setAuthority(s, args, deps);
    case 'propose_reading': return proposeReading(s, args, deps);
    case 'start_reading': return startReading(s, deps);
    case 'reading_so_far': return readingSoFar(s, deps);
    case 'propose_workspace': return proposeWorkspace(s, args, deps);
    case 'create_workspace': return commitWorkspace(s, deps);
    case 'propose_edit': return proposeEdit(s, args, deps);
    case 'make_edit': return makeEdit(s, args, deps);
    case 'propose_research': return proposeResearch(s, args, deps);
    case 'spawn_research_agent': return spawnResearchAgent(s, deps);
    case 'teach_summon': return teachSummon(s, deps);
    case 'await_summon': return awaitSummon(s, deps);
    default: return null;
  }
}

function openingNotDone(): BeatToolResult {
  return {
    message:
      'Not yet. You are still in the opening and you have not called `conclude_opening`. ' +
      'Keep talking about their company until you understand it well enough to start work.',
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Nothing on their screen to say yes to. Same shape everywhere so the model
 *  always gets a next action rather than an error. */
/** The tool that puts each beat's thing on screen, so a refusal can name it
 *  rather than telling the model to go and find "the propose tool". */
const PROPOSE_TOOL: Record<RoomBeat, string> = {
  goals: 'propose_goals',
  tasks: 'propose_tasks',
  calendar: 'propose_daily_rhythm',
  workflows: 'propose_workflow',
  authority: 'propose_authority',
  files: 'propose_reading',
  workspace: 'propose_workspace',
  agents: 'propose_research',
  handover: 'teach_summon',
};

function nothingProposed(beat: RoomBeat, tool: string): BeatToolResult {
  return {
    message:
      `Nothing is on their screen yet. Say it out loud and call \`${PROPOSE_TOOL[beat]}\` first, ` +
      `then \`${tool}\` once they have agreed.`,
  };
}

/**
 * Has the founder said ANYTHING since this proposal went on their screen?
 *
 * The honest limit of this, stated plainly because it would otherwise be
 * mistaken for consent: it does not know whether they said yes. Realtime
 * auto-approves every tool call outside a destructive blocklist, so no server
 * anywhere in this codebase can tell a spoken yes from a spoken no, and this
 * one does not pretend to.
 *
 * What it does kill is the failure mode that actually matters here, and the one
 * a model drifts into under time pressure: proposing and committing in the same
 * breath, so the founder watches their quarter appear while Jarvis is still
 * asking whether to make it. D18 says the founder is the one who says yes; this
 * at least guarantees they got to say something.
 *
 * Deliberately satisfied by the VAD as well as by a transcript. If input
 * transcription is unavailable (the same failure the clock has a backstop for)
 * a transcript-only gate would refuse every commit for the whole session and
 * take the trial down with it.
 */
function founderHasAnswered(s: BeatsSession): boolean {
  if (s.proposalShownAt === null) return true;
  return s.lastUserTurnAt > s.proposalShownAt;
}

function notAnsweredYet(tool: string): BeatToolResult {
  return {
    message:
      'They have not answered yet. It is on their screen and you have not heard back from them, ' +
      `so ask, and then stop and listen. Call \`${tool}\` when they have replied.`,
  };
}

/** The beats whose card should say the founder's own documents are behind it. */
const READS_FROM_FILES: ReadonlySet<RoomBeat> = new Set<RoomBeat>(['goals', 'tasks', 'calendar', 'workflows']);

/** One place, so a proposal can never go up without arming the gate, and so
 *  no propose function can forget to say where its contents came from. */
function putOnScreen(s: BeatsSession, proposal: BeatProposal, deps: BeatDeps): void {
  const shown = READS_FROM_FILES.has(proposal.beat) && findingsOf(s, deps).found.length > 0
    ? { ...proposal, fromFiles: true }
    : proposal;
  s.proposal = shown;
  s.proposalShownAt = deps.now();
  deps.showProposal(shown);
}

function takeOffScreen(s: BeatsSession): void {
  s.proposal = null;
  s.proposalShownAt = null;
}

/* ── the goals beat ── */

function proposeGoals(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const objective = str(args.objective);
  if (!objective) return { message: 'Error: the objective was empty. Say their quarter in one line and call this again.' };

  const now = deps.now();
  const rawKrs = Array.isArray(args.key_results) ? args.key_results : [];
  const keyResults: KeyResultProposal[] = [];
  for (const raw of rawKrs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title);
    if (!title) continue;
    const measure = str(r.measure);
    const target = str(r.target);
    const today = str(r.today);
    keyResults.push({
      title,
      ...(measure ? { measure } : {}),
      ...(target ? { target } : {}),
      ...(today ? { today } : {}),
    });
  }
  if (keyResults.length === 0) {
    return { message: 'Error: no key results came through. An objective on its own is a wish; give it two to four results.' };
  }

  const deadlineLabel = str(args.deadline) || null;
  const deadline = deadlineLabel ? resolveDue(deadlineLabel, now) : null;

  let firstMove: GoalProposal['firstMove'] = null;
  const rawMove = args.first_move;
  if (typeof rawMove === 'object' && rawMove !== null) {
    const m = rawMove as Record<string, unknown>;
    const what = str(m.what);
    const under = str(m.under);
    if (what && under) {
      const dueLabel = str(m.due) || null;
      firstMove = { what, under, due: dueLabel ? resolveDue(dueLabel, now) : null, dueLabel };
    }
  }

  const measure = str(args.measure);
  const proposal: GoalProposal = {
    beat: 'goals',
    objective,
    ...(measure ? { measure } : {}),
    deadline,
    deadlineLabel,
    keyResults,
    firstMove,
  };
  deps.enterRoom('goals', 'their quarter');
  putOnScreen(s, proposal, deps);

  // The card is on their screen; what comes back tells the model which of the
  // three passes it is still owed rather than letting it stop at the first.
  const missing = missingGoalDepth(proposal);
  return {
    message:
      `On their screen: "${objective}" with ${keyResults.length} key result${keyResults.length === 1 ? '' : 's'}. ` +
      'Do not read the list back to them, they can see it.\n\n' +
      (missing.length > 0
        ? `Still owed before this can be written: ${missing.join(' ')} Ask for the next one of those now, one at a time, ` +
          'and call `propose_goals` again with their answer.'
        : 'That is the whole tree. Ask them plainly whether to make it real.'),
  };
}

/**
 * What a tree still needs before it is a plan rather than a wish. Returned as
 * sentences the model can act on, and used by BOTH the propose result (so it
 * knows what to ask next) and the commit gate (so it cannot skip it).
 *
 * D41 in one function: a beat is finished when the room's work is finished.
 */
function missingGoalDepth(p: GoalProposal): string[] {
  const missing: string[] = [];
  if (p.keyResults.length < 2) {
    missing.push('A second key result: one result under an objective is the objective again, said twice.');
  }
  const noToday = p.keyResults.filter((kr) => !kr.today);
  if (noToday.length > 0) {
    missing.push(
      `Where ${noToday.length === p.keyResults.length ? 'each of these' : `"${noToday[0]!.title}"`} ` +
      'stands TODAY, from them, not estimated by you. A guess is fine; silence is not.',
    );
  }
  if (!p.firstMove) {
    missing.push('The first actual move, inside the next two weeks, and which key result it sits under.');
  }
  return missing;
}

function createGoals(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'goals') return nothingProposed('goals', 'create_goals');
  if (!founderHasAnswered(s)) return notAnsweredYet('create_goals');

  // The depth gate. Enforced here rather than asked for in the prompt, for the
  // same reason the authority ceiling is: a model under time pressure will take
  // the first yes and move on, which is exactly the failure D41 names.
  const missing = missingGoalDepth(p);
  if (missing.length > 0) {
    return {
      message:
        'Not yet, and this is worth the extra minute rather than something to work around.\n\n' +
        missing.map((m) => `- ${m}`).join('\n') +
        '\n\nAsk them for the first of those, in their language, then call `propose_goals` again with ' +
        'the answer and `create_goals` after that. Do not fill any of it in yourself.',
    };
  }

  let objective: Goal;
  try {
    objective = createGoal(p.objective, 'objective', {
      status: 'active',
      time_horizon: 'quarterly',
      ...(p.measure ? { success_criteria: p.measure } : {}),
      ...(p.deadline !== null ? { deadline: p.deadline } : {}),
      tags: [TRIAL_BEATS_SOURCE],
    });
  } catch (err) {
    console.warn('[TrialBeats] failed to create objective', err);
    return { message: 'That did not save. Tell them plainly that it did not take, and try `create_goals` once more.' };
  }

  let made = 1;
  const created: { id: string; title: string }[] = [];
  p.keyResults.forEach((kr, i) => {
    try {
      const goal = createGoal(kr.title, 'key_result', {
        parent_id: objective.id,
        status: 'active',
        time_horizon: 'quarterly',
        ...(kr.measure ? { success_criteria: kr.measure } : {}),
        ...(p.deadline !== null ? { deadline: p.deadline } : {}),
        sort_order: i,
        tags: [TRIAL_BEATS_SOURCE],
      });
      made++;
      created.push({ id: goal.id, title: goal.title });
      // The starting line. `today` against `target` is where this key result
      // actually is, so the tree opens with a position rather than a zero, and
      // the founder's own words are the reason on the first progress entry.
      const score = baselineScore(kr);
      const reason = kr.target ? `${kr.today} today, ${kr.target} to go for` : `${kr.today} today`;
      try {
        updateGoalScore(goal.id, score, reason, TRIAL_BEATS_SOURCE);
      } catch (err) {
        console.warn('[TrialBeats] failed to record the baseline for', kr.title, err);
      }
    } catch (err) {
      console.warn('[TrialBeats] failed to create key result', kr.title, err);
    }
  });

  // The first move, as a milestone under the key result they named. Falls back
  // to the objective rather than being dropped: the founder said it out loud.
  let milestone = 0;
  let milestoneId: string | null = null;
  if (p.firstMove) {
    const parent = created.find((c) => sameish(c.title, p.firstMove!.under)) ?? null;
    try {
      milestoneId = createGoal(p.firstMove.what, 'milestone', {
        parent_id: parent?.id ?? objective.id,
        status: 'active',
        time_horizon: 'weekly',
        ...(p.firstMove.due !== null ? { deadline: p.firstMove.due } : {}),
        tags: [TRIAL_BEATS_SOURCE],
      }).id;
      made++;
      milestone = 1;
    } catch (err) {
      console.warn('[TrialBeats] failed to create the first move', err);
    }
  }

  s.objective = { id: objective.id, title: objective.title, keyResults: created };
  takeOffScreen(s);
  markDone(s, 'goals');
  deps.proposalLanded('goals', `${p.objective} · ${p.keyResults.length} key results, first move set`);
  deps.refreshRoom('goals');
  showTheTree(p, { objective: objective.id, keyResults: created, milestone: milestoneId }, deps);
  deps.roomIsTheirs('goals', 'your quarter lives here');
  deps.beatComplete('goals', {
    objective: p.objective,
    keyResults: p.keyResults.length,
    goalsCreated: made,
    hasDeadline: p.deadline !== null,
    firstMove: milestone === 1,
  });
  return {
    message:
      `Created: the objective, ${created.length} key results with today's number on each, ` +
      `${milestone === 1 ? 'and the first move underneath' : 'but the first move did not save'}. ` +
      'Their tree is open in front of them and the parts are being pointed at as you speak.\n\n' +
      'ONE sentence about how it actually works, and only the part the tree cannot show them: the ' +
      'number on each key result is where they are TODAY, and it moves when the two of you score it ' +
      'at the evening review. Do not read the tree back to them and do not list its parts, they are ' +
      'looking at it.\n\n' + onward(s, deps),
  };
}

/**
 * D41, one axis in. Open their objective in the room and walk the pebble down
 * the three levels of the thing they just built.
 *
 * Why this is explanation and not a tour: every stop is a node THEY dictated,
 * created ten seconds ago, and the labels name the mechanic rather than the
 * feature. Nothing else in the room is opened, no other room is shown, and the
 * whole thing is over in about seven seconds. A tour would have started with
 * "this is the goals room".
 */
function showTheTree(
  p: GoalProposal,
  ids: { objective: string; keyResults: { id: string; title: string }[]; milestone: string | null },
  deps: BeatDeps,
): void {
  // Select it, so the room opens its detail panel on their objective rather
  // than on whatever the room happened to be showing.
  deps.roomAction('goals', 'focus_goal', { id: ids.objective, title: p.objective });

  const parts: { anchor: string; label?: string }[] = [
    { anchor: `goal:${ids.objective}`, label: 'the objective · where the quarter ends' },
  ];
  const firstKr = ids.keyResults[0];
  if (firstKr) {
    const kr = p.keyResults.find((k) => sameish(k.title, firstKr.title)) ?? p.keyResults[0];
    const today = kr?.today ? short(kr.today, 22) : null;
    parts.push({
      anchor: `goal:${firstKr.id}`,
      label: today ? `a key result · ${today} today` : 'a key result · how you will know',
    });
  }
  if (ids.milestone) {
    parts.push({
      anchor: `goal:${ids.milestone}`,
      label: p.firstMove?.dueLabel
        ? `the first move · ${short(p.firstMove.dueLabel, 18)}`
        : 'the first move · this week',
    });
  }
  deps.showParts(parts, { room: 'goals' });
}

/** Pebble labels are one line of mono that must not wrap. */
function short(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Where a key result starts, as an OKR score.
 *
 * Only computed when both ends are actually numbers the founder said; anything
 * else starts at zero, because a made-up starting position is worse than an
 * honest one. "about three" against "40" is 0.075 and that is correct.
 *
 * Direction matters and getting it wrong is not a rounding error. "Month three
 * churn under 4%", sitting at 9% today, is a quarter of the way there and NOT
 * finished, but a naive today/target reads 2.25, clamps to 1.0, and tells a
 * founder on the goals room's own progress bar that the hardest thing on their
 * tree is already done. So a ceiling is detected from the words they used and
 * scored the other way up.
 */
export function baselineScore(kr: KeyResultProposal): number {
  const today = firstNumber(kr.today);
  const target = firstNumber(kr.target ?? kr.measure);
  if (today === null || target === null) return 0;
  if (isCeiling(kr)) {
    if (today <= target) return 1;
    return today === 0 ? 1 : Math.min(Math.max(target / today, 0), 1);
  }
  if (target === 0) return 0;
  return Math.min(Math.max(today / target, 0), 1);
}

/** Is this a number to get UNDER rather than a number to reach? Read off the
 *  founder's own words, which is the only signal there is. */
function isCeiling(kr: KeyResultProposal): boolean {
  const text = `${kr.title} ${kr.target ?? ''} ${kr.measure ?? ''}`.toLowerCase();
  return /\b(under|below|less than|fewer than|no more than|at most|down to|reduce|cut|lower)\b|<\s*\d/.test(text);
}

function firstNumber(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Loose title match, because the model retypes the key result rather than
 *  copying it, and "12 booked demos" should still find "12 booked demos a month". */
function sameish(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
}

/* ── the tasks beat ── */

const PRIORITIES: CommitmentPriority[] = ['low', 'normal', 'high', 'critical'];

function proposeTasks(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const raw = Array.isArray(args.tasks) ? args.tasks : [];
  const now = deps.now();
  const tasks: TaskProposal['tasks'] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const what = str(t.what);
    if (!what) continue;
    const dueRaw = str(t.due);
    const due = dueRaw ? resolveDue(dueRaw, now) : null;
    const priority = PRIORITIES.includes(t.priority as CommitmentPriority)
      ? (t.priority as CommitmentPriority)
      : 'normal';
    // "Late" is a fact about the date when we have one, and the model's word
    // only when we do not: a founder told a task is late that is not is worse
    // than a missing flag.
    const late = due !== null ? due < now : t.late === true;
    const toward = str(t.toward);
    tasks.push({
      what, due, dueLabel: dueRaw || null, priority, late,
      ...(toward ? { toward } : {}),
      first: t.first === true,
    });
  }
  if (tasks.length === 0) {
    return { message: 'Error: no tasks came through. Name the ones they actually said and call this again.' };
  }

  const proposal: TaskProposal = { beat: 'tasks', tasks };
  deps.enterRoom('tasks', 'their week');
  putOnScreen(s, proposal, deps);

  const lateCount = tasks.filter((t) => t.late).length;
  const firsts = tasks.filter((t) => t.first).length;
  const towardCount = tasks.filter((t) => t.toward).length;
  const notes: string[] = [];
  if (firsts !== 1) {
    notes.push(
      firsts === 0
        ? 'Nobody has picked the first one. Ask them which single thing they do next and call `propose_tasks` again with that one marked `first`.'
        : `${firsts} of them are marked first, which is none of them. Ask them to pick one.`,
    );
  }
  notes.push(
    towardCount === 0
      ? `None of these ${tasks.length} point at the quarter. That is worth saying out loud to them, plainly, before you ask for a yes.`
      : `${towardCount} of ${tasks.length} point at the quarter. Say that ratio out loud; it is the most useful sentence in this beat.`,
  );
  return {
    message:
      `On their screen: ${tasks.length} task${tasks.length === 1 ? '' : 's'}` +
      `${lateCount > 0 ? `, ${lateCount} already late` : ''}. Say the late one first if there is one.\n\n` +
      notes.join('\n'),
  };
}

/** ISO first, then the plain-language parser the calendar room already uses. */
function resolveDue(text: string, now: number): number | null {
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return iso;
  const parsed = parseRelativeDate(text, now);
  return parsed ? parsed.ts : null;
}

function createTasks(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'tasks') return nothingProposed('tasks', 'create_tasks');
  if (!founderHasAnswered(s)) return notAnsweredYet('create_tasks');

  // The depth gate for this beat. One thing, always satisfiable, and it can
  // only be satisfied by the founder actually choosing: a board of five equal
  // things is the week they already have.
  const firsts = p.tasks.filter((t) => t.first);
  if (firsts.length !== 1) {
    return {
      message:
        (firsts.length === 0
          ? 'Not yet: none of these is marked as the one they do first.'
          : `Not yet: ${firsts.length} of these are marked first, which means none of them is.`) +
        ' Ask them, out loud, which single thing they do next, and call `propose_tasks` again with ' +
        'exactly that one marked `first`. Do not choose it for them.',
    };
  }

  // The chosen one goes on the board first, so the room reads the way the
  // sentence did. Everything else keeps the order it was said in.
  const ordered = [...p.tasks].sort((a, b) => Number(b.first) - Number(a.first));
  const created: Commitment[] = [];
  for (const t of ordered) {
    try {
      const context = [
        t.first ? 'first thing' : '',
        t.toward ? `toward: ${t.toward}` : '',
      ].filter(Boolean).join(' · ');
      created.push(
        createCommitment(t.what, {
          ...(t.due !== null ? { when_due: t.due } : {}),
          priority: t.priority,
          created_from: TRIAL_BEATS_SOURCE,
          assigned_to: 'user',
          ...(context ? { context } : {}),
        }),
      );
    } catch (err) {
      console.warn('[TrialBeats] failed to create task', t.what, err);
    }
  }
  if (created.length === 0) {
    return { message: 'None of those saved. Say so plainly and try `create_tasks` again.' };
  }

  const towardCount = p.tasks.filter((t) => t.toward).length;
  takeOffScreen(s);
  markDone(s, 'tasks');
  deps.proposalLanded('tasks', `${created.length} on the board, "${firsts[0]!.what}" first`);
  deps.refreshRoom('tasks');
  deps.roomIsTheirs('tasks', 'your week lives here');
  deps.beatComplete('tasks', {
    created: created.length,
    late: p.tasks.filter((t) => t.late).length,
    toward: towardCount,
    first: firsts[0]!.what,
  });
  return {
    message:
      `On the board, ${created.length} of them, "${firsts[0]!.what}" at the top and ` +
      `${towardCount} pointing at the quarter.\n\n${onward(s, deps)}`,
  };
}

/* ── the calendar beat ── */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readWeek(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const now = deps.now();
  deps.enterRoom('calendar', 'the week');

  let upcoming: Commitment[] = [];
  let overdue: Commitment[] = [];
  try {
    upcoming = getUpcoming(50).filter((c) => c.when_due !== null && c.when_due >= now && c.when_due < now + WEEK_MS);
    overdue = findCommitments({ overdue: true });
  } catch (err) {
    console.warn('[TrialBeats] failed to read the week', err);
    return { message: 'Their calendar would not open. Ask them what their week looks like instead, and carry on.' };
  }

  const line = (c: Commitment) =>
    `- ${c.what}${c.when_due ? ` (${new Date(c.when_due).toDateString()})` : ''}${c.context ? ` [${c.context}]` : ''}`;
  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`Already late:\n${overdue.slice(0, 8).map(line).join('\n')}`);
  parts.push(
    upcoming.length > 0
      ? `The next seven days:\n${upcoming.map(line).join('\n')}`
      : 'The next seven days are empty apart from what the two of you just put on the board.',
  );

  // What the quarter itself is due, so the week is read against the tree rather
  // than as a list of chores that happens to exist.
  const dated = datedTree(now);
  if (dated.length > 0) parts.push(`What the quarter has dates on:\n${dated.join('\n')}`);

  // D44. The third source of dates, and the only one the founder has not
  // already seen: the deadlines sitting inside their own documents. A renewal
  // in a client agreement, a date in a proposal, a milestone in a plan. None
  // of it is on any calendar, which is exactly why it is worth reading back.
  const fromFiles = datedFindings(findingsOf(s, deps));
  if (fromFiles.length > 0) {
    parts.push(
      `Dates written in their own documents, which are on no calendar:\n${fromFiles.join('\n')}`,
    );
  }

  return {
    message:
      `${parts.join('\n\n')}\n\nRead the shape of that back to them in one or two sentences, saying how ` +
      'their week and their quarter line up or do not.' +
      (fromFiles.length > 0
        ? ' Name at least one of the dates out of their own files, because that is the half of their ' +
          'week nothing was tracking. If one of them collides with something already on the list, say so.'
        : '') +
      ' Then ask when their day actually starts, and when it actually ends.',
  };
}

/**
 * The reader's findings that have a date in them.
 *
 * Deliberately a crude filter over what the reader wrote down rather than
 * anything that tries to PARSE a date: the findings are sentences in the
 * document's own words, and a parser that turned "renews in October" into a
 * timestamp would be inventing the year. What this has to be right about is
 * only which lines are worth reading back, and the model does the rest.
 */
const DATEISH = new RegExp(
  [
    // Month names, whole words only. Deliberately NOT `jan[a-z]*`, which
    // matches "market" through `mar` and "deck" through `dec`, and "market" is
    // the single most common word in a founder's own files.
    '\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?' +
      '|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b',
    '\\bq[1-4]\\b',
    '\\b20\\d{2}\\b',
    '\\b\\d{1,2}[\\/.-]\\d{1,2}(?:[\\/.-]\\d{2,4})?\\b',
    '\\b(?:deadline|due|renews?|renewal|expires?|ships?|launch(?:es)?|monthly|weekly' +
      '|quarterly|annually|every (?:week|month|quarter))\\b',
  ].join('|'),
  'i',
);

export function datedFindings(files: FileFindings, limit = 8): string[] {
  return files.found.filter((f) => DATEISH.test(f)).slice(0, limit).map((f) => `- ${f}`);
}

/** The goal tree's own deadlines, so `read_week` can say what is due. */
function datedTree(now: number): string[] {
  try {
    const goals = findGoals({ status: 'active' }).filter((g) => g.deadline !== null);
    return goals
      .sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0))
      .slice(0, 6)
      .map((g) => {
        const days = Math.round(((g.deadline ?? now) - now) / 86_400_000);
        return `- ${g.title} (${g.level.replace('_', ' ')}, ${days <= 0 ? 'due' : `${days} days`})`;
      });
  } catch (err) {
    console.warn('[TrialBeats] failed to read the goal tree for the week', err);
    return [];
  }
}

function proposeDailyRhythm(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const hour = clampBriefHour(args.hour);
  const minute = clampBriefMinute(args.minute);
  const eveningHour = args.evening_hour === undefined || args.evening_hour === null
    ? null
    : clampBriefHour(args.evening_hour);
  const because = str(args.because);
  const proposal: CalendarProposal = {
    beat: 'calendar', hour, minute, eveningHour, ...(because ? { because } : {}),
  };
  deps.enterRoom('calendar', 'their rhythm');
  putOnScreen(s, proposal, deps);
  return {
    message:
      `On their screen: the brief at ${fmtTime(hour, minute)}` +
      `${eveningHour === null ? ' and no evening yet' : `, the review at ${fmtTime(eveningHour, 0)}`}. ` +
      (eveningHour === null
        ? 'Ask when they actually stop for the day, take the honest answer rather than the aspirational one, ' +
          'and call `propose_daily_rhythm` again with it. Both ends or it is a notification, not a rhythm.'
        : 'Say both hours and why, then let them answer.'),
  };
}

export function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function setDailyRhythm(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'calendar') return nothingProposed('calendar', 'set_daily_rhythm');
  if (!founderHasAnswered(s)) return notAnsweredYet('set_daily_rhythm');

  // The depth gate for this beat: both ends of the day, because the evening
  // review is the half that closes the loop on the tree they just built.
  if (p.eveningHour === null) {
    return {
      message:
        'Not yet: only the morning is on the card. Ask them when they actually stop working, then call ' +
        '`propose_daily_rhythm` again with `evening_hour` and `set_daily_rhythm` after that. The evening ' +
        'review is what closes the day off against the tree, so half of it is not the beat.',
    };
  }

  try {
    deps.setDailyRhythm({ hour: p.hour, minute: p.minute }, p.eveningHour);
  } catch (err) {
    console.warn('[TrialBeats] failed to set the rhythm', err);
    return { message: 'Those hours did not save. Say so and try `set_daily_rhythm` again.' };
  }

  s.briefAt = { hour: p.hour, minute: p.minute };
  s.eveningHour = p.eveningHour;
  takeOffScreen(s);
  markDone(s, 'calendar');
  deps.proposalLanded('calendar', `brief ${fmtTime(p.hour, p.minute)}, review ${fmtTime(p.eveningHour, 0)}`);
  deps.refreshRoom('calendar');
  deps.roomIsTheirs('calendar', 'tomorrow starts here');
  deps.beatComplete('calendar', { hour: p.hour, minute: p.minute, eveningHour: p.eveningHour });
  return {
    message:
      `Set. Their brief lands at ${fmtTime(p.hour, p.minute)} and the day gets closed off at ` +
      `${fmtTime(p.eveningHour, 0)}.\n\n${onward(s, deps)}`,
  };
}

/* ── the workflows beat ── */

function proposeWorkflow(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const name = str(args.name);
  const runsWhen = str(args.runs_when);
  const steps = (Array.isArray(args.steps) ? args.steps : []).map(str).filter(Boolean);
  if (!name || !runsWhen || steps.length === 0) {
    return { message: 'Error: a flow needs a name, when it runs, and what it does. Say it out loud and call this again.' };
  }
  const never = str(args.never);
  // Required, in code. The never line is what makes a founder willing to let
  // something run while they are not watching, and a flow proposed without one
  // is asking for a blank cheque in the beat that matters most for trust.
  if (!never) {
    return {
      message:
        `"${name}" has no line it must never cross. Work out what this flow must NOT do on its own ` +
        '(send rather than draft, pay rather than flag, reply rather than surface), say that out loud ' +
        'to them, and call `propose_workflow` again with it in `never`.',
    };
  }
  const proposal: WorkflowProposal = { beat: 'workflows', name, runsWhen, steps, never };
  deps.enterRoom('workflows', 'the flow');
  putOnScreen(s, proposal, deps);
  return {
    message:
      `On their screen: "${name}", ${steps.length} steps, ${runsWhen}. Say what it takes off them, ` +
      'say what it will never do on its own, then ask.',
  };
}

async function publishWorkflow(s: BeatsSession, deps: BeatDeps): Promise<BeatToolResult> {
  const p = s.proposal;
  if (!p || p.beat !== 'workflows') return nothingProposed('workflows', 'publish_workflow');
  if (!founderHasAnswered(s)) return notAnsweredYet('publish_workflow');

  // The composer is a real LLM round trip and the founder is listening to
  // silence while it runs. Marking the card as building is what makes that
  // silence legible: they can see it working rather than wondering.
  // Not putOnScreen: this is the same proposal in a different state, and
  // re-arming the answered gate here would make them say yes twice.
  const building: WorkflowProposal = { ...p, building: true };
  s.proposal = building;
  deps.showProposal(building);

  let outcome: { ok: boolean; detail: string; flowId?: string };
  try {
    outcome = await deps.publishWorkflow(p);
  } catch (err) {
    outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  if (!outcome.ok) {
    // Leave the proposal up: the founder is still looking at a flow that was
    // promised to them, and the model is about to say what happened to it.
    s.proposal = p;
    deps.showProposal(p);
    return {
      message:
        `That one did not build: ${outcome.detail}\n\nTell them plainly, in one sentence, that it needs ` +
        'more wiring than this conversation can do. Then either simplify it and call `propose_workflow` ' +
        'again, or leave it and move on. Do not claim it is live.',
    };
  }

  s.workflowsPublished.push(p.name);
  takeOffScreen(s);
  const count = s.workflowsPublished.length;
  deps.proposalLanded('workflows', `${p.name} · published`);
  deps.refreshRoom('workflows');

  // D41 again, and this is the one Vieri asked for by name. A workflow is the
  // most abstract object in the product and the one a founder is least likely
  // to understand from a card: a card can list four sentences, but a flow is a
  // trigger and a chain of steps, and until you have seen that you do not know
  // what you own. So the FIRST one that builds is opened in the editor and the
  // pebble walks its actual nodes.
  //
  // The first rather than the second, because this is the moment they first
  // own a flow and the moment "what IS a workflow" is a live question; the
  // second one then lands against an understanding rather than before one.
  let opened = false;
  if (count === 1 && outcome.flowId) {
    s.firstFlow = { id: outcome.flowId, name: p.name };
    deps.roomAction('workflows', 'open_flow', { id: outcome.flowId, name: p.name });
    // No anchors from here: the daemon proposed the flow in the founder's
    // sentences and the COMPOSER decided what the nodes are. The surface reads
    // the real graph and walks whatever is actually in it, so the labels are
    // the flow's own node names rather than a guess at them.
    deps.showParts([], { room: 'workflows', kind: 'flow' });
    opened = true;
  }

  // D16.5 wants TWO, and the old version completed the beat on the first one,
  // which is why it never got a second: the model was handed the next brief
  // the instant it had a yes. The beat now stays open until there are two, or
  // until the model records that their week honestly has one.
  if (count < 2) {
    return {
      message:
        `"${p.name}" is live: ${outcome.detail}\n\n` +
        (opened
          ? 'It is OPEN on their screen as the thing it actually is: the trigger at the top, then ' +
            'each step in order, and the pebble is going down them now. Say the one thing the ' +
            'picture cannot say: the top of it is what wakes it up, and it runs the rest without ' +
            'either of you. Two sentences at most, and do not read the steps out, they can see them.\n\n'
          : '') +
        'That is one. The second one comes out of the tree the ' +
        'two of you built: something has to keep those key results honest week to week and nobody does ' +
        'that by hand for long. Propose it now. If you ask properly and their week genuinely has only ' +
        'this one recurring thing in it, call `no_second_workflow` rather than inventing one.',
    };
  }

  markDone(s, 'workflows');
  deps.roomIsTheirs('workflows', 'what runs without you');
  deps.beatComplete('workflows', { flows: [...s.workflowsPublished], published: count });
  return { message: `"${p.name}" is live too, ${count} flows now: ${outcome.detail}\n\n${onward(s, deps)}` };
}

function noSecondWorkflow(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  if (s.workflowsPublished.length === 0) {
    return {
      message:
        'Nothing has been published yet, so there is no second one to be missing. Propose the first flow ' +
        'out of what they are drowning in.',
    };
  }
  const because = str(args.because);
  s.onlyOneWorkflow = true;
  markDone(s, 'workflows');
  deps.roomIsTheirs('workflows', 'what runs without you');
  deps.beatComplete('workflows', { flows: [...s.workflowsPublished], published: s.workflowsPublished.length, onlyOne: true, because });
  return {
    message:
      `Recorded: one flow, because ${because || 'their week has one'}. That is the honest answer and ` +
      `better than a second flow nobody asked for.\n\n${onward(s, deps)}`,
  };
}

/* ── the authority beat ── */

function proposeAuthority(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const level = args.level === undefined ? TRIAL_AUTHORITY_PROPOSED : clampAuthorityLevel(args.level);
  const alwaysAsk = cleanCarveOuts(args.always_ask);
  const proposal: AuthorityProposal = { beat: 'authority', level, alwaysAsk };
  deps.enterRoom('authority', 'what you may do');
  putOnScreen(s, proposal, deps);
  return {
    message:
      `The ladder is on their screen with ${level} marked` +
      `${alwaysAsk.length > 0 ? ` and ${alwaysAsk.length} carved out` : ' and nothing carved out yet'}. ` +
      'Ask for it out loud, say what it buys and what it still will not touch, and tell them they can ' +
      'pull you down.\n\n' +
      (alwaysAsk.length === 0
        ? 'Then ask the second half: what do they want to keep their hand on anyway? Offer the real ones, ' +
          `say which you would pick if you were them and why, and call \`propose_authority\` again with ` +
          `their answer. The choices are: ${CARVE_OUT_CATEGORIES.map((c) => `${c.id} (${c.says})`).join(', ')}.`
        : 'They have chosen what stays theirs. Read it back in their words, not the category names, and ask.'),
  };
}

function setAuthority(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'authority') return nothingProposed('authority', 'set_authority');
  if (!founderHasAnswered(s)) return notAnsweredYet('set_authority');

  const asked = args.level === undefined ? p.level : Math.round(Number(args.level));
  const level = clampAuthorityLevel(args.level === undefined ? p.level : args.level);
  const alwaysAsk = args.always_ask === undefined ? p.alwaysAsk : cleanCarveOuts(args.always_ask);

  // The depth gate for this beat. D14 wants authority configured WITH them, and
  // a number they said yes to is not a configuration: the carve-out is the part
  // they decide. Refused rather than defaulted, because a default here would be
  // Jarvis choosing its own limits.
  if (alwaysAsk.length === 0) {
    return {
      message:
        'Not yet: they have granted a number but they have not said what still comes to them first. ' +
        'Ask that now, out loud, offer the real choices, and say which one you would keep if you were ' +
        `them: ${CARVE_OUT_CATEGORIES.map((c) => `${c.id} (${c.says})`).join(', ')}. Then call ` +
        '`propose_authority` again with their answer and `set_authority` after it. If they genuinely ' +
        'want nothing held back, say plainly that you would rather they held one thing back, and take ' +
        'their answer either way.',
    };
  }

  let landed: { level: number; alwaysAsk: string[] };
  try {
    landed = deps.setAuthority(level, alwaysAsk);
  } catch (err) {
    console.warn('[TrialBeats] failed to set authority', err);
    return { message: 'That did not save. Say so and try `set_authority` again.' };
  }

  s.authorityLevel = landed.level;
  s.alwaysAsk = landed.alwaysAsk;
  takeOffScreen(s);
  markDone(s, 'authority');
  deps.proposalLanded('authority', `level ${landed.level}, ${landed.alwaysAsk.length} still yours`);
  deps.refreshRoom('authority');
  deps.roomIsTheirs('authority', 'what I may do, and what I may not');
  deps.beatComplete('authority', { level: landed.level, asked, alwaysAsk: landed.alwaysAsk });

  const capped =
    Number.isFinite(asked) && asked > TRIAL_AUTHORITY_CEILING
      ? `They offered ${asked}. It is ${landed.level}: seven and above is not on the table during a trial, ` +
        'and you should say that plainly rather than let them think they gave you more than they did. '
      : '';
  const kept = landed.alwaysAsk
    .map((id) => CARVE_OUT_CATEGORIES.find((c) => c.id === id)?.says ?? id)
    .join(', ');
  return {
    message:
      `Set to ${landed.level}, and ${kept} still needs their yes every time. ${capped}\n\n` +
      onward(s, deps),
  };
}

/* ── D42 · the files beat: their own material, read by something else ── */

/**
 * What Jarvis can offer when the folder they named is not there, and when they
 * simply ask what it can see.
 *
 * The second live run died on exactly this: the founder named a folder, the
 * reader found nothing, they asked "what folders do you have access to", and
 * it could not name a single one. It had no way to look. This is the way to
 * look, and it is deliberately a handful of suggestions rather than an
 * inventory of their disk.
 */
function offerFolders(deps: BeatDeps, limit = 5): { lines: string[]; sentence: string } {
  let found: ReturnType<typeof folderCandidates> = [];
  try {
    found = folderCandidates({ home: deps.home ? deps.home() : undefined, shape: hostShape(deps), limit });
  } catch (err) {
    console.warn('[TrialBeats] could not look for candidate folders', err);
  }
  const lines = found.map((c) => {
    const readable = c.readable > 0 ? `${c.readable} readable` : 'nothing readable';
    return `- ${c.says}: ${c.path} (${c.files}${c.more ? '+' : ''} files, ${readable})`;
  });
  const sentence = found.length === 0
    ? ''
    : found.map((c) => c.says).slice(0, 3).join(', ');
  return { lines, sentence };
}

/** The machine this daemon is on, resolved once per session. */
function hostShape(deps: BeatDeps): HostShape {
  return deps.host ? deps.host() : detectHostShape();
}

function whatCanYouSee(deps: BeatDeps): BeatToolResult {
  const { lines, sentence } = offerFolders(deps, 6);
  const shape = hostShape(deps);
  const wsl = shape.kind === 'wsl'
    ? '\n\nThis machine runs Jarvis inside Linux and their documents on Windows, so both spellings of a ' +
      'path work: they can say `C:\\Users\\...` the way they would type it into Explorer. Never make them ' +
      'learn a second spelling of their own folder.'
    : '';
  if (lines.length === 0) {
    return {
      message:
        'Nothing with anything in it turned up in the usual places. Say plainly that you cannot find their ' +
        'documents from here and ask them to open the folder on their machine and read you the path from ' +
        `the address bar. Do not say you have no access to their files; say you could not find them.${wsl}`,
    };
  }
  return {
    message:
      `Folders on this machine with real content in them, best first:\n${lines.join('\n')}\n\n` +
      `Offer them by NAME, two or three of them, not as paths: "${sentence}". Ask which one the company ` +
      'lives in, or whether it is somewhere else. Do not read the list out and do not read out the paths ' +
      `unless they ask. Nothing has been read.${wsl}`,
  };
}

function proposeReading(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const asked = str(args.folder);
  const shape = hostShape(deps);
  const verdict = resolveFounderFolder(asked, deps.home ? deps.home() : undefined, shape);
  if (!verdict.ok) {
    // "There is no folder at X" on its own is what made the founder think it
    // was blind. So: what was actually tried, and what is actually there.
    const tried = verdict.tried && verdict.tried.length > 0
      ? `\n\nWhere this machine looked: ${verdict.tried.join(', ')}.`
      : '';
    const { lines, sentence } = offerFolders(deps);
    const offer = lines.length > 0
      ? `\n\nWhat IS on this machine, with content in it:\n${lines.join('\n')}\n\nSay you could not find ` +
        `the one they named, then offer these by name: "${sentence}". One sentence, then ask.`
      : '\n\nNothing else turned up in the usual places either, so ask them to open the folder on their ' +
        'machine and read you the path out of the address bar.';
    return {
      message:
        `Not that: ${verdict.why}.${tried}${offer}\n\nDo not tell them you have no access to their files, ` +
        'because you do; you could not find that one. Do not widen it and do not guess at a path.',
    };
  }

  let survey;
  try {
    survey = surveyFolder(verdict.path, deps.now());
  } catch (err) {
    console.warn('[TrialBeats] failed to survey', verdict.path, err);
    return { message: `${sayPath(verdict.path, shape)} could not be opened. Say so and ask for a different folder.` };
  }

  // The degenerate cases, handled here rather than left to the model, because
  // "I read your company" said about an empty folder is the worst sentence in
  // the trial. Nothing is proposed and nothing is started in either case.
  const says = sayPath(verdict.path, shape);
  if (survey.files.length === 0) {
    const { sentence } = offerFolders(deps, 3);
    return {
      message:
        `${says} has nothing in it${survey.truncated ? ' at the level worth reading' : ''}. Say that ` +
        'out loud, because they probably think it does, and ask whether there is another folder or ' +
        'whether the company mostly lives somewhere that is not this machine.' +
        (sentence ? ` You can also see ${sentence}, so offer those.` : '') +
        ' Nothing has been read.',
    };
  }
  if (survey.shortlist.length === 0) {
    return {
      message:
        `${says} has ${survey.files.length} files in it but none that can be opened as text: ` +
        `${survey.kinds.slice(0, 4).map((k) => `${k.n} ${k.ext}`).join(', ')}. Tell them exactly that, ` +
        'say you can see the names but not the insides, and ask whether there is a folder with the ' +
        'written material in it. Do not pretend to have read a PDF.',
    };
  }

  const proposal: FilesProposal = {
    beat: 'files',
    folder: verdict.path,
    says,
    what: describeSurvey(survey),
    sample: survey.shortlist.slice(0, 6).map((f) => f.rel),
    willRead: survey.shortlist.length,
    total: survey.files.length,
  };
  deps.enterRoom('files', 'what it will read');
  putOnScreen(s, proposal, deps);
  // Stashed unstarted: `start_reading` reads it back rather than surveying
  // again, so what runs is exactly what they were shown.
  pendingSurveys.set(s, { folder: verdict.path, shortlist: survey.shortlist.map((f) => f.rel) });

  return {
    message:
      `${says}: ${proposal.what}.\n\nThat is on their screen. Say the folder and the numbers out ` +
      'loud, in one sentence, and then ASK. Nothing is read until they answer and you call ' +
      '`start_reading`. Their authority level does not cover this and does not stand in for their yes. ' +
      'If they say no, or name a different folder, take it: `move_on`, or `propose_reading` again.' +
      (says !== verdict.path
        ? `\n\nSay it as ${says}, which is how they know it. Never say ${verdict.path} out loud: that is ` +
          'where this machine opens it, not where they keep it.'
        : ''),
  };
}

/**
 * The survey behind the card on screen, keyed by session.
 *
 * A WeakMap rather than a field on BeatsSession because it is a cache of what
 * the founder was SHOWN, not part of the ledger: it exists so `start_reading`
 * launches exactly the shortlist that was named out loud, instead of walking
 * the folder a second time and possibly getting a different answer.
 */
const pendingSurveys = new WeakMap<BeatsSession, { folder: string; shortlist: string[] }>();

async function startReading(s: BeatsSession, deps: BeatDeps): Promise<BeatToolResult> {
  const p = s.proposal;
  if (!p || p.beat !== 'files') return nothingProposed('files', 'start_reading');
  if (!founderHasAnswered(s)) return notAnsweredYet('start_reading');
  const pending = pendingSurveys.get(s);
  if (!pending || pending.folder !== p.folder) {
    return { message: 'The folder on their screen is not the one that was surveyed. Call `propose_reading` again.' };
  }

  let started: { agentId: string; taskId: string | null };
  try {
    started = await deps.startFolderReader({
      folder: pending.folder,
      shortlist: pending.shortlist,
      about: deps.fuel().company ?? '',
    });
  } catch (err) {
    console.warn('[TrialBeats] failed to start the folder reader', err);
    return {
      message:
        `Nobody could be put on it: ${err instanceof Error ? err.message : String(err)}\n\n` +
        'Say plainly that you could not start reading, and do not claim anything is being read. ' +
        'Then carry on: call `move_on`.',
    };
  }

  s.files = {
    folder: pending.folder,
    says: p.says,
    willRead: p.willRead,
    agentId: started.agentId,
    taskId: started.taskId,
    startedAt: deps.now(),
    finishedAt: null,
    found: 0,
    summary: null,
  };
  const reading: FilesProposal = { ...p, reading: true, found: 0 };
  s.proposal = reading;
  deps.showProposal(reading);
  markDone(s, 'files');
  deps.refreshRoom('memory');
  deps.roomIsTheirs('files', 'everything I know about you');
  deps.beatComplete('files', { folder: pending.folder, willRead: p.willRead, agentId: started.agentId });

  // Deliberately NOT `onward`. The next beat is `workspace` and it cannot be
  // done until the reader has found something, so handing its brief over now
  // would give the model an instruction it can only follow by inventing. The
  // workspace brief arrives from `reading_so_far` instead, at the moment there
  // is something to organise. See `whileItReadsBrief`.
  return {
    message:
      `It is reading ${p.willRead} of their files now, in the background, and it will be a couple of ` +
      'minutes. Do NOT wait for it and do not narrate it.\n\n' +
      'The first time something real has landed, stop whatever you were saying and tell them what it ' +
      'found: the people, the numbers, the things you now know that they never said out loud. That is ' +
      'the moment this is for, and `reading_so_far` will tell you when it has come.\n\n' +
      whileItReadsBrief(deps.fuel()),
  };
}

function readingSoFar(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  if (!s.files) {
    return { message: 'Nothing is being read. Nothing to report, say nothing about it.' };
  }
  const progress = deps.readerProgress();
  s.files.found = progress.found.length;
  if (progress.finished && s.files.finishedAt === null) s.files.finishedAt = deps.now();
  if (progress.summary) s.files.summary = progress.summary;

  // Keep the card in step with the vault so the founder sees the same number
  // Jarvis is about to say.
  if (s.proposal && s.proposal.beat === 'files' && s.proposal.found !== progress.found.length) {
    const next: FilesProposal = { ...s.proposal, reading: !progress.finished, found: progress.found.length };
    s.proposal = next;
    deps.showProposal(next);
  }

  const says = s.files.says ?? s.files.folder;

  if (progress.found.length === 0) {
    if (!progress.finished) {
      return {
        message:
          'Nothing has landed yet. Say NOTHING about it and carry on with what you were talking about. ' +
          'Call this again in a turn or two.',
      };
    }
    // Finished and empty. There is nothing to organise, so `workspace` closes
    // here rather than leaving the model holding a beat it cannot do, and the
    // conversation goes straight on to their quarter. The ledger records it as
    // what it was: not declined by them, just empty.
    if (!beatIsDone(s, 'workspace')) {
      markDone(s, 'workspace');
      deps.beatComplete('workspace', { skipped: true, because: 'the reader found nothing to organise' });
    }
    return {
      message:
        `It has finished and found nothing about the company in ${says}. ` +
        (s.files.summary ? `It said: ${s.files.summary}\n\n` : '') +
        'Say that straight, without dressing it up, and without inventing a finding. Ask whether the ' +
        'real material is somewhere else. Do NOT offer to organise a folder you learned nothing from.' +
        `\n\n${onward(s, deps)}`,
    };
  }

  const report =
    `${progress.found.length} things about their company have landed from their own files` +
    `${progress.finished ? ' and it has finished' : ' and it is still reading'}:\n` +
    progress.found.slice(0, 30).map((f) => `- ${f}`).join('\n') +
    (s.files.summary ? `\n\nWhat it made of the whole folder: ${s.files.summary}` : '') +
    '\n\nIf you have not already, say some of this back to them now. Their words for their own things, ' +
    'the specific ones, and the ones they never mentioned to you are the ones worth naming. Do not read ' +
    'the whole list out and do not say where you got each one.';

  // The first real landing is the event this beat exists for, and it is also
  // the moment the NEXT beat becomes possible: there is finally something to
  // organise. So the workspace brief is handed over here rather than at
  // `start_reading`, once and never again, so the model is not re-briefed on
  // the same beat every time it checks progress.
  if (!s.files.toldOfFindings) {
    s.files.toldOfFindings = true;
    return { message: `${report}\n\n${onward(s, deps)}` };
  }
  return { message: report };
}

/* ── D43 · the workspace beat: acting on what it read ── */

function proposeWorkspace(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  if (!s.files) {
    return {
      message:
        'There is nothing to organise: no folder was ever read. Do not offer to tidy files you have not ' +
        'seen. Call `move_on`.',
    };
  }
  // The reader is still working and has landed nothing, so any sections named
  // here would be invented. Under D44 this is a live risk rather than a
  // theoretical one: the beat now starts three minutes into the session, and a
  // model with nothing else to do will reach for the next tool it has.
  if (findingsOf(s, deps).found.length === 0) {
    return {
      message:
        'Nothing has come back from their files yet, so you do not know what is in them and you cannot ' +
        'name the sections. Do not guess at a filing system for documents you have not read. Carry on ' +
        'talking to them and call `reading_so_far` in a turn or two; it will tell you when there is ' +
        'something to organise.',
    };
  }
  const title = str(args.title) || 'the company';
  const rawSections = Array.isArray(args.sections) ? args.sections : [];
  const sections: WorkspaceProposal['sections'] = [];
  for (const raw of rawSections) {
    if (typeof raw !== 'object' || raw === null) continue;
    const sec = raw as Record<string, unknown>;
    const name = str(sec.name);
    if (!name) continue;
    const files = (Array.isArray(sec.files) ? sec.files : []).map(str).filter(Boolean);
    sections.push({ name, about: str(sec.about), files });
  }
  if (sections.length === 0) {
    return { message: 'Error: no sections came through. A folder with nothing in it is not an improvement.' };
  }
  const totalFiles = sections.reduce((n, sec) => n + sec.files.length, 0);
  if (totalFiles === 0) {
    return {
      message:
        'Those sections have no files in them, so it would build an empty scaffold. Put the paths the ' +
        'reader actually saw into the sections they belong in, exactly as it saw them, and call this again.',
    };
  }

  const shape = hostShape(deps);
  const destination = str(args.destination) || defaultWorkspacePath(s.files.folder, title);
  const plan: WorkspaceProposal = {
    beat: 'workspace',
    kind: 'workspace',
    destination,
    source: s.files.folder,
    saysDestination: sayPath(destination, shape),
    saysSource: sayPath(s.files.folder, shape),
    title,
    sections,
  };
  const verdict = checkWorkspacePlan({ destination, source: s.files.folder, title, sections });
  if (!verdict.ok) {
    return {
      message:
        `That will not do: ${verdict.why}. Say it to them in one line and call \`propose_workspace\` again ` +
        'with somewhere else, or leave it and `move_on`.',
    };
  }

  deps.enterRoom('workspace', 'their own files');
  putOnScreen(s, plan, deps);
  return {
    message:
      `On their screen: ${plan.saysDestination}, ${sections.length} sections, ${totalFiles} files copied into it.\n\n` +
      'Say the sections out loud in their language, say WITHOUT being asked that nothing gets moved and ' +
      'nothing gets deleted and every original stays exactly where it is, and then ask. It is refusable ' +
      'and it is not worth pushing twice: if they say no, `move_on`.',
  };
}

function commitWorkspace(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'workspace' || p.kind !== 'workspace') return nothingProposed('workspace', 'create_workspace');
  if (!founderHasAnswered(s)) return notAnsweredYet('create_workspace');

  // Checked again at the moment of writing, not just when it went on screen:
  // the founder has been talking for a couple of minutes and the destination
  // may have appeared in between.
  const shape = hostShape(deps);
  const verdict = checkWorkspacePlan({
    destination: p.destination,
    source: p.source,
    sourceLabel: p.saysSource ?? sayPath(p.source, shape),
    title: p.title,
    sections: p.sections,
  });
  if (!verdict.ok) {
    return {
      message:
        `Stopped before writing anything: ${verdict.why}. Say that to them, and either propose a different ` +
        'place or leave it.',
    };
  }

  let result;
  try {
    result = createWorkspace(verdict.plan, deps.now());
  } catch (err) {
    console.warn('[TrialBeats] failed to create the workspace', err);
    return {
      message:
        `It could not be built: ${err instanceof Error ? err.message : String(err)}\n\nSay so plainly. ` +
        'Nothing of theirs has been moved or changed either way, and you can say that too.',
    };
  }

  const saysDest = p.saysDestination ?? sayPath(result.destination, shape);
  s.workspace = {
    destination: result.destination, saysDestination: saysDest, copied: result.copied, sections: result.sections,
  };
  takeOffScreen(s);
  markDone(s, 'workspace');
  deps.proposalLanded('workspace', `${saysDest} · ${result.copied} files copied`);
  deps.refreshRoom('memory');
  deps.beatComplete('workspace', {
    destination: result.destination, copied: result.copied, skipped: result.skipped.length,
  });

  const skipped = result.skipped.length > 0
    ? ` ${result.skipped.length} could not be copied and they are listed in the README: ` +
      `${result.skipped.slice(0, 3).map((x) => `${x.rel} (${x.why})`).join(', ')}.`
    : '';
  return {
    message:
      `Built: ${saysDest}, ${result.sections} sections, ${result.copied} files copied, and a ` +
      `README saying where each one came from.${skipped} Every original is untouched.\n\n` +
      'Tell them where it is, in one sentence. Then the second half of this: offer ONE concrete piece of ' +
      'work on ONE file you have actually read. A page of the deck that undersells them, a README that ' +
      'does not say what the company does, the document that contradicts the others. Name the file, say ' +
      'what is wrong with it and what you would change, and call `propose_edit`. Do not offer anything ' +
      'you cannot do right now; a promise here is worse than nothing. If they are not interested, ' +
      '`move_on`.',
  };
}

function proposeEdit(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  if (!s.files) {
    return { message: 'You have not read any of their files, so there is nothing to offer to change. `move_on`.' };
  }
  const file = str(args.file);
  const change = str(args.change);
  if (!file || !change) {
    return { message: 'Error: name the file and say in one line what you would change about it.' };
  }
  // It has to be a file that actually exists inside the folder they gave you.
  // Offering to rewrite something imagined is the failure mode this whole beat
  // is supposed to be the opposite of.
  const check = readInside(s.files.folder, file);
  if (!check.ok) {
    return {
      message:
        `Cannot offer that: ${check.why} Pick a file the reader actually opened, by the path it used, ` +
        'and call `propose_edit` again.',
    };
  }

  const proposal: EditProposal = {
    beat: 'workspace',
    kind: 'edit',
    file,
    change,
    as: revisionName(file),
  };
  deps.enterRoom('workspace', 'one real thing');
  putOnScreen(s, proposal, deps);
  return {
    message:
      `On their screen: ${file}, "${change}".\n\nHere is what is actually in it right now:\n\n` +
      `${check.ok ? check.text.slice(0, 8000) : ''}\n\n` +
      'Say what is wrong with it, specifically, out of what you have just read, and what you would do ' +
      'instead. Then ask. When they say yes, call `make_edit` with the WHOLE new version. It is written ' +
      'as a new file beside theirs and theirs is not touched, so say that as well.',
  };
}

function revisionName(file: string): string {
  const base = file.split(/[/\\]/).pop() ?? file;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '.md';
  return `${stem} - rewritten${ext}`;
}

function makeEdit(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'workspace' || p.kind !== 'edit') return nothingProposed('workspace', 'make_edit');
  if (!founderHasAnswered(s)) return notAnsweredYet('make_edit');
  if (!s.files) return { message: 'No folder was ever read, so there is nothing to write beside. `move_on`.' };

  const body = typeof args.body === 'string' ? args.body : '';
  if (body.trim().length === 0) {
    return { message: 'Error: the new version was empty. Send the WHOLE new file, not a description of it.' };
  }

  // Into the organised folder when there is one, so the founder's own folder
  // gains nothing it did not ask for; beside the original otherwise.
  const intoDir = s.workspace?.destination ?? s.files.folder;
  let written;
  try {
    written = writeRevision({
      intoDir,
      originalName: p.file.split(/[/\\]/).pop() ?? p.file,
      label: 'rewritten',
      body,
    });
  } catch (err) {
    console.warn('[TrialBeats] failed to write the revision', err);
    return {
      message:
        `It could not be written: ${err instanceof Error ? err.message : String(err)}\n\nSay so. Their ` +
        'own file is untouched either way.',
    };
  }

  // No `beatComplete` here: the workspace beat closed when the folder was
  // built. `beatComplete` fires once per beat, and a second one for the same
  // beat would tell any surface reading it that the beat had happened twice.
  s.edit = { path: written.path, file: p.file };
  takeOffScreen(s);
  deps.proposalLanded('workspace', `${written.path.split(/[/\\]/).pop()} written`);
  return {
    message:
      `Written: ${sayPath(written.path, hostShape(deps))}. Their ${p.file} is exactly as it was.\n\nTell ` +
      'them where it is and what you changed, in a sentence, and say plainly that the original is ' +
      'untouched and they can throw yours away. Then, if there is another file in the same state, OFFER ' +
      'to do that one too rather than telling them what to fix in it. Do not tell them to go and read ' +
      `it; ask if they want it read to them.\n\n${onward(s, deps)}`,
  };
}

/* ── the exit from any offer they turn down ── */

function moveOn(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const beat = currentBeat(s);
  if (!beat) {
    return { message: 'There is nothing left to set up. You are simply their co-founder; carry on talking.' };
  }
  const because = str(args.because);
  // Nothing is written and nothing is claimed: the beat is closed as not done
  // WITH them, which is different from done. The ledger records both.
  takeOffScreen(s);
  deps.showProposal(null);
  markDone(s, beat);
  deps.beatComplete(beat, { declined: true, because });

  // D44's refusal path. A founder who says no to the read has said no to the
  // organised copy of it in the same breath, and making them refuse twice in
  // ninety seconds is how a trial starts feeling like a salesman. `workspace`
  // closes with them, silently, and the conversation goes to their quarter.
  // Without this the model would be handed `workspaceBrief`, whose first
  // sentence is "you have read their files".
  if (beat === 'files' && !beatIsDone(s, 'workspace')) {
    markDone(s, 'workspace');
    deps.beatComplete('workspace', { skipped: true, because: 'they did not want their files read' });
  }

  return {
    message:
      `Left alone, and that is theirs to decide. Do not raise it again and do not sound disappointed.` +
      (beat === 'files'
        ? ' Do not offer to organise their folder either; that was the same question and they have ' +
          'answered it. Everything after this works out of what they tell you, and it works.'
        : '') +
      `\n\n${onward(s, deps)}`,
  };
}

/* ── beat 12 · agents, the finale ── */

/**
 * The question goes on screen before anyone is sent off with it.
 *
 * Every other beat proposes, then commits. The finale used to do both in one
 * call, and the second live run found what that costs: the founder heard "I am
 * putting someone on it" and watched nothing happen, so the one beat that is
 * supposed to prove the thing keeps working after the conversation was the one
 * beat with nothing to look at. `enterRoom` fires here rather than at the
 * spawn, so they are already standing in the agents room, watching it empty,
 * when the agent appears in it.
 */
function proposeResearch(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const question = str(args.question);
  const brief = str(args.brief);
  if (!question) {
    return { message: 'Error: no question came through. Say the question they have never had time to answer, in their words.' };
  }
  if (!brief) {
    return {
      message:
        'Error: no brief came through. Say what a useful answer would look like FOR THEM specifically: ' +
        'what to compare, what to ignore, what they would do with it.',
    };
  }
  const proposal: AgentProposal = { beat: 'agents', question, brief, running: false, agentName: null };
  deps.enterRoom('agents', 'the agent');
  putOnScreen(s, proposal, deps);
  return {
    message:
      `On their screen: "${question}".\n\nSay what you are sending someone off to find out, in one ` +
      'sentence, and check it is the right question before anyone starts. When they say yes, call ' +
      '`spawn_research_agent`. If they want it changed, call `propose_research` again with their version.',
  };
}

async function spawnResearchAgent(s: BeatsSession, deps: BeatDeps): Promise<BeatToolResult> {
  const p = s.proposal;
  if (!p || p.beat !== 'agents') return nothingProposed('agents', 'spawn_research_agent');
  if (!founderHasAnswered(s)) return notAnsweredYet('spawn_research_agent');

  // No `enterRoom` here: `propose_research` already led them into the agents
  // room, and the whole point of the split is that they are standing in it,
  // looking at it empty, when the agent lands in it.
  let spawned: { agentId: string; taskId: string | null; agentName: string };
  try {
    spawned = await deps.spawnResearchAgent(p.question, p.brief);
  } catch (err) {
    console.warn('[TrialBeats] failed to spawn the research agent', err);
    return {
      message:
        `The agent would not start: ${err instanceof Error ? err.message : String(err)}\n\n` +
        'Say plainly that you could not put anyone on it yet, and that you will. Do not pretend it is running.',
    };
  }

  s.agent = { ...spawned, question: p.question };
  markDone(s, 'agents');
  s.finishedAt = deps.now();
  // The card STAYS, unlike every other beat's, and turns into the thing it
  // described. It is the last surface of the session and what it says is "this
  // is still working", which is the whole of D15.
  const running: AgentProposal = { ...p, running: true, agentName: spawned.agentName };
  s.proposal = running;
  deps.showProposal(running);
  deps.refreshRoom('agents');
  deps.roomIsTheirs('agents', 'whoever is working for you');
  deps.beatComplete('agents', { question: p.question, agentId: spawned.agentId, agentName: spawned.agentName });
  try {
    deps.onFinished(s);
  } catch (err) {
    console.warn('[TrialBeats] finished listener failed', err);
  }
  return { message: `${spawned.agentName} is on it, and they can see it working in the agents room.\n\n${closing(s)}` };
}

/* ── beat 13 · the handover, and the end of the conducted hour ── */

/**
 * How long `await_summon` waits for the keystroke.
 *
 * Long enough that a founder who is mid-thought, or looking for the control
 * key on a laptop they have had for a week, still gets there. Short enough
 * that a founder who has walked away is not left with a live conductor sitting
 * on top of the product they were promised. Either way it comes back and
 * either way the conductor stands down, which is the property that matters:
 * the fault being fixed here is a trial that never ends.
 */
export const SUMMON_WAIT_MS = 45_000;

/**
 * D28's card, and D24's lesson.
 *
 * `chord` is written with `mod` where the modifier differs by platform, and the
 * surface renders it as ⌘ or Ctrl. The one they PRESS is the one that works on
 * the surface they are standing on: ctrl+space is the OS sidecar's summon and a
 * browser never sees it, so asking them to press that would be teaching a key
 * that does nothing in front of them.
 */
export const HANDOVER_KEYS: HandoverProposal['keys'] = [
  { chord: 'mod+J', what: 'brings me back', where: 'wherever you are in here', press: true },
  { chord: 'ctrl+space', what: 'the same, from anywhere', where: 'even with this shut' },
  { chord: 'mod+K', what: 'anything, by name', where: 'the command palette' },
];

function teachSummon(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const proposal: HandoverProposal = { beat: 'handover', keys: HANDOVER_KEYS, pressed: false };
  putOnScreen(s, proposal, deps);
  return {
    message:
      'The three keys are on their screen. Ask them to hold control and press J, in your own words, ' +
      'and say what it does: it brings you back, wherever they are. One sentence, no list, do not ' +
      'read the other two out.\n\nThen call `await_summon` and stop talking. It comes back the moment ' +
      'they press it.',
  };
}

/**
 * Wait for the keystroke, then stand the conductor down.
 *
 * THE STAND-DOWN IS NOT A SEPARATE TOOL, deliberately. A third tool the model
 * had to remember to call would reintroduce the exact fault being fixed here:
 * a founder left underneath a conductor that never finished, this time because
 * a model got distracted rather than because nobody wrote the code. So the
 * stand-down happens on the way out of this call, on both branches, and the
 * founder gets their shell back whether or not they pressed anything.
 *
 * What it leaves running: the entitlement, the 48-hour clock, the realtime
 * grant, everything in the vault, both flows, the rhythm, the authority level
 * and the research agent. Only the conducted conversation finishes.
 */
async function awaitSummon(s: BeatsSession, deps: BeatDeps): Promise<BeatToolResult> {
  const p = s.proposal;
  if (!p || p.beat !== 'handover') return nothingProposed('handover', 'await_summon');

  let outcome: 'pressed' | 'timeout';
  try {
    outcome = await deps.awaitSummon(SUMMON_WAIT_MS);
  } catch (err) {
    // A handover that throws would leave them where they started. It does not.
    console.warn('[TrialBeats] waiting for the summon failed', err);
    outcome = 'timeout';
  }
  const pressed = outcome === 'pressed';
  s.summonPressed = pressed;
  s.handedOverAt = deps.now();

  // The card's last frame: the tick they earned, and the fact that the shell
  // underneath is theirs now.
  const done: HandoverProposal = { ...p, pressed, handedOver: true };
  s.proposal = done;
  s.proposalShownAt = null;
  deps.showProposal(done);

  markDone(s, 'handover');
  try {
    deps.standDown(s);
  } catch (err) {
    console.warn('[TrialBeats] the stand-down listener failed', err);
  }
  deps.beatComplete('handover', { pressed, keys: HANDOVER_KEYS.length });

  return {
    message: pressed
      ? 'They pressed it, and their own pebble and panel are back on the screen in front of them. ' +
        'Say so, warmly, in ONE sentence, the way you would to someone who just got something ' +
        'right, and say that is how they get you from now on.\n\nThen you are done setting things ' +
        'up. The 48 hours are still running and so are you: if they keep talking, you are simply ' +
        'their co-founder and the conversation carries on. Do not recap and do not give them a list.'
      : 'They did not press it, and that is fine. Their own pebble and panel are back on the screen ' +
        'anyway. Say once, lightly, that it is control and J whenever they want you, and do not ' +
        'ask them again.\n\nThen you are done setting things up. The 48 hours are still running and ' +
        'so are you: if they keep talking, you are simply their co-founder and the conversation ' +
        'carries on.',
  };
}
