/**
 * The seven room beats of the trial: what Jarvis and the founder actually DO
 * together, in a fixed order, without the conversation ever stopping.
 *
 * This is beats 06 to 12 of the trial spec. It attaches to the seam the
 * opening left behind (`conclude_opening` in `conductor.ts`) and it is the
 * second half of the same conversation, not a phase that follows it.
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
import { createGoal } from '../../vault/goals.ts';
import type { Goal } from '../../goals/types.ts';
import { parseRelativeDate } from '../../voice/parse-date.ts';
import type { LLMTool } from '../../llm/provider.ts';
import type { RoomKey } from '../../voice/intent.ts';

/** Vault `source` for everything the room beats write. Distinct from the
 *  opening's `trial_conductor` so the D38 debrief can tell "what it learned
 *  while you talked" from "what the two of you built". */
export const TRIAL_BEATS_SOURCE = 'trial_room_beats';

/**
 * The six beats that are stops, in D16's order. `memory` is D16's first beat
 * and is deliberately absent: it is not a stop, it is `remember` running
 * underneath all six of these.
 */
export const ROOM_BEATS = ['goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents'] as const;

export type RoomBeat = (typeof ROOM_BEATS)[number];

/** Which dashboard room each beat happens in. */
export const BEAT_ROOM: Record<RoomBeat, RoomKey> = {
  goals: 'goals',
  tasks: 'tasks',
  calendar: 'calendar',
  workflows: 'workflows',
  authority: 'authority',
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

export type GoalProposal = {
  beat: 'goals';
  objective: string;
  measure?: string;
  keyResults: { title: string; measure?: string }[];
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
  }[];
};

export type CalendarProposal = {
  beat: 'calendar';
  hour: number;
  minute: number;
  because?: string;
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
};

export type BeatProposal =
  | GoalProposal
  | TaskProposal
  | CalendarProposal
  | WorkflowProposal
  | AuthorityProposal;

/* ─────────────────────────── session state ─────────────────────────── */

export type BeatsSession = {
  /** True once `conclude_opening` fired. Nothing below opens before it. */
  open: boolean;
  /** Beats that have happened, in order. */
  done: RoomBeat[];
  /** The one proposal currently on the founder's screen. */
  proposal: BeatProposal | null;
  /** D16.5 wants two flows. Names, in publish order. */
  workflowsPublished: string[];
  /** What the founder ended up granting. */
  authorityLevel: number | null;
  /** The brief hour they chose, as {hour, minute}. */
  briefAt: { hour: number; minute: number } | null;
  /** Beat 12's output, and the seam into beat 14. */
  agent: { agentId: string; taskId: string | null; agentName: string; question: string } | null;
  /** When the seventh beat closed. Onboarding is over at this moment. */
  finishedAt: number | null;
};

export function createBeatsSession(): BeatsSession {
  return {
    open: false,
    done: [],
    proposal: null,
    workflowsPublished: [],
    authorityLevel: null,
    briefAt: null,
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

export function goalsBrief(fuel: BeatFuel = {}): string {
  return `${NOTHING_ABOUT_THIS}

Now the two of you start doing the work, and the first thing is their quarter.

Write it as ONE objective with two to four key results underneath, out of the sentences they actually said. Their words, their numbers, no OKR vocabulary and no invented metrics. If they gave you a number, it is a key result. If they gave you a date inside the quarter, say so.

Say it out loud as a proposal and call \`propose_goals\` in the SAME turn, so it is on their screen while you are still saying it. Then ask them plainly whether to make it real.

They say yes: call \`create_goals\`. They want it different: call \`propose_goals\` again with the change and ask again. Never write it without them.

If they never actually told you what this quarter is for, ask them now, once, in their language, and write it from their answer.${quoted('their goal', fuel.goal)}`;
}

export function tasksBrief(fuel: BeatFuel = {}): string {
  return `Their tree is on the screen and it is real. Do not read it back to them.

Next, the things with dates on them. Out of what they told you about the next few days, write their actual tasks, and if something is already late, put it first and say so. Four or five at most: this beat is momentum, not thoroughness.

Call \`propose_tasks\` in the same turn as you say them, then \`create_tasks\` when they say yes.${quoted('the next few days', fuel.next_days)}`;
}

export function calendarBrief(fuel: BeatFuel = {}): string {
  return `Those are on their board. Now their week.

Call \`read_week\` and read the actual shape of it back to them, briefly. Then find out when their day really starts, and from that propose the hour their morning brief arrives, with a reason: early enough to be waiting for them, not so early it is stale.

Call \`propose_morning_brief\` while you say the hour, and \`set_morning_brief\` when they agree. This is the appointment tomorrow depends on, so do not let it pass as a throwaway.${quoted('their days', fuel.next_days)}`;
}

export function workflowsBrief(fuel: BeatFuel = {}): string {
  return `This is the heavy one, and the last three beats are what earned it.

They told you what they are drowning in. Take the biggest recurring piece of it and say plainly that it is yours now: what it will do, in steps, when it runs, and anything it must never do on its own. Call \`propose_workflow\` while you say it.

When they say yes, call \`publish_workflow\`. It takes a few seconds to build, so say that you are building it BEFORE you call it, never after.

Then do a second one if their week has a second one in it. Two is the target. One is fine if one is all they have.${quoted('what they are drowning in', fuel.drowning)}`;
}

export function authorityBrief(): string {
  return `Both of those will act while they are not watching, which is exactly why this comes now.

Ask for level ${TRIAL_AUTHORITY_PROPOSED}, out loud, and say plainly what it buys and what it does not. At ${TRIAL_AUTHORITY_PROPOSED} you can read their things, write and change them, send them a message, run a command, open a browser, drive an app. You still cannot send email as them, install software, spend their money or delete anything. Say that you want it, and say they can pull you down.

Call \`propose_authority\` while you are saying it, and \`set_authority\` when they answer, passing the number they gave you if they gave one. Seven and above does not exist for these 48 hours and you do not ask for it, not even if they offer.`;
}

export function agentsBrief(fuel: BeatFuel = {}): string {
  return `Last thing, and it is the only part of this that keeps working after you stop talking.

They mentioned something about their market or their business they have never had time to answer. Put someone on it. Say what you are sending them off to find out, then call \`spawn_research_agent\` with the question in their words and a brief saying what a useful answer would look like for them specifically.

If no such question ever came up, ask for one now, plainly: the thing about their market they would look into if they had a spare afternoon. Do not invent one for them, and do not settle for something you could answer yourself in a sentence.${quoted('the open question', fuel.open_question)}`;
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
    case 'agents': return agentsBrief(fuel);
  }
}

/* ─────────────────────────── the tools ─────────────────────────── */

const PROPOSE_NOTE =
  'Writes nothing. It puts the proposal on the founder\'s screen so they can ' +
  'see it while you say it, which is the point: they approve something in ' +
  'front of them, not something they half-heard.';

export const ROOM_BEAT_TOOLS: LLMTool[] = [
  {
    name: 'propose_goals',
    description:
      'Beat 2 of the work: put their quarter on screen as one objective with key ' +
      `results under it, built out of what they told you. ${PROPOSE_NOTE} ` +
      'Call it again with the change if they want it different.',
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
        key_results: {
          type: 'array',
          description: 'Two to four results that would add up to the objective. Their numbers, not yours.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The result, as they would say it. "12 booked demos a month".' },
              measure: { type: 'string', description: 'The number or the date it turns on, if there is one.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['objective', 'key_results'],
    },
  },
  {
    name: 'create_goals',
    description:
      'Make the goal tree currently on their screen real. Call this ONLY after ' +
      'they have said yes out loud. Creates exactly what was proposed, nothing else.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_tasks',
    description:
      'Beat 3: put their real, dated tasks on screen, including anything already ' +
      `late. ${PROPOSE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Four or five at most. Small, concrete, and theirs.',
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
      'Creates exactly what was proposed.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_week',
    description:
      'Beat 4: open their calendar and read what is actually on the next seven ' +
      'days, so you can talk about their real week instead of guessing. Writes ' +
      'nothing. Overdue things come back too.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_morning_brief',
    description:
      `Put the hour their morning brief will arrive on screen. ${PROPOSE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        hour: { type: 'number', description: 'Hour of the day, 0 to 23.' },
        minute: { type: 'number', description: 'Minutes past the hour, 0 to 59. 30 for "half seven".' },
        because: { type: 'string', description: 'The reason, in one short clause: "you are at the desk by eight".' },
      },
      required: ['hour'],
    },
  },
  {
    name: 'set_morning_brief',
    description:
      'Lock in the brief hour currently on their screen, after they agreed. This ' +
      'is a real setting: it is when tomorrow morning actually arrives.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_workflow',
    description:
      'Beat 5: put a standing flow on screen, taken from the recurring manual work ' +
      `they described. ${PROPOSE_NOTE} Do not call \`publish_workflow\` until they say yes.`,
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
            'The line it must not cross on its own, if there is one. "Drafts the client ' +
            'update but never sends it." Say this out loud too: it is the reason they trust it.',
        },
      },
      required: ['name', 'runs_when', 'steps'],
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
    name: 'propose_authority',
    description:
      'Beat 6: put the authority ladder on screen with the level you are asking ' +
      `for marked on it. ${PROPOSE_NOTE} Ask for ${TRIAL_AUTHORITY_PROPOSED}.`,
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'number',
          description: `The level you are asking for. ${TRIAL_AUTHORITY_PROPOSED} unless they have already named a lower one.`,
        },
      },
    },
  },
  {
    name: 'set_authority',
    description:
      'Set the authority level for real, after they answered. Pass the number they ' +
      'said if they said one, otherwise it takes the level you proposed. Anything ' +
      `above ${TRIAL_AUTHORITY_CEILING} is refused during a trial, whatever they say.`,
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'The number they agreed to.' },
      },
    },
  },
  {
    name: 'spawn_research_agent',
    description:
      'Beat 7, the last one: put a research agent on the open question the founder ' +
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
];

export const ROOM_BEAT_TOOL_NAMES: ReadonlySet<string> = new Set(ROOM_BEAT_TOOLS.map((t) => t.name));

/** Which beat each tool belongs to, for the order gate. */
const TOOL_BEAT: Record<string, RoomBeat> = {
  propose_goals: 'goals',
  create_goals: 'goals',
  propose_tasks: 'tasks',
  create_tasks: 'tasks',
  read_week: 'calendar',
  propose_morning_brief: 'calendar',
  set_morning_brief: 'calendar',
  propose_workflow: 'workflows',
  publish_workflow: 'workflows',
  propose_authority: 'authority',
  set_authority: 'authority',
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
  /** Persist the morning brief hour into the goal rhythm. */
  setMorningBrief: (hour: number, minute: number) => void;
  /** Persist the authority level. Returns the level that actually landed. */
  setAuthorityLevel: (level: number) => number;
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
  const beat = TOOL_BEAT[name];
  if (!beat) return null;

  // The order gate (D16). Written as an instruction, not an error: a model
  // that reads "not available" invents an apology to the founder, and a model
  // that reads "you are still in X, do X" simply carries on.
  if (!s.open) {
    return {
      message:
        'Not yet. You are still in the opening and you have not called `conclude_opening`. ' +
        'Keep talking about their company until you understand it well enough to start work.',
    };
  }
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
    case 'propose_morning_brief': return proposeMorningBrief(s, args, deps);
    case 'set_morning_brief': return setMorningBrief(s, deps);
    case 'propose_workflow': return proposeWorkflow(s, args, deps);
    case 'publish_workflow': return publishWorkflow(s, deps);
    case 'propose_authority': return proposeAuthority(s, args, deps);
    case 'set_authority': return setAuthority(s, args, deps);
    case 'spawn_research_agent': return spawnResearchAgent(s, args, deps);
    default: return null;
  }
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

/* ── beat 07 · goals ── */

function proposeGoals(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const objective = str(args.objective);
  if (!objective) return { message: 'Error: the objective was empty. Say their quarter in one line and call this again.' };

  const rawKrs = Array.isArray(args.key_results) ? args.key_results : [];
  const keyResults: GoalProposal['keyResults'] = [];
  for (const raw of rawKrs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title);
    if (!title) continue;
    const measure = str(r.measure);
    keyResults.push({ title, ...(measure ? { measure } : {}) });
  }
  if (keyResults.length === 0) {
    return { message: 'Error: no key results came through. An objective on its own is a wish; give it two to four results.' };
  }

  const measure = str(args.measure);
  const proposal: GoalProposal = { beat: 'goals', objective, ...(measure ? { measure } : {}), keyResults };
  s.proposal = proposal;
  deps.enterRoom('goals', 'their quarter');
  deps.showProposal(proposal);
  return {
    message:
      `On their screen: "${objective}" with ${keyResults.length} key result${keyResults.length === 1 ? '' : 's'}. ` +
      'Now ask them, out loud, whether to make it real. Do not read the list back to them, they can see it.',
  };
}

function createGoals(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'goals') return nothingProposed('goals', 'create_goals');

  let objective: Goal;
  try {
    objective = createGoal(p.objective, 'objective', {
      status: 'active',
      time_horizon: 'quarterly',
      ...(p.measure ? { success_criteria: p.measure } : {}),
      tags: [TRIAL_BEATS_SOURCE],
    });
  } catch (err) {
    console.warn('[TrialBeats] failed to create objective', err);
    return { message: 'That did not save. Tell them plainly that it did not take, and try `create_goals` once more.' };
  }

  let made = 1;
  p.keyResults.forEach((kr, i) => {
    try {
      createGoal(kr.title, 'key_result', {
        parent_id: objective.id,
        status: 'active',
        time_horizon: 'quarterly',
        ...(kr.measure ? { success_criteria: kr.measure } : {}),
        sort_order: i,
        tags: [TRIAL_BEATS_SOURCE],
      });
      made++;
    } catch (err) {
      console.warn('[TrialBeats] failed to create key result', kr.title, err);
    }
  });

  s.proposal = null;
  markDone(s, 'goals');
  deps.proposalLanded('goals', `${p.objective} · ${p.keyResults.length} key results`);
  deps.refreshRoom('goals');
  deps.beatComplete('goals', { objective: p.objective, keyResults: p.keyResults.length, goalsCreated: made });
  return { message: `Created, ${made} goals, live on their screen now.\n\n${nextBrief(s, deps.fuel())}` };
}

/* ── beat 08 · tasks ── */

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
    tasks.push({ what, due, dueLabel: dueRaw || null, priority, late });
  }
  if (tasks.length === 0) {
    return { message: 'Error: no tasks came through. Name the ones they actually said and call this again.' };
  }

  const proposal: TaskProposal = { beat: 'tasks', tasks };
  s.proposal = proposal;
  deps.enterRoom('tasks', 'their week');
  deps.showProposal(proposal);
  const lateCount = tasks.filter((t) => t.late).length;
  return {
    message:
      `On their screen: ${tasks.length} task${tasks.length === 1 ? '' : 's'}` +
      `${lateCount > 0 ? `, ${lateCount} already late` : ''}. Say the late one first if there is one, ` +
      'then ask whether to put them on the board.',
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

  const created: Commitment[] = [];
  for (const t of p.tasks) {
    try {
      created.push(
        createCommitment(t.what, {
          ...(t.due !== null ? { when_due: t.due } : {}),
          priority: t.priority,
          created_from: TRIAL_BEATS_SOURCE,
          assigned_to: 'user',
        }),
      );
    } catch (err) {
      console.warn('[TrialBeats] failed to create task', t.what, err);
    }
  }
  if (created.length === 0) {
    return { message: 'None of those saved. Say so plainly and try `create_tasks` again.' };
  }

  s.proposal = null;
  markDone(s, 'tasks');
  deps.proposalLanded('tasks', `${created.length} on the board`);
  deps.refreshRoom('tasks');
  deps.beatComplete('tasks', { created: created.length, late: p.tasks.filter((t) => t.late).length });
  return { message: `On the board, ${created.length} of them.\n\n${nextBrief(s, deps.fuel())}` };
}

/* ── beat 09 · calendar ── */

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
    `- ${c.what}${c.when_due ? ` (${new Date(c.when_due).toDateString()})` : ''}`;
  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`Already late:\n${overdue.slice(0, 8).map(line).join('\n')}`);
  parts.push(
    upcoming.length > 0
      ? `The next seven days:\n${upcoming.map(line).join('\n')}`
      : 'The next seven days are empty apart from what the two of you just put on the board.',
  );
  return {
    message:
      `${parts.join('\n\n')}\n\nRead the shape of that back to them in one or two sentences, then ask ` +
      'when their day actually starts.',
  };
}

function proposeMorningBrief(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const hour = clampBriefHour(args.hour);
  const minute = clampBriefMinute(args.minute);
  const because = str(args.because);
  const proposal: CalendarProposal = { beat: 'calendar', hour, minute, ...(because ? { because } : {}) };
  s.proposal = proposal;
  deps.enterRoom('calendar', 'the brief hour');
  deps.showProposal(proposal);
  return {
    message: `On their screen: the brief at ${fmtTime(hour, minute)}. Say the hour and why, then let them answer.`,
  };
}

export function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function setMorningBrief(s: BeatsSession, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'calendar') return nothingProposed('calendar', 'set_morning_brief');

  try {
    deps.setMorningBrief(p.hour, p.minute);
  } catch (err) {
    console.warn('[TrialBeats] failed to set the brief hour', err);
    return { message: 'That hour did not save. Say so and try `set_morning_brief` again.' };
  }

  s.briefAt = { hour: p.hour, minute: p.minute };
  s.proposal = null;
  markDone(s, 'calendar');
  deps.proposalLanded('calendar', `brief at ${fmtTime(p.hour, p.minute)}, every day`);
  deps.refreshRoom('calendar');
  deps.beatComplete('calendar', { hour: p.hour, minute: p.minute });
  return { message: `Set. Their brief lands at ${fmtTime(p.hour, p.minute)}.\n\n${nextBrief(s, deps.fuel())}` };
}

/* ── beat 10 · workflows ── */

function proposeWorkflow(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const name = str(args.name);
  const runsWhen = str(args.runs_when);
  const steps = (Array.isArray(args.steps) ? args.steps : []).map(str).filter(Boolean);
  if (!name || !runsWhen || steps.length === 0) {
    return { message: 'Error: a flow needs a name, when it runs, and what it does. Say it out loud and call this again.' };
  }
  const never = str(args.never);
  const proposal: WorkflowProposal = { beat: 'workflows', name, runsWhen, steps, ...(never ? { never } : {}) };
  s.proposal = proposal;
  deps.enterRoom('workflows', 'the flow');
  deps.showProposal(proposal);
  return {
    message:
      `On their screen: "${name}", ${steps.length} steps, ${runsWhen}. Say what it takes off them, ` +
      `${never ? 'say what it will never do on its own, ' : ''}then ask.`,
  };
}

async function publishWorkflow(s: BeatsSession, deps: BeatDeps): Promise<BeatToolResult> {
  const p = s.proposal;
  if (!p || p.beat !== 'workflows') return nothingProposed('workflows', 'publish_workflow');

  // The composer is a real LLM round trip and the founder is listening to
  // silence while it runs. Marking the card as building is what makes that
  // silence legible: they can see it working rather than wondering.
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
  s.proposal = null;
  const count = s.workflowsPublished.length;
  markDone(s, 'workflows');
  deps.proposalLanded('workflows', `${p.name} · published`);
  deps.refreshRoom('workflows');
  deps.beatComplete('workflows', { name: p.name, published: count });

  if (count === 1) {
    return {
      message:
        `"${p.name}" is live: ${outcome.detail}\n\nIf their week has a second recurring thing in it, do that ` +
        'one now the same way. If it does not, move on.\n\n' + authorityBrief(),
    };
  }
  return { message: `"${p.name}" is live too: ${outcome.detail}\n\n${nextBrief(s, deps.fuel())}` };
}

/* ── beat 11 · authority ── */

function proposeAuthority(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const level = args.level === undefined ? TRIAL_AUTHORITY_PROPOSED : clampAuthorityLevel(args.level);
  const proposal: AuthorityProposal = { beat: 'authority', level };
  s.proposal = proposal;
  deps.enterRoom('authority', 'what you may do');
  deps.showProposal(proposal);
  return {
    message:
      `The ladder is on their screen with ${level} marked. Ask for it out loud, say what it buys and ` +
      'what it still will not touch, and tell them they can pull you down.',
  };
}

function setAuthority(s: BeatsSession, args: Record<string, unknown>, deps: BeatDeps): BeatToolResult {
  const p = s.proposal;
  if (!p || p.beat !== 'authority') return nothingProposed('authority', 'set_authority');

  const asked = args.level === undefined ? p.level : Math.round(Number(args.level));
  const level = clampAuthorityLevel(args.level === undefined ? p.level : args.level);

  let landed: number;
  try {
    landed = deps.setAuthorityLevel(level);
  } catch (err) {
    console.warn('[TrialBeats] failed to set authority', err);
    return { message: 'That did not save. Say so and try `set_authority` again.' };
  }

  s.authorityLevel = landed;
  s.proposal = null;
  markDone(s, 'authority');
  deps.proposalLanded('authority', `level ${landed}`);
  deps.refreshRoom('authority');
  deps.beatComplete('authority', { level: landed, asked });

  const capped =
    Number.isFinite(asked) && asked > TRIAL_AUTHORITY_CEILING
      ? `They offered ${asked}. It is ${landed}: seven and above is not on the table during a trial, ` +
        'and you should say that plainly rather than let them think they gave you more than they did. '
      : '';
  return { message: `Set to ${landed}. ${capped}\n\n${nextBrief(s, deps.fuel())}` };
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
