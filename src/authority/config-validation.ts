/**
 * Q-08: an Authority config change is checked before it is applied. A level
 * that is not a number used to slip through `POST /api/authority/config`, and
 * the engine read it as "every level check passes" for every agent and for
 * every workflow.
 */
import { AUTHORITY_REQUIREMENTS, type ActionCategory } from '../roles/authority.ts';

const CATEGORIES = new Set(Object.keys(AUTHORITY_REQUIREMENTS));
const CONDITIONS = new Set(['time_range', 'tool_name', 'always']);
const EFFECTS = new Set(['allow', 'deny', 'require_approval']);

export function isActionCategory(value: unknown): value is ActionCategory {
  return typeof value === 'string' && CATEGORIES.has(value);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isHour = (value: unknown, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/**
 * Why this time-range rule's hours are not usable, or null. The window runs
 * from `start_hour` to `end_hour` (whole hours, 0 to 23; an end of 24 means
 * the end of the day) and wraps past midnight when it ends before it starts.
 */
export function contextRuleParamsError(rule: { condition?: unknown; params?: unknown }): string | null {
  const params = isObject(rule.params) ? rule.params : {};
  if (rule.condition === 'time_range') {
    if (params.start_hour !== undefined && !isHour(params.start_hour, 23)) return 'start_hour must be a whole hour from 0 to 23';
    if (params.end_hour !== undefined && !isHour(params.end_hour, 24)) return 'end_hour must be a whole hour from 0 to 23 (24 means the end of the day)';
  }
  if (rule.condition === 'tool_name' && params.tool_name !== undefined && (typeof params.tool_name !== 'string' || !params.tool_name.trim())) {
    return 'tool_name must be the name of a tool';
  }
  return null;
}

/** The roles an override can name: letters, digits and - _ . : only, at most 64 characters. */
export const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;

/** Why a background-agent restriction cannot be saved, or null. */
export function backgroundPatchError(background: unknown): string | null {
  if (!isObject(background)) return 'background must be an object';
  if (background.governed_categories !== undefined
    && (!Array.isArray(background.governed_categories) || !background.governed_categories.every(isActionCategory))) {
    return 'background.governed_categories must be a list of known action categories';
  }
  if (background.level_cap !== undefined
    && (typeof background.level_cap !== 'number' || !Number.isInteger(background.level_cap) || background.level_cap < 1 || background.level_cap > 10)) {
    return 'background.level_cap must be a whole number from 1 to 10';
  }
  return null;
}

/**
 * Why this quick override cannot be applied, or null. `role_id` is optional and,
 * when present, a role name: a value of any other kind used to be saved and then
 * broke every full-config save made after it.
 */
export function quickOverrideError(body: { action?: unknown; allow?: unknown; role_id?: unknown }): string | null {
  if (body.role_id !== undefined && body.role_id !== null && (typeof body.role_id !== 'string' || !ROLE_ID_PATTERN.test(body.role_id))) {
    return 'role_id must be a role name: letters, numbers and - _ . : only, at most 64 characters';
  }
  return null;
}

/**
 * What is wrong in a config that is already saved. A saved config is never
 * refused: the engine reads each of these as its clamped or default value (an
 * hour outside 0 to 24 is clamped, an unknown background category is ignored).
 * This is how they are reported.
 */
export function authorityConfigWarnings(config: {
  context_rules?: unknown; overrides?: unknown; background?: unknown;
}): string[] {
  const warnings: string[] = [];
  if (Array.isArray(config.context_rules)) {
    for (const rule of config.context_rules) {
      if (!isObject(rule)) { warnings.push('A saved context rule is not readable and is ignored.'); continue; }
      const problem = contextRuleParamsError(rule);
      if (problem) warnings.push(`Context rule "${String(rule.id)}": ${problem}. It is read with the nearest valid value.`);
    }
  }
  if (Array.isArray(config.overrides)) {
    for (const override of config.overrides) {
      if (isObject(override) && override.role_id !== undefined && typeof override.role_id !== 'string') {
        warnings.push(`An override for ${String(override.action)} names a role that is not text, so it matches no role.`);
      }
    }
  }
  if (isObject(config.background)) {
    const problem = backgroundPatchError(config.background);
    if (problem) warnings.push(`${problem}. It is read with the nearest valid value.`);
  }
  return warnings;
}

/** Why this config patch cannot be applied, or null. Only the fields present are checked.
 * A context rule already saved unchanged is not checked again, so a bad rule from an
 * earlier version does not block saving anything else (`current` is the saved rules). */
export function authorityConfigPatchError(body: Record<string, unknown>, current?: { context_rules?: readonly unknown[] }): string | null {
  if (body.default_level !== undefined) {
    const level = body.default_level;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 10) {
      return 'default_level must be a whole number from 0 to 10';
    }
  }
  if (body.governed_categories !== undefined) {
    if (!Array.isArray(body.governed_categories) || !body.governed_categories.every(isActionCategory)) {
      return 'governed_categories must be a list of known action categories';
    }
  }
  if (body.overrides !== undefined) {
    if (!Array.isArray(body.overrides)) return 'overrides must be a list';
    for (const override of body.overrides) {
      if (!isObject(override) || !isActionCategory(override.action) || typeof override.allowed !== 'boolean'
        || (override.requires_approval !== undefined && typeof override.requires_approval !== 'boolean')
        || (override.role_id !== undefined && typeof override.role_id !== 'string')) {
        return 'each override needs a known action, allowed true or false, and optionally requires_approval and role_id';
      }
    }
  }
  if (body.context_rules !== undefined) {
    if (!Array.isArray(body.context_rules)) return 'context_rules must be a list';
    for (const rule of body.context_rules) {
      if (!isObject(rule) || typeof rule.id !== 'string' || !isActionCategory(rule.action)
        || typeof rule.condition !== 'string' || !CONDITIONS.has(rule.condition)
        || typeof rule.effect !== 'string' || !EFFECTS.has(rule.effect)
        || typeof rule.description !== 'string' || !isObject(rule.params)) {
        return 'each context rule needs an id, a known action, a condition, an effect, a description and params';
      }
      const unchanged = current?.context_rules?.some(saved => JSON.stringify(saved) === JSON.stringify(rule));
      const problem = unchanged ? null : contextRuleParamsError(rule);
      if (problem) return `Context rule "${rule.id}": ${problem}`;
    }
  }
  if (body.learning !== undefined) {
    const learning = body.learning;
    if (!isObject(learning)
      || (learning.enabled !== undefined && typeof learning.enabled !== 'boolean')
      || (learning.suggest_threshold !== undefined
        && (typeof learning.suggest_threshold !== 'number' || !Number.isInteger(learning.suggest_threshold) || learning.suggest_threshold < 1))) {
      return 'learning takes enabled (true or false) and suggest_threshold (a whole number of at least 1)';
    }
  }
  return null;
}
