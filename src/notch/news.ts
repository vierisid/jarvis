/**
 * One-line news on the notch: what went wrong, and what finished.
 *
 * News is said once and asks nothing. If the notch is busy when it happens
 * it waits in the count and is said in the next round.
 *
 * Failures are the product's own open failures (workflows/runtime/
 * open-failures.ts): workflow runs that ended badly, messages that may not
 * have arrived, chat turns that may have acted. Each already has one
 * headline sentence and a stable key, and that sentence is what is said.
 * Nothing in the product announces them, so they are found by looking, as
 * the dashboard finds them. What was already open when the notch came up is
 * not news and is not said: it is in the dashboard.
 *
 * Finished work is a background agent's task, completed or failed.
 *
 * A failure of one of the owner's agents is said as that agent's, and has a
 * way out when the product says there is a safe one (the prototype: "Otto
 * stopped. Stripe wants you to sign in again.", and yes signs in). Which
 * next steps are safe is the product's own judgement of that failure
 * (failures/projection.ts, `next`), never this file's: "reconnect, then run
 * it again" opens the Connections and then offers the run, "run it again"
 * runs it. A failure with no such step is said, with the agent's name, and
 * asks nothing, as before.
 */
import type { NotchInbox, NotchItem } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** How often the open failures are looked at. */
export const NOTCH_FAILURE_LOOK_MS = 5000;
/** The most of a task's text one line carries. */
const LINE_CHARS = 90;

export interface NotchOpenFailure {
  /** The failure's stable identity. */
  key: string;
  /** What happened, one sentence. */
  headline: string;
  /** The workflow whose run it was, when it was a run. */
  flowId?: string;
  /** The safe next steps the product names for it, as it names them: "connect", "run_again", and others the notch does not take. */
  steps?: readonly string[];
}

export interface NotchNewsDeps {
  /** The failures that are open now. */
  openFailures?: () => NotchOpenFailure[];
  /** The agent a workflow is, when it is one of the owner's agents. */
  agent?: (flowId: string) => { name: string } | null;
  /** Opens the notch's Connections, where a sign-in is started. Comes back when it is closed. */
  connections?: (stage: NotchStage) => Promise<void>;
  /** Runs an agent's workflow once, now. */
  run?: (flowId: string) => { ok: true } | { ok: false; why: string };
  /** Everything is stopped: nothing is run. */
  paused?: () => boolean;
  log?: (line: string) => void;
}

export interface NotchNews {
  /** Looks at the open failures now. The first look only takes note of what is already there. */
  sync(): void;
  /** A background task came to an end. */
  taskEnded(event: 'complete' | 'fail', task: { id: string; agentName: string; task: string }): void;
}

const em = (text: string): NotchPart => ({ em: text });

const cut = (text: string): string => {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length <= LINE_CHARS ? points.join('') : `${points.slice(0, LINE_CHARS - 1).join('').trimEnd()}…`;
};

export function attachNotchNews(inbox: NotchInbox, deps: NotchNewsDeps = {}): NotchNews {
  const log = deps.log ?? ((line: string) => console.log(line));
  /** Failures already told, or already open at the first look. Null before the first look. */
  let seen: Set<string> | null = null;

  const news = (id: string, say: NotchPart[], ms: number, ok: boolean): NotchItem => ({
    id, subject: id, class: 'rest', speaks: true, once: true,
    title: () => say,
    play: async (stage) => {
      // What an agent finished comes hopping along the edge; what went wrong comes fast, twice.
      await stage.say(say, ms, ok ? { mood: 'happy', mark: 'check', comes: 'hop' } : { mood: 'worried', mark: 'fail' });
      return 'settled';
    },
  });

  const named = (flowId: string): { name: string } | null => { try { return deps.agent?.(flowId) ?? null; } catch { return null; } };
  /** Whether a failure is still open: one that was settled elsewhere is not spoken of, and offers nothing. */
  const open = (key: string): boolean => { try { return deps.openFailures?.().some((failure) => failure.key === key) ?? false; } catch { return true; } };

  /**
   * An agent's run ended badly. It is said as the agent's own, in the
   * product's sentence, and has a yes when the product names a next step the
   * notch can take: a sign-in, or the run again.
   */
  function stopped(failure: NotchOpenFailure, flowId: string, name: string): NotchItem {
    const steps = failure.steps ?? [];
    const way: 'connect' | 'again' | null = steps.includes('connect') && deps.connections ? 'connect' : steps.includes('run_again') && deps.run ? 'again' : null;
    const say: NotchPart[] = [em(name), ' stopped. ', failure.headline];
    const id = `failure:${failure.key}`;
    const run = async (stage: NotchStage): Promise<void> => {
      if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return; }
      const ran = deps.run!(flowId);
      log(`[notch] an agent that had stopped was run again (${ran.ok ? 'started' : 'not started'})`);
      await stage.say(ran.ok ? [em(name), ' is running again.'] : [em(name), ' could not start: ', ran.why.replace(/[.\s]+$/, ''), '.'], ran.ok ? 2600 : 5000,
        ran.ok ? { mood: 'look', who: name } : { mood: 'sorry', mark: 'fail', who: name });
    };
    if (!way) {
      // Nothing the notch can do about it: said once, with whose it is, and it asks nothing.
      return {
        id, subject: id, class: 'rest', speaks: true, once: true,
        title: () => say,
        play: async (stage) => { await stage.say(say, 6000, { mood: 'worried', mark: 'fail', who: name }); return 'settled'; },
      };
    }
    return {
      id, subject: id, class: 'rest', speaks: true,
      title: () => say,
      check: () => open(failure.key),
      play: async (stage) => {
        const answer = await stage.offer(say, way === 'connect' ? 'sign in' : 'run again', { mood: 'worried', mark: 'fail', who: name });
        // Left alone it waits in the count: not now is not no. Esc is a no, and it is in the dashboard.
        if (answer.act === 'fold') return 'waits';
        if (answer.act !== 'yes') return 'settled';
        if (way === 'again') { await run(stage); return 'settled'; }
        log('[notch] the way to a sign-in was opened for an agent that had stopped');
        await deps.connections!(stage);
        // The product's own next step: "reconnect, then run it again". The run is offered, not taken for granted:
        // whether the sign-in was done is theirs to know.
        if (deps.run) {
          const again = await stage.offer(['Run ', em(name), ' again now?'], 'run', { mood: 'curious', who: name, fold: 0 });
          if (again.act === 'yes') await run(stage);
        }
        return 'settled';
      },
    };
  }

  function sync(): void {
    const list = deps.openFailures;
    if (!list) return;
    let open: NotchOpenFailure[];
    try {
      open = list();
    } catch (error) {
      log(`[notch] the open failures could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (seen === null) {
      seen = new Set(open.map((failure) => failure.key));
      return;
    }
    for (const failure of open) {
      if (seen.has(failure.key)) continue;
      seen.add(failure.key);
      const agent = failure.flowId ? named(failure.flowId) : null;
      if (agent && failure.flowId) { inbox.add(stopped(failure, failure.flowId, agent.name)); continue; }
      // The product's own sentence, as it is.
      inbox.add(news(`failure:${failure.key}`, [failure.headline], 6000, false));
    }
    // Forget what is no longer open, so the set cannot grow without end. A
    // failure that comes back after it was settled is news again.
    if (seen.size > 500) {
      const still = new Set(open.map((failure) => failure.key));
      for (const key of seen) if (!still.has(key)) seen.delete(key);
    }
  }

  function taskEnded(event: 'complete' | 'fail', task: { id: string; agentName: string; task: string }): void {
    const who = task.agentName.trim() || 'An agent';
    inbox.add(event === 'complete'
      ? news(`task:${task.id}`, [`${who} finished: `, em(cut(task.task))], 4200, true)
      : news(`task:${task.id}`, [`${who} could not finish: `, em(cut(task.task))], 5200, false));
  }

  return { sync, taskEnded };
}
