import type { AuthorityConfig } from './engine.ts';
import type { ActionCategory } from '../roles/authority.ts';

/**
 * Body shape accepted by `/api/authority/config/quick-override`.
 *
 * `role_id` is optional — when present, the override applies only to
 * agents in that role; when absent, it applies globally.
 */
export type QuickOverrideRequest = {
  action: ActionCategory;
  allow: boolean;
  role_id?: string;
};

/**
 * Merge a quick-override decision into an AuthorityConfig.
 *
 * Insert-or-update by `(action, role_id)` tuple. Idempotent across
 * repeated grants — calling twice with the same body produces the same
 * config (we update the existing override row instead of appending a
 * duplicate). `requires_approval` is forced to false because a quick
 * override is the user explicitly granting blanket allow/deny without
 * the approval card path.
 *
 * Pure: returns a new config; does not mutate the input. Both the route
 * handler in `api-routes.ts` and the test in `quick-override.test.ts`
 * import this so they cannot drift.
 */
export function applyQuickOverride(
  cfg: AuthorityConfig,
  body: QuickOverrideRequest,
): AuthorityConfig {
  const overrides = [...(cfg.overrides ?? [])];
  const idx = overrides.findIndex(
    (o) =>
      o.action === body.action &&
      ((o as { role_id?: string }).role_id ?? undefined) === (body.role_id ?? undefined),
  );
  const next = {
    action: body.action,
    ...(body.role_id ? { role_id: body.role_id } : {}),
    allowed: body.allow,
    requires_approval: false,
  };
  if (idx >= 0) overrides[idx] = next as typeof overrides[number];
  else overrides.push(next as typeof overrides[number]);
  return { ...cfg, overrides };
}
