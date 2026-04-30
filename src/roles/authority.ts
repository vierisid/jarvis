import type { RoleDefinition } from './types.ts';

export type ActionCategory =
  | 'read_data' | 'write_data' | 'delete_data'
  | 'send_message' | 'send_email'
  | 'execute_command' | 'install_software'
  | 'make_payment' | 'modify_settings'
  | 'spawn_agent' | 'terminate_agent'
  | 'access_browser' | 'control_app';

/**
 * High-level impact classification used by the dashboard ApprovalCard.
 * Mirrors the VOICE_SCHEMA.md contract from the v2 redesign.
 *   read        — observes state, no side effects
 *   write       — mutates local state (files, DB, agents, messages)
 *   external    — reaches off-device (email, browser navigation)
 *   destructive — irreversible or costly (delete, payment, install, terminate, exec)
 */
export type Impact = 'read' | 'write' | 'external' | 'destructive';

export const IMPACT_MAP: Record<ActionCategory, Impact> = {
  read_data:        'read',
  write_data:       'write',
  send_message:     'write',
  spawn_agent:      'write',
  control_app:      'write',
  access_browser:   'external',
  send_email:       'external',
  execute_command:  'destructive',
  install_software: 'destructive',
  make_payment:     'destructive',
  modify_settings:  'destructive',
  delete_data:      'destructive',
  terminate_agent:  'destructive',
};

export function impactFromCategory(category: ActionCategory): Impact {
  return IMPACT_MAP[category];
}

/**
 * Minimum classifier confidence required to resolve a non-destructive
 * approval by voice. Below this, we ask the user to repeat or click.
 *
 * 0.85 sits above STT's typical "noisy environment" output (~0.6–0.8) but
 * below confident clean-input output (~0.9+). Tunable; raise if voice
 * approvals are misfiring, lower if confident "yes"es are being rejected.
 */
export const VOICE_APPROVAL_CONFIDENCE_FLOOR = 0.85;

/**
 * Outcome of evaluating whether a voice "approve/cancel" should resolve a
 * pending approval, refuse it (clarify), or fall through.
 *
 *   resolve  — confidence is high enough and the action is safe enough
 *              for voice resolution; proceed with approve/deny.
 *   clarify  — voice resolution refused; emit a clarifier card asking
 *              the user to either repeat (low confidence) or click
 *              (destructive impact). The pending approval STAYS in the
 *              queue and can be resolved via the dashboard.
 */
export type VoiceApprovalGateOutcome =
  | { kind: 'resolve' }
  | { kind: 'clarify'; reason: 'destructive_impact' | 'low_confidence'; message: string };

/**
 * Pure decision: should a voice approve/cancel be allowed to resolve an
 * approval with the given category and STT confidence?
 *
 * Two-tier safety net:
 *   1. Destructive impacts (make_payment, delete_data, terminate_agent,
 *      execute_command, install_software, modify_settings) NEVER resolve
 *      by voice. A single misheard syllable could trigger a payment;
 *      the dashboard click is the only authoritative path.
 *   2. Non-destructive impacts require confidence ≥ 0.85. STT mishears,
 *      podcasts, third parties saying "yes" all hit this gate.
 *
 * Returning `clarify` is intentionally not the same as falling through —
 * the caller emits a clarifier card so the user knows the spoken
 * resolution was heard but suppressed (instead of the resolution silently
 * doing nothing).
 *
 * Exported for unit testing; this is the regression boundary for the
 * "voice approves a destructive action by misheard 'yes'" failure mode.
 */
export function gateVoiceApprovalResolution(
  category: ActionCategory,
  confidence: number,
): VoiceApprovalGateOutcome {
  const impact = IMPACT_MAP[category];
  if (impact === 'destructive') {
    return {
      kind: 'clarify',
      reason: 'destructive_impact',
      message: 'This action requires dashboard confirmation. Please click the approval card.',
    };
  }
  if (confidence < VOICE_APPROVAL_CONFIDENCE_FLOOR) {
    return {
      kind: 'clarify',
      reason: 'low_confidence',
      message: "Couldn't confirm clearly. Please repeat, or click the approval card.",
    };
  }
  return { kind: 'resolve' };
}

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
