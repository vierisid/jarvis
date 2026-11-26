/**
 * The one way a mail is sent in a thread (./send.ts), with a mailbox that
 * says what was asked of it. Each caller's own words are tested where they
 * are said (./notch.test.ts, ./attach.test.ts); here it is the steps, their
 * order, and what becomes of the draft at every way out.
 */
import { describe, expect, test } from 'bun:test';
import { MAIL_WHY_DRAFT_THERE, type MailReplyPlan, type MailReplySession, type MailStep, type Mailbox } from './mailbox.ts';
import { sendMail, type MailSendWay } from './send.ts';

const PLAN: MailReplyPlan = { thread: '19a1b2c3d4e5f601', to: ['leo@lumen.example'], cc: [], text: 'Hi Leo,\nTuesday at 10:00 would suit me.\nSam' };

function box(steps: Partial<Record<'write' | 'send' | 'discard', MailStep | Error>> = {}, shows: (boolean | null)[] = [true]) {
  const did: string[] = [];
  const plans: MailReplyPlan[] = [];
  const left = [...shows];
  const step = (name: 'write' | 'send' | 'discard') => async (): Promise<MailStep> => {
    did.push(name);
    const answer = steps[name] ?? { ok: true };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const session: MailReplySession = {
    write: step('write'),
    send: step('send'),
    discard: step('discard'),
    sent: async (since) => { did.push(`sent? ${since}`); return left.length > 1 ? left.shift()! : left[0]!; },
  };
  const mailbox: Pick<Mailbox, 'reply'> = { reply: async (plan, work) => { plans.push(plan); return work(session); } };
  return { mailbox, did, plans };
}

/** A reply: the thread must show it, and what did not go stays in the drafts. */
const reply = (more: Partial<MailSendWay> = {}): MailSendWay => ({ trust: 'thread', leftover: 'keep', asks: 2, waitMs: 1500, wait: async () => {}, now: () => 700, ...more });
/** A nudge: Gmail's word is enough, and what did not go is taken away. */
const nudge = (more: Partial<MailSendWay> = {}): MailSendWay => ({ trust: 'gmail', leftover: 'discard', asks: 3, waitMs: 1500, wait: async () => {}, now: () => 700, ...more });

describe('one mail in one thread', () => {
  test('written, let through, sent and seen in the thread: the plan goes to the mailbox as it is', async () => {
    const b = box();
    const order: string[] = [];
    const end = await sendMail(b.mailbox, PLAN, reply({ gate: async () => { order.push(`gate after ${b.did.join(',')}`); return true; } }));
    expect(end).toEqual({ state: 'sent' });
    expect(b.plans).toEqual([PLAN]);
    // The gate stands between the draft and Send, and the look begins at the moment before the press.
    expect(order).toEqual(['gate after write']);
    expect(b.did).toEqual(['write', 'send', 'sent? 700']);
  });

  test('stopped before anything is written: nothing is written, and there is nothing to take away', async () => {
    const b = box();
    expect(await sendMail(b.mailbox, PLAN, reply({ stopped: () => true }))).toEqual({ state: 'not_sent', at: 'stopped', why: 'stopped', draft: 'none' });
    expect(b.did).toEqual([]);
  });

  test('stopped while it is written: what was written is taken away, and it is said when that does not work', async () => {
    let asked = 0;
    const b = box();
    expect(await sendMail(b.mailbox, PLAN, reply({ stopped: () => asked++ > 0 }))).toEqual({ state: 'not_sent', at: 'stopped', why: 'stopped', draft: 'gone' });
    expect(b.did).toEqual(['write', 'discard']);

    asked = 0;
    const stuck = box({ discard: { ok: false, why: 'no bin' } });
    expect(await sendMail(stuck.mailbox, PLAN, reply({ stopped: () => asked++ > 0 }))).toEqual({ state: 'not_sent', at: 'stopped', why: 'stopped', draft: 'left', leftWhy: 'no bin' });
  });

  test('a draft that was there before is never thrown away: not at the write, and not when it is stopped there', async () => {
    const b = box({ write: { ok: false, why: MAIL_WHY_DRAFT_THERE } });
    expect(await sendMail(b.mailbox, PLAN, reply())).toEqual({ state: 'not_sent', at: 'write', why: MAIL_WHY_DRAFT_THERE, draft: 'theirs' });
    expect(b.did).toEqual(['write']);

    let asked = 0;
    const stopped = box({ write: { ok: false, why: MAIL_WHY_DRAFT_THERE } });
    expect(await sendMail(stopped.mailbox, PLAN, nudge({ stopped: () => asked++ > 0 }))).toEqual({ state: 'not_sent', at: 'stopped', why: 'stopped', draft: 'theirs' });
    expect(stopped.did).toEqual(['write']);
  });

  test('a write that failed half way is taken away again, and nothing is sent', async () => {
    const b = box({ write: { ok: false, why: 'the thread did not open' } });
    expect(await sendMail(b.mailbox, PLAN, reply({ gate: async () => { throw new Error('the gate must not be reached'); } }))).toEqual({ state: 'not_sent', at: 'write', why: 'the thread did not open', draft: 'gone' });
    expect(b.did).toEqual(['write', 'discard']);
  });

  test('a gate that says no sends nothing and leaves no draft, whichever way the caller keeps what did not go', async () => {
    for (const way of [reply, nudge]) {
      const b = box();
      expect(await sendMail(b.mailbox, PLAN, way({ gate: async () => false }))).toEqual({ state: 'not_sent', at: 'gate', why: 'taken back', draft: 'gone' });
      expect(b.did).toEqual(['write', 'discard']);
    }
  });

  test('a gate that fails (the notch was taken) takes the draft away, sends nothing, and the failure goes on', async () => {
    const b = box();
    const taken = new Error('the stage ended');
    await expect(sendMail(b.mailbox, PLAN, reply({ gate: async () => { throw taken; } }))).rejects.toBe(taken);
    expect(b.did).toEqual(['write', 'discard']);
  });

  test('Send refused before it was pressed: nothing went. A reply stays in the drafts, a nudge is taken away', async () => {
    const refused: MailStep = { ok: false, why: 'the reply is not to those people', pressed: false };
    const kept = box({ send: refused });
    expect(await sendMail(kept.mailbox, PLAN, reply())).toEqual({ state: 'not_sent', at: 'send', why: 'the reply is not to those people', draft: 'kept' });
    expect(kept.did).toEqual(['write', 'send']);

    const taken = box({ send: refused });
    expect(await sendMail(taken.mailbox, PLAN, nudge())).toEqual({ state: 'not_sent', at: 'send', why: 'the reply is not to those people', draft: 'gone' });
    expect(taken.did).toEqual(['write', 'send', 'discard']);
  });
});

describe('whether it went', () => {
  test('a nudge: Gmail saying so after the press is enough, and the thread is not asked', async () => {
    const b = box({}, [false]);
    expect(await sendMail(b.mailbox, PLAN, nudge())).toEqual({ state: 'sent' });
    expect(b.did).toEqual(['write', 'send']);
  });

  test('a reply: Gmail saying so is not enough. The thread is asked, as often as was said, and no oftener', async () => {
    const waits: number[] = [];
    const late = box({}, [false, true]);
    expect(await sendMail(late.mailbox, PLAN, reply({ wait: async (ms) => { waits.push(ms); } }))).toEqual({ state: 'sent' });
    expect(late.did).toEqual(['write', 'send', 'sent? 700', 'sent? 700']);
    expect(waits).toEqual([1500]);

    const never = box({}, [false]);
    expect(await sendMail(never.mailbox, PLAN, reply())).toEqual({ state: 'unsure', since: 700, why: 'the thread does not show it yet', said: true, draft: 'kept' });
    expect(never.did).toEqual(['write', 'send', 'sent? 700', 'sent? 700']);
  });

  test('a reply Gmail says went, in a thread that cannot be read: Gmail\'s word stands', async () => {
    const b = box({}, [null]);
    expect(await sendMail(b.mailbox, PLAN, reply())).toEqual({ state: 'sent' });
    expect(b.did).toEqual(['write', 'send', 'sent? 700']);
  });

  test('Gmail silent after the press: the thread decides, and a thread that does not show it, or cannot be read, is "may have gone"', async () => {
    const silent: MailStep = { ok: false, why: 'Gmail did not say it was sent', pressed: true };
    const there = box({ send: silent }, [false, false, true]);
    expect(await sendMail(there.mailbox, PLAN, nudge())).toEqual({ state: 'sent' });
    expect(there.did).toEqual(['write', 'send', 'sent? 700', 'sent? 700', 'sent? 700']);

    for (const shows of [false, null]) {
      const kept = box({ send: silent }, [shows]);
      expect(await sendMail(kept.mailbox, PLAN, reply())).toEqual({ state: 'unsure', since: 700, why: 'Gmail did not say it was sent', said: false, draft: 'kept' });
      // What a nudge was still writing is taken away: when the reply has closed there is nothing to take.
      const taken = box({ send: silent }, [shows]);
      expect(await sendMail(taken.mailbox, PLAN, nudge())).toEqual({ state: 'unsure', since: 700, why: 'Gmail did not say it was sent', said: false, draft: 'gone' });
      expect(taken.did.at(-1)).toBe('discard');
    }
  });

  test('a send that says nothing about the press is one that may have been pressed', async () => {
    const b = box({ send: { ok: false, why: 'the page went away' } }, [false]);
    expect(await sendMail(b.mailbox, PLAN, reply())).toMatchObject({ state: 'unsure', said: false });
  });

  test('a wait that fails between two looks ends the looking: after the press the answer is still "may have gone", never a failure', async () => {
    const b = box({ send: { ok: false, why: 'Gmail did not say it was sent', pressed: true } }, [false]);
    const end = await sendMail(b.mailbox, PLAN, reply({ asks: 5, wait: async () => { throw new Error('the stage ended'); } }));
    expect(end).toEqual({ state: 'unsure', since: 700, why: 'Gmail did not say it was sent', said: false, draft: 'kept' });
    expect(b.did).toEqual(['write', 'send', 'sent? 700']);
  });

  test('the look begins at the moment before the press, not when the draft was written', async () => {
    let clock = 100;
    const b = box();
    await sendMail(b.mailbox, PLAN, reply({ now: () => clock, gate: async () => { clock = 8100; return true; } }));
    expect(b.did).toEqual(['write', 'send', 'sent? 8100']);
  });
});
