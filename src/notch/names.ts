/**
 * A name that may have been misheard is read back before anything runs.
 *
 * The prototype: 'I heard "send the notes to Ana". Is that Anna Rossi?', with
 * the name as a word that can be changed. Speech-to-text is at its worst with
 * names: it writes "Ana" for Anna and "Marko" for Marco, and an instruction
 * then goes to nobody, or to the wrong person. Only a spoken "remember" was
 * read back before.
 *
 * What is read here is whether a spoken instruction names somebody in a way
 * that is not sure. It is, in two cases, and in no other:
 *
 *   - **A name that is close to somebody Jarvis knows, and is not theirs.**
 *     "Ana", with an Anna Rossi among the people the owner writes with. One
 *     letter off for a short name, two for a long one, or the same sounds.
 *   - **A first name that two of them have**, said without a surname.
 *
 * A name that is exactly one known person's is sure, and so is a name that is
 * near nobody's: then it is somebody Jarvis does not know, and the
 * instruction runs as it was said.
 *
 * Only a word the speech-to-text wrote with a capital letter, inside a
 * sentence, is taken to be a name at all: that is how it writes them. The
 * first word of a sentence has its capital for another reason, and days,
 * months and programs have theirs.
 *
 * Nothing here asks a model, and no name is ever written to a log.
 */

/** A word in an instruction that may name somebody, and who it may be. */
export interface NotchNameDoubt {
  /** The word as it was heard, with a surname when one followed it. */
  heard: string;
  /** Where it stands in the instruction: from this letter up to, not including, that one. */
  from: number;
  to: number;
  /** Who it may be, the likeliest first. Whole names, as Jarvis knows them. */
  options: string[];
}

/** The most people a read-back offers. */
export const NOTCH_NAME_OPTIONS = 4;

/** Words that have a capital letter and name nobody. */
const NOT_NAMES = new Set([
  'i', 'im', 'ill', 'ive', 'id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jarvis', 'pillow', 'gmail', 'google', 'slack', 'excel', 'word', 'chrome', 'stripe', 'zoom', 'teams', 'notion', 'drive', 'sheets', 'docs',
  'calendar', 'outlook', 'windows', 'mac', 'linkedin', 'whatsapp', 'telegram', 'github', 'figma', 'ok', 'okay', 'english', 'italian',
]);

const plain = (word: string): string => word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

/** How many single changes turn one word into the other: a letter put in, left out, changed, or two swapped. */
export function nameDistance(a: string, b: string): number {
  const rows = a.length + 1, cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[rows - 1]![cols - 1]!;
}

/** The sounds of a name, roughly: its first letter, then its consonants with the ones that sound alike made the same. */
function sounds(name: string): string {
  const alike: Record<string, string> = { k: 'c', q: 'c', z: 's', v: 'f', y: 'i', j: 'g', d: 't', p: 'b', m: 'n' };
  const letters = [...name].map((letter) => alike[letter] ?? letter);
  const kept = letters.filter((letter, at) => at === 0 || !'aeiouh'.includes(letter));
  // A letter said twice is said once.
  return kept.filter((letter, at) => at === 0 || letter !== kept[at - 1]).join('');
}

/** Whether a name that was heard may be this one, without being it: how far off it is, or null when it is too far. */
function near(heard: string, known: string): number | null {
  if (heard === known) return 0;
  const distance = nameDistance(heard, known);
  const longest = Math.max(heard.length, known.length);
  if (distance <= (longest <= 5 ? 1 : 2)) return distance;
  // "Kristian" and "Christian", "Stefan" and "Stephan": far in letters, the same when said.
  return Math.abs(heard.length - known.length) <= 2 && heard[0] === known[0] && sounds(heard) === sounds(known) ? 3 : null;
}

/**
 * The first word of a spoken instruction that names somebody in a way that
 * is not sure, with who it may be. Null when every name in it is sure, or it
 * names nobody Jarvis knows.
 */
export function notchNameDoubt(text: string, people: readonly { name: string }[]): NotchNameDoubt | null {
  // Whole names of people, each once, in the order given: the ones dealt with last come first.
  const known: { full: string; first: string; rest: string }[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const full = person.name.replace(/\s+/g, ' ').trim();
    if (!full || full.includes('@') || full.length > 60 || seen.has(full.toLowerCase())) continue;
    const [given = '', ...family] = full.split(' ');
    const first = plain(given);
    if (first.length < 2) continue;
    seen.add(full.toLowerCase());
    known.push({ full, first, rest: plain(family.join('')) });
  }
  if (known.length === 0) return null;

  const words = [...text.matchAll(/\p{L}[\p{L}'’-]*/gu)].map((match) => ({ word: match[0], at: match.index ?? 0 }));
  for (let n = 0; n < words.length; n++) {
    const { word, at } = words[n]!;
    // The first word of a sentence has its capital whatever it is.
    const opens = n === 0 || /[.!?]\s*$/.test(text.slice(0, at));
    if (opens || word[0] !== word[0]!.toUpperCase() || word[0] === word[0]!.toLowerCase()) continue;
    const heard = plain(word);
    if (heard.length < 3 || NOT_NAMES.has(heard)) continue;
    // A surname said after it, when the next word has a capital too.
    const next = words[n + 1];
    const follows = next && /^\s+$/.test(text.slice(at + word.length, next.at)) && next.word[0] !== next.word[0]!.toLowerCase() && !NOT_NAMES.has(plain(next.word)) ? next : null;
    const family = follows ? plain(follows.word) : '';

    const same = known.filter((person) => person.first === heard);
    if (same.length === 1) continue;
    if (same.length > 1) {
      // Two of them have that first name: the surname says which, when it was said and is one of theirs.
      if (family && same.filter((person) => person.rest.startsWith(family) || family.startsWith(person.rest)).length === 1) continue;
      return { heard: word, from: at, to: at + word.length, options: same.slice(0, NOTCH_NAME_OPTIONS).map((person) => person.full) };
    }
    const close = known.map((person, order) => ({ person, order, off: near(heard, person.first) }))
      .filter((one): one is { person: typeof known[number]; order: number; off: number } => one.off !== null)
      .sort((a, b) => a.off - b.off || a.order - b.order);
    if (close.length === 0) continue;
    // With a surname said, those whose surname it is come first; the word that is read back takes the surname with it.
    const byFamily = family ? close.filter((one) => one.person.rest && near(family, one.person.rest) !== null) : [];
    const ordered = [...byFamily, ...close.filter((one) => !byFamily.includes(one))];
    const to = follows && byFamily.length > 0 ? follows.at + follows.word.length : at + word.length;
    return { heard: text.slice(at, to), from: at, to, options: ordered.slice(0, NOTCH_NAME_OPTIONS).map((one) => one.person.full) };
  }
  return null;
}

/** The instruction with the name that was in doubt put right: who was chosen stands where the word was heard. */
export function notchNamed(text: string, doubt: Pick<NotchNameDoubt, 'from' | 'to'>, chosen: string): string {
  // eslint-disable-next-line no-control-regex
  const name = chosen.replace(/[\u0000-\u001f\u007f"<>`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  if (!name || doubt.from < 0 || doubt.to > text.length || doubt.to <= doubt.from) return text;
  return `${text.slice(0, doubt.from)}${name}${text.slice(doubt.to)}`;
}
