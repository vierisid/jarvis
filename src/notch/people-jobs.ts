/**
 * A job that changes hands: "hand Dana's answer to Leo".
 *
 * The prototype (v15: handChase, lhand, jobTake, askBack): a job goes to a
 * teammate with what was asked, what was done and what is left. It changes
 * hands only when they take it. Until then it stays yours. The other party
 * hears from its new owner, and you hear once, when it is done.
 *
 * A job here is a chase (./standing.ts): getting somebody's answer by a
 * day, by mail, with a history of what was sent and when.
 *
 *   1. The giver hands it over: who it is got from, what is wanted, the day,
 *      and the history. Nothing changes here yet.
 *   2. The other person reads what was done so far and what would be sent
 *      in THEIR name, and takes it or not. Taking it starts their own chase:
 *      the first mail goes from their own mailbox, and the history is kept.
 *   3. Only then does it stop here: one owner at a time.
 *   4. When they are done, or let it go, the giver hears it, once.
 *   5. The giver can ask for it back. Handed back, it comes with what was
 *      done meanwhile, and asks what now: nothing of it is sent from here
 *      until the giver has said.
 *
 * What holds:
 *
 *   - It is the giver's until it is taken. A no, or no answer, changes nothing.
 *   - Nobody's mail is written in a name without that person having seen
 *     the words: what the taker's chase sends is on the sheet they say yes to.
 *   - The history that travels is what the notch itself wrote down, step by
 *     step. It arrives as text and is shown as text.
 *   - An answer counts only from the one the job was handed to.
 */
import { notchSentOutcome, type NotchActions } from './actions.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { chaseWhat } from './standing.ts';
import type { NotchChase, NotchStanding } from './standing.ts';
import type { PeerItem, PeerLink, PeerPerson } from '../peers/link.ts';
import { PEER_JOB_STEPS_MAX, PEER_JOB_STEP_MAX, peerNoteText, peerPlain } from '../peers/notes.ts';
import type { PeerNote } from '../peers/notes.ts';
import type { PeerStore } from '../peers/store.ts';

const em = (text: string): NotchPart => ({ em: text });
const cap = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const first = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** How long handing over, and asking back, can be taken back. */
export const NOTCH_JOB_FUSE_MS = 3000;

export type PeerJobNote = Extract<PeerNote, { kind: 'job' | 'job-yes' | 'job-no' | 'job-done' | 'job-back' | 'job-return' | 'job-keep' }>;
export const isJobNote = (note: PeerNote | null): note is PeerJobNote => !!note && (note.kind === 'job' || note.kind.startsWith('job-'));

/** What the chases part gives: the ones under way, and how one changes hands (./standing.ts). */
export type NotchJobChases = Pick<NotchStanding, 'handable' | 'chase' | 'hand' | 'back' | 'closed' | 'drafted' | 'blocks' | 'begin' | 'undo'>;

export interface NotchPeopleJobsDeps {
  inbox: NotchInbox;
  link: PeerLink;
  store: PeerStore;
  chases: NotchJobChases;
  person(id: string): PeerPerson | null;
  /** News that is said once. */
  news(id: string, say: NotchPart[], more?: { who?: string }): void;
  /** Where a job offered to somebody, or asked back, is written down (./actions.ts). */
  actions?: NotchActions | null;
  log?: (line: string) => void;
  now?: () => number;
}

export interface NotchPeopleJobs {
  /** The chases that could be handed over now. */
  mine(): NotchChase[];
  /** Hands one to somebody. */
  hand(to: PeerPerson, chase: NotchChase): void;
  /** Asks for one back that somebody took. */
  askBack(job: string): void;
  /** What is with somebody else, and what was taken from somebody, for the organisation's sheet. */
  rows(): { id: string; dir: 'out' | 'in'; what: string; with: string; state: 'offered' | 'taken'; small: string }[];
  /** Takes in a note about a job that arrived. */
  note(item: PeerItem, from: PeerPerson, note: PeerJobNote): Promise<void>;
  /** The clock: a job that was taken here and has ended is told to whoever gave it. */
  tick(): Promise<void>;
}

/** A job that was handed to somebody: which chase, to whom, and whether they took it. */
interface Given { peer: string; chase: string; what: string; state: 'offered' | 'taken'; asked?: boolean }
/** A job that was taken from somebody: the chase it became here. */
interface Taken { peer: string; chase: string; what: string }

export function attachNotchPeopleJobs(deps: NotchPeopleJobsDeps): NotchPeopleJobs {
  const { inbox, link, store, chases } = deps;
  const log = deps.log ?? (() => { /* quiet */ });
  const now = deps.now ?? Date.now;

  // What is handed over and what was taken is kept by name, so that it outlives a restart.
  const read = <T>(key: string): T | null => { try { return JSON.parse(store.meta(key) ?? 'null') as T | null; } catch { return null; } };
  const names = (): string[] => read<string[]>('jobs') ?? [];
  const keep = (key: string, value: Given | Taken | null): void => {
    store.setMeta(key, value ? JSON.stringify(value) : null);
    const all = names().filter((one) => one !== key);
    store.setMeta('jobs', JSON.stringify(value ? [...all, key] : all));
  };
  const given = (id: string): Given | null => read<Given>(`job-out:${id}`);
  const taken = (id: string): Taken | null => read<Taken>(`job-in:${id}`);
  const sorry = (why: string): NotchPart[] => (why === 'signed_out' ? ['You are signed out. It was not sent.'] : why === 'offline' || why === 'down' ? ['I have no line to the others now. It was not sent.'] : ['That could not be sent.']);
  /** The history as it travels: the newest steps, each cut to what is read as one line. */
  const history = (chase: NotchChase): { at: number; text: string }[] => chase.steps.slice(-PEER_JOB_STEPS_MAX).map((one) => ({ at: one.at, text: peerPlain(one.text, PEER_JOB_STEP_MAX) })).filter((one) => one.text);
  const clock = (at: number): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

  // --- the giver ---

  function hand(to: PeerPerson, chase: NotchChase): void {
    const what = chaseWhat(chase);
    inbox.present('people-job', async (stage) => {
      const open = names().map((key) => (key.startsWith('job-out:') ? read<Given>(key) : null)).find((one) => one?.chase === chase.id);
      if (open) { await stage.say(open.state === 'taken' ? [em(deps.person(open.peer)?.name ?? 'Somebody'), ' already has ', em(what), '.'] : ['I have offered it already. It has not been taken yet.'], 3200); return; }
      const went = await stage.fuse(['Handing ', em(what), ' to ', em(to.name), ', with its history…'], NOTCH_JOB_FUSE_MS, { mood: 'work', who: to.name });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was handed over.'], 2000); return; }
      if (went === 'lost') return;
      const id = crypto.randomUUID();
      // The sentence is for a contact who is not on a Pillow: they read it, and answer in their own words.
      const told = await link.tell(to.id, peerNoteText(
        `Can you take this over from me: getting ${what}${chase.about ? ` on ${chase.about}` : ''} by ${chase.day}?`,
        { kind: 'job', id, name: chase.name, address: chase.address, thing: chase.thing, about: chase.about, day: chase.day, steps: history(chase) }));
      deps.actions?.record({ kind: 'people_job', what: `Offered ${to.name} to take over getting ${what}, with its history`, target: to.name, asked: { seen: 'line', how: 'said', fuseMs: NOTCH_JOB_FUSE_MS }, outcome: notchSentOutcome(told) });
      if (!told.ok) { await stage.say(sorry(told.why), 3400, { mood: 'sorry' }); return; }
      keep(`job-out:${id}`, { peer: to.id, chase: chase.id, what, state: 'offered' });
      log('[notch] a job was offered to somebody, with its history');
      await stage.say(told.delivered ? ['Offered to ', em(to.name), '. It stays yours, and I stay on it, until ', em(to.name), ' takes it.'] : ['Offered. It waits until ', em(`${to.name}'s`), ' Pillow is on. It stays yours until then.'], 3800, { mark: 'check', who: to.name });
    });
  }

  function askBack(job: string): void {
    const mine = given(job);
    const to = mine ? deps.person(mine.peer) : null;
    inbox.present('people-job', async (stage) => {
      if (!mine || !to || mine.state !== 'taken') { await stage.say(['That one is not with anybody. Nothing to take back.'], 2800); return; }
      const went = await stage.fuse(['Asking ', em(to.name), ' for ', em(mine.what), ' back…'], NOTCH_JOB_FUSE_MS, { mood: 'work', who: to.name });
      if (went === 'undo') { await stage.say(['Taken back. Nothing was asked.'], 2000); return; }
      if (went === 'lost') return;
      const told = await link.tell(to.id, peerNoteText(`Can I have ${mine.what} back?`, { kind: 'job-back', of: job }));
      deps.actions?.record({ kind: 'people_job', what: `Asked ${to.name} for ${mine.what} back`, target: to.name, asked: { seen: 'line', how: 'said', fuseMs: NOTCH_JOB_FUSE_MS }, outcome: notchSentOutcome(told) });
      if (!told.ok) { await stage.say(sorry(told.why), 3400, { mood: 'sorry' }); return; }
      keep(`job-out:${job}`, { ...mine, asked: true });
      await stage.say(['Asked ', em(to.name), '. I will tell you what ', em(to.name), ' says.'], 2800, { mark: 'check', who: to.name });
    });
  }

  /** How a job that was handed over went on: taken or not, done, handed back or kept. */
  function heard(got: Exclude<PeerJobNote, { kind: 'job' | 'job-back' }>, from: PeerPerson): void {
    const mine = given(got.of);
    // Only from the one it was handed to.
    if (!mine || mine.peer !== from.id) return;
    const them = first(chases.chase(mine.chase)?.name ?? 'They');
    const say = (parts: NotchPart[]): void => deps.news(`people:job:${got.of}:${got.kind}`, parts, { who: from.name });
    if (got.kind === 'job-no') {
      if (mine.state !== 'offered') return;
      keep(`job-out:${got.of}`, null);
      say([em(from.name), ' cannot take ', em(mine.what), '. It is still yours, and I am still on it.']);
      return;
    }
    if (got.kind === 'job-yes') {
      if (mine.state !== 'offered') return;
      // It may have ended here while it was on offer: then nothing changes hands, and they are told to let it be.
      if (!chases.hand(mine.chase, from.name)) {
        keep(`job-out:${got.of}`, null);
        void link.tell(from.id, peerNoteText('It was closed before you took it. Leave it.', { kind: 'job-back', of: got.of }));
        say([cap(mine.what), ' closed before ', em(from.name), ' took it. Nothing changed hands.']);
        return;
      }
      keep(`job-out:${got.of}`, { ...mine, state: 'taken' });
      say([em(from.name), ' took it. ', em(them), ' hears from ', em(from.name), ' now. I tell you when it is done.']);
      return;
    }
    if (mine.state !== 'taken') return;
    if (got.kind === 'job-done') {
      chases.closed(mine.chase, got.how, from.name);
      keep(`job-out:${got.of}`, null);
      say(got.how === 'done' ? ['Done. ', em(them), ' answered. ', em(from.name), ' closed it.'] : [em(from.name), ' let ', em(mine.what), ' go. It is closed.']);
      return;
    }
    if (got.kind === 'job-keep') {
      keep(`job-out:${got.of}`, { ...mine, asked: false });
      say([em(from.name), ' keeps ', em(mine.what), '.']);
      return;
    }
    // Handed back, with what was done there. It is not taken up again by itself: the chase asks what
    // now (./standing.ts). The yes that started it was given before it left, and no mail goes on it.
    if (got.kind !== 'job-return' || !chases.back(mine.chase, got.steps, from.name)) return;
    keep(`job-out:${got.of}`, null);
    say(['It is back with you, with what ', em(from.name), ' did. Nothing more goes until you say what now.']);
  }

  // --- the one it is handed to ---

  /** "Sam hands you Dana's answer, due Friday. So far: 2 steps. Take it?" The history and what would be sent are on the sheet. */
  function offered(item: PeerItem, from: PeerPerson, job: Extract<PeerJobNote, { kind: 'job' }>): void {
    const what = chaseWhat({ name: job.name, thing: job.thing });
    const settle = (): void => { store.done(item.id); void link.seen(item.id); };
    inbox.add({
      id: `people:job:${job.id}`, subject: `people:job:${job.id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' hands you ', what, '.'],
      check: () => store.got(item.id)?.done !== true,
      play: async (stage) => {
        const no = async (why: NotchPart[]): Promise<'settled' | 'waits'> => {
          const told = await link.tell(from.id, peerNoteText('No, I cannot take that.', { kind: 'job-no', of: job.id }), { replyTo: item.id });
          if (!told.ok) { await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' }); return 'waits'; }
          settle();
          await stage.say(why, 3200, { who: from.name });
          return 'settled';
        };
        // What it would be here: a chase of the taker's own, with the history in hand. Null when one for that person is under way here.
        const draft = chases.drafted({ name: job.name, address: job.address, thing: job.thing, about: job.about, day: job.day, steps: job.steps, from: from.name });
        const so = job.steps.length === 0 ? 'Nothing was sent yet.' : `So far: ${job.steps.length} step${job.steps.length === 1 ? '' : 's'}.`;
        if (!draft) {
          const picked = await stage.choose([em(from.name), ' hands you ', em(what), '. You are getting an answer from ', em(first(job.name)), ' already, so I cannot take it on here.'], ['Say no', 'Not now'], { who: from.name, mood: 'look' });
          if (picked.act !== 'pick' || picked.index !== 0) return 'waits';
          return no(['Told ', em(from.name), ' no. It stays with ', em(from.name), '.']);
        }
        const sheet = stage.id();
        const past: NotchBlock[] = job.steps.map((one): NotchBlock => ({ kind: 'row', lead: clock(one.at), say: [`${from.name}: ${one.text}`] }));
        stage.put({
          id: sheet, kind: 'sheet', who: from.name, mood: 'look', stay: true, no: 'not now', yes: 'take it', whole: true,
          say: [em(from.name), ' hands you ', em(what), job.about ? ` on ${job.about}` : '', `, due ${draft.day}. ${so} Take it?`],
          blocks: [
            ...past,
            { kind: 'note', say: ['Taken, it is yours: ', em(first(job.name)), ' hears from you next. This is what goes, from your own mailbox:'] },
            ...chases.blocks(draft),
            { kind: 'buttons', buttons: [{ id: 'no', label: 'Say no' }] },
          ],
        });
        const answer = await stage.answer(sheet, ['yes', 'no', 'button']);
        if (answer.act === 'button' && answer.button === 'no') return no(['Told ', em(from.name), ' no. It stays with ', em(from.name), '.']);
        if (answer.act !== 'yes') return 'waits';
        // Taking it is starting it: a fuse burns, and the first mail goes from here. Only when it went is it said to be taken.
        const begun = await chases.begin(draft, stage);
        // A fuse nobody saw burn out decides nothing, and there is nobody to say it to.
        if (begun.took === 'lost') return 'waits';
        if (!begun.ok) { await stage.say([...begun.parts, ' It stays with ', em(from.name), ' for now.'], 5200, begun.took === 'undo' ? {} : { mood: 'sorry' }); return 'waits'; }
        const told = await link.tell(from.id, peerNoteText('Yes, I took it.', { kind: 'job-yes', of: job.id }), { replyTo: item.id });
        keep(`job-in:${job.id}`, { peer: from.id, chase: draft.id, what });
        settle();
        log('[notch] a job was taken from somebody, with its history');
        // Its first mail may have gone or not: it is taken all the same, so that one person has it, and
        // the truth is said. Its own question comes next, and it looks before it sends again (./standing.ts).
        if (begun.unsure) {
          await stage.say(['Yours now', told.ok ? ['. ', em(from.name), ' knows.'] : ['. I could not tell ', em(from.name), ' yet.'], ' The first mail to ', em(first(job.name)), ' may have gone: Gmail did not confirm it. I ask you about it next.'].flat(), 6200, { mood: 'careful', who: from.name });
          return 'settled';
        }
        await stage.say(told.ok ? ['Yours now. ', em(first(job.name)), ' hears from you next. ', em(from.name), ' knows.'] : ['Yours now. I could not tell ', em(from.name), ' yet.'], 4200, { mood: 'proud', mark: 'check', who: from.name });
        return 'settled';
      },
    });
  }

  /** "Sam asks for Dana's answer back. Hand it back, with what you did?" */
  function wantedBack(item: PeerItem, from: PeerPerson, job: string): void {
    const settle = (): void => { store.done(item.id); void link.seen(item.id); };
    const mine = taken(job);
    // Not one that was taken from this person: nothing to hand back. An offer of theirs that still waits is withdrawn.
    if (!mine || mine.peer !== from.id) { inbox.remove(`people:job:${job}`); settle(); return; }
    inbox.add({
      id: `people:job-back:${job}`, subject: `people:job-back:${job}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' asks for ', mine.what, ' back.'],
      check: () => store.got(item.id)?.done !== true,
      play: async (stage) => {
        const picked = await stage.choose([em(from.name), ' asks for ', em(mine.what), ' back. Hand it back, with what you did?'], ['Hand it back', 'Keep it'], { who: from.name, mood: 'look' });
        if (picked.act !== 'pick' || typeof picked.index !== 'number') return 'waits';
        const chase = chases.chase(mine.chase);
        if (picked.index === 1 || !chase) {
          const told = await link.tell(from.id, peerNoteText('I keep it for now.', { kind: 'job-keep', of: job }), { replyTo: item.id });
          if (!told.ok) { await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' }); return 'waits'; }
          settle();
          await stage.say(['Told ', em(from.name), ' you keep it.'], 2600, { who: from.name });
          return 'settled';
        }
        // Stopped here first, then told: one owner at a time.
        const steps = history(chase).filter((one) => !one.text.startsWith(`${from.name}: `) && !/^Taken from /.test(one.text));
        chases.undo(`chase:${chase.id}`);
        const told = await link.tell(from.id, peerNoteText(`Handed back: ${mine.what}.`, { kind: 'job-return', of: job, steps }), { replyTo: item.id });
        keep(`job-in:${job}`, null);
        settle();
        await stage.say(told.ok ? ['Handed back to ', em(from.name), ', with what you did. It is off your list.'] : ['Stopped here. I could not tell ', em(from.name), ' yet.'], 3600, { mark: 'check', who: from.name });
        return 'settled';
      },
    });
  }

  async function note(item: PeerItem, from: PeerPerson, got: PeerJobNote): Promise<void> {
    if (got.kind === 'job') { if (!inbox.has(`people:job:${got.id}`) && !taken(got.id)) offered(item, from, got); return; }
    if (got.kind === 'job-back') { wantedBack(item, from, got.of); return; }
    store.done(item.id);
    void link.seen(item.id);
    heard(got, from);
  }

  async function tick(): Promise<void> {
    // A job that was taken here and has ended: whoever gave it hears it, once.
    for (const key of names()) {
      if (!key.startsWith('job-in:')) continue;
      const mine = read<Taken>(key);
      const chase = mine ? chases.chase(mine.chase) : null;
      if (!mine) { keep(key, null); continue; }
      const how = !chase ? 'dropped' : chase.state === 'done' ? 'done' : chase.state === 'dropped' ? 'dropped' : null;
      if (!how) continue;
      const told = await link.tell(mine.peer, peerNoteText(how === 'done' ? `Done: ${mine.what}.` : `I let ${mine.what} go.`, { kind: 'job-done', of: key.slice('job-in:'.length), how }));
      if (told.ok) keep(key, null);
    }
  }

  function rows(): ReturnType<NotchPeopleJobs['rows']> {
    const out: ReturnType<NotchPeopleJobs['rows']> = [];
    for (const key of names()) {
      const out_ = key.startsWith('job-out:');
      const one = read<Given & Taken>(key);
      const who = one ? deps.person(one.peer)?.name : null;
      if (!one || !who) continue;
      const id = key.slice(key.indexOf(':') + 1);
      if (out_) out.push({ id, dir: 'out', what: one.what, with: who, state: one.state, small: one.state === 'taken' ? (one.asked ? `With ${who}. You asked for it back.` : `${who} took it. I tell you when it is done.`) : `Offered to ${who}. Still yours until it is taken.` });
      else out.push({ id, dir: 'in', what: one.what, with: who, state: 'taken', small: `Yours, taken from ${who}, with its history.` });
    }
    return out;
  }

  return { mine: () => chases.handable(), hand, askBack, rows, note, tick };
}
