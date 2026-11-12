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
 */
import type { NotchInbox, NotchItem } from './inbox.ts';
import type { NotchPart } from './protocol.ts';

/** How often the open failures are looked at. */
export const NOTCH_FAILURE_LOOK_MS = 5000;
/** The most of a task's text one line carries. */
const LINE_CHARS = 90;

export interface NotchOpenFailure {
  /** The failure's stable identity. */
  key: string;
  /** What happened, one sentence. */
  headline: string;
}

export interface NotchNewsDeps {
  /** The failures that are open now. */
  openFailures?: () => NotchOpenFailure[];
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
      await stage.say(say, ms, ok ? { mood: 'happy', mark: 'check' } : { mood: 'worried', mark: 'fail' });
      return 'settled';
    },
  });

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
