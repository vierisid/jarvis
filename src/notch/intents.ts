/**
 * The one table of what a sentence can mean to the notch itself.
 *
 * Every part of the notch that has words of its own ("watch me", "tell Leo
 * ...", "settings") hands over a list of intents, and this file decides which
 * of them takes a sentence. Nothing else decides it: the notch asks here once
 * for each instruction (./asks.ts keeps the answer on the instruction), and
 * so does the corpus of what every sentence means (./intents-corpus.test.ts).
 *
 * An intent is one thing the fixed words can do. Its `match` is the fast
 * path: the part's own regexes, with no model and no waiting. A sentence
 * that no intent matches is an instruction for the assistant like any other.
 *
 * ## What kind of act an intent is (`act`)
 *
 * This is what the owner's words cover when they fit the intent, and it is
 * the field that the question "did the owner ask for this?" is answered
 * from (docs/notch/fixes/01-owner-word.md, step C4). It names the strongest
 * thing the intent can lead to, not what it does on a quiet day:
 *
 *   none      Shows, opens or notes something on the notch itself. Nothing
 *             leaves this machine, nothing in another window changes, and
 *             nothing is left standing. Opening the settings sheet is here
 *             (opening is not changing).
 *   answer    Answers a line that is up on the notch: its yes, its no, a
 *             choice, a new value for one of its words. What that does is
 *             the line's own, and is not known from the words: whoever
 *             reads this field has to ask what the line was about. A yes
 *             to "make agent" creates, a yes to a mail's line sends.
 *   screen    Works in the owner's own windows: the pointer, clicks, keys,
 *             a paste, or taking a paste back.
 *   send      Something goes to another person or another machine: a word,
 *             a question, a file, an agent, a job, a mail, the free times of
 *             a calendar.
 *   create    Makes a standing thing: an agent, a chase, a job that was
 *             shown, an eye that is kept on somebody's mail.
 *   command   Runs a program or a shell command. No fixed word does this
 *             today. It is here so that a reading of a sentence (the next
 *             step) and the owner's-word check have one closed set.
 *   install   Installs or removes software. No fixed word does this today.
 *   settings  Changes how Jarvis itself behaves from now on: a rule for one
 *             person, a switch.
 *
 * An instruction that no intent took has no act here: what its words cover
 * is for whoever reads the sentence to say, and until somebody does they
 * cover nothing.
 *
 * ## Whether it acts at once (`first`)
 *
 *   'acts'    its run does the thing with nothing asked.
 *   'yes'     its run shows a line that waits for a yes: nothing happens
 *             without one.
 *   'fuse'    its run shows a line under a fuse: it can be taken back while
 *             the fuse burns, and goes by itself when it has burnt.
 *
 * The rule, held by a test over the table: an intent whose act is screen,
 * send or create shows a line first ('yes' or 'fuse'), unless it names the
 * live context that its words are about (`live`): the thing that is held,
 * the job that was just shown, the paste that was just made. Words alone
 * never set the hands to work. One intent is let off, and says why
 * (`alone`): an eye is kept at once, as it always was.
 *
 * ## Order (`band`, `over`)
 *
 * The table is asked from the top, and the first intent that matches takes
 * the sentence. No model settles it. The order is declared:
 *
 *   1. control   a word that stops everything ("pause")
 *   2. up        an answer to what is up on the notch now, or was a moment
 *                ago: day one waiting to hear the person, a draft, a line
 *                that takes a yes, a showing that waits for "done"
 *   3. command   something to do
 *   4. open      something of the notch's own to open
 *   5. said      what was said over a line that was up, when it is none of
 *                the above: a no, a choice, a new value for a word
 *
 * Inside a band the order is the order the parts are handed over in, and
 * inside a part the order of its list. A plain yes said over an offer
 * ("do it", "go ahead") stands with what is up, so it is the yes to that
 * offer, also when a job was once shown that "do it" could mean
 * (docs/notch/README.md, rule 206). Everything else that is said over a
 * line is asked last: "undo", "watch me" and "tell Anna" keep their own
 * meaning also when a choice on the line happens to read the same.
 *
 * When a sentence can be matched by two intents, the one that takes it says
 * so: `over` names the intents it is taken from. A test over the corpus
 * holds that no sentence there is matched twice without it, so a new intent
 * cannot quietly take, or lose, somebody else's words.
 *
 * ## Words that are not an intent (`never`)
 *
 * Sentences that look like the intent and are not: "do it by email" is not
 * the job that was shown. A test holds that the fast path of the intent
 * does not take them. They are also what a reading of a sentence (the next
 * step) is shown as "none of these".
 *
 * ## A reply (`inReply`)
 *
 * When the assistant has asked something back and the person answers, what
 * they say is the answer: it goes to the assistant, and no intent takes it.
 * "Do it", said to "Shall I send it?", is not the job that was shown. Only
 * an intent marked `inReply` is still asked: "pause", which pauses whatever
 * is on the notch, and "undo", which takes back the notch's last paste.
 */

/** What kind of act an intent is. See the top of this file. */
export type NotchIntentAct = 'none' | 'answer' | 'screen' | 'send' | 'create' | 'command' | 'install' | 'settings';

/** The acts that need a line first, or a live context that the words are about. */
export const NOTCH_INTENT_ACTS_GUARDED: readonly NotchIntentAct[] = ['screen', 'send', 'create', 'command', 'install'];

/**
 * Where an intent stands among the others:
 *   control   a word that stops or wakes everything
 *   up        an answer to what is up on the notch now, or was a moment ago
 *   command   something to do
 *   open      something of the notch's own to open
 *   said      what was said over a line that was up, and is none of the above
 */
export type NotchIntentBand = 'control' | 'up' | 'command' | 'open' | 'said';

/** The bands, in the order they are asked in. */
export const NOTCH_INTENT_BANDS: readonly NotchIntentBand[] = ['control', 'up', 'command', 'open', 'said'];

/**
 * How some words came: typed or spoken, and when the typing was sent or the talk keys went down. `reply`: they
 * are the answer to a question the assistant asked back, typed into its line or said while it was up.
 */
export interface NotchIntentHow { source: 'spoken' | 'typed' | 'offered' | 'shown'; at: number; reply?: boolean }

/** What an intent would do with a sentence: what the ledger says was done, and the doing. Nothing happens until `run`. */
export interface NotchIntentHit { did: string; run(): void }

export interface NotchIntent {
  /** `<part>.<what>`, as in 'teach.run'. Never changed once it is out: it is what is kept on an instruction. */
  id: string;
  /** The part that handed it over, by the name ./real.ts has for it. */
  feature: string;
  /** What it is, in one line, as a person would say it. */
  says: string;
  band: NotchIntentBand;
  act: NotchIntentAct;
  first: 'acts' | 'yes' | 'fuse';
  /** The live context its words are about, when it acts at once on the screen, sends or creates. */
  live?: string;
  /** Why it may act at once with no line and no live context. Only where that is how it always was. */
  alone?: string;
  /** Sentences that are this intent, when the state it needs holds. */
  examples: readonly string[];
  /** Sentences that look like it and are not: its fast path must not take them. */
  never?: readonly string[];
  /**
   * The intents further down that can match a sentence this one takes. 'any': it takes whatever is said while
   * what it answers is up (day one waiting to hear the person, a draft that is open).
   */
  over?: readonly string[] | 'any';
  /** Still asked when the words are the reply to a question the assistant asked back: the control word, and the take-back. */
  inReply?: boolean;
  /** The fast path: the part's own fixed words. Null when the sentence is not this intent now. */
  match(text: string, how?: NotchIntentHow): NotchIntentHit | null;
}

/** A part that has words of its own. */
export interface NotchIntentSource { intents(): readonly NotchIntent[] }

/** A sentence that an intent took. */
export interface NotchRouted extends NotchIntentHit { intent: NotchIntent }

/**
 * The lists of the parts as one table, in the order it is asked in: by band, and inside a band in the order
 * the lists are given in. A part that was not made gives none.
 */
export function notchIntentTable(lists: readonly (readonly NotchIntent[] | null | undefined)[]): NotchIntent[] {
  const given = lists.flatMap((list) => list ?? []);
  const ids = new Set<string>();
  for (const intent of given) {
    if (ids.has(intent.id)) throw new Error(`two intents are called ${intent.id}`);
    ids.add(intent.id);
    if (!NOTCH_INTENT_BANDS.includes(intent.band)) throw new Error(`${intent.id} stands in no band`);
  }
  return NOTCH_INTENT_BANDS.flatMap((band) => given.filter((intent) => intent.band === band));
}

/** Whether an intent is asked about these words at all: a reply to the assistant's question is only a control word's. */
const asked = (intent: NotchIntent, how?: NotchIntentHow): boolean => how?.reply !== true || intent.inReply === true;

/** Which intent of the table takes the sentence: the first that matches. Null when none does. */
export function resolveIntent(table: readonly NotchIntent[], text: string, how?: NotchIntentHow): NotchRouted | null {
  for (const intent of table) {
    if (!asked(intent, how)) continue;
    const hit = intent.match(text, how);
    if (hit) return { intent, did: hit.did, run: () => hit.run() };
  }
  return null;
}

/**
 * Every intent of the table that matches the sentence, in the order of the table: the first is the one that
 * takes it. For the tests that hold the declared overlaps; the notch itself asks `resolveIntent`.
 */
export function matchingIntents(table: readonly NotchIntent[], text: string, how?: NotchIntentHow): NotchIntent[] {
  return table.filter((intent) => asked(intent, how) && intent.match(text, how) !== null);
}

/** A part's own `route`: the first of its intents that takes the words. */
export function routeByIntents(list: readonly NotchIntent[], text: string, how?: NotchIntentHow): NotchIntentHit | null {
  const hit = resolveIntent(list, text, how);
  return hit ? { did: hit.did, run: hit.run } : null;
}
