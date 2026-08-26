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

/** Vault `source` for everything the room beats write. Distinct from the
 *  opening's `trial_conductor` so the D38 debrief can tell "what it learned
 *  while you talked" from "what the two of you built". */
export const TRIAL_BEATS_SOURCE = 'trial_room_beats';

/**
 * The beats that are stops, in D16's order. `memory` is D16's first beat and
 * is deliberately absent from the list: it is not a stop, it is `remember`
 * running underneath all of these.
 *
 * `files` and `workspace` are D42 and D43, added on 26 August, and they sit
 * between `authority` and `agents` on purpose:
 *
 *   - AFTER authority, because reading a founder's disk is the most invasive
 *     thing in the whole trial and the beat immediately before it is the one
 *     where the two of them just negotiated what Jarvis may do. D16's own
 *     logic for putting authority sixth is "negotiate power once the founder
 *     can see what it will be used for", and there is no clearer thing it will
 *     be used for than this. Asking first would be asking for the biggest
 *     thing before the conversation about power had happened.
 *   - BEFORE agents, because agents is the finale (D15) and the finale has to
 *     be last: it is the only beat that keeps working after the talking stops.
 *     It also matters that the reader gets a few minutes of the conversation
 *     to run in (D17), which only exists if something comes after it.
 */
export const ROOM_BEATS = [
  'goals', 'tasks', 'calendar', 'workflows', 'authority', 'files', 'workspace', 'agents',
] as const;

export type RoomBeat = (typeof ROOM_BEATS)[number];

/** Which dashboard room each beat happens in. */
export const BEAT_ROOM: Record<RoomBeat, RoomKey> = {
  goals: 'goals',
  tasks: 'tasks',
  calendar: 'calendar',
  workflows: 'workflows',
  authority: 'authority',
  // Both file beats happen in `memory`, which is where what the reader finds
  // actually lands. D16.1 says the founder is never SHOWN the memory room
  // during the opening; by the time these run it has an hour of their company
  // in it and their own files are being added to it, which is the opposite of
  // a tour. `enterRoom` is a no-op on an unchanged room, so the pebble makes
  // one gesture across both beats rather than twitching twice.
  files: 'memory',
  workspace: 'memory',
  agents: 'agents',
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
};

export type CalendarProposal = {
  beat: 'calendar';
  hour: number;
  minute: number;
  because?: string;
  /** The other end of the day: when the evening review runs. */
  eveningHour: number | null;
};

export type WorkflowProposal = {
  beat: 'workflows';
  name: string;
  runsWhen: string;
  steps: string[];
  never?: string;
  /** Set while the composer is building it, so the silence is legible. */
  building?: boolean;
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

export type BeatProposal =
  | GoalProposal
  | TaskProposal
  | CalendarProposal
  | WorkflowProposal
  | AuthorityProposal
  | FilesProposal
  | WorkspaceProposal
  | EditProposal;

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
    /** What the reader said when it finished, or the reason it could not. */
    summary: string | null;
  } | null;
  /** D43: where the organised copy went, once it exists. */
  workspace: { destination: string; copied: number; sections: number } | null;
  /** D43: the one piece of real work it did, if they took it. */
  edit: { path: string; file: string } | null;
  /** Beat 12's output, and the seam into beat 14. */
  agent: { agentId: string; taskId: string | null; agentName: string; question: string } | null;
  /** When the last beat closed. Onboarding is over at this moment. */
  finishedAt: number | null;
};

export function createBeatsSession(): BeatsSession {
  return {
    open: false,
    done: [],
    proposal: null,
    proposalShownAt: null,
    lastUserTurnAt: 0,
    workflowsPublished: [],
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
 * arrive one at a time as tool results. Handing the model all seven up front
 * would turn the opening into a rehearsal for the beats, which is exactly the
 * drift D12 exists to stop: it would start steering the founder toward the
 * goals room while it was still supposed to be listening.
 *
 * `fuel` is the founder's own words, captured in the opening. It is repeated
 * into the brief that needs it so a long session cannot lose it out of the
 * model's context window, and so the model reaches for the founder's phrasing
 * rather than a paraphrase of a paraphrase.
 */
export type BeatFuel = Partial<Record<'company' | 'goal' | 'drowning' | 'next_days' | 'open_question', string>>;

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
 *   goals      an objective with an end date, key results with a number AND
 *              where that number is today, and the first move under one of
 *              them. Three answers from the founder, not one nod.
 *   tasks      the week, with the one they do first chosen by them, and each
 *              task said to serve the quarter or admitted not to.
 *   calendar   both ends of the day, not just the morning.
 *   workflows  two flows (D16.5), and the line each must never cross.
 *   authority  the number AND the carve-out they choose.
 *   files      their own material, read by something that is not them.
 *   workspace  a real folder on their disk, and one real piece of work in it.
 *
 * Every one of those is a row in their vault or a file on their disk
 * afterwards. None of them is a pause, a progress bar, or Jarvis saying more
 * words about the same thing.
 */

export function goalsBrief(fuel: BeatFuel = {}): string {
  return `${NOTHING_ABOUT_THIS}

Now the two of you start doing the work, and the first thing is their quarter. Do not rush this one. It is the first real thing you build together and it is worth several turns.

Build it with them in three passes, and call \`propose_goals\` again after each so the card on their screen fills in as they answer.

1. THE SHAPE. One objective and two to four key results under it, out of the sentences they actually said. Their words, their numbers, no OKR vocabulary and no invented metrics. Say it out loud and call \`propose_goals\` in the SAME turn so it is on their screen while you are still speaking. Then ask them to change something: what is missing, or which one of these is not really the point. A tree they edited is theirs. A tree they nodded at is yours.

2. THE NUMBERS. For every key result, ask where it is TODAY. This is the question they have to stop and work out, and it is the whole difference between a target and something either of you can track. If they do not know, ask them to guess and put the guess in. \`create_goals\` will not write the tree until every key result has one.

3. THE FIRST MOVE. The quarter is three months and this week is this week. Ask what the first actual move is, name the key result it sits under, and give it a date inside the next two weeks. Say plainly if you think they have picked the wrong one, and why.

When all three are on the card and they have said yes, call \`create_goals\`.

If they never told you what this quarter is for, ask them now, once, in their language, and build it from their answer.${quoted('their goal', fuel.goal)}`;
}

export function tasksBrief(fuel: BeatFuel = {}): string {
  return `Their tree is on the screen and it is real. Do not read it back to them.

Now the things with dates on them, and this is a shorter beat than the last one but not a throwaway.

Write their actual tasks out of what they told you: four to six, with real dates. If something is already late, put it first and say so.

Two things make this more than a list, and both need them to answer:

- FOR EACH ONE, does it move the quarter or not? Put the key result it serves in \`toward\`, and leave \`toward\` off the ones that are just this week's noise. Then say out loud how many of their next few days actually point at the thing they told you matters. If the answer is none of them, say that; it is the most useful sentence in this beat.
- ONE OF THEM IS FIRST. Ask them which single thing they do next, and mark exactly that one \`first\`. \`create_tasks\` will not write the board until exactly one is marked.

Also ask what they keep pushing: the thing that has moved three weeks running. Nobody volunteers that one, and it belongs on the board more than anything else on it.

Call \`propose_tasks\` in the same turn as you say them, then \`create_tasks\` when they say yes.${quoted('the next few days', fuel.next_days)}`;
}

export function calendarBrief(fuel: BeatFuel = {}): string {
  return `Those are on their board. Now their week, and the rhythm the two of you will actually run on.

Call \`read_week\` first and read the real shape of it back to them, briefly, including what the quarter needs and when it is due. Then find out when their day really starts and when it really ends.

You are setting BOTH ends, not just the morning:

- The morning brief, which is the appointment tomorrow depends on. Early enough to be waiting for them, not so early it is stale. Say why you picked the hour.
- The evening review, which is when the day gets closed off and the goals get their score. Ask when they actually stop, and take the honest answer rather than the aspirational one.

Call \`propose_daily_rhythm\` while you say the hours, and \`set_daily_rhythm\` when they agree. It refuses without both, because half a rhythm is a notification rather than a working relationship.${quoted('their days', fuel.next_days)}`;
}

export function workflowsBrief(fuel: BeatFuel = {}): string {
  return `This is the heavy one, and the last three beats are what earned it. TWO flows come out of this beat, not one.

The first comes from what they are drowning in. Take the biggest recurring piece of it and say plainly that it is yours now: what it will do, in steps, when it runs, and the line it must NEVER cross on its own. The never line is not optional and \`propose_workflow\` refuses without it: it is the sentence that makes a founder willing to let something run unattended, and it is the reason they will trust the next one.

The second comes from the tree you just built. Something has to keep their key results honest week to week, and nobody does that by hand for long. Propose the flow that does it.

Call \`propose_workflow\` while you say each one. When they say yes, call \`publish_workflow\`. It takes a few seconds of real building, so say that you are building it BEFORE you call it, never after.

If their week genuinely has only one recurring thing in it and you have asked properly, call \`no_second_workflow\` with the reason rather than inventing a second. Do not invent a second.${quoted('what they are drowning in', fuel.drowning)}`;
}

export function authorityBrief(): string {
  return `Both of those will act while they are not watching, which is exactly why this comes now. There are two halves to it and the second half is the one that matters.

FIRST, the number. Ask for level ${TRIAL_AUTHORITY_PROPOSED}, out loud, and say plainly what it buys and what it does not. At ${TRIAL_AUTHORITY_PROPOSED} you can read their things, write and change them, send them a message, run a command, open a browser, drive an app. You still cannot send email as them, install software, spend their money or delete anything. Say that you want it, and say they can pull you down.

SECOND, and do not skip it: ask what they want to keep their hand on anyway. Whatever the number says, some things should still come to them first, and they get to name them. Offer the real ones and let them choose: messages sent as them, commands run on their machine, changes written to their files, a browser driving their accounts, apps being controlled. Say which one you would pick if you were them, and why.

Call \`propose_authority\` while you are saying it, and \`set_authority\` when they answer, passing the number they gave you and the categories they named. Seven and above does not exist for these 48 hours and you do not ask for it, not even if they offer.`;
}

export function filesBrief(fuel: BeatFuel = {}): string {
  return `Everything they have told you so far, they told you. Now stop asking and go and look.

Offer to read their own files: the folder where the company actually lives on this machine. Say why, in one line, and say it as the thing it is. You will come back knowing their company from their own material rather than from an interview.

THIS IS THE MOST INVASIVE THING YOU WILL ASK THEM FOR, so ask for it properly and never assume it:

- Ask them to name ONE folder. Not their home directory, not the whole disk. The folder where the startup's documents are.
- Call \`propose_reading\` with what they said. It comes back with exactly what is in there, how many files, and how many you would open. Read that back to them and let them hear the number before they answer. It is on their screen too.
- Nothing is read until they say yes and you call \`start_reading\`. The level they just granted you does not cover this and does not stand in for their answer. If they say no, say that is fine, and call \`move_on\`.

Once it is running it runs in the background and you carry straight on talking. Do not narrate it and do not wait for it. Call \`reading_so_far\` silently as you go, the way you call \`remember\`, and when something real has landed, say what it found in their own terms: the people, the numbers, the things it now knows that they never said out loud. That is the moment this beat exists for.${quoted('their company', fuel.company)}`;
}

export function workspaceBrief(): string {
  return `You have read their files. Now do something about them, and this is where you stop being a conversation about a product.

TWO things, in order.

1. THE FOLDER. Offer to put everything about the company in one properly organised place. Say the sections out loud, in their language and derived from what you actually found, not a generic filing system. Say plainly and without being asked that nothing gets moved and nothing gets deleted: it copies, and every original stays exactly where it is. Call \`propose_workspace\` while you say it, and \`create_workspace\` when they say yes.

2. ONE REAL PIECE OF WORK. Then offer to do a specific thing you can genuinely do right now, on a specific file you have actually read. A page of the deck that undersells them. A README that does not say what the company does. The one document that contradicts the others. Name the file, say what you would change and why you would change it, and say what you think is wrong with it as it stands. Call \`propose_edit\`, and \`make_edit\` when they say yes. The rewritten version is written as a NEW file next to theirs, never over it, and say that too.

Both of these are refusable and neither is worth pushing twice. If they say no to either, take it, say something honest about why you offered, and call \`move_on\`.

Do not offer anything you cannot do inside this conversation. A promise here is worse than nothing.`;
}

export function agentsBrief(fuel: BeatFuel = {}): string {
  return `Last thing, and it is the only part of this that keeps working after you stop talking.

They mentioned something about their market or their business they have never had time to answer. Put someone on it. Say what you are sending them off to find out, then call \`spawn_research_agent\` with the question in their words and a brief saying what a useful answer would look like for them specifically.

If no such question ever came up, ask for one now, plainly: the thing about their market they would look into if they had a spare afternoon. Do not invent one for them, and do not settle for something you could answer yourself in a sentence. If reading their files threw up something nobody has an answer to, that is the best question available and you should use it.${quoted('the open question', fuel.open_question)}`;
}

export const FINALE_MESSAGE =
  'Spawned, and it is working now. Close the way a co-founder closes: that is the ' +
  'two of you set up, they should go and do their day, and the agent will be back ' +
  'shortly with what it found. Your own words, not those, and do NOT list what you ' +
  'built or thank them for their time. After that there is nothing left to set up: ' +
  'if they keep talking, you are simply their co-founder and the conversation ' +
  'carries on.';

/**
 * The brief for the beat that comes after `beat`, or the finale message when
 * `beat` was the last one. This is the whole of the "what happens next"
 * mechanism: no scheduler, no queue, one string handed back on a tool result.
 */
export function nextBrief(s: BeatsSession, fuel: BeatFuel): string {
  const next = currentBeat(s);
  if (!next) return FINALE_MESSAGE;
  switch (next) {
    case 'goals': return goalsBrief(fuel);
    case 'tasks': return tasksBrief(fuel);
    case 'calendar': return calendarBrief(fuel);
    case 'workflows': return workflowsBrief(fuel);
    case 'authority': return authorityBrief();
    case 'files': return filesBrief(fuel);
    case 'workspace': return workspaceBrief();
    case 'agents': return agentsBrief(fuel);
  }
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
            'The folder they named, as they said it. An absolute path, or one starting ' +
            'with ~. Ask them for it; never guess and never widen it.',
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
    name: 'spawn_research_agent',
    description:
      'The last one: put a research agent on the open question the founder ' +
      'has never had time to answer, and leave it running. It keeps working after ' +
      'the conversation ends, which is the whole point of ending here.',
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
  spawn_research_agent: 'agents',
};

/* ─────────────────────────── the executor ─────────────────────────── */

export type BeatSurfaces = {
  /** Lead them to the room this beat happens in (D21, D22). */
  enterRoom: (beat: RoomBeat, label: string) => void;
  /** Something landed in that room; make it show now rather than on the poll. */
  refreshRoom: (room: RoomKey) => void;
  /** Put a proposal on the founder's screen, or take it off. */
  showProposal: (proposal: BeatProposal | null) => void;
  /** A proposal just became real: what landed, for the card's last frame. */
  proposalLanded: (beat: RoomBeat, summary: string) => void;
  /** Every beat that completes, for the live surface and the report. */
  beatComplete: (beat: RoomBeat, detail: Record<string, unknown>) => void;
};

export type BeatActions = {
  /** Compose + publish a flow. Returns a short human sentence, or throws. */
  publishWorkflow: (p: WorkflowProposal) => Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
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
};

export type BeatDeps = BeatSurfaces & BeatActions & {
  fuel: () => BeatFuel;
  now: () => number;
  /** The founder's home directory, so the folder fence has something to refuse
   *  against. Injected rather than read here so the tests are not run against
   *  whoever's machine they happen to be on. */
  home?: () => string;
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

  const beat = TOOL_BEAT[name];
  if (!beat) return null;

  // The order gate (D16). Written as an instruction, not an error: a model
  // that reads "not available" invents an apology to the founder, and a model
  // that reads "you are still in X, do X" simply carries on.
  if (!s.open) return openingNotDone();
  if (!beatIsOpen(s, beat)) {
    const now = currentBeat(s);
    return {
      message:
        `Not yet. You are in the ${now} part of the work, not ${beat}. Finish that with ` +
        'them first; this will open when it does.',
    };
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
    case 'spawn_research_agent': return spawnResearchAgent(s, args, deps);
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
function nothingProposed(beat: RoomBeat, tool: string): BeatToolResult {
  return {
    message:
      `Nothing is on their screen yet. Say the ${beat} out loud and call the propose ` +
      `tool for it first, then \`${tool}\` once they have agreed.`,
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

/** One place, so a proposal can never go up without arming the gate. */
function putOnScreen(s: BeatsSession, proposal: BeatProposal, deps: BeatDeps): void {
  s.proposal = proposal;
  s.proposalShownAt = deps.now();
  deps.showProposal(proposal);
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
  if (p.firstMove) {
    const parent = created.find((c) => sameish(c.title, p.firstMove!.under)) ?? null;
    try {
      createGoal(p.firstMove.what, 'milestone', {
        parent_id: parent?.id ?? objective.id,
        status: 'active',
        time_horizon: 'weekly',
        ...(p.firstMove.due !== null ? { deadline: p.firstMove.due } : {}),
        tags: [TRIAL_BEATS_SOURCE],
      });
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
      'Live on their screen now.\n\n' + nextBrief(s, deps.fuel()),
  };
}

/**
 * Where a key result starts, as an OKR score.
 *
 * Only computed when both ends are actually numbers the founder said; anything
 * else starts at zero, because a made-up starting position is worse than an
 * honest one. "about three" against "40" is 0.075 and that is correct.
 */
export function baselineScore(kr: KeyResultProposal): number {
  const today = firstNumber(kr.today);
  const target = firstNumber(kr.target ?? kr.measure);
  if (today === null || target === null || target === 0) return 0;
  return Math.min(Math.max(today / target, 0), 1);
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
  deps.beatComplete('tasks', {
    created: created.length,
    late: p.tasks.filter((t) => t.late).length,
    toward: towardCount,
    first: firsts[0]!.what,
  });
  return {
    message:
      `On the board, ${created.length} of them, "${firsts[0]!.what}" at the top and ` +
      `${towardCount} pointing at the quarter.\n\n${nextBrief(s, deps.fuel())}`,
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

  return {
    message:
      `${parts.join('\n\n')}\n\nRead the shape of that back to them in one or two sentences, saying how ` +
      'their week and their quarter line up or do not. Then ask when their day actually starts, and when ' +
      'it actually ends.',
  };
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
  deps.beatComplete('calendar', { hour: p.hour, minute: p.minute, eveningHour: p.eveningHour });
  return {
    message:
      `Set. Their brief lands at ${fmtTime(p.hour, p.minute)} and the day gets closed off at ` +
      `${fmtTime(p.eveningHour, 0)}.\n\n${nextBrief(s, deps.fuel())}`,
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

  let outcome: { ok: boolean; detail: string };
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

  // D16.5 wants TWO, and the old version completed the beat on the first one,
  // which is why it never got a second: the model was handed the next brief
  // the instant it had a yes. The beat now stays open until there are two, or
  // until the model records that their week honestly has one.
  if (count < 2) {
    return {
      message:
        `"${p.name}" is live: ${outcome.detail}\n\nThat is one. The second one comes out of the tree the ` +
        'two of you built: something has to keep those key results honest week to week and nobody does ' +
        'that by hand for long. Propose it now. If you ask properly and their week genuinely has only ' +
        'this one recurring thing in it, call `no_second_workflow` rather than inventing one.',
    };
  }

  markDone(s, 'workflows');
  deps.beatComplete('workflows', { flows: [...s.workflowsPublished], published: count });
  return { message: `"${p.name}" is live too, ${count} flows now: ${outcome.detail}\n\n${nextBrief(s, deps.fuel())}` };
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
  deps.beatComplete('workflows', { flows: [...s.workflowsPublished], published: s.workflowsPublished.length, onlyOne: true, because });
  return {
    message:
      `Recorded: one flow, because ${because || 'their week has one'}. That is the honest answer and ` +
      `better than a second flow nobody asked for.\n\n${nextBrief(s, deps.fuel())}`,
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
      nextBrief(s, deps.fuel()),
  };
}

/* ── D42 · the files beat: their own material, read by something else ── */

function proposeReading(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const asked = str(args.folder);
  const verdict = resolveFounderFolder(asked, deps.home ? deps.home() : undefined);
  if (!verdict.ok) {
    return {
      message:
        `Not that: ${verdict.why}. Say that to them plainly and ask them to name the one folder where ` +
        'the company actually lives on this machine. Do not widen it and do not guess at a path.',
    };
  }

  let survey;
  try {
    survey = surveyFolder(verdict.path, deps.now());
  } catch (err) {
    console.warn('[TrialBeats] failed to survey', verdict.path, err);
    return { message: `${verdict.path} could not be opened. Say so and ask for a different folder.` };
  }

  // The degenerate cases, handled here rather than left to the model, because
  // "I read your company" said about an empty folder is the worst sentence in
  // the trial. Nothing is proposed and nothing is started in either case.
  if (survey.files.length === 0) {
    return {
      message:
        `${verdict.path} has nothing in it${survey.truncated ? ' at the level worth reading' : ''}. Say that ` +
        'out loud, because they probably think it does, and ask whether there is another folder or ' +
        'whether the company mostly lives somewhere that is not this machine. Nothing has been read.',
    };
  }
  if (survey.shortlist.length === 0) {
    return {
      message:
        `${verdict.path} has ${survey.files.length} files in it but none that can be opened as text: ` +
        `${survey.kinds.slice(0, 4).map((k) => `${k.n} ${k.ext}`).join(', ')}. Tell them exactly that, ` +
        'say you can see the names but not the insides, and ask whether there is a folder with the ' +
        'written material in it. Do not pretend to have read a PDF.',
    };
  }

  const proposal: FilesProposal = {
    beat: 'files',
    folder: verdict.path,
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
      `${verdict.path}: ${proposal.what}.\n\nThat is on their screen. Say the folder and the numbers out ` +
      'loud, in one sentence, and then ASK. Nothing is read until they answer and you call ' +
      '`start_reading`. Their authority level does not cover this and does not stand in for their yes. ' +
      'If they say no, or name a different folder, take it: `move_on`, or `propose_reading` again.',
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
  deps.beatComplete('files', { folder: pending.folder, willRead: p.willRead, agentId: started.agentId });

  return {
    message:
      `It is reading ${p.willRead} of their files now, in the background, and it will be a couple of ` +
      'minutes. Do NOT wait for it and do not narrate it.\n\n' +
      'Keep talking to them about their company while it runs, and call `reading_so_far` silently as ' +
      'you go, the way you call `remember`. The first time something real has landed, stop whatever ' +
      'you were saying and tell them what it found: the people, the numbers, the things you now know ' +
      'that they never said out loud. That is the moment this is for.\n\n' +
      nextBrief(s, deps.fuel()),
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

  if (progress.found.length === 0) {
    return {
      message: progress.finished
        ? `It has finished and found nothing about the company in ${s.files.folder}. ` +
          (s.files.summary ? `It said: ${s.files.summary}\n\n` : '') +
          'Say that straight, without dressing it up, and without inventing a finding. Ask whether the ' +
          'real material is somewhere else. Then carry on.'
        : 'Nothing has landed yet. Say NOTHING about it and carry on with what you were talking about.',
    };
  }

  return {
    message:
      `${progress.found.length} things about their company have landed from their own files` +
      `${progress.finished ? ' and it has finished' : ' and it is still reading'}:\n` +
      progress.found.slice(0, 30).map((f) => `- ${f}`).join('\n') +
      (s.files.summary ? `\n\nWhat it made of the whole folder: ${s.files.summary}` : '') +
      '\n\nIf you have not already, say some of this back to them now. Their words for their own things, ' +
      'the specific ones, and the ones they never mentioned to you are the ones worth naming. Do not read ' +
      'the whole list out and do not say where you got each one.',
  };
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

  const destination = str(args.destination) || defaultWorkspacePath(s.files.folder, title);
  const plan: WorkspaceProposal = {
    beat: 'workspace', kind: 'workspace', destination, source: s.files.folder, title, sections,
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
      `On their screen: ${destination}, ${sections.length} sections, ${totalFiles} files copied into it.\n\n` +
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
  const verdict = checkWorkspacePlan({
    destination: p.destination, source: p.source, title: p.title, sections: p.sections,
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

  s.workspace = { destination: result.destination, copied: result.copied, sections: result.sections };
  takeOffScreen(s);
  markDone(s, 'workspace');
  deps.proposalLanded('workspace', `${result.destination} · ${result.copied} files copied`);
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
      `Built: ${result.destination}, ${result.sections} sections, ${result.copied} files copied, and a ` +
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
  return `${stem} — rewritten${ext}`;
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
      `Written: ${written.path}. Their ${p.file} is exactly as it was.\n\nTell them where it is and what ` +
      `you changed, in a sentence, and say plainly that the original is untouched and they can throw ` +
      `yours away.\n\n${nextBrief(s, deps.fuel())}`,
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
  return {
    message:
      `Left alone, and that is theirs to decide. Do not raise it again and do not sound disappointed.` +
      `\n\n${nextBrief(s, deps.fuel())}`,
  };
}

/* ── beat 12 · agents, the finale ── */

async function spawnResearchAgent(
  s: BeatsSession,
  args: Record<string, unknown>,
  deps: BeatDeps,
): Promise<BeatToolResult> {
  const question = str(args.question);
  const brief = str(args.brief);
  if (!question) {
    return { message: 'Error: no question came through. Say the question they have never had time to answer, in their words.' };
  }

  deps.enterRoom('agents', 'the agent');
  let spawned: { agentId: string; taskId: string | null; agentName: string };
  try {
    spawned = await deps.spawnResearchAgent(question, brief);
  } catch (err) {
    console.warn('[TrialBeats] failed to spawn the research agent', err);
    return {
      message:
        `The agent would not start: ${err instanceof Error ? err.message : String(err)}\n\n` +
        'Say plainly that you could not put anyone on it yet, and that you will. Do not pretend it is running.',
    };
  }

  s.agent = { ...spawned, question };
  markDone(s, 'agents');
  s.finishedAt = deps.now();
  deps.refreshRoom('agents');
  deps.beatComplete('agents', { question, agentId: spawned.agentId, agentName: spawned.agentName });
  try {
    deps.onFinished(s);
  } catch (err) {
    console.warn('[TrialBeats] finished listener failed', err);
  }
  return { message: FINALE_MESSAGE };
}
