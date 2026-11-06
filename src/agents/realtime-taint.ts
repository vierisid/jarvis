/**
 * The taint of ONE realtime voice session (#928), and what clears it (#1007).
 *
 * A text turn owns a Set that `executeTool` enters through AsyncLocalStorage.
 * A realtime voice session has no turn objects, so its taint lived in one
 * process-wide set on the orchestrator: the dashboard's session and every
 * pebble's read and cleared the same marks. A page read on one surface
 * refused an action spoken on another, and anyone starting to speak on one
 * surface cleared what another had read.
 *
 * Each realtime session now owns one of these. Its tool calls run inside
 * `marks` (see `AgentOrchestrator.executeRealtimeToolCall`), so taint noted by
 * a call, and anything a call spawns, belongs to that session alone. Only the
 * session's own tool calls write it; they and the session's room-action gate
 * (`getRealtimeSessionTaint`) read it.
 *
 * WHAT CLEARS IT (#1007, owner decision 2026-10-20): only a final transcript
 * with words in it. It used to be the server VAD's speech start, which fires
 * on a cough or a door, so one sound after a page read cleared the taint while
 * the page stayed in the model's context. Speech from anyone the mic hears
 * (another person, the TV) still transcribes to words and still clears: that
 * is the residual the owner chose.
 *
 * The trap that rules out "clear everything on a transcript": the transcript
 * is asynchronous. The response to an utterance, and its tool calls, can run
 * before that utterance's own transcript arrives. Clearing everything then
 * would clear a read the SAME utterance's response made, and the page could
 * drive the next call in that response untainted. So a transcript clears only
 * the marks noted before its utterance began:
 *
 * - `speech_started` for an utterance records how far the marks had got (a
 *   watermark), keyed by the utterance's conversation item id;
 * - the transcript for that item id clears the marks noted up to that
 *   watermark, and nothing noted after it.
 *
 * The ordering this relies on: an utterance's `speech_started` arrives before
 * any tool call of the response to it (the server creates that response after
 * the speech, and events come in order on one socket), and a mark is noted
 * when the tool call that read the content returns. So a read made for an
 * utterance, or still running when it began, is always past its watermark and
 * survives its transcript, whether the transcript lands before or after it.
 * Nothing relies on when the transcript arrives. The cost, which the owner
 * accepted: a request made right after a read is refused when its tool call
 * beats its own transcript, and stays refused until that transcript lands
 * (or, if its transcription fails or never comes, a later utterance's).
 *
 * Fail safe throughout: a transcript with no item id, or one whose utterance
 * start was never seen, clears nothing.
 *
 * Nor does a bare affirmation ("yes", "ok", "yeah go ahead") while the
 * session holds any mark (owner decision 2026-11-05, #1156): after a page
 * read, "shall I run it?" can be the page speaking through the assistant, and
 * a plain yes to it is not the person's own request. Any mark includes a
 * declined intent (Q-08): a spoken yes does not walk around a denied card.
 * The accepted cost: they have to say what they want ("yes, run the build").
 */

/** A transcript with no letter or digit in it is not something the user said. */
const SPOKEN = /[\p{L}\p{N}]/u;

/**
 * Utterance starts remembered while their transcripts are awaited. A cough
 * leaves one that no transcript will ever claim, so they are bounded; the
 * oldest is dropped first, and its transcript, should it still come, clears
 * nothing (fail safe).
 */
export const MAX_PENDING_UTTERANCES = 32;

/**
 * A Set that remembers when each mark was last noted. Always built empty:
 * the Set constructor would call `add` for an iterable before `noted` exists.
 */
class SequencedMarks extends Set<string> {
  private noted = new Map<string, number>();
  private counter = 0;

  /** Noting a mark again moves it past every earlier watermark. */
  override add(mark: string): this {
    this.noted.set(mark, ++this.counter);
    return super.add(mark);
  }

  override delete(mark: string): boolean {
    this.noted.delete(mark);
    return super.delete(mark);
  }

  override clear(): void {
    this.noted.clear();
    super.clear();
  }

  /** How far the marks have got: every mark noted so far is at or below it. */
  get watermark(): number {
    return this.counter;
  }

  /** Remove the marks last noted at or before `watermark`. */
  clearThrough(watermark: number): void {
    for (const [mark, at] of this.noted) if (at <= watermark) this.delete(mark);
  }
}

/**
 * A reply that only agrees to what was just proposed, with nothing of its own
 * in it (owner decision 2026-11-05, #1156): at least one word of agreement,
 * and every other word filler, politeness or a wake word. Any word of content
 * ("build", "email", "bob") makes it the person's own request, so this cannot
 * hold an ordinary request back.
 *
 * Wide on purpose: a yes missed here clears the taint, which is the unsafe
 * direction. ws-service's isVoiceAffirmative is narrow on purpose (a yes it
 * misses leaves a held room action unconfirmed); do not merge the two.
 * English and Italian, the languages known to be spoken to it; a yes in
 * another language still clears. Typed replies too (agents/turn-taint-carry.ts
 * carries a text turn's taint across one): a stretched word ("yesss", "okk")
 * is read with its repeats collapsed, and an emoji is agreement, so a reply of
 * only emoji ("thumbs up") is a yes.
 */
const AGREEMENT: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yea', 'yep', 'yup', 'ya', 'yah', 'ok', 'okay', 'k', 'kk', 'sure', 'alright', 'right', 'fine',
  'correct', 'affirmative', 'proceed', 'confirm', 'confirmed', 'approve', 'approved', 'absolutely', 'definitely',
  'certainly', 'mhm', 'agreed', 'do', 'ahead', 'si', 'sì', 'certo', 'procedi', 'bene', 'fallo', 'vai', 'perfetto', 'esatto',
  'go', 'y', 'ye', 'yeh', 'okie', 'lgtm', 'course', 'good', 'sí', 'cool', 'great', 'perfect', 'nice', 'awesome',
]);
const FILLER: ReadonlySet<string> = new Set([
  'it', 'for', 'on', 'of', 'with', 'looks', 'to', 'me', 'why', 'not', 'pls', 'plz', 'thx', 'ty', 'now', 'just', "let's", 'lets', 'please', 'thanks', 'thank', 'you', 'sir',
  'sounds', 'good', "that's", 'thats', 'that', 'this', 'one', 'all', 'is', 'so', 'then', 'o', 'and', 'again', 'thing',
  'uh', 'um', 'mm', 'hmm', 'huh', 'er', 'ah', 'oh', 'jarvis', 'hey', 'hi',
  'va', 'pure', 'grazie', 'per', 'favore', 'dai', 'ok',
]);

/** An emoji, with its presentation selector and skin tone, read as agreement. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/** Whether `text` is only a yes to whatever was proposed (see AGREEMENT). */
export function isBareAffirmation(text: string): boolean {
  const normalized = text.normalize('NFKC');
  const said = words(normalized);
  const agrees = (w: string) => AGREEMENT.has(w) || AGREEMENT_COLLAPSED.has(collapsed(w));
  const fills = (w: string) => FILLER.has(w) || FILLER_COLLAPSED.has(collapsed(w));
  return (PICTOGRAPH.test(normalized) || said.some(agrees)) && said.every((w) => agrees(w) || fills(w));
}

/** `w` with each run of one letter shortened to one: "yesss" -> "yes". */
function collapsed(w: string): string {
  return w.replace(/(.)\1+/gu, '$1');
}

/** The lists collapsed the same way, so "goood" meets "good" and "hmmm" "hmm". */
const AGREEMENT_COLLAPSED: ReadonlySet<string> = new Set([...AGREEMENT].map(collapsed));
const FILLER_COLLAPSED: ReadonlySet<string> = new Set([...FILLER].map(collapsed));

/** The words of `text`, lowercased, for comparing what was heard with what was said. */
function words(text: string): string[] {
  // Typed apostrophes are often curly (smart punctuation): read them as `'`.
  return text.replace(/[\u2018\u2019\u02bc\u02b9\u2032\uff07]/gu, "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * Whether a user transcript is the assistant's own speech coming back in
 * through the mic (#1156): every word of it, in order and side by side, is in
 * something the assistant has just said. The browser's echo cancellation and
 * the pebble's half-duplex mic gate catch most of it, not all (a loud speaker,
 * the room's tail after the gate reopens), and an echo transcribes to words
 * like any speech, so on its own it would clear the session's taint with
 * words the page put in the assistant's mouth.
 *
 * Fail safe: a person repeating the assistant's words exactly ("send it" after
 * "shall I send it?") is taken for an echo too, and clears nothing. The cost is
 * the one the owner accepted for #1007: a governed request is refused until
 * the person says something of their own.
 *
 * Defence in depth, not a detector: an echo the transcription model changes
 * (a word misheard, room noise added) still clears. The caller compares only
 * with what the assistant had said when the utterance began, never with the
 * reply to it.
 */
export function echoesAssistant(userText: string, assistantSpeech: readonly string[]): boolean {
  const said = words(userText);
  if (said.length === 0) return false;
  for (const speech of assistantSpeech) {
    const heard = words(speech);
    for (let i = 0; i + said.length <= heard.length; i++) {
      let j = 0;
      while (j < said.length && heard[i + j] === said[j]) j++;
      if (j === said.length) return true;
    }
  }
  return false;
}

export class RealtimeTaint {
  /** The set the orchestrator enters for this session's tool calls. */
  readonly marks = new SequencedMarks();
  /** Utterance item id -> the watermark when it began. Insertion-ordered. */
  private utterances = new Map<string, number>();

  /**
   * The user has started a new utterance (server VAD). Records where it began;
   * clears nothing, since a VAD start is any sound at all.
   */
  userTurnStarted(itemId?: string): void {
    if (!itemId) return;
    // A repeated start for the same item keeps where it first began: moving
    // it later would let its transcript clear reads made after it began.
    if (this.utterances.has(itemId)) return;
    this.utterances.set(itemId, this.marks.watermark);
    while (this.utterances.size > MAX_PENDING_UTTERANCES) {
      const oldest = this.utterances.keys().next().value as string;
      this.utterances.delete(oldest);
    }
  }

  /**
   * A final transcript of what the user said. Clears the marks noted before
   * that utterance began, and returns whether it cleared (anything or nothing)
   * as a boundary. An empty or wordless transcript, one with no item id, one
   * for an utterance whose start was not seen, and a bare affirmation while
   * any mark is held (#1156) are no boundary.
   */
  userTranscript(itemId: string | undefined, text: string): boolean {
    if (!SPOKEN.test(text)) return false;
    // A bare "yes" after the session read outside content agrees to what the
    // assistant proposed, and that proposal may be the page's (owner
    // decision 2026-11-05, #1156). It is not a fresh request, so it clears
    // nothing; the person says what they want in their own words instead.
    if (this.marks.size > 0 && isBareAffirmation(text)) return false;
    if (!itemId) return false;
    const began = this.utterances.get(itemId);
    if (began === undefined) return false;
    this.marks.clearThrough(began);
    // This utterance, and any that began no later (a cough with no
    // transcript, or one whose transcript would now clear nothing more).
    for (const [id, at] of this.utterances) if (at <= began) this.utterances.delete(id);
    return true;
  }
}
