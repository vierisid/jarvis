/**
 * The rest of day one. D25 to D30, the four beats that happen AFTER the
 * conducted hour has been handed back.
 *
 * Everything in this file is pure. It decides what should happen and says so;
 * it never broadcasts, never writes to the vault, never spawns anything. The
 * director next door does all of that. The split is not tidiness: the two
 * judgements this file makes (when Jarvis is allowed to interrupt a founder's
 * afternoon, and what it is allowed to offer them) are the two things in day
 * one most likely to be wrong, and they need to be readable and testable
 * without a daemon, a socket or a model.
 *
 * The rule that governs all four, and every string in here:
 * **Jarvis takes work off the founder. It never hands work back.** An offer is
 * a thing Jarvis will do. "You could..." is the failure, and so is a task
 * created on their board with their name on it.
 */

import type { AgentFailure } from '../../agents/task-failure.ts';
import { isInfrastructureFailure } from '../../agents/task-failure.ts';

/* ──────────────────────── what onboarding built ──────────────────────── */

/**
 * The hour that just happened, in the form day one needs it.
 *
 * Read from the vault and the finished beats session rather than carried in a
 * message, because day one outlives the socket the conversation ran on and a
 * founder who reloads at hour six must get the same offers as one who never
 * closed the tab.
 */
export type DayOneFoundation = {
  /** When the conductor stood down. Day one is measured from here. */
  handedOverAt: number | null;
  /** Their quarter, if they built one. */
  objective: { id: string; title: string; keyResults: { id: string; title: string }[] } | null;
  /** What is on their board, most important first. */
  board: { id: string; what: string; first: boolean }[];
  /** Flows they published, in publish order. */
  workflows: string[];
  /** The organised copy of their folder, if they let it be made. */
  workspace: { destination: string; says: string } | null;
  /** People, clients and companies the reader landed out of their documents. */
  landed: string[];
  /** What they granted. Outward action needs 5 (spec section 4). */
  authorityLevel: number | null;
  /** The finale's agent and the founder's own question. */
  agent: { agentId: string; taskId: string | null; agentName: string; question: string } | null;
  /** The hour they chose for the evening review, which is when day one closes. */
  eveningHour: number | null;
};

export function emptyFoundation(): DayOneFoundation {
  return {
    handedOverAt: null,
    objective: null,
    board: [],
    workflows: [],
    workspace: null,
    landed: [],
    authorityLevel: null,
    agent: null,
    eveningHour: null,
  };
}

/* ─────────────────────────────── offers ─────────────────────────────── */

export type OfferKind = 'task' | 'toward' | 'workspace_write';

export type DayOneOffer = {
  id: string;
  kind: OfferKind;
  /** D27's two flavours. `inward` is always available; `outward` is not. */
  direction: 'inward' | 'outward';
  /**
   * The button, in Jarvis's voice, first person, future tense. It is a thing
   * Jarvis is about to do. Every one of these was checked against the rule:
   * none of them is an instruction and none of them ends up on the founder's
   * own list.
   */
  label: string;
  /** The line under the button: where it lands, so nothing is a surprise. */
  where: string;
  /** What it points at, when it points at something from the hour. */
  target?: { id?: string; title: string };
  /** Everything the executor needs and nothing it does not. */
  payload: Record<string, unknown>;
};

/**
 * The floor. Composed from the foundation alone, with no model in the loop,
 * and it can always be built.
 *
 * This exists because D27's promise ("one of them is always available") cannot
 * be kept by anything that might fail. The model gets to write better offers
 * when it can; when it cannot, because it is out of credit or slow or wrong,
 * these are still true, still executable, and still point at something the
 * founder made an hour ago.
 */
export function floorOffers(
  subject: string,
  f: DayOneFoundation,
  seed = 'o',
): DayOneOffer[] {
  const offers: DayOneOffer[] = [];
  const kr = nearestKeyResult(subject, f);

  if (kr) {
    offers.push({
      id: `${seed}-toward`,
      kind: 'toward',
      direction: 'inward',
      label: 'I will take this one and put it against your key result.',
      where: `On your board under my name, noted on "${kr.title}".`,
      target: { id: kr.id, title: kr.title },
      payload: { what: subject, goalId: kr.id, goalTitle: kr.title },
    });
  } else {
    offers.push({
      id: `${seed}-task`,
      kind: 'task',
      direction: 'inward',
      label: 'I will take this one and carry it on your board.',
      where: 'On the board you built this morning, under my name, not yours.',
      ...(f.objective ? { target: { id: f.objective.id, title: f.objective.title } } : {}),
      payload: { what: subject, ...(f.objective ? { goalTitle: f.objective.title } : {}) },
    });
  }

  // D27's outward arm. Only offered where it can actually be done: a folder
  // that was organised, and level 5, which is what the spec says buys changing
  // the thing rather than describing it. Nothing here touches an original.
  if (f.workspace && (f.authorityLevel ?? 0) >= 5) {
    offers.push({
      id: `${seed}-write`,
      kind: 'workspace_write',
      direction: 'outward',
      label: 'I will write the changed version into your workspace.',
      where: `A new file in ${f.workspace.says}. Your originals are not touched.`,
      target: { title: f.workspace.says },
      payload: { subject, intoDir: f.workspace.destination },
    });
  }

  return offers;
}

/**
 * The key result a finding is closest to, by shared words.
 *
 * Crude on purpose, and crude in the direction that fails safe: it needs two
 * substantial words in common before it will claim a connection, so a finding
 * about pricing does not get filed under hiring. When nothing clears that, the
 * offer points at the objective instead, which is always true.
 */
export function nearestKeyResult(
  subject: string,
  f: DayOneFoundation,
): { id: string; title: string } | null {
  if (!f.objective || f.objective.keyResults.length === 0) return null;
  const words = significantWords(subject);
  if (words.size === 0) return null;
  let best: { id: string; title: string } | null = null;
  let bestScore = 0;
  for (const kr of f.objective.keyResults) {
    let score = 0;
    for (const w of significantWords(kr.title)) if (words.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = kr; }
  }
  return bestScore >= 2 ? best : null;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'have', 'has', 'are', 'was',
  'were', 'you', 'your', 'our', 'their', 'they', 'them', 'about', 'into', 'more', 'than',
  'per', 'how', 'why', 'who', 'when', 'where', 'does', 'did', 'not', 'but', 'all', 'any',
  'one', 'two', 'get', 'got', 'out', 'own', 'other', 'others', 'much', 'many', 'each',
]);

function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/* ─────────────────────── D25, D26, D27: the return ─────────────────────── */

export type AgentReturn = {
  /** What the founder's own question was. */
  question: string;
  /** The row to fly to, and what it is called. */
  agent: { taskId: string | null; agentName: string };
  /** True when the agent answered. False when it died. */
  answered: boolean;
  /**
   * One or two sentences, spoken. The finding when there is one; what stopped
   * it when there is not, naming the cause rather than shrugging.
   */
  says: string;
  /** The finding itself, for the card. Null when there is none. */
  finding: string | null;
  /** D27. Never empty. */
  offers: DayOneOffer[];
  /** Set when the run died, so the surface can say so rather than imply it. */
  failure: { kind: string; says: string } | null;
};

/** How much of a research answer belongs on a card before it becomes a report. */
const FINDING_MAX = 700;

/**
 * Beat 14, composed.
 *
 * The shape is fixed whichever way the agent went, and that is the point. D27
 * says the finding is ALWAYS followed by an offer, and the case that tests it
 * is not a thin finding, it is no finding at all. An agent that died on
 * billing has told the founder nothing about their question, so the honest
 * sentence says which side the fault was on, keeps the question, and still
 * arrives with something Jarvis will do.
 *
 * `decisions.md` does not cover an agent that dies, so the smallest reasonable
 * thing is taken: the beat keeps its shape, the offer is the inward one, and
 * nothing is claimed about the question that was never asked.
 */
export function composeAgentReturn(opts: {
  question: string;
  agentName: string;
  taskId: string | null;
  response: string | null;
  failure: AgentFailure | null;
  foundation: DayOneFoundation;
}): AgentReturn {
  const { question, agentName, taskId, response, failure, foundation } = opts;
  const subject = question.trim() || 'the question you gave it';

  if (failure) {
    const ours = isInfrastructureFailure(failure.kind);
    return {
      question,
      agent: { taskId, agentName },
      answered: false,
      says: ours
        ? `Your question did not get an answer, and it was not the question. ${failure.says} ` +
          'I have kept it and I will run it again.'
        : `Your question did not get an answer. ${failure.says} I have kept it and I will run it again.`,
      finding: null,
      offers: floorOffers(subject, foundation, 'back'),
      failure: { kind: failure.kind, says: failure.says },
    };
  }

  const finding = tidyFinding(response ?? '');
  if (!finding) {
    return {
      question,
      agent: { taskId, agentName },
      answered: false,
      says: 'Your question came back empty. That is on the run, not on the question, and I will run it again.',
      finding: null,
      offers: floorOffers(subject, foundation, 'back'),
      failure: null,
    };
  }

  return {
    question,
    agent: { taskId, agentName },
    answered: true,
    says: 'That question you gave me has come back.',
    finding,
    offers: floorOffers(subject, foundation, 'back'),
    failure: null,
  };
}

/** Strip the markdown scaffolding a research agent writes in, and cap it. */
export function tidyFinding(raw: string): string | null {
  const cleaned = raw
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length < 12) return null;
  if (cleaned.length <= FINDING_MAX) return cleaned;
  const cut = cleaned.slice(0, FINDING_MAX);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(stop > FINDING_MAX / 2 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

/* ─────────────────────── D29: the ambient afternoon ─────────────────────── */

/**
 * Something the awareness layer wants to say.
 *
 * Deliberately the same shape as the suggestion engine's output plus one
 * extra field, `wouldDo`, because the governor's hardest gate is not about
 * the trigger at all: it is about whether the sentence at the end of it is an
 * offer or a remark.
 */
export type AmbientCandidate = {
  /** The suggestion engine's own type: error, struggle, stuck, automation… */
  type: string;
  title: string;
  body: string;
  /** The app it came off, when it came off one. */
  appName?: string;
  /**
   * What Jarvis would DO if the founder said yes. Empty means there is
   * nothing on offer, and a candidate with nothing on offer is a remark.
   */
  wouldDo?: string;
};

export type AmbientVerdict =
  | { speak: true; subject: string }
  | { speak: false; why: AmbientRefusal };

export type AmbientRefusal =
  | 'not_day_one'
  | 'budget_spent'
  | 'too_soon_after_handover'
  | 'too_soon_after_last'
  | 'type_never_speaks'
  | 'not_about_their_work'
  | 'nothing_offered'
  | 'already_said';

/**
 * How many times Jarvis may interrupt a founder between the handover and the
 * close of day one, before they have done anything themselves.
 *
 * D29: "once or twice". Two.
 */
export const AMBIENT_BASE_ALLOWANCE = 2;

/** The ceiling, however heavily they use it. Four is still a quiet afternoon. */
export const AMBIENT_MAX_ALLOWANCE = 4;

/**
 * D29's "more only if the founder is themselves using Jarvis heavily", made
 * countable. Every this-many things the founder does of their own accord (a
 * turn spoken to Jarvis, a room opened, an offer accepted) buys one more.
 */
export const AMBIENT_ENGAGEMENT_PER_EXTRA = 12;

/** The quiet either side of an interruption. */
export const AMBIENT_MIN_GAP_MS = 90 * 60_000;

/** How long after being handed the product a founder is left completely alone. */
export const AMBIENT_SETTLE_MS = 10 * 60_000;

/**
 * Types that never speak in day one, whatever else is true.
 *
 * `break` is the clearest case and it is worth saying why out loud. A break
 * reminder is a remark about the founder's body from a piece of software they
 * met this morning, it can never carry an offer, and it is the single most
 * likely sentence in the whole product to make somebody turn it off. `stuck`
 * goes for a weaker version of the same reason: it fires on idleness, which is
 * often a person thinking.
 */
export const AMBIENT_SILENT_TYPES: ReadonlySet<string> = new Set(['break', 'stuck', 'general']);

export type AmbientState = {
  /** How many have been spoken since the handover. */
  spoken: number;
  /** When the last one was spoken. */
  lastSpokenAt: number | null;
  /** Subjects already used, so the same one is never raised twice in a day. */
  subjects: Set<string>;
  /** Things the founder did of their own accord. See the allowance. */
  engagement: number;
};

export function emptyAmbientState(): AmbientState {
  return { spoken: 0, lastSpokenAt: null, subjects: new Set(), engagement: 0 };
}

export function ambientAllowance(state: AmbientState): number {
  const earned = Math.floor(state.engagement / AMBIENT_ENGAGEMENT_PER_EXTRA);
  return Math.min(AMBIENT_MAX_ALLOWANCE, AMBIENT_BASE_ALLOWANCE + earned);
}

/**
 * The bar, in one place, as one conjunction.
 *
 * Every gate has to hold. They are ordered cheapest first, and the order also
 * happens to be least to most interesting: the last two are the ones doing the
 * real work, and they are the ones that would still be right if the numbers
 * above them were all wrong.
 *
 * Why it is this high. The fixed heartbeat was removed from this product
 * already, and what is left is a suggestion engine tuned in seconds: errors at
 * 15s, struggle at 90s, a 60s floor on everything else. Left alone during a
 * trial that is not "ambient", it is a stream. D29 was chosen KNOWING it is
 * the high-risk beat, on the grounds that initiative is the thesis, so the
 * answer cannot be to turn it off; it has to be to make the few things it does
 * say worth the interruption. That is what gates 5 and 6 are: it must be about
 * the founder's own work, named out of what they built this morning, and it
 * must arrive with something Jarvis will do about it.
 */
export function ambientVerdict(opts: {
  state: AmbientState;
  candidate: AmbientCandidate;
  foundation: DayOneFoundation;
  now: number;
  /** False outside day one, and then nothing here applies. */
  dayOneRunning: boolean;
}): AmbientVerdict {
  const { state, candidate, foundation, now, dayOneRunning } = opts;

  // 0. Not day one at all. The governor has no opinion about anybody else's
  //    afternoon and this is the branch every non-trial install takes.
  if (!dayOneRunning) return { speak: false, why: 'not_day_one' };

  // 1. Budget.
  if (state.spoken >= ambientAllowance(state)) return { speak: false, why: 'budget_spent' };

  // 2. They were handed the product minutes ago. An hour of conversation just
  //    ended; the first thing that happens next must be silence.
  if (foundation.handedOverAt !== null && now - foundation.handedOverAt < AMBIENT_SETTLE_MS) {
    return { speak: false, why: 'too_soon_after_handover' };
  }

  // 3. Cadence. Two in an afternoon is a rhythm, not a count: ninety minutes
  //    apart is what stops both of them landing in the same ten minutes and
  //    reading as a machine that has noticed something and cannot stop.
  if (state.lastSpokenAt !== null && now - state.lastSpokenAt < AMBIENT_MIN_GAP_MS) {
    return { speak: false, why: 'too_soon_after_last' };
  }

  // 4. Types that never speak.
  if (AMBIENT_SILENT_TYPES.has(candidate.type)) return { speak: false, why: 'type_never_speaks' };

  // 5. It has to be about their work. Not their machine, not their posture,
  //    not their tab count. The test is concrete and it is deliberately hard
  //    to pass by accident: the thing it noticed has to name something the two
  //    of them made or found this morning. Anything that cannot is a stranger
  //    talking about a screen.
  const subject = ambientSubject(candidate, foundation);
  if (!subject) return { speak: false, why: 'not_about_their_work' };

  // 6. It has to arrive with an action. The governing rule of the whole trial,
  //    applied to the output rather than the trigger, which is the only place
  //    it can be enforced: a candidate whose best sentence is "you seem to be
  //    having trouble with X" is not softened here, it is dropped.
  if (!candidate.wouldDo || candidate.wouldDo.trim().length === 0) {
    return { speak: false, why: 'nothing_offered' };
  }

  // 7. Once per subject per day.
  if (state.subjects.has(subject)) return { speak: false, why: 'already_said' };

  return { speak: true, subject };
}

/**
 * What of the founder's own world this candidate is about, or null.
 *
 * Matching is on the things the hour produced, in the founder's own words:
 * their objective and its key results, what is on their board, the flows they
 * published, the folder that was organised, the people and companies the
 * reader landed, and the question they asked the agent. If a candidate cannot
 * name one of those, it does not speak.
 */
export function ambientSubject(
  candidate: AmbientCandidate,
  f: DayOneFoundation,
): string | null {
  const haystack = `${candidate.title} ${candidate.body} ${candidate.appName ?? ''}`;
  const words = significantWords(haystack);
  if (words.size === 0) return null;

  const known: { key: string; title: string }[] = [];
  if (f.objective) {
    known.push({ key: `objective:${f.objective.id}`, title: f.objective.title });
    for (const kr of f.objective.keyResults) known.push({ key: `kr:${kr.id}`, title: kr.title });
  }
  for (const t of f.board) known.push({ key: `task:${t.id}`, title: t.what });
  for (const w of f.workflows) known.push({ key: `flow:${w}`, title: w });
  for (const name of f.landed) known.push({ key: `entity:${name}`, title: name });
  if (f.agent) known.push({ key: 'question', title: f.agent.question });
  if (f.workspace) known.push({ key: 'workspace', title: f.workspace.says });

  for (const item of known) {
    const itemWords = significantWords(item.title);
    if (itemWords.size === 0) continue;
    let hits = 0;
    for (const w of itemWords) if (words.has(w)) hits++;
    // A single shared word is a coincidence; a name is worth more than a word.
    // One is enough only when the whole title is one substantial word, which
    // is what a client's name or a flow called "Invoices" looks like.
    const enough = itemWords.size === 1 ? hits === 1 : hits >= 2;
    if (enough) return item.key;
  }
  return null;
}

/* ────────────────────── D30: the close of day one ────────────────────── */

/**
 * One stretch of the founder's day, written down WHILE it was happening.
 *
 * This type is the answer to the retention problem. Awareness keeps full
 * capture for one hour and key moments for twenty-four (`src/config/types.ts`),
 * so a summary assembled at seven in the evening out of raw captures would be
 * a summary of the evening. The captures are not the only durable thing
 * though: `awareness_sessions` rows are never pruned by the retention sweep,
 * and each one already carries an LLM-written `topic` and `summary` produced
 * at the moment the session ended, from OCR that was still on disk.
 *
 * So day one does not reconstruct the day at the end of it. It writes a line
 * as each session closes, keeps those lines itself, and closes the day out of
 * its own ledger. What survives is what it decided mattered, at the time,
 * which is both cheaper and more honest than sampling whatever is left.
 */
export type DayLine = {
  at: number;
  /** What they were doing, in a phrase. */
  topic: string;
  /** How long it went on. */
  minutes: number;
  /** The apps it happened in, for grounding. */
  apps: string[];
};

export type DayOneClose = {
  /** Two or three lines. What they actually worked on, not a diary. */
  summary: string[];
  /** The point of the whole beat. Never empty. */
  offers: DayOneOffer[];
  /** True when the ledger was thin enough that the summary leans on the hour. */
  thin: boolean;
};

/** Sessions shorter than this are noise, not work. */
const DAY_LINE_MIN_MINUTES = 8;

/** How many stretches of a day a person recognises as their day. */
const DAY_LINE_MAX = 3;

/**
 * D30, composed from the ledger.
 *
 * "A summary of your own day is mildly interesting; an offer to do part of it
 * is the product." So the summary is capped at three lines and the offers are
 * the thing that cannot be empty. If the ledger holds nothing worth saying,
 * the close still happens and still offers, out of what the two of them built
 * in the morning, which day one knows for certain.
 */
export function composeDayOneClose(opts: {
  lines: DayLine[];
  foundation: DayOneFoundation;
  now: number;
}): DayOneClose {
  const { lines, foundation } = opts;

  const worth = lines
    .filter((l) => l.minutes >= DAY_LINE_MIN_MINUTES && l.topic.trim().length > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, DAY_LINE_MAX);

  if (worth.length === 0) {
    const fallbackSubject = foundation.objective?.title ?? 'what the two of you set up this morning';
    return {
      summary: ['I did not see enough of your afternoon to summarise it, so I will not pretend to.'],
      offers: floorOffers(fallbackSubject, foundation, 'close'),
      thin: true,
    };
  }

  const summary = worth.map((l) => `${l.topic} · about ${l.minutes} minutes${l.apps.length ? ` in ${l.apps.slice(0, 2).join(' and ')}` : ''}`);
  // The offer points at the longest stretch, because the thing they spent most
  // of the day on is the thing worth taking off them.
  return {
    summary,
    offers: floorOffers(worth[0]!.topic, foundation, 'close'),
    thin: false,
  };
}

/**
 * When day one closes.
 *
 * Not a fixed hour (D30). It is the evening hour the founder themselves chose
 * at the calendar beat, since that is the hour they already told Jarvis they
 * stop; failing that, nine hours after the handover, which lands a morning
 * trial in the early evening and a late-afternoon trial before midnight.
 */
export function dayOneCloseAt(f: DayOneFoundation, handedOverAt: number): number {
  if (f.eveningHour === null) return handedOverAt + 9 * 60 * 60_000;
  const at = new Date(handedOverAt);
  at.setHours(f.eveningHour, 0, 0, 0);
  const stamp = at.getTime();
  // A handover that already happened after their evening hour closes the same
  // evening rather than waiting a day: day one is one day.
  return stamp > handedOverAt + 30 * 60_000 ? stamp : handedOverAt + 9 * 60 * 60_000;
}
