/**
 * Mail on the notch: "You have not replied to Marco. I drafted a reply."
 *
 * The replies that ./watch.ts prepared are one thing on the notch: mail, with
 * one reply per thread in it. Where they wait is decided by one fact about
 * the notch: whatever is in the count comes before the text field when the
 * owner taps the resting notch. Mail that nobody has answered is there every
 * day, so if every reply stayed in the count the owner could never type.
 *
 * So a reply is in the count until the owner has seen it once: its line came
 * up, or it was a row of the list they opened. After that it waits in Home,
 * under the text field, as one row for all of them ("3 replies drafted"),
 * and it is not lost and not said again. The count is what is new.
 *
 * When mail speaks up by itself it is about one reply, the newest unseen.
 * When the owner comes to it and several are unseen, it is one line and a
 * list behind it, and each row opens its reply.
 *
 * What the owner can do with a reply, and what each thing does:
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
  watch: Pick<MailWatch, 'hold' | 'release' | 'redraft' | 'stillWaits' | 'look' | 'lastLook' | 'busy'>;
  /** The mailbox to write through, or null when no desktop app with the notch's tab is there. */
  mailbox(): Mailbox | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchMail {
  /** Brings the inbox in line with the replies that wait. */
  sync(): void;
  /** The owner has come to Gmail: the newest reply they have not seen speaks up, or it is said that nothing waits. */
  arrived(): Promise<void>;
  /** Home's row about the replies that wait, or null when none does. */
  homeRow(): NotchBlock | null;
  /** What that row opens: the reply when one waits, the list when several do. Comes back when it is closed. */
  open(stage: NotchStage): Promise<void>;
}

/** The one thing mail is in the inbox. */
export const NOTCH_MAIL_ITEM = 'mail';

const em = (text: string): NotchPart => ({ em: text });
const names = (people: MailPerson[]): string => people.map((who) => who.name || who.address).join(', ');
const short = (text: string, most: number): string => { const points = [...text.trim()]; return points.length <= most ? points.join('') : `${points.slice(0, most - 1).join('').trimEnd()}…`; };

/** The draft as a sheet: the paper, what Jarvis did not know, what it found, and the tone. */
export function mailDraftBlocks(row: MailProposalRow, note?: string): NotchBlock[] {
  let lit = false;
  // Each line of the reply is a paragraph on the paper. An empty line is the gap between two: the paper makes that itself.
  const lines = row.draft.split('\n').filter((line) => line.trim()).map((line): NotchPart[] => {
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
  /** Whether mail is in the inbox now. */
  let present = false;
  let saidNothingAt = -Infinity;
  /** Replies the owner has seen once, as a line or as a row of the list they opened: these wait in Home, not in the count. */
  const seen = new Set<string>();
  const unseen = (): MailProposalRow[] => store.ready().filter((row) => !seen.has(row.id));

  const decline = (id: string): NotchItemEnd => {
    store.move(id, 'ready', 'declined', now());
    return 'settled';
  };

  /**
   * One reply, from its line to its end. `line: false` opens the draft at
   * once: the owner picked it from the list. Comes back `settled` when the
   * reply no longer waits, `waits` when it does.
   */
  async function play(stage: NotchStage, id: string, options: { line: boolean }): Promise<NotchItemEnd> {
    let row = store.proposal(id);
    if (!row || row.state !== 'ready') return 'settled';
    const who = mailFirstName(row.who);
    if (options.line) {
      const first = await stage.offer(['You have not replied to ', em(who), '. I drafted a reply.'], 'show', { src: 'mail' });
      if (first.act === 'fold') return 'waits';
      if (first.act === 'no') return decline(id);
    }

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
      // Whoever found it out has usually marked it already; here it is made sure of.
      store.move(id, 'ready', 'answered', now());
      await stage.say(['The thread has moved on since. I did not send it.'], 3600, { src: 'mail' });
      return 'settled';
    }
    const plan: MailReplyPlan = { thread: row.thread, to: row.to.map((person) => person.address), cc: row.cc.map((person) => person.address), text: row.draft };
    watch.hold(id);
    // Said at once: the tab may be in the middle of a look, and the yes must not seem to have gone nowhere.
    stage.put({ id: stage.id(), kind: 'work', say: ['Putting it in the thread…'], steps: 0, done: 0, src: 'mail' });
    try {
      return await mailbox.reply(plan, async (reply) => {
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

  /** Is this reply still an answer to the last word? Asked of the mailbox unless a look saw so a moment ago. Not known is not no. */
  const stillTrue = async (row: MailProposalRow): Promise<boolean> =>
    store.proposal(row.id)?.state === 'ready' && (await watch.stillWaits(row.id)) !== false;

  /** The list of the replies that wait: who, and about what. A row opens its reply. */
  const listBlocks = (ready: MailProposalRow[]): NotchBlock[] =>
    ready.map((row) => ({ kind: 'row', id: row.thread, lead: short(mailFirstName(row.who), 18), say: [short(row.subject, 70)], go: true }));

  /** The list, until it is closed or nothing is left in it. Every reply in it has been seen from then on. */
  async function list(stage: NotchStage): Promise<void> {
    for (;;) {
      const ready = store.ready();
      if (ready.length === 0) return;
      for (const row of ready) seen.add(row.id);
      const answer = await stage.sheet([ready.length === 1 ? '1 reply waits' : `${ready.length} replies wait`], listBlocks(ready), { src: 'mail' });
      if (answer.act !== 'go' || !answer.row) return;
      const row = ready.find((entry) => entry.thread === answer.row);
      if (!row || !(await stillTrue(row))) continue;
      await play(stage, row.id, { line: false });
    }
  }

  /**
   * Mail in the count: the replies the owner has not seen. One reply when it
   * speaks up by itself or only one is unseen, one line and the list behind
   * it when the owner came and several are. Whatever they do with the line,
   * it has had its say: the replies wait in Home from then on.
   */
  async function playMail(stage: NotchStage, how: { unasked: boolean }): Promise<NotchItemEnd> {
    const left = (): NotchItemEnd => (unseen().length > 0 ? 'waits' : 'settled');
    const fresh = unseen();
    if (fresh.length === 0) return 'settled';
    if (how.unasked || fresh.length === 1) {
      let row: MailProposalRow | undefined;
      for (const candidate of fresh) {
        seen.add(candidate.id);
        if (await stillTrue(candidate)) { row = candidate; break; }
      }
      if (row) await play(stage, row.id, { line: true });
      return left();
    }
    for (const row of fresh) seen.add(row.id);
    const many = await stage.offer([em(`${fresh.length} people`), ' are waiting for a reply. I drafted them.'], 'show', { src: 'mail' });
    // Esc here is not a no to anyone's reply: each is turned down on its own draft.
    if (many.act === 'yes') await list(stage);
    return left();
  }

  const item = (speaks: boolean): NotchItem => ({
    id: NOTCH_MAIL_ITEM,
    subject: NOTCH_MAIL_ITEM,
    class: 'person',
    speaks,
    title: () => {
      const fresh = unseen();
      const [only] = fresh;
      return fresh.length === 1 && only ? ['Reply to ', em(mailFirstName(only.who)), `: ${short(only.subject, 60)}`] : [em(`${fresh.length} replies`), ' drafted, waiting for your word'];
    },
    check: () => unseen().length > 0,
    play: playMail,
  });

  function sync(): void {
    // What is no longer waiting need not be remembered as seen.
    const ready = new Set(store.ready().map((row) => row.id));
    for (const id of [...seen]) if (!ready.has(id)) seen.delete(id);
    const waiting = unseen().length > 0;
    if (waiting && (!present || !inbox.has(NOTCH_MAIL_ITEM))) { present = true; inbox.add(item(false)); }
    // The last unseen reply was answered, sent or turned down elsewhere: mail leaves the count by itself.
    if (!waiting && present) { present = false; inbox.remove(NOTCH_MAIL_ITEM); }
  }

  async function arrived(): Promise<void> {
    // What is known is brought up to date first, unless it was just now. A look that is under way is
    // not waited for: the first one goes through a month, and what it has prepared so far is there.
    const last = watch.lastLook();
    let look: MailLook | null = last && now() - last.at < MAIL_LOOK_FRESH_MS ? last.look : null;
    const reading = watch.busy();
    if (!look && !reading) look = await watch.look('recent').catch(() => null);
    sync();
    if (store.ready().length > 0) {
      // A reply the owner has not seen takes the notch, if the notch is free. Something that is up
      // already is not spoken over, and nobody's one say is used up for it.
      if (unseen().length === 0 || inbox.showing() !== null) return;
      present = true;
      inbox.add(item(true));
      return;
    }
    // Still being read, and nothing found yet: not known, so nothing is said.
    if (!look && reading) return;
    if (now() - saidNothingAt < MAIL_NOTHING_AGAIN_MS) return;
    // Said only when it is true: the mailbox was looked at, and nobody is waiting. When it could not be
    // looked at, that is what is said.
    const words: NotchPart[] = look?.through
      ? ['Nobody in your mail is waiting for a reply.']
      : ['I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.'];
    if (inbox.present('mail-nothing', (stage) => stage.say(words, 3600, { src: 'mail' }))) saidNothingAt = now();
  }

  function homeRow(): NotchBlock | null {
    const ready = store.ready();
    const [only] = ready;
    if (!only) return null;
    return {
      kind: 'row', id: 'mail', lead: 'Mail', go: true,
      say: ready.length === 1 ? ['Reply to ', em(mailFirstName(only.who)), ' is drafted'] : [em(`${ready.length} replies`), ' drafted, waiting for your word'],
    };
  }

  async function open(stage: NotchStage): Promise<void> {
    const ready = store.ready();
    const [only] = ready;
    if (ready.length === 1 && only) {
      seen.add(only.id);
      if (await stillTrue(only)) await play(stage, only.id, { line: false });
    } else {
      await list(stage);
    }
    // Seen now, all of them: mail is out of the count, if it was in it.
    sync();
  }

  sync();
  return { sync, arrived, homeRow, open };
}
