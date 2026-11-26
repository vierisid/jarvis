/**
 * One mail written into one thread and sent: the one way the notch does it.
 *
 * A reply the owner said yes to (./notch.ts), a time they picked for one, and
 * a nudge of a chase or the follow-up of a call (./attach.ts `sendNudge`) all
 * go through here. They used to be two copies of the same steps, and each
 * was put right for what the other had already learned.
 *
 * The steps, in this order, with the tab to itself from the first to the last
 * (`Mailbox.reply`):
 *
 *   stopped?   the owner stopped it before anything was written
 *   write      into the thread, as a draft. A draft that was there before is
 *              somebody's: nothing is written, and nothing is thrown away
 *   stopped?   the owner stopped it while it was written: it is taken away
 *   gate       what stands between the draft and Send: a fuse. Only a yes
 *              lets it go. Anything else takes the draft away again, and so
 *              does a gate that fails (something took the notch)
 *   send       Send is pressed, once
 *   look       whether it went, by Gmail's word and by the thread
 *
 * What it answers is one of three things. `sent`. `not_sent`: Send was not
 * pressed, and where it ended. `unsure`: Send was pressed, or it is not known
 * that it was not, and nothing says it went. Such a mail may be on its way:
 * whoever sends it again looks for it first (`Mailbox.went`), from `since`.
 *
 * The callers differ in two things, and say which they want:
 *
 *   trust      what Gmail saying "sent" after the press is worth. For a reply
 *              the thread must show it as well (README 62). For a nudge
 *              Gmail's word is enough, by the choice of 17 November 2026
 *   leftover   what is done with the reply when Send did not go through: a
 *              reply the owner read stays in their drafts and is said to be
 *              there, a nudge is taken away
 *
 * What is said on the notch about any of it is the caller's.
 */
import { MAIL_WHY_DRAFT_THERE, type Mailbox, type MailReplyPlan, type MailStep } from './mailbox.ts';

/**
 * What became of the draft that was put in the thread:
 *   none    nothing was written
 *   gone    it was taken away again
 *   left    taking it away did not work: one may be left in the thread
 *   theirs  a draft was there before, somebody's: it was not touched
 *   kept    it was left where it is on purpose
 */
export type MailDraftEnd = 'none' | 'gone' | 'left' | 'theirs' | 'kept';

export type MailSendEnd =
  | { state: 'sent' }
  | {
    state: 'not_sent';
    /** Where it ended: stopped by the owner, at the write, at the gate, or Send refused before it was pressed. */
    at: 'stopped' | 'write' | 'gate' | 'send';
    why: string;
    draft: MailDraftEnd;
    /** Why the draft could not be taken away, when it could not. */
    leftWhy?: string;
  }
  | {
    state: 'unsure';
    /** The moment before the press: where a later look for this mail begins. */
    since: number;
    why: string;
    /** Gmail said it went, and the thread does not show it. */
    said: boolean;
    draft: MailDraftEnd;
    leftWhy?: string;
  };

export interface MailSendWay {
  /** Whether the owner has stopped it. Asked before the write and right after it. */
  stopped?(): boolean;
  /**
   * What stands between the draft and Send. Only `true` lets it go. When it
   * throws, the draft is taken away and the error goes on to whoever asked.
   */
  gate?(): Promise<boolean>;
  trust: 'gmail' | 'thread';
  leftover: 'keep' | 'discard';
  /** How often the thread is asked whether it shows the mail, and how long between two askings. */
  asks: number;
  waitMs: number;
  /**
   * The wait between two askings. One that fails (the notch was taken) ends
   * the asking, and the answer is what is known by then: after the press a
   * mail that may have gone is never forgotten for want of a second look.
   */
  wait(ms: number): Promise<void>;
  now(): number;
}

export async function sendMail(box: Pick<Mailbox, 'reply'>, plan: MailReplyPlan, way: MailSendWay): Promise<MailSendEnd> {
  return box.reply(plan, async (session): Promise<MailSendEnd> => {
    /** Takes away what was put in the thread, and says whether that worked. */
    const discard = async (): Promise<{ draft: MailDraftEnd; leftWhy?: string }> => {
      const gone = await session.discard().catch((error: unknown): MailStep => ({ ok: false, why: error instanceof Error ? error.message : 'error' }));
      return gone.ok ? { draft: 'gone' } : { draft: 'left', leftWhy: gone.why };
    };
    const leftover = async (): Promise<{ draft: MailDraftEnd; leftWhy?: string }> => (way.leftover === 'discard' ? discard() : { draft: 'kept' });

    if (way.stopped?.()) return { state: 'not_sent', at: 'stopped', why: 'stopped', draft: 'none' };
    const wrote = await session.write();
    // A draft that was there before is somebody's: whatever happens next, it is not thrown away.
    const theirs = !wrote.ok && wrote.why === MAIL_WHY_DRAFT_THERE;
    if (way.stopped?.()) return { state: 'not_sent', at: 'stopped', why: 'stopped', ...(theirs ? { draft: 'theirs' as const } : await discard()) };
    // A write that failed half way is taken away again: nothing half written is left behind.
    if (!wrote.ok) return { state: 'not_sent', at: 'write', why: wrote.why, ...(theirs ? { draft: 'theirs' as const } : await discard()) };

    if (way.gate) {
      let go: boolean;
      try {
        go = await way.gate();
      } catch (error) {
        // Something took the notch while the draft was in Gmail and not yet sent: it is not left there.
        await session.discard().catch(() => {});
        throw error;
      }
      // Taken back, or nobody was there to see it burn: nothing goes out, and nothing is left in Drafts.
      if (!go) return { state: 'not_sent', at: 'gate', why: 'taken back', ...(await discard()) };
    }

    const since = way.now();
    const sent = await session.send();
    // The page refused before it pressed Send: nothing went.
    if (!sent.ok && sent.pressed === false) return { state: 'not_sent', at: 'send', why: sent.why, ...(await leftover()) };
    // Gmail said, after the press, that it went, and its word is enough here.
    if (sent.ok && way.trust === 'gmail') return { state: 'sent' };
    // Send was pressed, or it is not known that it was not: from here on it may be on its way.
    // The thread is asked, a few times: it takes a moment to show a mail.
    let there = await session.sent(since);
    for (let asks = 1; there === false && asks < way.asks; asks++) {
      try { await way.wait(way.waitMs); } catch { break; }
      there = await session.sent(since);
    }
    if (there === true) return { state: 'sent' };
    // Gmail said so, and the thread could not be read: Gmail's word stands.
    if (sent.ok && there === null) return { state: 'sent' };
    return { state: 'unsure', since, why: sent.ok ? 'the thread does not show it yet' : sent.why, said: sent.ok, ...(await leftover()) };
  });
}
