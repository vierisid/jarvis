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
import type { NotchBlock, NotchPart, NotchWord } from './protocol.ts';
import type { NotchStage } from './stage.ts';

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
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export interface AgentSentence {
  /** The schedule that was said, as the notch says one: "Monday at 9:00". Null for an agent that waits for something to happen. */
  when: string | null;
  /** What it does, without the schedule: "send Sam the numbers". For one that waits, the whole sentence. */
  job: string;
}

/**
 * "Every Monday send Sam the numbers", "make an agent that files my
 * invoices", "when an invoice is 7 days late, chase it": an agent is asked
 * for. Null when it is not. A question is never one ("when is my next
 * call?"), and neither is "tell me when", which is an eye.
 */
export function agentSentence(text: string): AgentSentence | null {
  let said = text.trim().replace(/[’`]/g, "'").replace(/[.!]+$/, '');
  if (!said || said.endsWith('?') || said.split(/\s+/).length > 40 || said.split(/\s+/).length < 3) return null;
  said = said.replace(new RegExp(`^${LEAD}`, 'i'), '');
  const made = said.match(/^(?:create|make|build|set up)(?: me)? (?:an?|the)?\s*(?:new )?(?:agent|workflow)\s+(?:that|to|which|for)\s+(.+)$/i);
  if (made) said = made[1]!.trim();
  // One that waits for something to happen: no schedule to read back.
  if (/^(?:when(?:ever)?|before every|after every|before each|after each)\b/i.test(said)) {
    if (/^when (?:is|are|do|does|did|will|can|could|should|would|was|were|am)\b/i.test(said)) return null;
    // It has to say what to do then: a comma, or enough words to hold both halves.
    if (!said.includes(',') && said.split(/\s+/).length < 6) return null;
    return { when: null, job: said };
  }
  const every = said.match(/^(?:every|each)\s+(.+)$/i) ?? (/^(?:daily|weekly)\b/i.test(said) ? [said, said] : null);
  if (!every && !made) return null;
  if (!every) return { when: 'Monday at 9:00', job: said };
  let rest = every[1]!.trim();
  let day: string | null = null;
  const dayFound = rest.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|morning|evening|week|weekday)\b[,\s]*/i);
  if (dayFound) {
    const name = dayFound[1]!.toLowerCase();
    day = DAYS.includes(name) ? cap(name) : name === 'week' ? 'Monday' : 'day';
    rest = rest.slice(dayFound[0].length);
  } else if (/^(daily|weekly)\b/i.test(rest)) {
    day = /^weekly/i.test(rest) ? 'Monday' : 'day';
    rest = rest.replace(/^(daily|weekly)\b[,\s]*/i, '');
  } else {
    // "every 5 minutes", "every invoice": not a schedule the notch can say.
    return null;
  }
  let time = /^evening/i.test(dayFound?.[1] ?? '') ? '18:00' : '9:00';
  const at = rest.match(/^(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b[,\s]*/i);
  if (at && (at[0].toLowerCase().startsWith('at') || at[2] || at[3])) {
    let hour = Number(at[1]);
    if (at[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (at[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    if (hour <= 23) { time = `${hour}:${at[2] ?? '00'}`; rest = rest.slice(at[0].length); }
  }
  rest = rest.replace(/^[,\s]+/, '').trim();
  if (rest.split(/\s+/).filter(Boolean).length < 2) return null;
  return { when: `${day} at ${time}`, job: rest };
}

/** "Show my agents", "my agents": the list is asked for. */
export function agentsListRequest(text: string): boolean {
  return new RegExp(`^${LEAD}(?:(?:show|list|open|see)\\s+)?(?:me\\s+)?(?:my|your|the)\\s+agents[.!?]?$`, 'i').test(text.trim());
}

/** A sentence as it is told apart from another: its words, and nothing else. */
export const agentKey = (sentence: string): string => sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The whole sentence an agent is built from, with the schedule as it stands now. */
export const agentFull = (sentence: AgentSentence): string => (sentence.when ? `Every ${sentence.when}, ${sentence.job}.` : `${cap(sentence.job)}.`);

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

  drop(flowId: string): void {
    this.db.run('DELETE FROM notch_agents WHERE flow_id = ?', [flowId]);
  }
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
  /** Home's row about the agents, when there are any. */
  row(): NotchBlock | null;
  open(stage: NotchStage): Promise<void>;
  /** The clock: runs that have ended are counted, told of, and the next rung is offered. Tests call it by hand. */
  tick(): void;
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

  const nextName = (): string => {
    const taken = new Set(store.list().map((agent) => agent.name));
    return NOTCH_AGENT_NAMES.find((name) => !taken.has(name)) ?? `Agent ${taken.size + 1}`;
  };

  function make(asked: AgentSentence): void {
    if (deps.paused?.()) { tell(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return; }
    const sentence: AgentSentence = { ...asked };
    const id = `agent-make-${++n}`;
    const line = (): NotchPart[] => (sentence.when
      ? ['Every ', word('when', sentence.when, [sentence.when, ...NOTCH_AGENT_SCHEDULES], { label: 'Schedule', read: 'sched' }), ', ', sentence.job, '.']
      : [cap(sentence.job), '.']);
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
      title: line,
      play: async (stage) => {
        const lineId = stage.id();
        stage.put({ id: lineId, kind: 'offer', say: line(), yes: 'make agent', mood: 'look', fold: 0 });
        for (;;) {
          const answer = await stage.answer(lineId, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            const value = (answer.value ?? '').trim();
            if (answer.word === 'when' && /^[a-z]+ at \d{1,2}[:.]\d{2}$/i.test(value)) sentence.when = `${cap(value.split(' ')[0]!.toLowerCase() === 'day' ? 'day' : value.split(' ')[0]!)}${value.slice(value.indexOf(' '))}`.replace(/^Day /, 'day ');
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
        building.add(key);
        const workId = stage.id();
        stage.put({ id: workId, kind: 'work', say: ['Building it. This can take a couple of minutes.'], steps: 0, done: 0, mood: 'work' });
        let built: Awaited<ReturnType<NotchAgentWorkflows['build']>>;
        try { built = await deps.workflows.build(full); } catch (error) {
          built = { ok: false, why: error instanceof Error ? error.message.slice(0, 160) : 'it could not be built' };
        } finally {
          building.delete(key);
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
        const on = deps.workflows.enable(built.flowId);
        if (!on.ok) {
          await stage.say(['I built ', em(built.job), ', but could not switch it on: ', on.why.replace(/[.\s]+$/, ''), '. It is in the dashboard, switched off.'], 8000, { mood: 'sorry', mark: 'fail' });
          return 'settled';
        }
        const name = nextName();
        store.add({ flowId: built.flowId, name, rung: 'asks first', sentence: full, madeAt: now(), rungAt: now(), askedAt: 0, toldRun: '' });
        log('[notch] an agent was made from a sentence, and asks first');
        await stage.say(['Meet ', em(name), ', a new agent. The first time, it shows you before it acts.'], 7000, { mood: 'proud', mark: 'check' });
        return 'settled';
      },
    });
  }

  const rungLine = (agent: NotchAgent & { job: string }): NotchPart[] =>
    [`${agent.job}${/[.!?]$/.test(agent.job) ? '' : '.'} `, word(`rung:${agent.flowId}`, agent.rung, NOTCH_AGENT_RUNGS, { label: 'Freedom' })];

  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const list = agents();
      const blocks: NotchBlock[] = list.map((agent): NotchBlock => ({
        kind: 'row', id: agent.flowId, lead: agent.name, say: rungLine(agent), ...(agent.enabled ? {} : { small: 'Paused' }),
        buttons: [{ id: 'run', label: 'Run now' }, { id: 'pause', label: agent.enabled ? 'Pause' : 'Resume', quiet: true }, { id: 'go', label: 'Let go', quiet: true }],
      }));
      blocks.push({ kind: 'note', say: [list.length
        ? 'Their workflows live in the dashboard. Here you see what they do and how free they are. Money always asks.'
        : 'No agents yet. Tell me what to take over: "Every Monday, send Sam the numbers."'] });
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
      const agent = list.find((one) => one.flowId === answer.row);
      if (!agent) continue;
      if (answer.button === 'run') {
        if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return; }
        const ran = deps.workflows.run(agent.flowId);
        await stage.say(ran.ok ? [em(agent.name), ' is running.'] : [em(agent.name), ' could not start: ', ran.why.replace(/[.\s]+$/, ''), '.'], ran.ok ? 2400 : 5000, ran.ok ? { mood: 'look' } : { mood: 'sorry', mark: 'fail' });
        return;
      }
      if (answer.button === 'pause') { deps.workflows.pause(agent.flowId, agent.enabled); continue; }
      if (answer.button === 'go') {
        const sure = await stage.offer(['Let ', em(agent.name), ' go? The workflow is deleted too.'], 'let go', { mood: 'careful', fold: 0 });
        if (sure.act !== 'yes') continue;
        let gone = false;
        try { gone = await deps.workflows.remove(agent.flowId); } catch { gone = false; }
        if (gone) { store.drop(agent.flowId); log('[notch] an agent was let go, and its workflow deleted'); }
        else { await stage.say([em(agent.name), ' is still finishing something. Try again in a moment.'], 4200, { mood: 'careful' }); return; }
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
        if (agent.rung === 'tells you after' && newest.end === 'ok' && agent.toldRun !== '' ) {
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

  return {
    store,
    route(text) {
      if (stopped) return null;
      if (agentsListRequest(text)) return { did: 'Show the agents.', run: () => { deps.inbox.present('agents', (stage) => open(stage)); } };
      const asked = agentSentence(text);
      return asked ? { did: 'Make an agent from a sentence.', run: () => make(asked) } : null;
    },
    row() {
      const count = store.list().length;
      return count ? { kind: 'row', id: 'agents', go: true, say: [em(`${count} ${count === 1 ? 'agent' : 'agents'}`), ' on duty.'] } : null;
    },
    open,
    tick,
    stop() { stopped = true; },
  };
}
