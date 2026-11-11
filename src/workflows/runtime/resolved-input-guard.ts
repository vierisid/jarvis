import { emptyInput, inputIssue } from './input-validation';
import type { PieceInputType } from './piece-input';

const TYPES: Record<string, PieceInputType> = {
  SHORT_TEXT: 'string', LONG_TEXT: 'long_text', NUMBER: 'number', CHECKBOX: 'boolean',
  DATE_TIME: 'datetime', STATIC_DROPDOWN: 'enum', STATIC_MULTI_SELECT_DROPDOWN: 'multi_enum',
};
/** Called after engine property processing, before the piece's run/trigger hook.
 * Includes omitted keys: the upstream validator only visits supplied values.
 */
export function resolvedInputIssues(
  input: Record<string, unknown>,
  props: Record<string, { type: string; required: boolean; options?: unknown }>,
  requireAuth: boolean,
  hasAuth: boolean,
  propertySettings: Record<string, { schema?: unknown }> = {},
  originalInput: Record<string, unknown> = input,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'MARKDOWN') continue;
    if (prop.type === 'DYNAMIC' && (prop.required || !emptyInput(input[name]))) {
      const schema = propertySettings[name]?.schema;
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        errors[name] = ['Dynamic properties require a resolved property schema'];
        continue;
      }
    }
    const rawOptions = (prop.options as { options?: Array<{ value: unknown; label?: string }> } | undefined)?.options;
    // Processors may normalize null row collections to [] or spread a
    // scalar dynamic input into an object. Neither supplies a missing value
    // nor makes that original dynamic value a property map.
    const value = emptyInput(originalInput[name]) || prop.type === 'DYNAMIC' ? originalInput[name] : input[name];
    const reason = inputIssue({ name, label: name, required: prop.required, sourceType: prop.type, type: TYPES[prop.type] ?? 'json',
      options: Array.isArray(rawOptions) ? rawOptions.map(o => ({ value: String(o.value), label: o.label ?? '' })) : undefined,
    }, value);
    if (reason) errors[name] = [reason];
  }
  if (requireAuth && hasAuth && emptyInput(input.auth)) errors.auth = ['A resolved connection is required'];
  return errors;
}

/**
 * A plain sentence when a date input holds a value that is not a date, else
 * null. The engine's date processor turns such a value into nothing, so the
 * failure would otherwise read as a cut-off JSON fragment of the property map.
 * The value itself is never echoed (#1336): it can come from trigger data, and
 * the step's failure text reaches run history and the model. Only its kind is.
 */
export function invalidDateMessage(
  errors: Record<string, unknown>,
  props: Record<string, { type: string; displayName?: string }>,
  originalInput: Record<string, unknown>,
  actionName: string,
): string | null {
  for (const name of Object.keys(errors)) {
    if (props[name]?.type !== 'DATE_TIME') continue;
    const raw = originalInput[name];
    if (emptyInput(raw)) continue;
    const what = actionName === 'delay_until' ? 'The date to wait until' : `The date in "${props[name]?.displayName ?? name}"`;
    return `${what} is not a valid date. It got ${valueKind(raw)}. Use a date and time such as 2026-01-31T09:00:00Z.`;
  }
  return null;
}

function valueKind(value: unknown): string {
  if (typeof value === 'string') return 'text that is not a date';
  if (typeof value === 'number') return 'a number that is not a date';
  if (typeof value === 'boolean') return 'true or false';
  if (Array.isArray(value)) return 'a list';
  return 'an object';
}
