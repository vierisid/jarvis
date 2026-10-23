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
   * as a boundary. An empty or wordless transcript, one with no item id, and
   * one for an utterance whose start was not seen are no boundary.
   */
  userTranscript(itemId: string | undefined, text: string): boolean {
    if (!SPOKEN.test(text)) return false;
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
