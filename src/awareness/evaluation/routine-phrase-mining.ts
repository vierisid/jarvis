/**
 * Local phrase mining for routine detection (#1068).
 *
 * The field measurement (routine-field-measure.ts) shows where real captures
 * stop, but not which words real screens show. This lists the most frequent
 * 2-3 word sequences on captures that matched a family's source phrase, and on
 * the captures that followed one on the same device within the episode gap
 * (where the operation and output screens would be), so the catalog phrases
 * can be tuned from real OCR.
 *
 * Unlike the field measurement this prints screen words, so it is
 * default-deny: a sequence is kept only if every word is plain letters (no
 * digits, no @, no dots, no word over 20 letters), it is not made of
 * stopwords at either end, and it was seen on at least `minCount` captures on
 * `minDays` distinct days. Emails, amounts, dates, ids, URLs and one-off names
 * are dropped that way. A name seen on many days can still pass, so the owner
 * reads the output before sharing it. Nothing else is carried: no whole lines,
 * titles, app names, capture or device ids, or timestamps.
 */
import { ROUTINES } from '../routine-catalog.ts';
import { EPISODE_GAP_MS } from '../routine-episodes.ts';
import { routineAbstention, type RoutineAbstention, type RoutineCapture } from '../routine-signals.ts';

export type PhraseMiningOptions = {
  /** Distinct captures a sequence must appear on. */
  minCount: number;
  /** Distinct UTC days those captures must span. */
  minDays: number;
  /** Sequences listed per family and bucket. */
  top: number;
};
export const DEFAULT_PHRASE_MINING: PhraseMiningOptions = { minCount: 3, minDays: 2, top: 40 };

export type MinedPhrase = {
  phrase: string;
  /** Captures in this bucket the sequence appears on. */
  captures: number;
  days: number;
  /** Of all read captures, how many show it: high means window chrome, not the routine. */
  allCaptures: number;
};
export type FamilyPhrases = {
  sourceCaptures: number;
  followingCaptures: number;
  source: MinedPhrase[];
  following: MinedPhrase[];
};
export type RoutinePhraseReport = {
  schemaVersion: 1;
  data: 'local captures, filtered word sequences; review before sharing';
  captures: number;
  read: number;
  abstained: Record<RoutineAbstention, number>;
  options: PhraseMiningOptions;
  families: Record<string, FamilyPhrases>;
};

const MAX_WORD = 20;
// Letters only, with inner apostrophes or hyphens ("follow-up", "l'importo").
const WORD = /^\p{L}+(?:['\u2019-]\p{L}+)*$/u;
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'is', 'are', 'was',
  'be', 'it', 'this', 'that', 'as', 'not', 'no', 'you', 'your', 'we', 'our', 'i', 'my', 'me',
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'di', 'da', 'del', 'della', 'dei', 'delle', 'e', 'o', 'per',
  'con', 'su', 'che', 'non', 'al', 'alla', 'nel', 'nella',
]);

/** The distinct allowed 2-3 word sequences on one capture. A rejected word breaks the run. */
export function captureNgrams(capture: Pick<RoutineCapture, 'windowTitle' | 'ocrText'>): Set<string> {
  const grams = new Set<string>();
  const lines = `${capture.windowTitle ?? ''}\n${capture.ocrText ?? ''}`.split(/\r?\n/);
  for (const line of lines) {
    // Separators such as | : , ( ) end a run; within a segment, words are
    // split on whitespace and a word that is not plain letters ends the run.
    for (const segment of line.split(/[|:;,()[\]{}<>"\u201c\u201d!?/\\\u2022\u00b7\t]+/)) {
      let run: string[] = [];
      const flush = () => {
        for (let n = 2; n <= 3; n++) {
          for (let i = 0; i + n <= run.length; i++) {
            const words = run.slice(i, i + n);
            if (STOPWORDS.has(words[0]!) || STOPWORDS.has(words[n - 1]!)) continue;
            grams.add(words.join(' '));
          }
        }
        run = [];
      };
      for (const raw of segment.split(/\s+/)) {
        if (!raw) continue;
        // Trailing sentence periods are fine; any other dot (domains, emails, amounts) rejects the word.
        const token = raw.replace(/\.+$/, '').toLowerCase();
        if (token.length === 0 || token.length > MAX_WORD || !WORD.test(token)) { flush(); continue; }
        run.push(token);
        if (raw.endsWith('.')) flush();
      }
      flush();
    }
  }
  return grams;
}

// Captures arrive in timestamp order, so distinct days are counted by the
// last day seen instead of a set per sequence (a full screen has thousands).
type Tally = Map<string, { captures: number; days: number; lastDay: string }>;
function add(tally: Tally, grams: Set<string>, day: string) {
  for (const g of grams) {
    const t = tally.get(g);
    if (!t) { tally.set(g, { captures: 1, days: 1, lastDay: day }); continue; }
    t.captures++;
    if (t.lastDay !== day) { t.days++; t.lastDay = day; }
  }
}

/**
 * `captures` is called twice (once to tally the routine screens, once to count
 * the surviving sequences on all screens), so a caller can stream rows from
 * the database instead of holding them. Each pass must yield the same
 * captures in timestamp order.
 */
export function mineRoutinePhrases(captures: () => Iterable<RoutineCapture>,
  options: PhraseMiningOptions = DEFAULT_PHRASE_MINING): RoutinePhraseReport {
  const abstained: Record<RoutineAbstention, number> = { excluded: 0, invalid: 0, oversize: 0, private: 0, reading: 0 };
  const tallies = new Map(ROUTINES.map(job => [job.kind, {
    sourceCaptures: 0, followingCaptures: 0, source: new Map() as Tally, following: new Map() as Tally,
    // Last source match per device, for the following bucket.
    lastSource: new Map<string | null, number>(),
  }]));
  let total = 0;
  let read = 0;
  for (const capture of captures()) {
    total++;
    const gate = routineAbstention(capture);
    if (gate !== null) { abstained[gate]++; continue; }
    read++;
    const text = `${capture.windowTitle ?? ''}\n${capture.ocrText ?? ''}`;
    const device = capture.sidecarId || null;
    const day = new Date(capture.timestamp).toISOString().slice(0, 10);
    let grams: Set<string> | undefined;
    for (const job of ROUTINES) {
      const t = tallies.get(job.kind)!;
      if (job.source.test(text)) {
        t.sourceCaptures++;
        add(t.source, grams ??= captureNgrams(capture), day);
        t.lastSource.set(device, capture.timestamp);
        continue;
      }
      const last = t.lastSource.get(device);
      if (last !== undefined && capture.timestamp > last && capture.timestamp - last <= EPISODE_GAP_MS) {
        t.followingCaptures++;
        add(t.following, grams ??= captureNgrams(capture), day);
      }
    }
  }

  const keep = (tally: Tally) => [...tally].filter(([, t]) => t.captures >= options.minCount && t.days >= options.minDays)
    .sort((a, b) => b[1].captures - a[1].captures || a[0].localeCompare(b[0])).slice(0, options.top);
  const kept = new Map([...tallies].map(([kind, t]) => [kind, { source: keep(t.source), following: keep(t.following) }]));
  const overall = new Map<string, number>();
  for (const k of kept.values()) for (const [g] of [...k.source, ...k.following]) overall.set(g, 0);
  if (overall.size > 0) {
    for (const capture of captures()) {
      if (routineAbstention(capture) !== null) continue;
      for (const g of captureNgrams(capture)) {
        const n = overall.get(g);
        if (n !== undefined) overall.set(g, n + 1);
      }
    }
  }
  const families: Record<string, FamilyPhrases> = {};
  for (const [kind, t] of tallies) {
    const k = kept.get(kind)!;
    const list = (rows: typeof k.source): MinedPhrase[] => rows.map(([phrase, c]) =>
      ({ phrase, captures: c.captures, days: c.days, allCaptures: overall.get(phrase) ?? 0 }));
    families[kind] = { sourceCaptures: t.sourceCaptures, followingCaptures: t.followingCaptures,
      source: list(k.source), following: list(k.following) };
  }
  return { schemaVersion: 1, data: 'local captures, filtered word sequences; review before sharing',
    captures: total, read, abstained, options, families };
}
