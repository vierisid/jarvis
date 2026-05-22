/**
 * Pebble answer store — small in-memory LRU keeping the most recent N
 * pebble LLM responses keyed by UUID. Lets the user open a dedicated
 * markdown panel ("open full ↗") when a response is too long to read in
 * the speaking bubble.
 *
 * Not persisted — the bubble is ephemeral anyway, and the next response
 * supersedes the previous one in the user's mental model. 25-entry cap
 * is plenty for a working session without growing memory unbounded.
 */

export type AnswerRecord = {
  id: string;
  prompt: string;
  response: string;
  created_at: number;
};

const MAX_ANSWERS = 25;

class AnswerStore {
  private items = new Map<string, AnswerRecord>();

  register(prompt: string, response: string): AnswerRecord {
    const id = crypto.randomUUID();
    const record: AnswerRecord = {
      id,
      prompt,
      response,
      created_at: Date.now(),
    };
    this.items.set(id, record);
    // LRU eviction — drop the oldest entry (first inserted) once we cross
    // the cap. Map iteration is insertion order in JS.
    while (this.items.size > MAX_ANSWERS) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.items.delete(oldestKey);
    }
    return record;
  }

  get(id: string): AnswerRecord | undefined {
    return this.items.get(id);
  }

  /** Most recent answer, used as a fallback when the user opens "last answer". */
  latest(): AnswerRecord | undefined {
    let latest: AnswerRecord | undefined;
    for (const r of this.items.values()) {
      if (!latest || r.created_at > latest.created_at) latest = r;
    }
    return latest;
  }
}

export const pebbleAnswerStore = new AnswerStore();
