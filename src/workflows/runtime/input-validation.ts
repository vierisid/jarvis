import type { PieceInputField } from './piece-input';

export function emptyInput(value: unknown): boolean {
  // Required means present. Empty collections remain valid unless the
  // property's own schema imposes a minimum length.
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/** Mirrors the engine's text/number coercions; never guesses a dynamic value. */
export function inputIssue(field: PieceInputField, value: unknown): string | null {
  if (emptyInput(value)) return field.required ? 'required input is missing' : null;
  switch (field.type) {
    case 'number':
      return (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value))
        ? null : 'expected a finite number';
    case 'boolean': return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'datetime': return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? null : 'expected a valid date/time string';
    case 'string': case 'long_text': case 'flow_ref':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? null : 'expected text';
    case 'enum':
      return field.options && !field.options.some(option => option.value === String(value))
        ? 'value is not one of the declared choices' : null;
    case 'multi_enum':
      return !Array.isArray(value) || (field.options && value.some(item => !field.options!.some(o => o.value === String(item))))
        ? 'expected a list of declared choices' : null;
    case 'json': {
      // The editor groups several properties as json. The retained source
      // type tells us which engine conversion and shape check actually apply.
      const type = field.sourceType;
      if (type === 'DYNAMIC' && (typeof value !== 'object' || Array.isArray(value))) return 'expected a dynamic property object';
      if (type === 'JSON' || type === 'OBJECT') {
        let parsed = value;
        if (typeof value === 'string') {
          try { parsed = JSON.parse(value); } catch { return 'expected valid JSON'; }
        }
        if (parsed === null || typeof parsed !== 'object') return 'expected a JSON object or array';
        if (type === 'OBJECT' && Array.isArray(parsed)) return 'expected a JSON object';
      } else if (type === 'ARRAY' && !Array.isArray(value)) {
        // arrayZipperProcessor accepts a column map only for row schemas.
        if (!field.arrayHasProperties || typeof value !== 'object') return 'expected an array';
      }
      // Files and dynamic/custom properties still need their runtime schema.
      return null;
    }
  }
}

/**
 * The same finding as `inputIssue`, worded for a person and naming the field.
 * Readiness shows this; the validator's own phrases stay for the run-time guard.
 */
export function plainInputReason(reason: string, label: string): string {
  switch (reason) {
    case 'required input is missing': return `${label}: fill in this required input`;
    case 'expected a finite number': return `Enter a number for ${label}`;
    case 'expected a boolean': return `Choose Yes or No for ${label}`;
    case 'expected a valid date/time string': return `Enter a valid date and time for ${label}`;
    case 'expected text': return `Enter text for ${label}`;
    case 'value is not one of the declared choices':
    case 'expected a list of declared choices': return `Choose one of the listed options for ${label}`;
    case 'expected valid JSON': return `Enter valid JSON for ${label}`;
    case 'expected a JSON object or array':
    case 'expected a JSON object':
    case 'expected a dynamic property object': return `${label} needs a set of named values`;
    case 'expected an array': return `${label} needs a list`;
    default: return `${label}: ${reason}`;
  }
}
