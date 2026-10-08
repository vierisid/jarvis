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

/** Why this config patch cannot be applied, or null. Only the fields present are checked. */
export function authorityConfigPatchError(body: Record<string, unknown>): string | null {
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
