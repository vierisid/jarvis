/**
 * The proposal study (the plan's Track B): the proposer replayed over a
 * month of real threads as if it had been running, so that its proposals can
 * be scored by the owner before anything is built on them.
 *
 * This file is the part that needs no mailbox and no model: finding the
 * moments at which a proposal would have been made, picking which of them to
 * put in front of the owner, and working out the score.
 */
import { isOwner, mailFirstName, threadAsOf, type MailOwner, type MailPerson, type MailThread } from './thread.ts';
import { mailVoiceSamples, proposeMail, type MailCalendarEvent, type MailProposed, type MailThink } from './proposer.ts';
import { MAIL_WAIT_MIN_MS, mailReplyTo, mailWaiting, type MailWaiting } from './waiting.ts';

export interface StudyMoment {
  thread: string;
  /** Which message of the thread was waiting, counted from 0. */
  message: number;
  /** When the proposal would have been made: once the message had waited long enough. */
  at: number;
  who: MailPerson;
  /** Still unanswered when the mailbox was read: what the owner would be shown today. */
  live: boolean;
  /** What happened next in the thread. */
  after:
    | { kind: 'nothing' }
    | { kind: 'owner-replied'; afterMs: number; text: string }
    | { kind: 'other-wrote'; afterMs: number };
}

export type StudyRuledOut = Exclude<MailWaiting, { waits: true }>['why'];

/**
 * Every moment at which a proposal would have been made. A message from
 * someone else that nobody answered within the wait is one, when the rule in
 * ./waiting.ts says a person was waiting, read as the thread stood then.
 *
 * `ruled` counts, per thread, why its last message is not one.
 */
export function studyMoments(threads: MailThread[], owner: MailOwner, now: number, wait = MAIL_WAIT_MIN_MS): { moments: StudyMoment[]; ruled: Partial<Record<StudyRuledOut, number>> } {
  const moments: StudyMoment[] = [];
  const ruled: Partial<Record<StudyRuledOut, number>> = {};
  for (const thread of threads) {
    const count = thread.messages.length;
    for (let at = 0; at < count; at++) {
      const message = thread.messages[at]!;
      const next = thread.messages[at + 1];
      const last = at === count - 1;
      const due = message.at + wait;
      if (!last) {
        if (isOwner(message.from, owner) || next!.at <= due) continue;
        // As it stood then. Whether a draft existed then is not known, so none is assumed.
        if (!mailWaiting(threadAsOf({ ...thread, draft: false }, message.at), owner, due).waits) continue;
      } else {
        // The last message is judged as the mailbox is now, draft and age included.
        const waiting = mailWaiting(thread, owner, now);
        if (!waiting.waits) { ruled[waiting.why] = (ruled[waiting.why] ?? 0) + 1; continue; }
      }
      moments.push({
        thread: thread.id,
        message: at,
        at: due,
        who: message.from,
        live: last,
        after: !next ? { kind: 'nothing' }
          : isOwner(next.from, owner) ? { kind: 'owner-replied', afterMs: next.at - message.at, text: next.text }
          : { kind: 'other-wrote', afterMs: next.at - message.at },
      });
    }
  }
  return { moments, ruled };
}

/** A small generator of the same numbers every time, so that a sample can be made again. */
function numbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let at = out.length - 1; at > 0; at--) {
    const other = Math.floor(random() * (at + 1));
    [out[at], out[other]] = [out[other]!, out[at]!];
  }
  return out;
}

/**
 * The order in which moments are put to the proposer: one per thread (its
 * latest), and by turns one the owner would be shown today, one they answered
 * late, one where someone else wrote next. The same order for the same seed.
 */
export function studyOrder(moments: StudyMoment[], seed = 1): StudyMoment[] {
  const latest = new Map<string, StudyMoment>();
  for (const moment of moments) {
    const had = latest.get(moment.thread);
    if (!had || moment.message > had.message) latest.set(moment.thread, moment);
  }
  const random = numbers(seed);
  const all = [...latest.values()].sort((a, b) => a.thread.localeCompare(b.thread) || a.message - b.message);
  const kinds = [
    shuffled(all.filter((moment) => moment.live), random),
    shuffled(all.filter((moment) => !moment.live && moment.after.kind === 'owner-replied'), random),
    shuffled(all.filter((moment) => !moment.live && moment.after.kind === 'other-wrote'), random),
  ];
  const order: StudyMoment[] = [];
  for (let at = 0; kinds.some((kind) => at < kind.length); at++) {
    for (const kind of kinds) if (at < kind.length) order.push(kind[at]!);
  }
  return order;
}

/** The line the notch would say. */
export function studyLine(who: MailPerson): string {
  return `You have not replied to ${mailFirstName(who)}. I drafted a reply.`;
}

/** "4 hours", "3 days": how long, said the way a person would. */
export function studyHowLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export type StudyScore = 'useful' | 'not' | 'wrong';
export interface StudyMark { score: StudyScore; wrong?: 'person' | 'content' }

/** At least this share of what was scored must be useful. */
export const STUDY_USEFUL_GATE = 0.6;
/** Fewer scored than this and the study says nothing yet. */
export const STUDY_SCORED_MIN = 30;

export interface StudyResult {
  scored: number;
  useful: number;
  not: number;
  wrong: number;
  wrongPerson: number;
  share: number;
  /** Null until enough are scored. */
  passes: boolean | null;
  why: string;
}

/**
 * The gate: pass 7 goes ahead as designed when at least 60% are useful and
 * none goes to the wrong person. A "wrong" that does not say which kind
 * counts as a wrong person: the gate is not passed on a guess.
 */
export function studyResult(marks: Record<string, StudyMark>, ids: string[]): StudyResult {
  const given = ids.map((id) => marks[id]).filter((mark): mark is StudyMark => !!mark);
  const useful = given.filter((mark) => mark.score === 'useful').length;
  const wrong = given.filter((mark) => mark.score === 'wrong');
  const wrongPerson = wrong.filter((mark) => mark.wrong !== 'content').length;
  const share = given.length ? useful / given.length : 0;
  const result = { scored: given.length, useful, not: given.filter((mark) => mark.score === 'not').length, wrong: wrong.length, wrongPerson, share };
  if (given.length < Math.min(STUDY_SCORED_MIN, ids.length)) {
    return { ...result, passes: null, why: `${given.length} scored so far.` };
  }
  if (wrongPerson > 0) return { ...result, passes: false, why: `${wrongPerson} would have gone to the wrong person.` };
  if (share < STUDY_USEFUL_GATE) return { ...result, passes: false, why: `${Math.round(share * 100)}% useful, under 60%.` };
  return { ...result, passes: true, why: `${Math.round(share * 100)}% useful, and none to the wrong person.` };
}

// ── The replay ───────────────────────────────────────────────────────────────


/** One row of the scoring sheet. */
export interface StudyProposal {
  id: string;
  thread: string;
  message: number;
  /** What the notch would say, and the name that is lit in it. */
  line: string;
  first: string;
  to: MailPerson[];
  cc: MailPerson[];
  subject: string;
  draft: string;
  time: string | null;
  missing: string;
  why: string;
  at: number;
  /** How long the message had waited when the proposal would have been made. */
  waited: string;
  live: boolean;
  last: { from: MailPerson; at: number; text: string };
  /** How many messages came before it in the thread. */
  earlier: number;
  after: { kind: 'nothing' } | { kind: 'owner-replied'; after: string; text: string } | { kind: 'other-wrote'; after: string };
}

export interface StudyTried {
  id: string;
  /** The model wrote a reply, said none was needed, or gave nothing that could be used. */
  outcome: 'proposed' | 'silent' | 'failed';
  cost: MailProposed['cost'];
  proposal?: StudyProposal;
}

export interface StudyReplayOptions {
  threads: MailThread[];
  owner: MailOwner;
  ownerName: string;
  /** Null when no calendar is connected. */
  calendar: MailCalendarEvent[] | null;
  /** When the mailbox was read. */
  now: number;
  zone?: string;
  /** Stop once this many proposals are made. */
  want: number;
  /** Never ask the model more than this many times in all. */
  most: number;
  seed?: number;
  think: MailThink;
  /** What an earlier run already tried: not asked again. */
  already?: StudyTried[];
  each?: (tried: StudyTried) => void | Promise<void>;
  parallel?: number;
}

/** How far ahead of a moment the calendar is shown to the model. */
const STUDY_CALENDAR_AHEAD_MS = 10 * 24 * 60 * 60 * 1000;

export const studyId = (moment: Pick<StudyMoment, 'thread' | 'message'>): string => `${moment.thread}-${moment.message}`;

/**
 * Puts the moments to the proposer, in the study's order, until enough
 * proposals are made. Each is read as the thread stood at that moment: no
 * later message, and no sample of the owner's writing from after it.
 */
export async function studyReplay(options: StudyReplayOptions): Promise<StudyTried[]> {
  const { threads, owner, now } = options;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tried = new Map((options.already ?? []).map((entry) => [entry.id, entry]));
  const proposed = () => [...tried.values()].filter((entry) => entry.outcome === 'proposed').length;
  const queue = studyOrder(studyMoments(threads, owner, now).moments, options.seed).filter((moment) => !tried.has(studyId(moment)));

  const one = async (moment: StudyMoment): Promise<StudyTried> => {
    const thread = byId.get(moment.thread)!;
    const waiting = thread.messages[moment.message]!;
    const then = threadAsOf({ ...thread, draft: false }, waiting.at);
    const calendar = options.calendar?.filter((event) => {
      const start = Date.parse(event.start);
      return start >= moment.at && start <= moment.at + STUDY_CALENDAR_AHEAD_MS;
    });
    const { proposal, cost } = await proposeMail({
      thread: then,
      owner,
      ownerName: options.ownerName,
      samples: mailVoiceSamples(threads, owner, { thread: thread.id, to: moment.who.address, before: moment.at }),
      ...(calendar ? { calendar } : {}),
      now: moment.at,
      zone: options.zone,
    }, options.think);
    const id = studyId(moment);
    if (!proposal) return { id, outcome: 'failed', cost };
    if (!proposal.needsReply) return { id, outcome: 'silent', cost };
    const { to, cc } = mailReplyTo(waiting, owner);
    return {
      id,
      outcome: 'proposed',
      cost,
      proposal: {
        id,
        thread: thread.id,
        message: moment.message,
        line: studyLine(moment.who),
        first: mailFirstName(moment.who),
        to,
        cc,
        subject: thread.subject,
        draft: proposal.reply,
        time: proposal.time,
        missing: proposal.missing,
        why: proposal.why,
        at: moment.at,
        waited: studyHowLong(moment.at - waiting.at),
        live: moment.live,
        last: { from: waiting.from, at: waiting.at, text: waiting.text },
        earlier: moment.message,
        after: moment.after.kind === 'nothing' ? { kind: 'nothing' }
          : moment.after.kind === 'owner-replied' ? { kind: 'owner-replied', after: studyHowLong(moment.after.afterMs), text: moment.after.text }
          : { kind: 'other-wrote', after: studyHowLong(moment.after.afterMs) },
      },
    };
  };

  const parallel = Math.max(1, options.parallel ?? 4);
  while (queue.length > 0 && proposed() < options.want && tried.size < options.most) {
    // Never more at once than could still be wanted, so that the last round does not overshoot by much.
    const room = Math.min(parallel, options.most - tried.size, Math.max(1, options.want - proposed()));
    const round = queue.splice(0, room);
    for (const entry of await Promise.all(round.map(one))) {
      tried.set(entry.id, entry);
      await options.each?.(entry);
    }
  }
  return [...tried.values()];
}
