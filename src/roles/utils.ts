/**
 * Utility functions for working with roles
 */

import type { RoleDefinition } from './types.ts';
import type { ActionCategory } from './authority.ts';
import { canPerform, listAllowedActions } from './authority.ts';

/**
 * Find roles that can perform a specific action
 */
export function findRolesWithPermission(
  roles: Map<string, RoleDefinition>,
  action: ActionCategory
): RoleDefinition[] {
  const result: RoleDefinition[] = [];

  for (const role of roles.values()) {
    if (canPerform(role, action)) {
      result.push(role);
    }
  }

  return result.sort((a, b) => a.authority_level - b.authority_level);
}

/**
 * Find the least privileged role that can perform an action
 */
export function findMinimalRoleForAction(
  roles: Map<string, RoleDefinition>,
  action: ActionCategory
): RoleDefinition | null {
  const capable = findRolesWithPermission(roles, action);
  return capable.length > 0 ? capable[0]! : null;
}

/**
 * Compare two roles and show permission differences
 */
export function compareRoles(
  role1: RoleDefinition,
  role2: RoleDefinition
): {
  onlyInRole1: ActionCategory[];
  onlyInRole2: ActionCategory[];
  inBoth: ActionCategory[];
} {
  const actions1 = new Set(listAllowedActions(role1));
  const actions2 = new Set(listAllowedActions(role2));

  const onlyInRole1: ActionCategory[] = [];
  const onlyInRole2: ActionCategory[] = [];
  const inBoth: ActionCategory[] = [];

  for (const action of actions1) {
    if (actions2.has(action)) {
      inBoth.push(action);
    } else {
      onlyInRole1.push(action);
    }
  }

  for (const action of actions2) {
    if (!actions1.has(action)) {
      onlyInRole2.push(action);
    }
  }

  return { onlyInRole1, onlyInRole2, inBoth };
}

/**
 * Get a summary of role hierarchy based on authority levels
 */
export function getRoleHierarchy(roles: Map<string, RoleDefinition>): string {
  const sorted = Array.from(roles.values()).sort(
    (a, b) => b.authority_level - a.authority_level
  );

  const lines: string[] = [];
  let currentLevel = -1;

  for (const role of sorted) {
    if (role.authority_level !== currentLevel) {
      currentLevel = role.authority_level;
      lines.push(`\nLevel ${currentLevel}:`);
    }
    lines.push(`  - ${role.name} (${role.id})`);
  }

  return lines.join('\n').trim();
}

/**
 * Check if a role can spawn a specific sub-role
 */
export function canSpawnRole(
  role: RoleDefinition,
  subRoleId: string
): boolean {
  return (role.sub_roles ?? []).some(sr => sr.role_id === subRoleId);
}

/**
 * Get all roles that can spawn a specific role
 */
export function findSpawnersOfRole(
  roles: Map<string, RoleDefinition>,
  targetRoleId: string
): RoleDefinition[] {
  const spawners: RoleDefinition[] = [];

  for (const role of roles.values()) {
    if (canSpawnRole(role, targetRoleId)) {
      spawners.push(role);
    }
  }

  return spawners;
}

/**
 * Validate role hierarchy (check for circular dependencies)
 */
export function validateRoleHierarchy(
  roles: Map<string, RoleDefinition>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [id, role] of roles) {
    // Check if sub-roles exist
    for (const subRole of role.sub_roles ?? []) {
      if (!roles.has(subRole.role_id)) {
        errors.push(
          `Role '${id}' references non-existent sub-role '${subRole.role_id}'`
        );
      }

      // Check for self-spawning
      if (subRole.role_id === id) {
        errors.push(`Role '${id}' attempts to spawn itself`);
      }

      // Check authority levels (parent should have higher authority)
      const subRoleDef = roles.get(subRole.role_id);
      if (subRoleDef && subRoleDef.authority_level > role.authority_level) {
        errors.push(
          `Role '${id}' (level ${role.authority_level}) attempts to spawn ` +
          `'${subRole.role_id}' (level ${subRoleDef.authority_level}) with higher authority`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get statistics about a role collection
 */
export function getRoleStats(roles: Map<string, RoleDefinition>): {
  totalRoles: number;
  averageAuthorityLevel: number;
  totalTools: number;
  totalKPIs: number;
  rolesWithSubRoles: number;
  authorityDistribution: Record<number, number>;
} {
  let totalAuthority = 0;
  let totalTools = 0;
  let totalKPIs = 0;
  let rolesWithSubRoles = 0;
  const authorityDistribution: Record<number, number> = {};

  for (const role of roles.values()) {
    totalAuthority += role.authority_level;
    totalTools += role.tools.length;
    totalKPIs += role.kpis?.length ?? 0;

    if ((role.sub_roles?.length ?? 0) > 0) {
      rolesWithSubRoles++;
    }

    authorityDistribution[role.authority_level] =
      (authorityDistribution[role.authority_level] || 0) + 1;
  }

  return {
    totalRoles: roles.size,
    averageAuthorityLevel: roles.size > 0 ? totalAuthority / roles.size : 0,
    totalTools,
    totalKPIs,
    rolesWithSubRoles,
    authorityDistribution,
  };
}
