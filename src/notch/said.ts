/**
 * Talking about the line that is up.
 *
 * In the prototype every line can be answered by voice: a choice of three
 * takes "Friday at ten works", a line with a lit word takes "be firm with
 * them" or "make it Friday at ten", an offer takes "yes, go ahead". In the
 * product only a mail draft took spoken words. This is the reading that
 * makes it so for every line: what was said with a line up is tried as an
 * answer to that line first.
 *
 * The talk keys take the notch for the listening, so the line they were
 * pressed over has left when the words arrive. What is read here is that
 * line as it was (`NotchLine`). The answer goes to the thing whose line it
 * was when it is shown again (./inbox.ts, `replay`).
 *
 * One rule keeps an instruction from being mistaken for an answer:
 *
 *   **Everything that was said has to be accounted for by the line.** After
 *   the small words are taken away ("make it", "works", "please"), every
 *   word left must belong to the choice, the value or the yes that is
 *   read. "Friday at ten works" is all of a choice. "Open the Friday
 *   report" is not, and runs as the instruction it is.
 *
 * And a few smaller ones:
 *
 *   - A choice is read only when the words mean exactly one of them.
 *   - A yes is the whole of what was said, or it is not a yes: "yes, go
 *     ahead", "do it", the word on the line's own key ("send", "send it").
 *     The same for a no: "not now", "skip it". A bare "yes", "okay" or "no"
 *     is not taken: those are the words a speech-to-text hears in a silence,
 *     and a line that approves something is not answered by a noise.
 *   - A line that has choices takes no yes: yes to three things means
 *     nothing.
 *   - Nothing here asks a model. It is a reading, not a guess.
 */
import type { NotchFeatureDef } from './feature.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart, NotchWord } from './protocol.ts';
import { routeByIntents, type NotchIntent } from './intents.ts';
import { sayDays, whenSaid, whenWords } from './when.ts';

/** One answer to a line, as the page would have sent it, without the line's id. */
export interface NotchSaid {
  act: Extract<NotchAnswerAct, 'yes' | 'no' | 'pick' | 'word'>;
  option?: string;
  index?: number;
  word?: string;
  value?: string;
}

/** The most words something said about a line has. More is an instruction. */
export const NOTCH_SAID_WORDS_MAX = 12;

const text = (parts: readonly NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

/** What a line reads as: the same line shown again reads the same. */
export function notchLineReads(line: Pick<NotchLine, 'kind' | 'say'> & { options?: readonly string[] }): string {
  return `${line.kind}|${text(line.say).replace(/\s+/g, ' ').trim()}|${(line.options ?? []).join('|')}`;
}

/** The lit words of a line: in what it says, and in the rows and notes of a sheet. */
export function notchLineWords(line: NotchLine): NotchWord[] {
  const found: NotchWord[] = [];
  const from = (parts: readonly NotchPart[] | undefined): void => { for (const part of parts ?? []) if (typeof part !== 'string' && 'word' in part) found.push(part.word); };
  from(line.say);
  const blocks: readonly NotchBlock[] = 'blocks' in line && Array.isArray(line.blocks) ? line.blocks : [];
  for (const block of blocks) {
    if ('say' in block) from(block.say as NotchPart[]);
    if (block.kind === 'paper') for (const one of block.lines) from(one);
  }
  // One word per name: the first is the one a spoken value goes to.
  return found.filter((word, at) => found.findIndex((other) => other.name === word.name) === at);
}

/** Words that carry no meaning of their own in an answer to a line. */
const SMALL = new Set([
  'a', 'an', 'the', 'it', 'its', 'that', 'this', 'one', 'option', 'them', 'him', 'her', 'me', 'i', 'you', 'we', 'us',
  'make', 'be', 'do', 'go', 'set', 'change', 'use', 'take', 'pick', 'choose', 'say', 'keep', 'put', 'let', 'lets',
  'with', 'for', 'at', 'on', 'to', 'by', 'as', 'in', 'of', 'and', 'then', 'instead', 'rather', 'more', 'just', 'actually',
  'is', 'works', 'work', 'fine', 'good', 'better', 'best', 'great', 'perfect', 'sounds', 'please', 'thanks', 'thank',
  'want', 'would', 'like', 'prefer', 'ok', 'okay', 'yes', 'yeah', 'no', 'time', 'day', 'clock',
]);

/** What was said, as plain small-letter words. Numbers said as words are digits, "p.m." is "pm". */
export function saidWords(said: string): string[] {
  return whenWords(said);
}

interface SaidWhen {
  /**
   * The day that was said, as the notch says one: "Friday", "today",
   * "tomorrow", and by the week "day" (every day) or "Monday to Friday".
   */
  day: string | null;
  /** The day is several, or comes round every week: no one day for a word that takes one. */
  many: boolean;
  time: string | null;
  /** "morning" or "afternoon", when no hour was said with it. */
  part: 'morning' | 'afternoon' | null;
  /** Which of the words each of them used. */
  dayAt: Set<number>;
  used: Set<number>;
}

/**
 * How late a bare hour is still the afternoon when it is said over a line:
 * seven, one later than in a sentence (./when.ts). Nobody meets at seven in
 * the night.
 */
export const NOTCH_SAID_AFTERNOON_TO = 7;

/**
 * The day and the time in what was said, with which of its words they used.
 * "friday at 10" is Friday at 10:00, "half past 9" is 9:30, "3 pm" is 15:00,
 * and an hour from 1 to 7 with no "am", "morning" or "night" beside it is
 * the afternoon. "Friday afternoon" names no hour: the day, and the part of
 * it. Read by the one reader of a time (./when.ts): "every weekday at 9" is
 * Monday to Friday at 9:00, "at 6 in the morning" is 6:00, and a schedule
 * that cannot be said ("every 2 weeks at 9") is not read at all.
 */
export function saidWhen(words: readonly string[]): SaidWhen {
  const read = whenSaid(words, { guessTo: NOTCH_SAID_AFTERNOON_TO });
  const many = read.days !== null && (read.every || read.days.length !== 1);
  const day = read.rel ?? (read.days === null ? null : sayDays(read.days));
  const time = read.hour === null ? null : `${read.hour}:${String(read.minute).padStart(2, '0')}`;
  return { day, many, time, part: read.part, dayAt: read.dayAt, used: read.used };
}

/** The words of a choice or a value that carry its meaning. All of them when none does ("Go on"). */
function meaning(label: string): string[] {
  const all = saidWords(label);
  const kept = all.filter((word) => !SMALL.has(word));
  return kept.length > 0 ? kept : all;
}

/** Two words are the same word: equal, or one begins the other from four letters on ("firm", "firmly"; "short", "shorter"). */
const same = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

const WHEN = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow) at (\d{1,2}):(\d{2})$/i;
const ORDINAL: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };

/**
 * Which of the choices was said, or -1. Exactly one of them has to be
 * meant, and nothing may be said beside it.
 */
export function saidOption(options: readonly string[], said: string): number {
  const words = saidWords(said);
  if (words.length === 0 || words.length > NOTCH_SAID_WORDS_MAX || options.length === 0) return -1;
  // The choice as it is written.
  const flat = words.join(' ');
  const exact = options.findIndex((option) => saidWords(option).join(' ') === flat);
  if (exact >= 0) return exact;
  const left = words.filter((word) => !SMALL.has(word));
  // "The second one", "the last": by its place, and nothing else said.
  const place = /^(?:the )?(first|second|third|fourth|fifth|last)(?: one| option| time)?(?: please)?$/.exec(said.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (place) {
    const at = place[1] === 'last' ? options.length - 1 : ORDINAL[place[1]!]!;
    return at < options.length ? at : -1;
  }
  // Times: the day, the hour, or both, and nothing else.
  if (options.every((option) => WHEN.test(option))) {
    const when = saidWhen(words);
    if (!when.day && !when.time && !when.part) return -1;
    if (words.some((word, at) => !when.used.has(at) && !SMALL.has(word))) return -1;
    const meant = options.map((option, at) => ({ at, parts: WHEN.exec(option)! })).filter(({ parts }) => {
      const hour = Number(parts[2]);
      return (!when.day || when.day.toLowerCase() === parts[1]!.toLowerCase())
        && (!when.time || when.time === `${hour}:${parts[3]}`)
        && (!when.part || (when.part === 'afternoon' ? hour >= 12 : hour < 12));
    });
    return meant.length === 1 ? meant[0]!.at : -1;
  }
  if (left.length === 0) return -1;
  // Anything else: every word that was said belongs to one choice, and that choice is said in full or by a word only it has.
  const marks = options.map(meaning);
  const meant = marks.map((mark, at) => ({ at, mark })).filter(({ at, mark }) => {
    if (!left.every((word) => mark.some((one) => same(one, word)))) return false;
    const whole = mark.every((one) => left.some((word) => same(one, word)));
    const own = left.some((word) => mark.some((one) => same(one, word)) && marks.every((other, index) => index === at || !other.some((one) => same(one, word))));
    return whole || own;
  });
  return meant.length === 1 ? meant[0]!.at : -1;
}

/** The value a lit word gets from what was said, with the words of it that it used. Null when it gets none. */
function saidValue(word: NotchWord, words: readonly string[]): { value: string; used: Set<number> } | null {
  // A word that takes a sentence is not something a few words are read into.
  if (word.long) return null;
  // One of its choices, or another way of saying one.
  const ways: { value: string; marks: string[][] }[] = word.options.map((option) => ({
    value: option,
    marks: [meaning(option), ...(word.syn?.[option] ?? []).map(meaning)],
  }));
  const hits = ways.map((way) => {
    for (const mark of way.marks) {
      const used = new Set<number>();
      if (mark.length > 0 && mark.every((one) => { const at = words.findIndex((said, index) => !used.has(index) && same(one, said)); if (at >= 0) used.add(at); return at >= 0; })) return { value: way.value, used };
    }
    return null;
  }).filter((hit): hit is { value: string; used: Set<number> } => hit !== null);
  // The one that takes the most of what was said: "more formal" before "formal".
  hits.sort((a, b) => b.used.size - a.used.size);
  if (hits.length > 0 && (hits.length === 1 || hits[0]!.used.size > hits[1]!.used.size)) return hits[0]!;
  if (hits.length > 1) return null;
  // A day, or a day and a time, read as when it is typed.
  if (word.read === 'day' || word.read === 'dayTime' || word.read === 'sched') {
    const when = saidWhen(words);
    // A word that takes one day, or one moment, takes no time by the week: "every weekday" is not a day to meet on.
    if (when.many && word.read !== 'sched') return null;
    if (word.read === 'day') return when.day ? { value: when.day, used: when.dayAt } : null;
    if (!when.day && !when.time && !when.part) return null;
    const [day, time] = word.value.split(' at ');
    // A part of the day with no hour: the middle of it.
    const hour = when.time ?? (when.part === 'afternoon' ? '15:00' : when.part === 'morning' ? '10:00' : null);
    if (word.read === 'sched') {
      const named = when.day && when.day !== 'today' && when.day !== 'tomorrow' ? when.day : null;
      return { value: `${named ?? (when.day ? 'day' : day ?? 'day')} at ${hour ?? time ?? '9:00'}`, used: when.used };
    }
    return { value: `${when.day ?? day ?? ''} at ${hour ?? time ?? '9:00'}`.trim(), used: when.used };
  }
  return null;
}

/**
 * A yes and a no, said. Never one word of the kind a speech-to-text hears in
 * a silence or a cough ("yes", "okay", "no", "thank you"): a line that
 * approves something must not be answered by a noise. Two words, or the word
 * on the line's own key.
 */
const YES = new Set(['yes please', 'yes go ahead', 'go ahead', 'do it', 'yes do it', 'please do', 'ok go ahead', 'okay go ahead', 'ok do it', 'okay do it']);
const NO = new Set(['no thanks', 'no thank you', 'not now', 'not needed', 'skip it', 'leave it', 'no leave it', 'no not now']);

/**
 * What was said, as answers to the line that was up, in the order they are
 * given. Null when it is not about that line: then it is an instruction.
 * An empty list when it is about the line and changes nothing in it ("be
 * polite", on a line that says politely): the line comes back as it was.
 */
export function saidAbout(line: NotchLine, said: string): NotchSaid[] | null {
  const words = saidWords(said);
  if (words.length === 0 || words.length > NOTCH_SAID_WORDS_MAX) return null;
  const options = 'options' in line && Array.isArray(line.options) ? line.options as string[] : [];
  if (options.length > 0) {
    const at = saidOption(options, said);
    return at >= 0 ? [{ act: 'pick', option: options[at]!, index: at }] : null;
  }
  const flat = words.join(' ');
  const yes = 'yes' in line && typeof line.yes === 'string' ? saidWords(line.yes).join(' ') : '';
  if (yes) {
    // The whole of what was said, or it is no yes.
    if (YES.has(flat) || flat === yes || flat === `${yes} it` || flat === `yes ${yes}` || flat === `yes ${yes} it`) return [{ act: 'yes' }];
    if (NO.has(flat)) return [{ act: 'no' }];
  }
  // Lit words: each takes its value from what was said, and together they account for all of it.
  const taken = new Set<number>();
  const answers: NotchSaid[] = [];
  let read = 0;
  for (const word of notchLineWords(line)) {
    const got = saidValue(word, words.map((one, at) => (taken.has(at) ? '' : one)));
    if (!got) continue;
    read++;
    for (const at of got.used) taken.add(at);
    // What it already says is not changed, and is still what was meant: the line comes back as it is.
    if (got.value !== word.value) answers.push({ act: 'word', word: word.name, value: got.value });
  }
  if (read === 0) return null;
  if (words.some((word, at) => !taken.has(at) && !SMALL.has(word))) return null;
  return answers;
}

/** How far apart the keys going down and the line being remembered may be, for what was said to be about that line. */
export const NOTCH_SAID_KEYS_MS = 3000;

export interface NotchSaidLine {
  /** The talk keys went down: the line that is on the notch now is the one they may be about. */
  keys(): void;
  /** What the notch does itself with words said over a line: they answer it. Has no effect until `run`. */
  route(text: string, how?: { source: 'spoken' | 'typed' | 'offered'; at: number }): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
}

export interface NotchSaidDeps {
  /**
   * Whether these words begin as the words for a job, and there is a job they could mean (./teach.ts,
   * `begins`): "do 3 more", "do it at 5". Then they are the job's, or an instruction, and no new value for a
   * word of the line is read out of them. With no job to mean they are read as ever. Not given: as ever.
   */
  jobWords?: (text: string) => boolean;
  /** The item on the notch, and a way to bring one back with its answer (./inbox.ts). */
  inbox: { showing(): string | null; replay(id: string, reads: string, answers: readonly NotchSaid[]): boolean };
  /** The line on the notch now. */
  line(): NotchLine | null;
  /** Items whose lines are not read here: an instruction's own (./asks.ts reads a spoken reply to its question itself). */
  skip?(item: string): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

const did = (answers: readonly NotchSaid[]): string => {
  const [first] = answers;
  if (!first) return 'Brought back the line that was up.';
  if (first.act === 'pick') return `Picked "${first.option}" on the line that was up.`;
  if (first.act === 'yes') return 'Said yes to the line that was up.';
  if (first.act === 'no') return 'Said no to the line that was up.';
  return `Changed the line that was up: ${answers.map((one) => one.value).join(', ')}.`;
};

export function attachNotchSaid(deps: NotchSaidDeps): NotchSaidLine {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let up: { item: string; line: NotchLine; at: number } | null = null;
  /** What was said, as answers to the line the keys were pressed over. Null when it is not about that line. */
  const about = (text: string, how?: { source: string; at: number }): { was: NonNullable<typeof up>; answers: NotchSaid[] } | null => {
    const was = up;
    // Meant only by what was said with the keys that took the line off: not by what is typed, and not by the next thing said.
    if (!was || !how || how.source !== 'spoken' || Math.abs(how.at - was.at) > NOTCH_SAID_KEYS_MS) return null;
    const answers = saidAbout(was.line, text);
    return answers ? { was, answers } : null;
  };
  const hit = (found: { was: NonNullable<typeof up>; answers: NotchSaid[] }): { did: string; run(): void } => ({
    did: did(found.answers),
    run: () => {
      if (up === found.was) up = null;
      // Which line and what kind of answer, never what was said.
      if (deps.inbox.replay(found.was.item, notchLineReads(found.was.line), found.answers)) log(`[notch] a line was answered by voice (${found.answers[0]?.act ?? 'as it was'})`);
      else log('[notch] a line was answered by voice, and could not be brought back: it waits where it was');
    },
  });
  /** A plain yes: one of the fixed ways of saying it, and not the word on the line's own key. */
  const plainYes = (text: string, answers: readonly NotchSaid[]): boolean => answers.length === 1 && answers[0]!.act === 'yes' && YES.has(saidWords(text).join(' '));
  // What an answer sets off is the line's own: the line was shown, and this is its answer.
  const intents: NotchIntent[] = [{
    // "Do it" over an offer is the yes to it, also when a job was once shown that "do it" could mean (rule 206).
    // This is the one thing said over a line that stands before a command.
    id: 'said.yes', feature: 'said', says: 'a plain yes said over a line that takes one ("do it", "go ahead") is the yes to that line', band: 'up', act: 'answer', first: 'acts',
    examples: ['yes do it', 'go ahead', 'do it'],
    over: ['teach.run'],
    match(text, how) {
      const found = about(text, how);
      return found && plainYes(text, found.answers) ? hit(found) : null;
    },
  }, {
    // Asked after everything that has words of its own: "undo", "watch me", "tell Anna" and "continue" keep
    // their meaning also when a choice on the line reads the same.
    id: 'said.answer', feature: 'said', says: 'what is said over a line that is up answers that line: its no, the word on its key, one of its choices, or a new value for one of its lit words', band: 'said', act: 'answer', first: 'acts',
    examples: ['not now', 'make it Friday at ten', 'the second one'],
    match(text, how) {
      const found = about(text, how);
      if (!found || plainYes(text, found.answers)) return null;
      // With a job that was shown, a new value for a word is not read out of a sentence that begins as the
      // words for that job: "do 3 more" is then the job, not three o'clock. With no job it is read as ever.
      const changes = found.answers.length === 0 || found.answers[0]!.act === 'word';
      return changes && deps.jobWords?.(text) === true ? null : hit(found);
    },
  }];
  return {
    keys() {
      const item = deps.inbox.showing();
      const line = deps.line();
      // A line of something that waits for an answer. Mail reads what is said over its own lines (./mail/notch.ts).
      up = item && line && (line.kind === 'offer' || line.kind === 'sheet') && line.src !== 'mail' && !deps.skip?.(item)
        ? { item, line: structuredClone(line), at: now() }
        : null;
    },
    route: (text, how) => routeByIntents(intents, text, how),
    intents: () => intents,
  };
}


/**
 * What is said over the line that is up, as a feature of the notch
 * (./feature.ts). An instruction's own lines are not read here: a spoken
 * reply to its question is read by ./asks.ts itself.
 */
export function notchSaidFeature(more: Pick<NotchSaidDeps, 'jobWords'> = {}): NotchFeatureDef<'said'> {
  return {
    id: 'said',
    make(ctx) {
      const api = attachNotchSaid({ inbox: ctx.inbox, line: () => ctx.surface.current().line, skip: (item) => item.startsWith('ask:'), log: ctx.log, ...more });
      return { api, intents: () => api.intents() };
    },
  };
}
