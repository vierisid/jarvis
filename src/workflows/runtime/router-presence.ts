/** Presence predicates deliberately inspect absence. Give only their complete
 * expression operands a null fallback; all other resolution stays strict.
 * Transform a copy at execution time so saved workflows keep their intent.
 */
export function withPresenceFallbacks(settings: Record<string, any>): Record<string, any> {
  return {
    ...settings,
    branches: settings.branches?.map((branch: Record<string, any>) => ({
      ...branch,
      conditions: branch.conditions?.map((group: Array<Record<string, any>>) => group.map(condition => {
        if (!['EXISTS', 'DOES_NOT_EXIST'].includes(condition.operator) || typeof condition.firstValue !== 'string') return condition;
        const match = /^\{\{(.*?)\}\}$/.exec(condition.firstValue);
        if (!match || (/^connections(?:\.|\[|$)/).test(match[1]!.trim()) || match[1]!.includes('{{') || match[1]!.includes('}}')) return condition;
        return { ...condition, firstValue: `{{(${match[1]}) ?? null}}` };
      })),
    })),
  };
}
