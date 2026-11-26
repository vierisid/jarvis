/**
 * Agents (pass 11): a sentence becomes an agent, and each agent has its own
 * name and its own rung of trust.
 *
 *   "Every Monday send Sam the numbers."
 *
 * The sentence is read back with its schedule as a word that can be changed.
 * One yes, and it is built: an agent is a workflow of the product's, made by
 * the product's own composer and switched on. It starts on the first rung,
 * "asks first": every step that acts is shown before it happens. The plan:
 * "one yes creates and enables it at asks first". The same sentence twice is
 * refused.
 *
 * Trust is per agent (decision F). The rungs are "asks first", "tells you
 * after" and "acts alone". After five runs in a row that went well, the next
 * rung is offered once; a no leaves it where it is until five more. The rung
 * is also a word on the agent's row, and can be changed there at any time.
 * What a rung may and may not let go is decided where a workflow's step is
 * judged (src/workflows/runtime/agent-rung.ts): money and deleting always
 * ask.
 *
 * Which workflow is an agent, what it is called and where it stands is kept
 * in a table that only an answer on the notch writes. A workflow's own notes
 * would be the wrong place: the assistant can write those.
 *
 * The words are the prototype's (v15: sentence, createAgent, viewAgents, the
 * `trust` moment), and "Freedom" for the rung is the demo's (./demo.ts).
 */
import type { Database } from 'bun:sqlite';
import type { NotchInbox } from './inbox.ts';
import type { NotchBead, NotchBlock, NotchPart, NotchWord } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { routeByIntents, type NotchIntent } from './intents.ts';
import { readSchedule, readWhen, sayWhen } from './when.ts';

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...new Set(options)], ...more } });
const cap = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

export const NOTCH_AGENT_RUNGS = ['asks first', 'tells you after', 'acts alone'] as const;
export type NotchAgentRung = (typeof NOTCH_AGENT_RUNGS)[number];
/** The names agents are given, in order. */
export const NOTCH_AGENT_NAMES = ['Tony', 'Mara', 'Enzo', 'Livia', 'Ada', 'Nico'] as const;
export const NOTCH_AGENT_SCHEDULES = ['Monday at 9:00', 'Monday at 14:00', 'Friday at 16:00', 'day at 9:00'] as const;
/** How many runs in a row must have gone well before the next rung is offered. */
export const NOTCH_AGENT_GOOD_RUNS = 5;
/** How often the agents' runs are looked at. */
export const NOTCH_AGENT_TICK_MS = 30_000;

const LEAD = '(?:(?:ok(?:ay)?|hey|jarvis|please|now|and|then|so)[,\\s]+)*';
/** How a request is put when it is put politely. A request put as a question is still a request. */
const POLITE = "(?:(?:can|could|would|will) you(?: please)?|please|i (?:want|need)(?: you)? to|i(?: would|'d) like(?: you)? to)\\s+";
const MAKE = '(?:make|create|build|set up|add|give)(?: me)?';
/** What an agent is also called. On the notch it is always an agent. */
const KIND = '(?:agent|workflow|automation|routine|bot)';

export interface AgentSentence {
  /** The schedule that was said, as the notch says one: "Monday at 9:00". Null for an agent that waits for something to happen. */
  when: string | null;
  /** What it does, without the schedule: "send Sam the numbers". For one that waits, the whole sentence. */
  job: string;
  /** It was asked for as an agent and names no schedule: "an agent that replies to new leads". */
  agent?: true;
}

/** "sends" as "send": what an agent does is read back as what to do. */
function plainVerb(job: string): string {
  const [first, ...rest] = job.split(' ');
  if (!first || /^(?:always|is|as|this|its|his|plus|across|unless|perhaps|sometimes)$/i.test(first) || !/s$/i.test(first) || /(?:ss|us|is)$/i.test(first)) return job;
  const plain = /ies$/i.test(first) ? first.replace(/ies$/i, 'y') : /(?:ch|sh|x|z|o)es$/i.test(first) ? first.replace(/es$/i, '') : first.replace(/s$/i, '');
  return [plain, ...rest].join(' ');
}

/**
 * The schedule a description names, wherever it stands in it, and the
 * description without it: "sends me the news every day at 5.10" is "day at
 * 17:10" and "sends me the news". Read by the one reader of a time
 * (./when.ts): a weekday is Monday to Friday, "morning" and "night" say
 * which half of the day, and an hour from one to six with none of them is
 * the afternoon. Null when it names none the notch can say: "every 2 weeks",
 * two times, an hour that is none. Such a schedule is never made into one
 * that is near it. `stored`: the words are the notch's own ("Every day at
 * 6:00, ..."), and an hour in them is what it says.
 */
function scheduleIn(text: string, stored = false): { when: string; rest: string } | null {
  const read = readSchedule(text, { exact: stored });
  return read && read !== 'unsaid' ? { when: sayWhen(read.when), rest: read.rest } : null;
}

/**
 * "Every Monday send Sam the numbers", "can you make an agent that every
 * day at 5.10 sends me the news", "I want an agent that replies to new
 * leads", "when an invoice is 7 days late, chase it": an agent is asked for.
 * Null when it is not. A question about something is never one ("when is my
 * next call?"), and neither is "tell me when", which is an eye. `stored`:
 * the sentence is one the notch wrote itself and reads again (an agent's own
 * sentence, one that somebody sent): an hour in it is what it says.
 *
 * The owner's first agent, 17 November 2026, began "Can you make an agent
 * that..." and was not taken as one: it went to the assistant, which built a
 * workflow that was switched off, had no name, and could only be switched on
 * in the dashboard. However it is put, asking for an agent is asking the
 * notch.
 */
export function agentSentence(text: string, stored = false): AgentSentence | null {
  let said = text.trim().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
  const words = said ? said.split(' ').length : 0;
  if (words < 3 || words > 45) return null;
  said = said.replace(new RegExp(`^${LEAD}`, 'i'), '');
  const asked = said.endsWith('?');
  const polite = new RegExp(`^${POLITE}`, 'i').test(said);
  const made = said.match(new RegExp(`^(?:${POLITE})?${MAKE}\\s+(?:an?\\s+|one\\s+|the\\s+)?(?:new\\s+)?${KIND}\\b[\\s:,-]*(that|to|which|who|for|so that)?\\s*(.*)$`, 'i'))
    ?? said.match(new RegExp(`^i (?:want|need|would like|'d like)\\s+(?:an?\\s+|one\\s+)?(?:new\\s+)?${KIND}\\b[\\s:,-]*(that|to|which|who|for)?\\s*(.*)$`, 'i'))
    ?? said.match(new RegExp(`^(?:new\\s+)?${KIND}\\s*[:,-]\\s*()(.*)$`, 'i'));
  // A question that asks for nothing to be made is a question.
  if (asked && !polite && !made) return null;
  let rest = (made ? made[2]! : polite ? said.replace(new RegExp(`^${POLITE}`, 'i'), '') : said).replace(/[.!?\s]+$/, '').trim();
  if (!rest) return null;
  // One that waits for something to happen: no schedule to read back.
  if (/^(?:when(?:ever)?|before every|after every|before each|after each)\b/i.test(rest)) {
    if (/^when (?:is|are|do|does|did|will|can|could|should|would|was|were|am)\b/i.test(rest)) return null;
    // It has to say what to do then: a comma, or enough words to hold both halves.
    if (!rest.includes(',') && rest.split(' ').length < 6) return null;
    return { when: null, job: rest };
  }
  // In "an agent that sends…" what it does is said of the agent: read back, it is what to do.
  const told = made && /^(?:that|which|who)$/i.test(made[1] ?? '');
  // Said without the word agent, it is one only when it begins with its schedule: "I run every
  // day" is something a person says about themselves.
  if (!made && !/^(?:every|each|daily|weekly)\b/i.test(rest)) return null;
  const schedule = scheduleIn(rest, stored);
  if (schedule) {
    const job = told ? plainVerb(schedule.rest) : schedule.rest;
    // Said without the word agent, what follows the schedule has to be
    // something to do. "Every day I get so many emails from recruiters" says
    // what happens to a person, and is not asking for anything to be made.
    if (!made && /^(?:i|i'm|i've|we|we're|you|he|she|they|it|it's|there|my|our|his|her|their|the|this|that|these|those|someone|somebody|people|everyone)\b/i.test(job)) return null;
    // "Daily" and "weekly" are also what a thing is called. "Daily standup notes should go to the team" says
    // what should happen to the daily notes, and asks for nothing to be made.
    // Only when "should" is what the sentence says of the thing ("standup notes should go"), a name of one to
    // three words and then the modal. "Daily check what must be paid" and "daily send Sam what he should know"
    // begin with something to do, and are asked for.
    if (!made && /^(?:daily|weekly)\b/i.test(rest)) {
      const before = /^((?:\S+ ){1,3})(?:should|must|ought to|shall)\b/i.exec(job)?.[1]?.trim().split(' ') ?? null;
      if (before && !before.some((word) => /^(?:what|that|which|who|whom|whose|if|whether|how|when|where|why|and|or|to|he|she|they|we|you|i|it|me|him|her|them|us)$/i.test(word.replace(/[,;:]+$/, '')) || /[,;:]$/.test(word))) return null;
    }
    return job.split(' ').filter(Boolean).length >= 2 ? { when: schedule.when, job } : null;
  }
  // "Every 5 minutes", "every invoice": not a schedule the notch can say, and not asked for as an agent.
  if (!made || rest.split(' ').length < 2) return null;
  // "An agent that replies…", "an agent to keep…", "an agent for my invoices": read back as it was put.
  const joined = (made[1] ?? '').toLowerCase();
  return { when: null, job: told ? rest : `${joined === 'for' ? 'for' : 'to'} ${rest}`, agent: true };
}

/** "Show my agents", "my agents": the list is asked for. */
export function agentsListRequest(text: string): boolean {
  return new RegExp(`^${LEAD}(?:(?:show|list|open|see)\\s+)?(?:me\\s+)?(?:my|your|the)\\s+agents[.!?]?$`, 'i').test(text.trim());
}

/** A sentence as it is told apart from another: its words, and nothing else. */
export const agentKey = (sentence: string): string => sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The whole sentence an agent is built from, with the schedule as it stands now. */
export const agentFull = (sentence: AgentSentence): string =>
  (sentence.when ? `Every ${sentence.when}, ${sentence.job}.` : sentence.agent ? `An agent ${/^(?:to|for)\b/i.test(sentence.job) ? '' : 'that '}${sentence.job}.` : `${cap(sentence.job)}.`);

export interface NotchAgent {
  flowId: string;
  name: string;
  rung: NotchAgentRung;
  /** The sentence it was made from, as it was read back. */
  sentence: string;
  madeAt: number;
  /** When it came to stand on this rung. */
  rungAt: number;
  /** When the next rung was last offered and not taken. */
  askedAt: number;
  /** The last of its runs that was told of, so that none is told twice. */
  toldRun: string;
}

interface StoredAgent { flow_id: string; name: string; rung: string; sentence: string; made_at: number; rung_at: number; asked_at: number; told_run: string }

/**
 * Where the agents are kept. Only the notch writes here: a rung loosens what
 * a workflow is asked about, so it is never read from anything a model can
 * write.
 */
export class NotchAgentStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_agents (
      flow_id TEXT PRIMARY KEY, name TEXT NOT NULL, rung TEXT NOT NULL, sentence TEXT NOT NULL,
      made_at INTEGER NOT NULL, rung_at INTEGER NOT NULL, asked_at INTEGER NOT NULL DEFAULT 0, told_run TEXT NOT NULL DEFAULT ''
    )`);
  }

  list(): NotchAgent[] {
    return (this.db.query('SELECT * FROM notch_agents ORDER BY made_at').all() as StoredAgent[]).map((row) => ({
      flowId: row.flow_id, name: row.name, sentence: row.sentence, madeAt: row.made_at, rungAt: row.rung_at, askedAt: row.asked_at, toldRun: row.told_run,
      rung: (NOTCH_AGENT_RUNGS as readonly string[]).includes(row.rung) ? row.rung as NotchAgentRung : 'asks first',
    }));
  }

  get(flowId: string): NotchAgent | null {
    return this.list().find((agent) => agent.flowId === flowId) ?? null;
  }

  /** The rung a workflow stands on, or null when it is not an agent: what the product asks before every step. */
  rung(flowId: string): NotchAgentRung | null {
    const row = this.db.query('SELECT rung FROM notch_agents WHERE flow_id = ?').get(flowId) as { rung: string } | null;
    return row && (NOTCH_AGENT_RUNGS as readonly string[]).includes(row.rung) ? row.rung as NotchAgentRung : row ? 'asks first' : null;
  }

  add(agent: NotchAgent): void {
    this.db.run('INSERT INTO notch_agents (flow_id, name, rung, sentence, made_at, rung_at, asked_at, told_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [agent.flowId, agent.name, agent.rung, agent.sentence, agent.madeAt, agent.rungAt, agent.askedAt, agent.toldRun]);
  }

  setRung(flowId: string, rung: NotchAgentRung, at: number): void {
    this.db.run('UPDATE notch_agents SET rung = ?, rung_at = ?, asked_at = 0 WHERE flow_id = ?', [rung, at, flowId]);
  }

  asked(flowId: string, at: number): void {
    this.db.run('UPDATE notch_agents SET asked_at = ? WHERE flow_id = ?', [at, flowId]);
  }

  told(flowId: string, run: string): void {
    this.db.run('UPDATE notch_agents SET told_run = ? WHERE flow_id = ?', [run, flowId]);
  }

  /** The owner gave it another name. */
  rename(flowId: string, name: string): void {
    this.db.run('UPDATE notch_agents SET name = ? WHERE flow_id = ?', [name, flowId]);
  }

  drop(flowId: string): void {
    this.db.run('DELETE FROM notch_agents WHERE flow_id = ?', [flowId]);
  }
}

/** The most an agent's name holds. */
export const NOTCH_AGENT_NAME_MAX = 24;
/** How many of an agent's last runs its card shows. */
export const NOTCH_AGENT_BEADS = 6;

/**
 * A name the owner typed for an agent, as it is kept: letters, and what
 * stands between them in a name. Null when it is no name: empty, too long,
 * or made of anything else. A name is said on the notch and beside every
 * step the agent asks about, so it is never markup or a sentence.
 */
export function agentName(typed: string): string | null {
  const name = typed.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || [...name].length > NOTCH_AGENT_NAME_MAX) return null;
  return /^\p{L}[\p{L}\p{N} '.-]*$/u.test(name) ? name : null;
}

/** When an agent runs, as its card says it: "Every Monday at 9:00". Null for one that waits for something to happen. */
export function agentRuns(sentence: string): string | null {
  const when = agentSentence(sentence, true)?.when ?? null;
  return when ? `Every ${when}` : null;
}

/** What the agents need of the product's workflows (src/daemon/notch-agents.ts gives it). */
export interface NotchAgentWorkflows {
  /** Builds a workflow from a sentence and saves it switched off. It can take minutes. */
  build(sentence: string): Promise<{ ok: true; flowId: string; job: string; ready: boolean; missing: string } | { ok: false; why: string }>;
  /** Switches a built workflow on. */
  enable(flowId: string): { ok: true } | { ok: false; why: string };
  /** Stops it from running by itself, or lets it again. */
  pause(flowId: string, paused: boolean): boolean;
  /** Runs it once, now. */
  run(flowId: string): { ok: true } | { ok: false; why: string };
  /** Deletes the workflow. */
  remove(flowId: string): Promise<boolean>;
  /** What it is called and whether it is on. Null when the workflow is gone. */
  look(flowId: string): { job: string; enabled: boolean } | null;
  /** How its latest runs ended, newest first. */
  runs(flowId: string, limit: number): { id: string; end: 'ok' | 'bad' | 'open'; at: number }[];
  /**
   * What was built since a moment, by whoever built it: the assistant too
   * builds one when it is asked in words the notch did not take as its own.
   * Newest first.
   */
  madeSince(at: number): { flowId: string; job: string; ready: boolean; missing: string; enabled: boolean }[];
}

export interface NotchAgentsDeps {
  inbox: NotchInbox;
  db: Database;
  workflows: NotchAgentWorkflows;
  paused?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchAgents {
  store: NotchAgentStore;
  /** What the notch does itself with these words: an agent is made, or the list is shown. Null otherwise. Has no effect until `run`. */
  route(text: string): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
  /** Home's row about the agents, when there are any. */
  row(): NotchBlock | null;
  open(stage: NotchStage): Promise<void>;
  /**
   * An instruction has been carried out by the assistant. If it built
   * something that runs by itself, that is an agent like any other: the
   * notch offers to switch it on, and gives it its name. Nobody is sent to
   * the dashboard to do that.
   */
  adopt(since: number): void;
  /** The clock: runs that have ended are counted, told of, and the next rung is offered. Tests call it by hand. */
  tick(): void;
  /** The agents there are: what each is called, and the sentence it was made from. */
  list(): { name: string; sentence: string }[];
  /**
   * Makes an agent from a sentence that was said yes to already, on the line
   * that offered it (an agent somebody sent). It is not asked about again.
   * False when nothing can be made of it.
   */
  take(sentence: string): boolean;
  /** The agents made since a moment, for the list of what was done (./today.ts). One that is switched on can be taken back. */
  done(since: number): { id: string; at: number; text: string; small: string; undo: boolean }[];
  /**
   * Takes back the making of an agent, by the id its row has: it is switched
   * off, not deleted. Deleting is asked for in the agents' own list, where it
   * is a question. Comes back with what to say, or null when it is no agent
   * or is off already.
   */
  undo(id: string): NotchPart[] | null;
  stop(): void;
}

/** How the next rung is offered, and how keeping the old one is said. */
const NEXT: Record<Exclude<NotchAgentRung, 'acts alone'>, { rung: NotchAgentRung; as: string; keep: string; kept: string }> = {
  'asks first': { rung: 'tells you after', as: 'tell you after', keep: 'keep asking', kept: 'keeps asking you, every time.' },
  'tells you after': { rung: 'acts alone', as: 'act alone', keep: 'keep telling you', kept: 'keeps telling you after.' },
};

export function attachNotchAgents(deps: NotchAgentsDeps): NotchAgents {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = new NotchAgentStore(deps.db);
  let stopped = false;
  let n = 0;
  /** A sentence that is being built into an agent: a second one of the same waits its turn by being refused. */
  const building = new Set<string>();
  /** Built, and not switched on yet: the notch was taken away, or everything was stopped, when the building was over. */
  const waiting = new Map<string, Extract<Awaited<ReturnType<NotchAgentWorkflows['build']>>, { ok: true }>>();

  const tell = (parts: NotchPart[], ms = 3000, extras: { mood?: 'look' | 'proud' | 'sorry' | 'careful' | 'confused' | 'happy'; mark?: 'check' | 'fail' } = {}): void => {
    const id = `agents-say-${++n}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, ms, extras); return 'settled'; },
    });
  };

  /** The agents whose workflow is still there. One whose workflow was deleted elsewhere is no agent any more. */
  function agents(): (NotchAgent & { job: string; enabled: boolean })[] {
    const out: (NotchAgent & { job: string; enabled: boolean })[] = [];
    for (const agent of store.list()) {
      let seen: { job: string; enabled: boolean } | null = null;
      try { seen = deps.workflows.look(agent.flowId); } catch { seen = { job: agent.sentence, enabled: false }; }
      if (!seen) { store.drop(agent.flowId); continue; }
      out.push({ ...agent, ...seen });
    }
    return out;
  }

  /**
   * "Meet Tony": said with a wink, and a moment later a piece of the notch
   * buds off and hops away along the edge, to its job (the prototype's `bud`).
   */
  async function meet(stage: NotchStage, parts: NotchPart[], ms: number, extras: Parameters<NotchStage['say']>[2]): Promise<void> {
    const said = stage.say(parts, ms, extras);
    stage.surface.act({ gesture: 'wink' });
    stage.wait(700).then(() => stage.surface.act({ edge: 'bud' }), () => {});
    await said;
  }

  const nextName = (): string => {
    const taken = new Set(store.list().map((agent) => agent.name));
    return NOTCH_AGENT_NAMES.find((name) => !taken.has(name)) ?? `Agent ${taken.size + 1}`;
  };

  /**
   * `agreed`: the sentence was read and said yes to already, on another
   * line (an agent that somebody sent, ./people.ts). It is not read back and
   * asked about a second time. Everything else is as for any agent: built,
   * switched on, named, on the first rung.
   */
  function make(asked: AgentSentence, agreed = false): void {
    if (deps.paused?.()) { tell(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return; }
    const sentence: AgentSentence = { ...asked };
    const id = `agent-make-${++n}`;
    const line = (): NotchPart[] => (sentence.when
      ? ['Every ', word('when', sentence.when, [sentence.when, ...NOTCH_AGENT_SCHEDULES], { label: 'Schedule', read: 'sched' }), ', ', sentence.job, '.']
      : [agentFull(sentence)]);
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
      title: line,
      play: async (stage) => {
        const lineId = stage.id();
        if (!agreed) stage.put({ id: lineId, kind: 'offer', say: line(), yes: 'make agent', mood: 'look', fold: 0 });
        for (; !agreed;) {
          const answer = await stage.answer(lineId, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            const value = (answer.value ?? '').trim();
            // A time as the notch writes one, read by the one reader (./when.ts). One that is none leaves the word as it was.
            const read = answer.word === 'when' ? readWhen(value, { exact: true }) : null;
            if (read && read.days.length > 0) sentence.when = sayWhen(read);
            stage.surface.update(lineId, { say: line() });
            continue;
          }
          if (answer.act !== 'yes') return 'settled';
          break;
        }
        const full = agentFull(sentence);
        const key = agentKey(full);
        // The same sentence twice is refused: one job, one agent.
        const same = store.list().find((agent) => agentKey(agent.sentence) === key);
        if (same) { await stage.say(['You already have an agent for that: ', em(same.name), '.'], 3600, { mood: 'careful' }); return 'settled'; }
        if (building.has(key)) { await stage.say(['I am already building that one.'], 2600); return 'settled'; }
        if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return 'settled'; }
        // One that was built while the notch was taken away is not built a second time: it waits here,
        // switched off, for its line to be back.
        let built: Awaited<ReturnType<NotchAgentWorkflows['build']>> | undefined = waiting.get(key);
        let stopped = false;
        if (!built) {
          building.add(key);
          const workId = stage.id();
          stage.put({ id: workId, kind: 'work', say: ['Building it. This can take a couple of minutes.'], steps: 0, done: 0, mood: 'work' });
          // The line shows "esc stop". Nobody listened: two minutes after an Esc came "Meet Tony", built and
          // switched on. The building itself cannot be called back, so what an Esc stops is the switching on.
          stage.answer(workId, ['stop']).then(() => { stopped = true; }, () => {});
          try { built = await deps.workflows.build(full); } catch (error) {
            built = { ok: false, why: error instanceof Error ? error.message.slice(0, 160) : 'it could not be built' };
          } finally {
            building.delete(key);
          }
        }
        if (!built.ok) {
          log('[notch] an agent could not be built from a sentence');
          await stage.say(['I could not build that: ', built.why.replace(/[.\s]+$/, ''), '. Nothing was set up.'], 6000, { mood: 'sorry', mark: 'fail' });
          return 'settled';
        }
        if (!built.ready) {
          // Built, and not fit to run: it is not switched on, and it is not called an agent.
          log('[notch] an agent was built but needs setting up before it can run');
          await stage.say(['I built ', em(built.job), ', but it cannot run yet: ', (built.missing || 'something in it is not set up').replace(/[.\s]+$/, ''),
            '. It is in the dashboard, switched off.'], 8000, { mood: 'careful' });
          return 'settled';
        }
        if (stopped) {
          log('[notch] an agent was built and not switched on: it was stopped while it was being built');
          await stage.say(['Stopped. ', em(built.job), ' is built but not switched on. It is in the dashboard.'], 6000, { mood: 'careful' });
          return 'settled';
        }
        // Nothing is switched on behind the person's back: not while everything is stopped, and not when
        // something else has taken the notch, so that "Meet…" could not be said. It waits, switched off, and
        // is switched on when this line has the notch again.
        if (deps.paused?.() || stage.ended()) {
          waiting.set(key, built);
          log('[notch] an agent was built and waits, switched off, until its line is back');
          await stage.say(['Everything is stopped. ', em(built.job), ' is built and waits, switched off.'], 5000, { mood: 'careful' });
          return 'waits';
        }
        waiting.delete(key);
        const on = deps.workflows.enable(built.flowId);
        if (!on.ok) {
          await stage.say(['I built ', em(built.job), ', but could not switch it on: ', on.why.replace(/[.\s]+$/, ''), '. It is in the dashboard, switched off.'], 8000, { mood: 'sorry', mark: 'fail' });
          return 'settled';
        }
        const name = nextName();
        store.add({ flowId: built.flowId, name, rung: 'asks first', sentence: full, madeAt: now(), rungAt: now(), askedAt: 0, toldRun: '' });
        log('[notch] an agent was made from a sentence, and asks first');
        await meet(stage, ['Meet ', em(name), ', a new agent. The first time, it shows you before it acts.'], 7000, { mood: 'proud', mark: 'check' });
        return 'settled';
      },
    });
  }

  /** How far back something that was built and never switched on is still offered. */
  const PENDING_MS = 48 * 3_600_000;

  /**
   * What was built lately and is no agent yet. Switched off, it waits to be
   * switched on. Switched on somewhere else (the dashboard), it runs with no
   * name: the owner, 17 November 2026, had done just that, "the only way for
   * me to enable it is to go to the dashboard, so it doesn't give me a name".
   * It is not made an agent behind their back, since an agent asks first and
   * this one does not today: it waits here for one click.
   */
  function pending(): ReturnType<NotchAgentWorkflows['madeSince']> {
    let made: ReturnType<NotchAgentWorkflows['madeSince']>;
    try { made = deps.workflows.madeSince(now() - PENDING_MS); } catch { return []; }
    const known = new Set(store.list().map((agent) => agent.flowId));
    return made.filter((one) => !known.has(one.flowId)).slice(0, 5);
  }

  /** Switches on something that was built, and makes it an agent: a name, and the first rung. */
  function switchOn(built: { flowId: string; job: string; enabled?: boolean }): { parts: NotchPart[]; ms: number; extras: { mood?: 'proud' | 'sorry'; mark?: 'check' | 'fail' }; born?: boolean } {
    if (!built.enabled) {
      const on = deps.workflows.enable(built.flowId);
      if (!on.ok) return { parts: ['I could not switch ', em(built.job), ' on: ', on.why.replace(/[.\s]+$/, ''), '.'], ms: 6000, extras: { mood: 'sorry', mark: 'fail' } };
    }
    const name = nextName();
    store.add({ flowId: built.flowId, name, rung: 'asks first', sentence: built.job, madeAt: now(), rungAt: now(), askedAt: 0, toldRun: '' });
    log('[notch] something the assistant built was made an agent, and asks first');
    return { parts: ['Meet ', em(name), ', a new agent. The first time, it shows you before it acts.'], ms: 7000, extras: { mood: 'proud', mark: 'check' }, born: true };
  }

  /** Says what switching on came to: the new agent is met, or why it could not be switched on. */
  const saySwitched = (stage: NotchStage, said: ReturnType<typeof switchOn>): Promise<void> =>
    (said.born ? meet(stage, said.parts, said.ms, said.extras) : stage.say(said.parts, said.ms, said.extras));

  function adopt(since: number): void {
    if (stopped) return;
    let made: ReturnType<NotchAgentWorkflows['madeSince']>;
    try { made = deps.workflows.madeSince(since); } catch { return; }
    const known = new Set(store.list().map((agent) => agent.flowId));
    // One instruction builds one thing: the newest that is no agent yet.
    const built = made.find((one) => !known.has(one.flowId));
    if (!built) return;
    const id = `agent-adopt-${built.flowId}`;
    if (deps.inbox.has(id)) return;
    if (!built.ready) {
      // Built, and not fit to run: said once, and it waits in the list until it is.
      const parts: NotchPart[] = [em(built.job), ' is built, but cannot run yet: ', (built.missing || 'something in it is not set up').replace(/[.\s]+$/, ''), '.'];
      deps.inbox.add({ id, subject: id, class: 'person', speaks: true, once: true, asked: true, title: () => parts,
        play: async (stage) => { await stage.say(parts, 7000, { mood: 'careful' }); return 'settled'; } });
      return;
    }
    // Switched on already, by whoever built it: it is an agent from now on, and is named.
    if (built.enabled) {
      const said = switchOn(built);
      deps.inbox.add({ id, subject: id, class: 'person', speaks: true, once: true, asked: true, title: () => said.parts,
        play: async (stage) => { await saySwitched(stage, said); return 'settled'; } });
      return;
    }
    const line: NotchPart[] = ['Switch ', em(built.job), ' on as an agent?'];
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, asked: true,
      title: () => line,
      check: () => !store.get(built.flowId) && deps.workflows.look(built.flowId)?.enabled === false,
      play: async (stage) => {
        const answer = await stage.offer(line, 'switch on', { mood: 'look', fold: 0 });
        if (answer.act === 'fold') return 'waits';
        // A no leaves it switched off, in the list, where it can still be switched on or discarded.
        if (answer.act !== 'yes') return 'settled';
        if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return 'waits'; }
        const said = switchOn(built);
        await saySwitched(stage, said);
        return 'settled';
      },
    });
  }

  const rungLine = (agent: NotchAgent & { job: string }): NotchPart[] =>
    [`${agent.job}${/[.!?]$/.test(agent.job) ? '' : '.'} `, word(`rung:${agent.flowId}`, agent.rung, NOTCH_AGENT_RUNGS, { label: 'Freedom' })];

  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const list = agents();
      // The prototype's list: who, what it does, how free it is, and a way in. What can be done with one is on its card.
      const blocks: NotchBlock[] = list.map((agent): NotchBlock => ({
        kind: 'row', id: agent.flowId, lead: agent.name, say: rungLine(agent), ...(agent.enabled ? {} : { small: 'Paused' }),
        buttons: [{ id: 'open', label: 'Open', quiet: true }],
      }));
      blocks.push({ kind: 'note', say: [list.length
        ? 'Here you see what each agent does and how free it is. Money always asks.'
        : 'No agents yet. Tell me what to take over: "Every Monday, send Sam the numbers."'] });
      // What was built lately and never switched on: one click makes it an agent.
      for (const draft of pending()) {
        blocks.splice(blocks.length - 1, 0, draft.enabled ? {
          // Running already, switched on somewhere else: one click gives it its name. Nothing here deletes a thing that runs.
          kind: 'row', id: draft.flowId, lead: 'New', say: [`${draft.job}${/[.!?]$/.test(draft.job) ? '' : '.'}`], small: 'Running, no name yet',
          buttons: [{ id: 'on', label: 'Make it an agent' }],
        } : {
          kind: 'row', id: draft.flowId, lead: 'New', say: [`${draft.job}${/[.!?]$/.test(draft.job) ? '' : '.'}`], small: draft.ready ? 'Not switched on' : 'Needs setting up',
          buttons: [...(draft.ready ? [{ id: 'on', label: 'Switch on' }] : []), { id: 'drop', label: 'Discard', quiet: true }],
        });
      }
      const id = stage.id();
      stage.put({ id, kind: 'sheet', say: ['Your agents'], blocks });
      const answer = await stage.answer(id, ['no', 'button', 'word', 'go']);
      if (answer.act === 'word') {
        const flowId = (answer.word ?? '').startsWith('rung:') ? (answer.word ?? '').slice(5) : '';
        const rung = NOTCH_AGENT_RUNGS.find((name) => name === answer.value);
        // The owner's own hand on the word: the rung is what they set it to, up or down.
        if (flowId && rung && store.get(flowId)) { store.setRung(flowId, rung, now()); log('[notch] the owner set an agent\'s rung by hand'); }
        continue;
      }
      if (answer.act !== 'button' || !answer.row) return;
      if (answer.button === 'on' || answer.button === 'drop') {
        const draft = pending().find((one) => one.flowId === answer.row);
        if (!draft) continue;
        if (answer.button === 'drop') {
          // Only what never ran is discarded from here. One that runs is let go as an agent, with its own ask.
          if (!draft.enabled) { try { await deps.workflows.remove(draft.flowId); } catch { /* it stays in the list, and can be tried again */ } }
          continue;
        }
        if (!draft.enabled && !draft.ready) continue;
        const said = switchOn(draft);
        await saySwitched(stage, said);
        return;
      }
      if (answer.button !== 'open' || !list.some((one) => one.flowId === answer.row)) continue;
      // Its card. It comes back when the card is closed; when the card ran it, or said something that ends it, this ends too.
      if ((await card(stage, answer.row)) === 'left') return;
    }
  }

  /**
   * One agent's card, the prototype's: its name as a word the owner can
   * change, what it does, how free it is, its last runs as dots, when it
   * runs next, and what can be done with it. `back` when it was closed and
   * the list is to come back, `left` when it ended in a line of its own.
   */
  async function card(stage: NotchStage, flowId: string): Promise<'back' | 'left'> {
    for (;;) {
      const agent = agents().find((one) => one.flowId === flowId);
      if (!agent) return 'back';
      // The last runs, the oldest first: a dot for each. One that is still open stopped to ask.
      let runs: NotchBead[] = [];
      try { runs = deps.workflows.runs(flowId, NOTCH_AGENT_BEADS).map((run): NotchBead => (run.end === 'ok' ? 'ok' : run.end === 'bad' ? 'bad' : 'ask')).reverse(); } catch { runs = []; }
      const when = agentRuns(agent.sentence);
      // Names that are free, for a click: its own first, then the ones no other agent has.
      const taken = new Set(store.list().map((one) => one.name.toLowerCase()));
      const names = [agent.name, ...NOTCH_AGENT_NAMES.filter((name) => !taken.has(name.toLowerCase()))].slice(0, 5);
      const blocks: NotchBlock[] = [
        { kind: 'note', say: [`${agent.job}${/[.!?]$/.test(agent.job) ? '' : '.'}`] },
        { kind: 'row', say: ['How free ', word(`rung:${flowId}`, agent.rung, NOTCH_AGENT_RUNGS, { label: 'Freedom' })] },
        runs.length > 0 ? { kind: 'row', say: ['Last runs'], beads: runs } : { kind: 'row', say: ['No runs yet'] },
        agent.enabled
          ? { kind: 'row', say: ['Next run'], small: when ?? 'When it happens' }
          : { kind: 'row', say: ['Paused'], small: 'until you resume' },
        { kind: 'buttons', buttons: [{ id: 'pause', label: agent.enabled ? 'Pause' : 'Resume' }, { id: 'go', label: 'Let go', quiet: true }] },
      ];
      const id = stage.id();
      stage.put({ id, kind: 'sheet', say: [word('name', agent.name, names, { label: 'Name', free: true })], blocks, yes: 'run now', no: 'back', stay: true });
      const answer = await stage.answer(id, ['yes', 'no', 'button', 'word']);
      if (answer.act === 'no') return 'back';
      if (answer.act === 'word') {
        if (answer.word === 'name') {
          // The owner's own hand on the name: another one, when it is a name and no other agent has it.
          const name = agentName(answer.value ?? '');
          if (name && name !== agent.name && !store.list().some((one) => one.flowId !== flowId && one.name.toLowerCase() === name.toLowerCase())) {
            store.rename(flowId, name);
            log('[notch] the owner gave an agent another name');
          }
        } else if (answer.word === `rung:${flowId}`) {
          const rung = NOTCH_AGENT_RUNGS.find((one) => one === answer.value);
          if (rung) { store.setRung(flowId, rung, now()); log('[notch] the owner set an agent\'s rung by hand'); }
        }
        continue;
      }
      if (answer.act === 'yes') {
        if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return 'left'; }
        const ran = deps.workflows.run(flowId);
        await stage.say(ran.ok ? [em(agent.name), ' is running.'] : [em(agent.name), ' could not start: ', ran.why.replace(/[.\s]+$/, ''), '.'], ran.ok ? 2400 : 5000, ran.ok ? { mood: 'look' } : { mood: 'sorry', mark: 'fail' });
        return 'left';
      }
      if (answer.button === 'pause') { deps.workflows.pause(flowId, agent.enabled); continue; }
      if (answer.button === 'go') {
        const sure = await stage.offer(['Let ', em(agent.name), ' go? It is deleted for good.'], 'let go', { mood: 'careful', fold: 0 });
        if (sure.act !== 'yes') continue;
        let gone = false;
        try { gone = await deps.workflows.remove(flowId); } catch { gone = false; }
        if (gone) { store.drop(flowId); log('[notch] an agent was let go and deleted'); return 'back'; }
        await stage.say([em(agent.name), ' is still finishing something. Try again in a moment.'], 4200, { mood: 'careful' });
        return 'left';
      }
    }
  }

  /** The next rung is offered from results, once. A no leaves it until as many good runs again. */
  function offerRung(agent: NotchAgent, good: number): void {
    if (agent.rung === 'acts alone') return;
    const next = NEXT[agent.rung];
    const id = `agent-rung-${agent.flowId}`;
    if (deps.inbox.has(id)) return;
    let how = next.as;
    const line = (): NotchPart[] => [em(agent.name), `'s last ${good} runs went well. Let ${agent.name} `, word('how', how, [next.as, next.keep], { label: 'Freedom' }), '?'];
    // Offered, taken or not: it is not offered again for these runs.
    store.asked(agent.flowId, now());
    deps.inbox.add({
      id, subject: id, class: 'rest', speaks: true,
      title: line,
      check: () => store.get(agent.flowId)?.rung === agent.rung,
      play: async (stage) => {
        const lineId = stage.id();
        stage.put({ id: lineId, kind: 'offer', say: line(), yes: 'yes', mood: 'curious', who: agent.name });
        for (;;) {
          const answer = await stage.answer(lineId, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            if (answer.word === 'how' && (answer.value === next.as || answer.value === next.keep)) how = answer.value;
            stage.surface.update(lineId, { say: line() });
            continue;
          }
          // No, or left alone: it stays where it is, and nothing is said.
          if (answer.act !== 'yes') return 'settled';
          if (how === next.keep) { await stage.say([em(agent.name), ` ${next.kept}`], 2800); return 'settled'; }
          store.setRung(agent.flowId, next.rung, now());
          log('[notch] an agent was moved up a rung on the owner\'s yes');
          await stage.say([em(agent.name), ` now ${next.rung}. Change it any time.`], 3000, { mood: 'proud', mark: 'check' });
          return 'settled';
        }
      },
    });
  }

  function tick(): void {
    if (stopped || deps.paused?.()) return;
    for (const agent of agents()) {
      let runs: ReturnType<NotchAgentWorkflows['runs']>;
      try { runs = deps.workflows.runs(agent.flowId, 12); } catch { continue; }
      const ended = runs.filter((run) => run.end !== 'open');
      // On "tells you after", a run that went well is told once it is over.
      const newest = ended[0];
      if (newest && newest.id !== agent.toldRun) {
        store.told(agent.flowId, newest.id);
        // Its first run on this rung is told like any other. (It was not: "none told yet" was taken for "this
        // one is from before I looked", and an agent that ran on Monday said nothing.) Only a run that ended
        // before it was put on this rung is not its news.
        if (agent.rung === 'tells you after' && newest.end === 'ok' && (agent.toldRun !== '' || newest.at >= agent.rungAt)) {
          const parts: NotchPart[] = [em(agent.name), ' did its job: ', agent.job.replace(/[.\s]+$/, ''), '.'];
          const id = `agent-told-${agent.flowId}-${newest.id}`;
          deps.inbox.add({
            id, subject: `agent-told-${agent.flowId}`, class: 'rest', speaks: true, once: true,
            title: () => parts,
            play: async (stage) => { await stage.say(parts, 4200, { mood: 'happy', mark: 'check', who: agent.name }); return 'settled'; },
          });
        }
      }
      if (agent.rung === 'acts alone') continue;
      // Runs in a row that went well, since it came to this rung and since it was last asked.
      const since = Math.max(agent.rungAt, agent.askedAt);
      let good = 0;
      for (const run of ended) {
        if (run.end !== 'ok' || run.at <= since) break;
        good++;
      }
      if (good >= NOTCH_AGENT_GOOD_RUNS) offerRung(agent, good);
    }
  }

  const intents: NotchIntent[] = [{
    id: 'agents.list', feature: 'agents', says: 'show the agents', band: 'open', act: 'none', first: 'acts',
    examples: ['my agents', 'show me my agents'],
    match(text) {
      if (stopped) return null;
      return agentsListRequest(text) ? { did: 'Show the agents.', run: () => { deps.inbox.present('agents', (stage) => open(stage)); } } : null;
    },
  }, {
    // The sentence is read back as a line, with its schedule lit, and only "make agent" makes it.
    id: 'agents.make', feature: 'agents', says: 'make an agent from a sentence that says when and what', band: 'command', act: 'create', first: 'yes',
    examples: ['every Monday send Sam the numbers', 'can you make an agent that replies to new leads'],
    never: ['daily standup notes should go to the team', 'every evening I go for a run', 'remind me every day at 8 to take my pills'],
    match(text) {
      if (stopped) return null;
      const asked = agentSentence(text);
      return asked ? { did: 'Make an agent from a sentence.', run: () => make(asked) } : null;
    },
  }];
  return {
    store,
    route: (text) => routeByIntents(intents, text),
    intents: () => intents,
    row() {
      const count = store.list().length;
      const waiting = pending();
      const many = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'}`;
      // Some on duty: what waits for a click is said beside them, so it is not lost behind them.
      if (count) return { kind: 'row', id: 'agents', go: true, say: [em(many(count)), waiting.length ? ` on duty. ${waiting.length} more ${waiting.length === 1 ? 'waits' : 'wait'} for you.` : ' on duty.'] };
      if (!waiting.length) return null;
      // None on duty, and one that was built waits: the way to it is here too.
      const running = waiting.filter((one) => one.enabled).length;
      const how = running === waiting.length ? ' running without a name.' : running === 0 ? ' built, not switched on.' : ' built, waiting for you.';
      return { kind: 'row', id: 'agents', go: true, say: [em(many(waiting.length)), how] };
    },
    open,
    adopt,
    tick,
    list: () => store.list().map((agent) => ({ name: agent.name, sentence: agent.sentence })),
    take(sentence) {
      if (stopped) return false;
      // Read as any sentence is. One that does not read as a schedule or as "an agent that" is taken as it stands.
      const asked = agentSentence(sentence, true) ?? { when: null, job: sentence.trim().replace(/[.!?\s]+$/, '') };
      if (!asked.job) return false;
      make(asked, true);
      return true;
    },
    done(since) {
      return store.list().filter((agent) => agent.madeAt >= since).flatMap((agent) => {
        const seen = deps.workflows.look(agent.flowId);
        // One whose workflow is gone was deleted: it is not something that was done and stands.
        if (!seen) return [];
        const sentence = [...agent.sentence];
        return [{
          id: `agent:${agent.flowId}`, at: agent.madeAt,
          text: `Made ${agent.name}: ${sentence.length <= 120 ? agent.sentence : `${sentence.slice(0, 119).join('').trimEnd()}…`}`,
          small: seen.enabled ? 'on' : 'switched off', undo: seen.enabled,
        }];
      });
    },
    undo(id) {
      if (!id.startsWith('agent:')) return null;
      const agent = store.get(id.slice('agent:'.length));
      const seen = agent ? deps.workflows.look(agent.flowId) : null;
      if (!agent || !seen?.enabled) return null;
      if (!deps.workflows.pause(agent.flowId, true)) return [em(agent.name), ' could not be switched off. It is still on.'];
      log('[notch] an agent was switched off from the list of what was done');
      return [em(agent.name), ' is switched off. It is still in Agents.'];
    },
    stop() { stopped = true; },
  };
}
