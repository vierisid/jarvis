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
 *   none      Shows, opens or notes something on the notch itself, or
 *             answers a line of the notch. Nothing leaves this machine,
 *             nothing in another window changes, and nothing is left that
 *             will act by itself later. Opening the settings sheet is here
 *             (opening is not changing), and so is an eye on somebody's
 *             mail: it only ever tells the owner.
 *   screen    Works in the owner's own windows: the pointer, clicks, keys,
 *             a paste, or taking a paste back.
 *   send      Something goes to another person or another machine: a word,
 *             a question, a file, an agent, a job, a mail, the free times of
 *             a calendar.
 *   create    Makes a standing thing that acts by itself later: an agent, a
 *             chase, a job that was shown.
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
 *   'line'    its run shows a line first: an offer that takes a yes, or a
 *             fuse that can be taken back.
 *
 * The rule, held by a test over the table: an intent whose act is screen,
 * send or create shows a line first, unless it names the live context that
 * its words are about (`live`): the thing that is held, the job that was
 * just shown, the paste that was just made. Words alone never set the hands
 * to work.
 *
 * ## Order
 *
 * The table is asked from the top, and the first intent that matches takes
 * the sentence. The order is the order the parts are handed over in, and
 * inside a part the order of its list.
 */

/** What kind of act an intent is. See the top of this file. */
export type NotchIntentAct = 'none' | 'screen' | 'send' | 'create' | 'command' | 'install' | 'settings';

/** The acts that need a line first, or a live context that the words are about. */
export const NOTCH_INTENT_ACTS_GUARDED: readonly NotchIntentAct[] = ['screen', 'send', 'create', 'command', 'install'];

/**
 * Where an intent stands among the others:
 *   control   a word that stops or wakes everything
 *   up        an answer to what is up on the notch now, or was a moment ago
 *   command   something to do
 *   open      something of the notch's own to open
 */
export type NotchIntentBand = 'control' | 'up' | 'command' | 'open';

/** How some words came: typed or spoken, and when the typing was sent or the talk keys went down. */
export interface NotchIntentHow { source: 'spoken' | 'typed' | 'offered' | 'shown'; at: number }

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
  first: 'acts' | 'line';
  /** The live context its words are about, when it acts at once on the screen, sends or creates. */
  live?: string;
  /** Sentences that are this intent, when the state it needs holds. */
  examples: readonly string[];
  /** The fast path: the part's own fixed words. Null when the sentence is not this intent now. */
  match(text: string, how?: NotchIntentHow): NotchIntentHit | null;
}

/** A part that has words of its own. */
export interface NotchIntentSource { intents(): readonly NotchIntent[] }

/** A sentence that an intent took. */
export interface NotchRouted extends NotchIntentHit { intent: NotchIntent }

/** The lists of the parts, put together in the order they are given in. A part that was not made gives none. */
export function notchIntentTable(lists: readonly (readonly NotchIntent[] | null | undefined)[]): NotchIntent[] {
  const table = lists.flatMap((list) => list ?? []);
  const ids = new Set<string>();
  for (const intent of table) {
    if (ids.has(intent.id)) throw new Error(`two intents are called ${intent.id}`);
    ids.add(intent.id);
  }
  return table;
}

/** Which intent of the table takes the sentence: the first that matches. Null when none does. */
export function resolveIntent(table: readonly NotchIntent[], text: string, how?: NotchIntentHow): NotchRouted | null {
  for (const intent of table) {
    const hit = intent.match(text, how);
    if (hit) return { intent, did: hit.did, run: () => hit.run() };
  }
  return null;
}

/** A part's own `route`: the first of its intents that takes the words. */
export function routeByIntents(list: readonly NotchIntent[], text: string, how?: NotchIntentHow): NotchIntentHit | null {
  const hit = resolveIntent(list, text, how);
  return hit ? { did: hit.did, run: hit.run } : null;
}
