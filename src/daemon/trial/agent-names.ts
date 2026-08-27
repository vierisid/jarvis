/**
 * What the founder's two sub-agents are CALLED.
 *
 * The trial spawns two sub-agents inside the conducted hour, both from a
 * research specialist, so both arrived in the agent strip as `Research
 * Analyst`. In today's log they are genuinely distinct runs with distinct
 * tasks. To a founder looking at a 290px panel they are one name written
 * twice, one of them finished half an hour ago, which is indistinguishable
 * from a single agent that never started. That is exactly the wrong reading
 * and it is the reading three sessions took.
 *
 * So each one is named for what it is for. The finale carries the founder's
 * own question, because the question is theirs and it is the only label that
 * could not belong to any other run on any other machine.
 */

/** The one that reads their folder, at the `files` beat. */
export const READER_AGENT_NAME = 'Reading your files';

/**
 * How much of their question fits on a row before it stops being readable.
 *
 * Set from the real one rather than from a round number: the question the
 * walked arcs produce, "What do the other studio schedulers charge a seat?",
 * is forty-nine characters with its question mark off, and a cap that cut it
 * would have proved the point about names and then failed on the only example
 * anybody has.
 */
const QUESTION_MAX = 56;

/**
 * The finale's agent, named after the thing they asked.
 *
 * Trailing punctuation goes because a name is not a sentence, and a question
 * longer than a row is cut at a word boundary rather than mid-word, since a
 * founder reading `What do the other studio schedu` learns less than one
 * reading `What do the other studio…`.
 */
export function researchAgentName(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim().replace(/[?.!,;:]+$/, '');
  if (!clean) return 'Your question';
  if (clean.length <= QUESTION_MAX) return clean;
  const cut = clean.slice(0, QUESTION_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > QUESTION_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
