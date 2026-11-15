/**
 * Mail on the notch: "You have not replied to Marco. I drafted a reply."
 *
 * A reply that ./watch.ts prepared is one item in the inbox, one per thread.
 * What the owner can do with it, and what each thing does:
 *
 *   yes on the line     shows the draft, on paper, with who it goes to
 *   a lit word          the tone: the reply is written again in that manner.
 *                       The time, when the reply names one: the owner's own
 *                       time takes its place in the text
 *   yes on the draft    the reply is put into the thread as a draft in Gmail,
 *                       a fuse burns, and it is sent. Saying yes is the
 *                       approval: nothing more is asked
 *   Esc while it burns  takes the yes back, and nothing else: the draft is
 *                       removed from Gmail, and the reply goes back to waiting
 *   Esc before that     is a no: the reply is turned down and does not come back
 *   left alone          it folds and goes back to the count. Not now is not no
 *
 * Before the line is shown, the mailbox is asked whether the reply is still
 * an answer to the last word in its thread. Before anything is written or
 * sent, the page itself checks that the reply goes to exactly the people
 * ./waiting.ts decided on (./page/reply.js): that is not a model's to decide,
 * and not this file's either.
 *
 * The reply speaks up by itself in one place for now: when the owner comes to
 * Gmail. Everywhere else it joins the count.
 */
import type { NotchInbox, NotchItem, NotchItemEnd } from '../inbox.ts';
import type { NotchBlock, NotchPart } from '../protocol.ts';
import type { NotchStage } from '../stage.ts';
import type { Mailbox, MailReplyPlan } from './mailbox.ts';
import type { MailProposalRow, MailStore } from './store.ts';
import { mailFirstName, type MailPerson } from './thread.ts';
import type { MailLook, MailWatch } from './watch.ts';

/** How long the owner has to take a yes back before the reply goes out. */
export const MAIL_FUSE_MS = 5000;
/** How long after saying that nothing waits it is not said again: coming back to Gmail is not a question. */
export const MAIL_NOTHING_AGAIN_MS = 30 * 60 * 1000;
/** A look this recent is taken as the state of the mailbox when the owner comes to Gmail. */
export const MAIL_LOOK_FRESH_MS = 10 * 60 * 1000;

/** The manners a reply can be written again in. The first is the owner's own. */
export const MAIL_TONES: Record<string, string> = { yours: '', shorter: 'shorter', warmer: 'more warmly', 'more formal': 'more formally' };

export interface NotchMailDeps {
  store: MailStore;
  watch: Pick<MailWatch, 'hold' | 'release' | 'redraft' | 'stillWaits' | 'look' | 'lastLook'>;
  /** The mailbox to write through, or null when no desktop app with the notch's tab is there. */
  mailbox(): Mailbox | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchMail {
  /** Brings the inbox in line with the replies that wait. */
  sync(): void;
  /** The owner has come to Gmail: the newest reply speaks up, or it is said that nothing waits. */
  arrived(): Promise<void>;
  /** The id a thread's reply has in the inbox. */
  itemId(thread: string): string;
}

const em = (text: string): NotchPart => ({ em: text });
const names = (people: MailPerson[]): string => people.map((who) => who.name || who.address).join(', ');
const short = (text: string, most: number): string => { const points = [...text.trim()]; return points.length <= most ? points.join('') : `${points.slice(0, most - 1).join('').trimEnd()}…`; };

/** The draft as a sheet: the paper, what Jarvis did not know, what it found, and the tone. */
export function mailDraftBlocks(row: MailProposalRow, note?: string): NotchBlock[] {
  let lit = false;
  const lines = row.draft.split('\n').map((line): NotchPart[] => {
    const at = row.time && !lit ? line.indexOf(row.time) : -1;
    if (at < 0) return [line];
    lit = true;
    // The time is a word the owner can change: clicked, or typed over with their own.
    return [line.slice(0, at), { word: { name: 'when', value: row.time!, options: [row.time!], label: 'Time', read: 'dayTime' } }, line.slice(at + row.time!.length)];
  });
  const to: NotchPart[] = ['To ', em(names(row.to))];
  if (row.cc.length) to.push('  ·  Copy to ', em(names(row.cc)));
  to.push(`  ·  Re: ${short(row.subject, 80)}`);
  const tone = Object.keys(MAIL_TONES).find((name) => MAIL_TONES[name] === row.tone) ?? 'yours';
  const blocks: NotchBlock[] = [{ kind: 'paper', to, lines }];
  if (row.missing) blocks.push({ kind: 'note', say: ['I did not know: ', short(row.missing, 200)] });
  if (row.found?.length) blocks.push({ kind: 'note', say: ['Found in your Drive: ', em(row.found.map((file) => short(file.name, 60)).join(', '))] });
  blocks.push({ kind: 'note', say: [note ?? 'Not sent yet.', ' Tone ', { word: { name: 'tone', value: tone, options: Object.keys(MAIL_TONES), label: 'Tone' } }] });
  return blocks;
}

export function attachNotchMail(inbox: NotchInbox, deps: NotchMailDeps): NotchMail {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const { store, watch } = deps;
  const itemId = (thread: string): string => `mail:${thread}`;
  /** The threads that have an item now, with the row each stands for. */
  const shown = new Map<string, string>();
  let saidNothingAt = -Infinity;
  /** Replies that have spoken up by themselves: each does so once. */
  const spoke = new Set<string>();

  const decline = (id: string): NotchItemEnd => {
    store.move(id, 'ready', 'declined', now());
    return 'settled';
  };

  async function play(stage: NotchStage, id: string): Promise<NotchItemEnd> {
    let row = store.proposal(id);
    if (!row || row.state !== 'ready') return 'settled';
    const who = mailFirstName(row.who);
    const first = await stage.offer(['You have not replied to ', em(who), '. I drafted a reply.'], 'show', { src: 'mail' });
    if (first.act === 'fold') return 'waits';
    if (first.act === 'no') return decline(id);

    // The draft, on paper. Only yes and Esc answer it: a click somewhere else is neither.
    const sheet = stage.id();
    stage.put({ id: sheet, kind: 'sheet', say: ['Reply to ', em(who)], blocks: mailDraftBlocks(row), yes: 'send', stay: true, src: 'mail' });
    for (;;) {
      const answer = await stage.answer(sheet, ['yes', 'no', 'word']);
      if (answer.act === 'no') return decline(id);
      if (answer.act === 'yes') break;
      const value = (answer.value ?? '').trim();
      if (answer.word === 'when' && row.time && value && value !== row.time && row.draft.includes(row.time)) {
        // The owner's own time, in the place of the one that was proposed.
        row = { ...row, draft: row.draft.replace(row.time, value), time: value, updatedAt: now() };
        store.put(row);
        stage.surface.update(sheet, { blocks: mailDraftBlocks(row) });
      }
      if (answer.word === 'tone' && value in MAIL_TONES && MAIL_TONES[value] !== row.tone) {
        // A new tone is a new letter: it is written again, and the paper says so while it is.
        stage.surface.update(sheet, { blocks: mailDraftBlocks({ ...row, tone: MAIL_TONES[value]! }, 'Writing it again…') });
        const again = await watch.redraft(id, MAIL_TONES[value]!);
        if (stage.ended()) return 'waits';
        if (again) row = again;
        stage.surface.update(sheet, { blocks: mailDraftBlocks(row, again ? undefined : 'I could not write it again. This is the reply as it was.') });
      }
    }

    // Yes: into the thread as a draft, a fuse, and out.
    const mailbox = deps.mailbox();
    if (!mailbox) {
      await stage.say(['I cannot reach Gmail from here to send it. The reply is kept.'], 4200, { mood: 'worried', src: 'mail' });
      return 'waits';
    }
    // Asked of the mailbox itself, not of what was seen a minute ago: this is about to be sent.
    if ((await watch.stillWaits(id, 0)) === false) {
      await stage.say(['The thread has moved on since. I did not send it.'], 3600, { src: 'mail' });
      return 'settled';
    }
    const plan: MailReplyPlan = { thread: row.thread, to: row.to.map((person) => person.address), cc: row.cc.map((person) => person.address), text: row.draft };
    watch.hold(id);
    try {
      return await mailbox.reply(plan, async (reply) => {
        stage.put({ id: stage.id(), kind: 'work', say: ['Putting it in the thread…'], steps: 0, done: 0, src: 'mail' });
        const wrote = await reply.write();
        if (!wrote.ok) {
          log(`[notch] a reply could not be put in its thread: ${wrote.why}`);
          // Whatever got as far as the page is taken away again: nothing half written is left behind.
          await reply.discard().catch(() => {});
          await stage.say(['I could not put the reply in the thread, so nothing was sent. It is kept here.'], 4600, { mood: 'worried', mark: 'fail', src: 'mail' });
          return 'waits';
        }
        let went: 'done' | 'undo' | 'lost';
        try {
          went = await stage.fuse(['Sending to ', em(who), '…'], MAIL_FUSE_MS, { src: 'mail' });
        } catch (error) {
          // Something took the notch while the draft was in Gmail and not yet sent: it is not left there.
          await reply.discard().catch(() => {});
          throw error;
        }
        if (went !== 'done') {
          // Taken back, or nobody was there to see it burn: nothing goes out, and nothing is left in Drafts.
          const gone = await reply.discard().catch(() => ({ ok: false as const, why: '' }));
          if (went === 'undo') await stage.say(gone.ok ? ['Not sent. No draft is left in Gmail.'] : ['Not sent. The draft is still in your Gmail drafts.'], 3200, { src: 'mail' });
          return 'waits';
        }
        const since = now();
        const sent = await reply.send();
        if (!sent.ok) {
          log(`[notch] a reply could not be sent: ${sent.why}`);
          await stage.say(['I could not send it. It is in your Gmail drafts.'], 4600, { mood: 'worried', mark: 'fail', src: 'mail' });
          return 'waits';
        }
        // Gmail said it went. The mailbox is asked too: a reply is called sent when it is the last word in its thread.
        let there = await reply.sent(since);
        if (there === false) { await stage.wait(1500); there = await reply.sent(since); }
        if (there === false) {
          await stage.say(['Gmail says it was sent, but I do not see it in the thread yet. I will look again.'], 4600, { mood: 'curious', src: 'mail' });
          return 'waits';
        }
        store.move(id, 'ready', 'sent', now());
        await stage.say(['Sent to ', em(who), '.'], 2400, { mood: 'happy', mark: 'check', src: 'mail' });
        return 'settled';
      });
    } finally {
      watch.release(id);
    }
  }

  const item = (row: MailProposalRow, speaks: boolean): NotchItem => ({
    id: itemId(row.thread),
    subject: itemId(row.thread),
    class: 'person',
    speaks,
    title: () => ['Reply to ', em(mailFirstName(row.who)), `: ${short(row.subject, 60)}`],
    // Before it is shown: is it still an answer to the last word? Not known is not no.
    check: async () => store.proposal(row.id)?.state === 'ready' && (await watch.stillWaits(row.id)) !== false,
    play: (stage) => play(stage, row.id),
  });

  function sync(): void {
    const ready = store.ready();
    const waiting = new Map(ready.map((row) => [row.thread, row]));
    for (const [thread, id] of [...shown]) {
      if (waiting.get(thread)?.id === id) continue;
      shown.delete(thread);
      // Its thread moved on, or it was answered here: the line leaves by itself.
      if (!waiting.has(thread)) inbox.remove(itemId(thread));
    }
    // The newest first: a round takes what waits in the order it was put here.
    for (const row of ready) {
      if (shown.get(row.thread) === row.id) continue;
      shown.set(row.thread, row.id);
      inbox.add(item(row, false));
    }
  }

  async function arrived(): Promise<void> {
    // What is known is brought up to date first, unless it was just now.
    const last = watch.lastLook();
    let look: MailLook | null = last && now() - last.at < MAIL_LOOK_FRESH_MS ? last.look : null;
    if (!look) look = await watch.look('recent').catch(() => null);
    sync();
    const ready = store.ready();
    if (ready.length > 0) {
      // Each reply speaks up by itself once. The newest that has not: it takes the notch if the notch is
      // free, and stays in the count if not. One that is on the notch now is left as it is.
      const next = ready.find((row) => !spoke.has(row.id));
      // Something of the notch's is up already: nobody speaks over it, and nobody's one chance is used up.
      if (!next || inbox.showing() !== null) return;
      shown.set(next.thread, next.id);
      inbox.add(item(next, true));
      // It has had its say only if it got the notch: a notch that was busy with something else leaves it its chance.
      if (inbox.showing() === itemId(next.thread)) spoke.add(next.id);
      return;
    }
    if (now() - saidNothingAt < MAIL_NOTHING_AGAIN_MS) return;
    // Said only when it is true: the mailbox was looked at, and nobody is waiting. When it could not be
    // looked at, that is what is said.
    const words: NotchPart[] = look?.through
      ? ['Nobody in your mail is waiting for a reply.']
      : ['I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.'];
    if (inbox.present('mail-nothing', (stage) => stage.say(words, 3600, { src: 'mail' }))) saidNothingAt = now();
  }

  sync();
  return { sync, arrived, itemId };
}
