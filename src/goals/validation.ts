import type { GoalLevel } from './types.ts';

export const GOAL_LEVELS = ['objective', 'key_result', 'milestone', 'task', 'daily_action'] as const;
export const TIME_HORIZONS = ['life', 'yearly', 'quarterly', 'monthly', 'weekly', 'daily'] as const;
const GOAL_STATUSES = ['draft', 'active', 'paused', 'completed', 'failed', 'killed'] as const;

export class GoalValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'GoalValidationError';
  }
}
export function invalid(path: string, message: string): never { throw new GoalValidationError(path, message); }
export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be an object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}.${key}`, 'is not supported');
}
export function text(value: unknown, path: string, required = true, max = 20000): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) invalid(path, 'must be a valid string');
  return value;
}
export function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(path, `must be one of ${values.join(', ')}`);
  return value as T;
}
export function number(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(path, 'is outside the permitted numeric range');
  return value;
}
export function strings(value: unknown, path: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must be an array of at most ${max} strings`);
  return value.map((entry, index) => text(entry, `${path}[${index}]`, true, 512));
}
export function epoch(value: unknown, path: string): number {
  return number(value, path, -8640000000000000, 8640000000000000, true);
}
export function timezone(value: unknown, path = 'timezone'): string {
  const zone = text(value, path, true, 100);
  if (/^[+-]/.test(zone)) invalid(path, 'must be an IANA timezone, not an offset');
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); }
  catch { invalid(path, 'must be an IANA timezone'); }
  return zone;
}
/** Strict RFC3339 at millisecond precision; never infer the host timezone or roll invalid dates. */
export function instant(value: unknown, path: string): number {
  const input = text(value, path, true, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) invalid(path, 'must be an RFC3339 timestamp with Z or an explicit offset');
  const [, y, mo, d, h, mi, s, , offset] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 ||
      (offset !== 'Z' && (offset === '-00:00' || Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) invalid(path, 'contains an invalid date, time or offset');
  return epoch(Date.parse(input), path);
}
export function nextGoalLevel(level: GoalLevel): GoalLevel | null {
  enumeration(level, GOAL_LEVELS, 'parent.level');
  return GOAL_LEVELS[GOAL_LEVELS.indexOf(level) + 1] ?? null;
}

const UPDATE_FIELDS = ['title', 'description', 'success_criteria', 'time_horizon', 'deadline', 'estimated_hours', 'authority_level', 'tags', 'dependencies', 'sort_order'];
const CREATE_FIELDS = [...UPDATE_FIELDS.filter(field => field !== 'title'), 'parent_id', 'status'];
/** Shared persistence boundary for API, tools and proposal creation. */
export function validateGoalFields(input: unknown, mode: 'create' | 'update'): Record<string, unknown> {
  const value = record(input, 'goal');
  keys(value, mode === 'create' ? CREATE_FIELDS : UPDATE_FIELDS, 'goal');
  const result = { ...value };
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const path = `goal.${key}`;
    switch (key) {
      case 'title': text(item, path); break;
      case 'description': case 'success_criteria': text(item, path, false); break;
      case 'time_horizon': enumeration(item, TIME_HORIZONS, path); break;
      case 'status': enumeration(item, GOAL_STATUSES, path); break;
      case 'parent_id': if (item !== null) text(item, path); break;
      case 'deadline': if (item !== null) epoch(item, path); break;
      case 'estimated_hours': if (item !== null) number(item, path); break;
      case 'authority_level': number(item, path, 0, 10, true); break;
      case 'sort_order': number(item, path, 0, Number.MAX_SAFE_INTEGER, true); break;
      case 'tags': case 'dependencies': result[key] = strings(item, path); break;
    }
  }
  return result;
}
