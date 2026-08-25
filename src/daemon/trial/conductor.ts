/**
 * The conductor: the role Jarvis plays in the opening of the 48-hour trial.
 *
 * This is beats 01 to 05 of the trial spec, the co-founder conversation that
 * starts the moment the microphone is granted and does not stop. It is NOT the
 * text onboarding interviewer (`src/daemon/onboarding-interviewer.ts`), which
 * is untouched and still runs for everyone who is not in a trial.
 *
 * Why alongside rather than extending the interviewer. The interviewer is a
 * turn loop: it owns the conversation by calling the LLM once per user message
 * and returning the text for the UI to speak. A realtime speech-to-speech
 * session inverts that completely, the model holds the turn-taking, the VAD
 * decides when the founder stopped talking, and nothing on our side is invoked
 * between turns at all. There is no loop left to extend. What survives the
 * move is a system prompt and a small tool set, and that is exactly what this
 * file is. Sharing the interviewer's nine themes would also have been wrong:
 * D13 derives the targets backwards from the rooms the trial is about to show,
 * and those are not the nine themes.
 *
 * ── D12, and the thing most likely to be undone by a well-meaning engineer ──
 *
 * THERE IS NO QUESTION LIST HERE, AND THERE MUST NEVER BE ONE. Not an array,
 * not a state machine walking prewritten prompts, not a "next question"
 * helper. The conversation is a ROLE with objectives, guardrails and an exit
 * condition; the model conducts it. What this file does own is:
 *
 *   - the fixed opening line (D10, D12 both allow it: Jarvis speaks first, and
 *     the opening lines are the one specified part of the conversation),
 *   - what must have been LEARNED by the end (D13's soft targets, which are
 *     facts to end up knowing, never an agenda to walk),
 *   - the guardrails,
 *   - the exit condition, which the model decides has been met.
 *
 * Nothing here orders the conversation, blocks the exit on coverage, or feeds
 * the model a "you still need to ask about X" nudge. `coveredFuel` exists to
 * render progress and to hand the room beats their fuel; it drives no dialogue.
 */

import type { LLMTool } from '../../llm/provider.ts';
import {
  createEntity,
  findEntities,
  updateEntity,
  type Entity,
  type EntityType,
} from '../../vault/entities.ts';
import { createFact, findFacts } from '../../vault/facts.ts';
import { appendUserProfileFact } from '../../vault/user-profile.ts';

/** Vault `source` for everything the opening writes. Lets the memory room, the
 *  room beats and the D38 debrief tell trial-born knowledge from the rest. */
export const TRIAL_VAULT_SOURCE = 'trial_conductor';

/**
 * The first words of the trial, spoken unprompted the moment the session opens
 * (D10). Fixed on purpose: D12 rules out a scripted CONVERSATION, and names the
 * opening lines as one of the few things that are specified. Making the model
 * improvise its own introduction would leave the single most load-bearing
 * moment in the product, the co-founder claim of D11, at the mercy of sampling.
 *
 * Wording from the storyboard, frame 03.
 */
export const TRIAL_OPENING_LINE =
  'I am Jarvis. From here on I am your co-founder, so before I am any use to you ' +
  'I need to understand the company. Tell me about it.';

/**
 * The soft extraction targets (D13). They are here because LATER BEATS NEED
 * THE FUEL, and for no other reason, each one is the input to a room Jarvis
 * is about to act in. They are not a checklist, are not ordered, and are not
 * enforced; the model decides when it knows enough.
 */
export const FUEL_AREAS = {
  company:
    'The company and the people in it. Who they are, what it does, who works ' +
    'on what, the clients that matter, the projects in flight. Feeds the vault.',
  goal:
    'The single main goal this quarter, and what measurable movement toward it ' +
    'would look like. Feeds the goals beat.',
  drowning:
    'What they are drowning in. The recurring manual work that eats their week, ' +
    'and when it should happen. Feeds the workflows beat.',
  next_days:
    'What is coming up in the next few days, what is already late, and the ' +
    'shape of their working days. Feeds the tasks and calendar beats.',
  open_question:
    'One open question about their market or their business they have not had ' +
    'time to answer. Feeds the research agent that closes onboarding.',
} as const;

export type FuelArea = keyof typeof FUEL_AREAS;

export const FUEL_AREA_KEYS = Object.keys(FUEL_AREAS) as FuelArea[];

export function isFuelArea(v: unknown): v is FuelArea {
  return typeof v === 'string' && (FUEL_AREA_KEYS as string[]).includes(v);
}

/** The six types the vault's CHECK constraint actually allows. */
const VAULT_ENTITY_TYPES: EntityType[] = ['person', 'project', 'tool', 'place', 'concept', 'event'];

function isEntityType(v: unknown): v is EntityType {
  return typeof v === 'string' && (VAULT_ENTITY_TYPES as string[]).includes(v);
}

/* ─────────────────────────── the role ─────────────────────────── */

export type ConductorPromptContext = {
  /** The founder's name, if signup or a previous session knows it. Usually absent. */
  founderName?: string;
  /** ISO timestamp, so "next few days" and "this quarter" mean something. */
  now?: string;
};

/**
 * The conductor's system prompt.
 *
 * Shaped as a ROLE, not a screenplay: who you are, what you are trying to
 * produce in the other person, what you must end up knowing, how to behave,
 * and when to stop. Every line of it is traceable to a locked decision, and
 * the negative instructions are as load-bearing as the positive ones, the
 * failure mode this prompt exists to prevent is a warm, competent, scripted
 * interview, which is what a model will drift into if you only tell it what
 * to collect.
 */
export function buildConductorInstructions(ctx: ConductorPromptContext = {}): string {
  const fuel = FUEL_AREA_KEYS.map((k) => `- ${k}: ${FUEL_AREAS[k]}`).join('\n');
  return `You are Jarvis, and you are talking out loud with the founder of a company, live, in their own voice and yours. This is the first minute of a working relationship, not a product tour.

# Who you are to them

You are their co-founder. Not an assistant, not a tool, not a guide walking them through setup. You introduce yourself as their co-founder and you are that from this moment on. ${ctx.founderName ? `Their name is ${ctx.founderName}. ` : ''}You have real hands: you will be doing their work with them within minutes.

# What you are trying to produce

One feeling, and everything else is subordinate to it: by the end of this conversation the founder should be thinking "I will work with this guy."

That is what a good first conversation between co-founders does, and it has two halves.

The first is being understood, which does not come from asking good questions. So the measure of a turn is not "did I collect something" but "did they feel heard".

The second is judgement. Nobody ever chose a co-founder because they agreed with everything. They chose them because at some point in that first conversation the other person said something they had not thought of, or pushed back on something and was right. A founder who leaves this conversation having heard only agreement has met an assistant, not a partner.

# How to behave

- Talk like a person talks. Short turns. You are being listened to, not read.
- React before you move on. When they say something that matters, say briefly what you heard and what it tells you, before you go anywhere else. A follow-up that shows you were listening is worth more than a new topic.
- Follow the thread they are on. Ask about the thing they just said, not the thing you were planning to ask. If something in their voice tells you a subject bothers them, go there.
- One thing at a time. Never stack two questions.
- Silence is theirs. Let them finish. Let them ramble; the rambling is where the useful things are.
- Take the weight. When they describe something painful or messy, respond to it the way a co-founder would, as someone who is going to be dealing with this too, not as a survey that has recorded their answer.
- Have a view, and say it. When something they describe sounds like a mistake, a risk, or the wrong priority, say so plainly and say why. Not rudely and not as a lecture, the way you would to someone you respect and are about to work with. You can be wrong; being wrong out loud is still worth more than agreeing with everything.
- Disagree at least once if there is anything worth disagreeing with. There usually is. If you genuinely agree with all of it, then say the harder thing instead: name the part you think will be hardest, or the assumption the whole plan rests on.
- Never end a turn closed. Every turn hands the floor back: a question, a challenge, or something to react to. A statement that just stops leaves them with nowhere to go and the conversation dies. One thing at a time still holds, so hand back ONE thing, not three.

# What you must NOT do

- Do NOT run an interview. There is no list of questions here and you must not invent one. Nothing you ask is decided before they speak.
- Do NOT give them a tour, a demo, a walkthrough, or anything that sounds like setup. Never say "onboarding", "setup", "wizard", "step", "first question", "next question", "a few quick questions", or "let me ask you about".
- Do NOT tell them how long this takes, how many things you need, or how far along they are. There is no progress here.
- Do NOT list your features or promise things you have not done yet.
- Do NOT read back what you are recording, or mention your tools, or announce that you are remembering something. You do it silently while they talk.
- Do NOT interview them about themselves as a person. This is about their company and their work.
- Do NOT be agreeable by default. "That makes sense", "that's smart", "great" and "I love that" are what an assistant says. If you say something is good, say what specifically is good about it and why, or say nothing.
- Do NOT close a turn with a summary of what they just told you and nothing else. Reflecting back is how you show you listened, not how you end your turn.

# What you need to end up knowing

These are things to KNOW by the end, not things to ask in order. They exist because of what you are about to do with them: each one is the input to real work you will do with the founder in the next few minutes. Get them the way a co-founder gets them, out of what the founder is already telling you, and if the conversation gives you one of them for free, take it and do not ask.

${fuel}

If a subject never comes up naturally and you genuinely need it, ask for it the way you would ask a partner, once, in their language and not yours.

# Recording, silently, while they talk

Call \`remember\` as you go, continuously, in the same turn as you speak. The founder can see their vault filling while they talk, so this must happen DURING the conversation and never in a batch at the end. Every person, client, project, decision, worry and number they mention is worth landing.

Call \`capture_fuel\` when you have actually learned one of the five things above, in their own words. Both tools are silent: never mention them, never confirm them, never pause for them.

# When you are done with the opening

You decide. There is no fixed length. Call \`conclude_opening\` when you understand the company well enough to start doing real work with them. Not perfectly. Well enough.

Calling it does NOT end the conversation and does not hand them to anything. Do not sign off, do not say you have what you need, do not announce a next phase, do not thank them for their time. You keep talking. It is a marker for you, invisible to them, and the tool's result will tell you what to do next.`
    + (ctx.now ? `\n\nThe current time is ${ctx.now}.` : '');
}

/* ─────────────────────────── the tools ─────────────────────────── */

export const CONDUCTOR_TOOLS: LLMTool[] = [
  {
    name: 'remember',
    description:
      'Silently land what the founder just told you in their vault: the people, ' +
      'clients, projects, events and ideas they mention, and the concrete facts ' +
      'about each. Call this continuously WHILE they are talking, not at the end ' +
      'of the conversation. Never mention it and never read it back.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          description: 'People, companies, clients, projects, tools, places, events or ideas just mentioned.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'What the founder calls it. Use their words.' },
              type: {
                type: 'string',
                enum: VAULT_ENTITY_TYPES,
                description:
                  'A company or a client is a "project" only if it is work in flight; ' +
                  'otherwise use "concept" for the business itself and put the finer ' +
                  'word in `role`.',
              },
              role: {
                type: 'string',
                description:
                  'The finer word for what this is, in the founder\'s language: ' +
                  '"company", "client", "competitor", "co-founder", "contractor", "investor".',
              },
              note: { type: 'string', description: 'One line on why this matters to them.' },
            },
            required: ['name', 'type'],
          },
        },
        facts: {
          type: 'array',
          description: 'Concrete things now known about one of those entities.',
          items: {
            type: 'object',
            properties: {
              about: { type: 'string', description: 'The entity name this is about.' },
              detail: {
                type: 'string',
                description:
                  'The fact, as a short sentence in the founder\'s own terms. ' +
                  '"Does the front end, two days a week." "Renews in October."',
              },
            },
            required: ['about', 'detail'],
          },
        },
      },
    },
  },
  {
    name: 'capture_fuel',
    description:
      'Record that you have actually learned one of the five things the rest of ' +
      'the session needs. Call it when you HAVE it, not when you go looking for ' +
      'it. Silent: never mention it to the founder.',
    parameters: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: FUEL_AREA_KEYS,
          description: 'Which of the five.',
        },
        summary: {
          type: 'string',
          description: 'What you learned, in one or two sentences, in their terms.',
        },
        quote: {
          type: 'string',
          description: 'Their own phrasing, verbatim, when it says something the summary loses.',
        },
      },
      required: ['area', 'summary'],
    },
  },
  {
    name: 'conclude_opening',
    description:
      'Mark the opening of the session complete. Call it when you understand the ' +
      'company well enough to start doing real work with the founder. This does ' +
      'NOT end the conversation, does not hand them anywhere, and is invisible to ' +
      'them: do not sign off or announce anything. Read the result and carry on.',
    parameters: {
      type: 'object',
      properties: {
        understanding: {
          type: 'string',
          description:
            'What you now understand about this company and this founder, in a ' +
            'few sentences. This is what carries into the rest of the session.',
        },
      },
      required: ['understanding'],
    },
  },
];

export const CONDUCTOR_TOOL_NAMES: ReadonlySet<string> = new Set(CONDUCTOR_TOOLS.map((t) => t.name));

/* ─────────────────────────── session state ─────────────────────────── */

/** One entity as it lands, for the live surface (D22). */
export type LandedEntity = {
  id: string;
  name: string;
  type: EntityType;
  role?: string;
  /** True the first time this entity is created, false when facts were added
   *  to one that already existed. The surface marks the new ones. */
  isNew: boolean;
  factCount: number;
};

export type CapturedFuel = {
  area: FuelArea;
  summary: string;
  quote?: string;
  at: number;
};

export type ConductorSession = {
  startedAt: number;
  /** D9: stamped from the founder's first utterance, by the caller. */
  firstSpeechAt: number | null;
  /** Everything the opening has landed, newest last. */
  landed: LandedEntity[];
  /** The five soft targets, as and when the model says it has them. Progress
   *  only: nothing reads this to decide what to ask. */
  coveredFuel: Map<FuelArea, CapturedFuel>;
  /** Set by `conclude_opening`. The seam. */
  concluded: boolean;
  understanding: string | null;
};

export function createConductorSession(now = Date.now()): ConductorSession {
  return {
    startedAt: now,
    firstSpeechAt: null,
    landed: [],
    coveredFuel: new Map(),
    concluded: false,
    understanding: null,
  };
}

/** What the room beats inherit. See `conclude_opening`. */
export type TrialOpeningHandoff = {
  understanding: string;
  fuel: CapturedFuel[];
  entities: LandedEntity[];
  concludedAt: number;
};

export type ConductorDeps = {
  /**
   * Fires for every entity that lands, as it lands. D22: the founder watches
   * their vault fill while they are still mid-sentence, so this must be a push
   * during the conversation, never a summary after it.
   */
  onEntitiesLanded?: (landed: LandedEntity[]) => void;
  /** Fires when the model says it has one of the five. Progress surface only. */
  onFuelCaptured?: (fuel: CapturedFuel) => void;
  /**
   * THE SEAM. Fires once, when the model concludes the opening.
   *
   * The room beats (goals, tasks, calendar, workflows, authority, agents) attach
   * HERE. The conversation is still live and still speaking when this fires,
   * per D17 it must not be treated as the end of anything.
   */
  onOpeningComplete?: (handoff: TrialOpeningHandoff) => void;
};

export type ConductorToolResult = {
  /** The string handed back to the model as the tool result. */
  message: string;
};

/**
 * Execute one conductor tool call. Synchronous: every write is a local vault
 * write, and a realtime session that awaits anything here is a founder
 * listening to silence.
 *
 * Returns null when `name` is not a conductor tool, so the caller can fall
 * through to whatever else it exposes.
 */
export function executeConductorTool(
  session: ConductorSession,
  name: string,
  args: Record<string, unknown>,
  deps: ConductorDeps = {},
  now = Date.now(),
): ConductorToolResult | null {
  switch (name) {
    case 'remember':
      return executeRemember(session, args, deps);
    case 'capture_fuel':
      return executeCaptureFuel(session, args, deps, now);
    case 'conclude_opening':
      return executeConcludeOpening(session, args, deps, now);
    default:
      return null;
  }
}

function executeRemember(
  session: ConductorSession,
  args: Record<string, unknown>,
  deps: ConductorDeps,
): ConductorToolResult {
  const rawEntities = Array.isArray(args.entities) ? args.entities : [];
  const rawFacts = Array.isArray(args.facts) ? args.facts : [];

  const landed: LandedEntity[] = [];
  /** name (lowercased) -> the entity it resolved to, for the facts below. */
  const byName = new Map<string, { entity: Entity; landedIdx: number }>();

  for (const raw of rawEntities) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) continue;
    // An unknown type is the model's slip, not the founder's: keep the entity
    // and file it as a concept rather than dropping something they said.
    const type: EntityType = isEntityType(e.type) ? e.type : 'concept';
    const role = typeof e.role === 'string' && e.role.trim() ? e.role.trim() : undefined;
    const note = typeof e.note === 'string' && e.note.trim() ? e.note.trim() : undefined;

    let entity: Entity;
    let isNew: boolean;
    try {
      const existing = findEntities({ name, type });
      if (existing.length > 0) {
        entity = existing[0]!;
        isNew = false;
        // Merge the finer role/note in without clobbering what is already known.
        const props = { ...(entity.properties ?? {}) };
        let changed = false;
        if (role && props.role !== role) { props.role = role; changed = true; }
        if (note && props.note !== note) { props.note = note; changed = true; }
        if (changed) {
          const updated = updateEntity(entity.id, { properties: props });
          if (updated) entity = updated;
        }
      } else {
        entity = createEntity(
          type,
          name,
          { ...(role ? { role } : {}), ...(note ? { note } : {}) },
          TRIAL_VAULT_SOURCE,
        );
        isNew = true;
      }
    } catch (err) {
      console.warn('[Conductor] failed to land entity', name, err);
      continue;
    }

    const entry: LandedEntity = { id: entity.id, name: entity.name, type: entity.type, role, isNew, factCount: 0 };
    byName.set(name.toLowerCase(), { entity, landedIdx: landed.length });
    landed.push(entry);
  }

  let factsSaved = 0;
  for (const raw of rawFacts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as Record<string, unknown>;
    const about = typeof f.about === 'string' ? f.about.trim() : '';
    const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
    if (!about || !detail) continue;

    // Resolve against the entities landed in THIS call first, then the vault,
    // a fact about someone mentioned two sentences ago must still find them.
    let target = byName.get(about.toLowerCase())?.entity ?? null;
    if (!target) {
      try {
        const found = findEntities({ name: about });
        target = found[0] ?? null;
      } catch { /* fall through */ }
    }
    if (!target) {
      // The model named a subject it never landed. Land it as a concept rather
      // than dropping the fact, the founder said it, so it belongs to them.
      try {
        target = createEntity('concept', about, {}, TRIAL_VAULT_SOURCE);
        const entry: LandedEntity = {
          id: target.id, name: target.name, type: target.type, isNew: true, factCount: 0,
        };
        byName.set(about.toLowerCase(), { entity: target, landedIdx: landed.length });
        landed.push(entry);
      } catch (err) {
        console.warn('[Conductor] failed to land implied entity', about, err);
        continue;
      }
    }

    try {
      // Skip a fact already on this entity: the model repeats itself across
      // turns as the conversation circles back, and a vault of duplicates is
      // exactly what the founder is watching.
      const already = findFacts({ subject_id: target.id }).some(
        (existing) => existing.object.toLowerCase() === detail.toLowerCase(),
      );
      if (already) continue;
      // Predicate is a fixed label, not model output: these facts are whole
      // sentences in the founder's voice, and splitting them into a synthetic
      // subject/predicate/object triple would mangle the phrasing the memory
      // room is meant to show back to them.
      createFact(target.id, 'said', detail, { confidence: 0.9, source: TRIAL_VAULT_SOURCE });
      factsSaved++;
      const idx = byName.get(about.toLowerCase())?.landedIdx;
      if (idx !== undefined && landed[idx]) landed[idx]!.factCount++;
    } catch (err) {
      console.warn('[Conductor] failed to land fact about', about, err);
    }
  }

  if (landed.length > 0) {
    session.landed.push(...landed);
    // Push NOW, in the same tick as the write. This is the whole of D22.
    try {
      deps.onEntitiesLanded?.(landed);
    } catch (err) {
      console.warn('[Conductor] entity-landed listener failed:', err);
    }
  }

  const newCount = landed.filter((l) => l.isNew).length;
  return {
    message: `Landed ${newCount} new, ${landed.length - newCount} updated, ${factsSaved} fact${factsSaved === 1 ? '' : 's'}.`,
  };
}

function executeCaptureFuel(
  session: ConductorSession,
  args: Record<string, unknown>,
  deps: ConductorDeps,
  now: number,
): ConductorToolResult {
  const area = args.area;
  if (!isFuelArea(area)) {
    return { message: `Error: area must be one of ${FUEL_AREA_KEYS.join(', ')}.` };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) return { message: 'Error: summary was empty.' };
  const quote = typeof args.quote === 'string' && args.quote.trim() ? args.quote.trim() : undefined;

  const fuel: CapturedFuel = { area, summary, quote, at: now };
  session.coveredFuel.set(area, fuel);

  // Also into the user profile, where the rest of the product already looks for
  // what it knows about this person. It is what makes `profile_completed` true
  // without the founder ever seeing the wizard's interview.
  try {
    appendUserProfileFact({ theme: `trial_${area}`, summary, raw_quote: quote });
  } catch (err) {
    console.warn('[Conductor] failed to write profile fact:', err);
  }

  try {
    deps.onFuelCaptured?.(fuel);
  } catch (err) {
    console.warn('[Conductor] fuel listener failed:', err);
  }

  // Deliberately says nothing about what is still missing. A tool result that
  // reported "3 of 5, still need the open question" would turn the model's next
  // turn into an agenda item, which is the exact failure D12 forbids.
  return { message: 'Noted.' };
}

function executeConcludeOpening(
  session: ConductorSession,
  args: Record<string, unknown>,
  deps: ConductorDeps,
  now: number,
): ConductorToolResult {
  const understanding = typeof args.understanding === 'string' ? args.understanding.trim() : '';

  if (session.concluded) {
    return { message: CONCLUDE_RESULT_MESSAGE };
  }
  session.concluded = true;
  session.understanding = understanding || null;

  try {
    deps.onOpeningComplete?.({
      understanding,
      fuel: [...session.coveredFuel.values()],
      entities: [...session.landed],
      concludedAt: now,
    });
  } catch (err) {
    console.warn('[Conductor] opening-complete listener failed:', err);
  }

  return { message: CONCLUDE_RESULT_MESSAGE };
}

/**
 * THE SEAM, in words.
 *
 * This string is what the model reads the instant the opening is done, and it
 * is where the next worker attaches beats 06 to 12. Today it holds the
 * conversation open and nothing else, because the room beats do not exist yet
 * and a model told to "now go to the goals room" with no goals tools would
 * promise the founder something that never arrives.
 *
 * When the beats land, this becomes the instruction that starts beat 06,
 * "propose their OKR tree out loud from what they just told you, then create it
 * when they say yes", and the beat tools are appended to CONDUCTOR_TOOLS. No
 * other part of the opening needs to change.
 */
export const CONCLUDE_RESULT_MESSAGE =
  'Recorded. Say nothing about this. Stay in the conversation as their co-founder ' +
  'and keep talking about their company.';
