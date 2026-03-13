import type { RoleDefinition } from './types.ts';

export type ActionCategory =
  | 'read_data' | 'write_data' | 'delete_data'
  | 'send_message' | 'send_email'
  | 'execute_command' | 'install_software'
  | 'make_payment' | 'modify_settings'
  | 'spawn_agent' | 'terminate_agent'
  | 'access_browser' | 'control_app';

/**
 * Maps action categories to minimum required authority level
 *
 * Authority levels:
 * - 1-2: Read only (read_data)
 * - 3-4: Read + write + send messages (write_data, send_message)
 * - 5-6: + execute commands, control apps (execute_command, access_browser, control_app)
 * - 1+: spawn agents (spawn_agent) — always allowed
 * - 7-8: + send email, install software (send_email, install_software)
 * - 9-10: Full access including payments and settings (make_payment, modify_settings, delete_data, terminate_agent)
 */
export const AUTHORITY_REQUIREMENTS: Record<ActionCategory, number> = {
  // Level 1-2: Read only
  'read_data': 1,

  // Level 3-4: Read + write + send messages
  'write_data': 3,
  'send_message': 3,

  // Level 5-6: + execute commands, control apps
  'execute_command': 5,
  'access_browser': 5,
  'control_app': 5,

  // Level 7-8: + spawn agents, send email, install software
  'spawn_agent': 1,
  'send_email': 7,
  'install_software': 7,

  // Level 9-10: Full access including payments and settings
  'make_payment': 9,
  'modify_settings': 9,
  'delete_data': 9,
  'terminate_agent': 9,
};

/**
 * Check if a role can perform a specific action
 */
export function canPerform(role: RoleDefinition, action: ActionCategory): boolean {
  const requiredLevel = AUTHORITY_REQUIREMENTS[action];
  return role.authority_level >= requiredLevel;
}

/**
 * Get the required authority level for an action
 */
export function getRequiredLevel(action: ActionCategory): number {
  return AUTHORITY_REQUIREMENTS[action];
}

/**
 * List all actions a role is allowed to perform
 */
export function listAllowedActions(role: RoleDefinition): ActionCategory[] {
  const actions = Object.keys(AUTHORITY_REQUIREMENTS) as ActionCategory[];
  return actions.filter(action => canPerform(role, action));
}

/**
 * List all actions a role is NOT allowed to perform
 */
export function listDeniedActions(role: RoleDefinition): ActionCategory[] {
  const actions = Object.keys(AUTHORITY_REQUIREMENTS) as ActionCategory[];
  return actions.filter(action => !canPerform(role, action));
}

/**
 * Get a human-readable description of what an authority level allows
 */
export function describeAuthorityLevel(level: number): string {
  if (level < 1 || level > 10) {
    return 'Invalid authority level';
  }

  if (level <= 2) {
    return 'Read-only access. Can read data but cannot modify anything.';
  }

  if (level <= 4) {
    return 'Read and write access. Can read/write data and send messages.';
  }

  if (level <= 6) {
    return 'Command execution. Can execute commands, control apps, and access browser.';
  }

  if (level <= 8) {
    return 'Agent management. Can spawn agents, send emails, and install software.';
  }

  return 'Full access. Can make payments, modify settings, delete data, and terminate agents.';
}

/**
 * Get a summary of a role's permissions
 */
export function getRolePermissionsSummary(role: RoleDefinition): {
  level: number;
  description: string;
  allowed: ActionCategory[];
  denied: ActionCategory[];
} {
  return {
    level: role.authority_level,
    description: describeAuthorityLevel(role.authority_level),
    allowed: listAllowedActions(role),
    denied: listDeniedActions(role),
  };
}
