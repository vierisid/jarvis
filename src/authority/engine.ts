/**
 * Authority Engine — Central decision maker for tool execution authorization.
 *
 * Decision order:
 * 1. Temporary grants (parent escalation) → allow
 * 2. Per-action overrides for this role → explicit allow/deny
 * 3. Context rules (time-based, tool-name-based) → allow/deny/require_approval
 * 4. Numeric level check: level >= AUTHORITY_REQUIREMENTS[action]
 * 5. Governed category check: if allowed but governed → requiresApproval
 */

import type { ActionCategory } from '../roles/authority.ts';
import { AUTHORITY_REQUIREMENTS } from '../roles/authority.ts';

export type PerActionOverride = {
  action: ActionCategory;
  role_id?: string;           // if unset, applies globally
  allowed: boolean;           // true = always allow, false = always deny
  requires_approval?: boolean; // if true, soft gate even when allowed
};

export type ContextRule = {
  id: string;
  action: ActionCategory;
  condition: 'time_range' | 'tool_name' | 'always';
  params: Record<string, unknown>;
  effect: 'allow' | 'deny' | 'require_approval';
  description: string;
};

export type AuthorityConfig = {
  default_level: number;
  governed_categories: ActionCategory[];
  overrides: PerActionOverride[];
  context_rules: ContextRule[];
  learning: {
    enabled: boolean;
    suggest_threshold: number;
  };
  emergency_state: 'normal' | 'paused' | 'killed';
};

export type AuthorityDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  actionCategory: ActionCategory;
  contextRule?: string;
};

export type AuthorityCheckParams = {
  agentId: string;
  agentAuthorityLevel: number;
  agentRoleId: string;
  toolName: string;
  toolCategory: string;
  actionCategory: ActionCategory;
  temporaryGrants: Map<string, ActionCategory[]>;
};

export class AuthorityEngine {
  private config: AuthorityConfig;

  constructor(config: AuthorityConfig) {
    this.config = config;
  }

  /**
   * Core decision function — determines if an action is allowed.
   */
  checkAuthority(params: AuthorityCheckParams): AuthorityDecision {
    const { agentId, agentAuthorityLevel, agentRoleId, toolName, actionCategory, temporaryGrants } = params;

    // 1. Check temporary grants (parent escalation)
    const grants = temporaryGrants.get(agentId);
    if (grants?.includes(actionCategory)) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: 'Temporarily granted by parent agent',
        actionCategory,
      };
    }

    // 2. Check per-action overrides for this role
    const override = this.findOverride(actionCategory, agentRoleId);
    if (override) {
      if (!override.allowed) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Explicitly denied by override for ${agentRoleId || 'global'}`,
          actionCategory,
        };
      }
      if (override.requires_approval) {
        return {
          allowed: true,
          requiresApproval: true,
          reason: `Override requires approval for ${actionCategory}`,
          actionCategory,
        };
      }
      return {
        allowed: true,
        requiresApproval: false,
        reason: `Explicitly allowed by override for ${agentRoleId || 'global'}`,
        actionCategory,
      };
    }

    // 3. Check context rules
    const contextResult = this.evaluateContextRules(actionCategory, toolName);
    if (contextResult) {
      if (contextResult.effect === 'deny') {
        return {
          allowed: false,
          requiresApproval: false,
          reason: contextResult.description,
          actionCategory,
          contextRule: contextResult.id,
        };
      }
      if (contextResult.effect === 'require_approval') {
        return {
          allowed: true,
          requiresApproval: true,
          reason: contextResult.description,
          actionCategory,
          contextRule: contextResult.id,
        };
      }
      if (contextResult.effect === 'allow') {
        return {
          allowed: true,
          requiresApproval: false,
          reason: contextResult.description,
          actionCategory,
          contextRule: contextResult.id,
        };
      }
    }

    // 4. Numeric level check
    // Use the higher of the agent's role level and the config's default_level,
    // so the dashboard authority slider acts as the effective authority floor.
    const effectiveLevel = Math.max(agentAuthorityLevel, this.config.default_level);
    const requiredLevel = AUTHORITY_REQUIREMENTS[actionCategory];
    if (effectiveLevel < requiredLevel) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Authority level ${effectiveLevel} is below required ${requiredLevel} for ${actionCategory}`,
        actionCategory,
      };
    }

    // 5. Governed category check — if level is sufficient but action is governed, require approval
    if (this.config.governed_categories.includes(actionCategory)) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `${actionCategory} is a governed action requiring user approval`,
        actionCategory,
      };
    }

    // Allowed without approval
    return {
      allowed: true,
      requiresApproval: false,
      reason: `Authority level ${effectiveLevel} meets requirement ${requiredLevel}`,
      actionCategory,
    };
  }

  /**
   * Generate human-readable authority rules for the system prompt.
   */
  describeRulesForAgent(authorityLevel: number, roleId: string): string {
    const effectiveLevel = Math.max(authorityLevel, this.config.default_level);
    const lines: string[] = [];

    lines.push(`Your authority level: ${effectiveLevel}/10`);
    lines.push('');

    // Governed categories
    if (this.config.governed_categories.length > 0) {
      lines.push('Actions requiring user approval before execution:');
      for (const cat of this.config.governed_categories) {
        lines.push(`  - ${cat}`);
      }
      lines.push('');
    }

    // Active overrides for this role
    const roleOverrides = this.config.overrides.filter(
      o => !o.role_id || o.role_id === roleId
    );
    if (roleOverrides.length > 0) {
      lines.push('Special permission overrides:');
      for (const o of roleOverrides) {
        const scope = o.role_id ? `[${o.role_id}]` : '[global]';
        const status = o.allowed
          ? (o.requires_approval ? 'allowed with approval' : 'always allowed')
          : 'denied';
        lines.push(`  - ${o.action}: ${status} ${scope}`);
      }
      lines.push('');
    }

    // Active context rules
    if (this.config.context_rules.length > 0) {
      lines.push('Context-based rules:');
      for (const rule of this.config.context_rules) {
        lines.push(`  - ${rule.description}`);
      }
    }

    return lines.join('\n');
  }

  // --- Config management ---

  addOverride(override: PerActionOverride): void {
    // Remove existing override for same action+role before adding
    this.removeOverride(override.action, override.role_id);
    this.config.overrides.push(override);
  }

  removeOverride(action: ActionCategory, roleId?: string): void {
    this.config.overrides = this.config.overrides.filter(
      o => !(o.action === action && o.role_id === roleId)
    );
  }

  addContextRule(rule: ContextRule): void {
    this.config.context_rules.push(rule);
  }

  removeContextRule(id: string): void {
    this.config.context_rules = this.config.context_rules.filter(r => r.id !== id);
  }

  setGovernedCategories(categories: ActionCategory[]): void {
    this.config.governed_categories = categories;
  }

  getConfig(): AuthorityConfig {
    return { ...this.config };
  }

  updateConfig(config: AuthorityConfig): void {
    this.config = config;
  }

  // --- Private helpers ---

  private findOverride(action: ActionCategory, roleId: string): PerActionOverride | null {
    // Role-specific override takes priority over global
    const roleSpecific = this.config.overrides.find(
      o => o.action === action && o.role_id === roleId
    );
    if (roleSpecific) return roleSpecific;

    const global = this.config.overrides.find(
      o => o.action === action && !o.role_id
    );
    return global ?? null;
  }

  private evaluateContextRules(action: ActionCategory, toolName: string): ContextRule | null {
    for (const rule of this.config.context_rules) {
      if (rule.action !== action) continue;

      switch (rule.condition) {
        case 'time_range': {
          const now = new Date();
          const hour = now.getHours();
          const startHour = (rule.params.start_hour as number) ?? 0;
          const endHour = (rule.params.end_hour as number) ?? 24;
          if (hour >= startHour && hour < endHour) {
            return rule;
          }
          break;
        }
        case 'tool_name': {
          const toolPattern = rule.params.tool_name as string;
          if (toolPattern && (toolName === toolPattern || toolName.startsWith(toolPattern))) {
            return rule;
          }
          break;
        }
        case 'always': {
          return rule;
        }
      }
    }
    return null;
  }
}
