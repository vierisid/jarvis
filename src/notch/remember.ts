/**
 * "Remember that Anna prefers calls."
 *
 * One sentence, written to memory as one fact, and read back from memory so
 * what the notch says is what was stored, not what was meant to be. It does
 * not go through the agent: the agent's own memory extraction would write the
 * same words a second time, under whatever name it chose.
 *
 * The sentence is split into who, what and the rest by one small model call.
 * Nothing is guessed when that fails, when the model adds words that were not
 * said, or when the name fits more than one person: then nothing is saved and
 * the notch says so.
 *
 * The fact is written as confirmed, with the person's own sentence as its
 * evidence and "you told me" as its source: they said it, to Jarvis, on
 * purpose. That source is what the Memory room shows beside it.
 */
import type { NotchRemembered } from './asks.ts';

/** Where a fact the person told the notch came from, as the Memory room shows it. */
export const NOTCH_TOLD_SOURCE = 'you told me';

export const NOTCH_ENTITY_TYPES = ['person', 'project', 'tool', 'place', 'concept', 'event'] as const;
export type NotchEntityType = (typeof NOTCH_ENTITY_TYPES)[number];

export interface NotchRememberedParts {
  subject: string;
  type: NotchEntityType;
  /** It is about the person speaking. */
  me: boolean;
  predicate: string;
  object: string;
}

export interface NotchRememberDeps {
  /** One small model call: the messages in, the reply's text out. */
  ask(messages: { role: 'system' | 'user'; content: string }[]): Promise<string>;
  /** Every name memory knows. */
  entities(): { id: string; name: string }[];
  /** Matches a name the way the Memory room does: one, several, or none. */
  match(entities: { id: string; name: string }[], name: string): { entity: { id: string; name: string } } | { ambiguous: number } | null;
  /** The person's own entry in memory, when they have one. */
  owner(): { id: string; name: string } | null;
  createEntity(type: NotchEntityType, name: string): { id: string; name: string };
  /** Writes the fact as confirmed and comes back with its id. */
  createFact(subjectId: string, predicate: string, object: string, evidence: { source: string; sourceRef: string; quote: string }): { id: string };
  /** The fact as memory now holds it. */
  read(factId: string): { subject: string; predicate: string; object: string } | null;
  log?: (line: string) => void;
}

export const NOTCH_REMEMBER_SYSTEM = [
  'You split one sentence a person wants remembered into a single fact.',
  'Answer with one JSON object and nothing else:',
  '{"subject": string, "type": "person" | "project" | "tool" | "place" | "concept" | "event", "me": boolean, "predicate": string, "object": string}',
  'subject: who or what the fact is about, as the name used in the sentence.',
  'me: true when the fact is about the person speaking (I, me, my). Then subject is "me".',
  'predicate: a short verb phrase in the third person, such as "prefers", "is", "works at", "has a birthday on".',
  'object: the rest of the fact.',
  'Use only words from the sentence. Add nothing, explain nothing.',
].join('\n');

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;

/** Reads the model's reply. Null for anything that is not exactly the object asked for. */
export function parseRemembered(raw: string): NotchRememberedParts | null {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const subject = text(data.subject, 120), predicate = text(data.predicate, 120), object = text(data.object, 1000);
  if (!subject || !predicate || !object) return null;
  const type = NOTCH_ENTITY_TYPES.find((known) => known === data.type) ?? 'concept';
  return { subject, type, me: data.me === true, predicate, object };
}

const fold = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether every word of the fact was in the sentence. A model that adds a
 * surname, a date or a reason is writing its own memory, not the person's.
 */
export function onlySaidWords(parts: NotchRememberedParts, sentence: string): boolean {
  const said = new Set(fold(sentence).split(' '));
  const used = `${parts.me ? '' : parts.subject} ${parts.object}`;
  return fold(used).split(' ').filter(Boolean).every((word) => said.has(word));
}

export function createNotchRemember(deps: NotchRememberDeps): (what: string, sentence: string, askId: string) => Promise<NotchRemembered> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const no = (why: string): NotchRemembered => ({ ok: false, why: `${why} Nothing was saved.` });
  return async (what, sentence, askId) => {
    let raw: string;
    try {
      raw = await deps.ask([{ role: 'system', content: NOTCH_REMEMBER_SYSTEM }, { role: 'user', content: what }]);
    } catch (error) {
      log(`[notch] the sentence to remember could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return no('I could not work out what to remember.');
    }
    const parts = parseRemembered(raw);
    if (!parts || !onlySaidWords(parts, what)) return no('I could not work out what to remember.');

    let subject: { id: string; name: string };
    if (parts.me) {
      subject = deps.owner() ?? deps.createEntity('person', 'The owner');
    } else {
      const found = deps.match(deps.entities(), parts.subject);
      if (found && 'ambiguous' in found) return no(`I know more than one ${parts.subject}. Say the full name.`);
      subject = found ? found.entity : deps.createEntity(parts.type, parts.subject);
    }
    const fact = deps.createFact(subject.id, parts.predicate, parts.object, { source: NOTCH_TOLD_SOURCE, sourceRef: `notch:${askId}`, quote: sentence });
    const stored = deps.read(fact.id);
    if (!stored) return no('It did not reach memory.');
    return {
      ok: true,
      said: `Remembered: ${stored.subject} ${stored.predicate} ${stored.object}.`,
      understood: `${stored.subject} · ${stored.predicate} · ${stored.object}`,
    };
  };
}
