import YAML from 'yaml';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { RoleDefinition, KPI, CommunicationStyle, SubRoleTemplate } from './types.ts';

/**
 * Load a role from a YAML file
 */
export function loadRole(filePath: string): RoleDefinition {
  const content = readFileSync(filePath, 'utf-8');
  const data = YAML.parse(content);

  if (!validateRole(data)) {
    throw new Error(`Invalid role definition in ${filePath}`);
  }

  return data;
}

/**
 * Load all roles from a directory
 */
export function loadRolesFromDir(dirPath: string): Map<string, RoleDefinition> {
  const roles = new Map<string, RoleDefinition>();

  try {
    const files = readdirSync(dirPath);

    for (const file of files) {
      const filePath = join(dirPath, file);
      const stat = statSync(filePath);

      if (stat.isFile() && (extname(file) === '.yaml' || extname(file) === '.yml')) {
        try {
          const role = loadRole(filePath);
          roles.set(role.id, role);
        } catch (error) {
          console.error(`Failed to load role from ${file}:`, error);
          // Continue loading other roles
        }
      }
    }
  } catch (error) {
    console.error(`Failed to read roles directory ${dirPath}:`, error);
  }

  return roles;
}

/**
 * Validate a role definition (check required fields)
 */
export function validateRole(role: unknown): role is RoleDefinition {
  if (!role || typeof role !== 'object') {
    return false;
  }

  const r = role as Record<string, unknown>;

  // Required fields - load-bearing for prompt building and authority gating.
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.name !== 'string' || !r.name) return false;
  if (typeof r.description !== 'string' || !r.description) return false;
  if (!Array.isArray(r.responsibilities)) return false;
  if (!Array.isArray(r.tools)) return false;
  if (typeof r.authority_level !== 'number') return false;
  if (r.authority_level < 1 || r.authority_level > 10) return false;
  if (!r.responsibilities.every((item) => typeof item === 'string')) return false;
  if (!r.tools.every((item) => typeof item === 'string')) return false;

  // Optional fields - validate shape only if present.
  if (r.autonomous_actions !== undefined) {
    if (!Array.isArray(r.autonomous_actions)) return false;
    if (!r.autonomous_actions.every((item) => typeof item === 'string')) return false;
  }
  if (r.approval_required !== undefined) {
    if (!Array.isArray(r.approval_required)) return false;
    if (!r.approval_required.every((item) => typeof item === 'string')) return false;
  }
  if (r.kpis !== undefined) {
    if (!Array.isArray(r.kpis)) return false;
    if (!r.kpis.every(validateKPI)) return false;
  }
  if (r.communication_style !== undefined && !validateCommunicationStyle(r.communication_style)) {
    return false;
  }
  if (r.heartbeat_instructions !== undefined && typeof r.heartbeat_instructions !== 'string') {
    return false;
  }
  if (r.sub_roles !== undefined) {
    if (!Array.isArray(r.sub_roles)) return false;
    if (!r.sub_roles.every(validateSubRoleTemplate)) return false;
  }

  return true;
}

/**
 * Validate a KPI object
 */
function validateKPI(kpi: unknown): kpi is KPI {
  if (!kpi || typeof kpi !== 'object') return false;

  const k = kpi as Record<string, unknown>;

  return (
    typeof k.name === 'string' &&
    typeof k.metric === 'string' &&
    typeof k.target === 'string' &&
    typeof k.check_interval === 'string'
  );
}

/**
 * Validate a CommunicationStyle object
 */
function validateCommunicationStyle(style: unknown): style is CommunicationStyle {
  if (!style || typeof style !== 'object') return false;

  const s = style as Record<string, unknown>;

  return (
    typeof s.tone === 'string' &&
    (s.verbosity === 'concise' || s.verbosity === 'detailed' || s.verbosity === 'adaptive') &&
    (s.formality === 'formal' || s.formality === 'casual' || s.formality === 'adaptive')
  );
}

/**
 * Validate a SubRoleTemplate object
 */
function validateSubRoleTemplate(template: unknown): template is SubRoleTemplate {
  if (!template || typeof template !== 'object') return false;

  const t = template as Record<string, unknown>;

  return (
    typeof t.role_id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof t.spawned_by === 'string' &&
    typeof t.reports_to === 'string' &&
    typeof t.max_budget_per_task === 'number'
  );
}
