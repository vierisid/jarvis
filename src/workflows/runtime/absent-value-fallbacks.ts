/**
 * The engine refuses a reference that resolves to nothing ("supply a value or
 * an explicit fallback"). A step whose whole purpose is the fallback would be
 * refused by that rule, so it is lifted for the named inputs below and nowhere
 * else: "Use Default Value if Input is Empty" takes a missing reference as
 * empty and returns its default.
 *
 * Only an input that is exactly one `{{ reference }}` is touched. Text with a
 * reference inside it, connection references and every other input keep the
 * strict rule. Like `withPresenceFallbacks`, this rewrites a copy at execution
 * time, so the saved workflow keeps its intent.
 */
const ABSENT_AS_EMPTY: Readonly<Record<string, readonly string[]>> = {
  '@activepieces/piece-text-helper/defaultValue': ['value'],
};

export function withAbsentValueFallbacks(pieceName: string, actionName: string, input: unknown): unknown {
  const props = ABSENT_AS_EMPTY[`${pieceName}/${actionName}`];
  if (!props || input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const prop of props) {
    const value = copy[prop];
    if (typeof value !== 'string') continue;
    const match = /^\{\{(.*?)\}\}$/.exec(value);
    if (!match || /^connections(?:\.|\[|$)/.test(match[1]!.trim()) || match[1]!.includes('{{') || match[1]!.includes('}}')) continue;
    copy[prop] = `{{(${match[1]}) ?? ''}}`;
  }
  return copy;
}
