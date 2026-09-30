import type { Goal, GoalLevel, TimeHorizon } from './types.ts';
import { enumeration, epoch, GOAL_LEVELS, instant, invalid, keys, nextGoalLevel, number, record, strings, text, TIME_HORIZONS, timezone } from './validation.ts';

type Deadline = { deadline_days?: number; deadline_at?: string };
type ProposedGoal = Deadline & { title: string; description: string; success_criteria?: string };
export type GoalProposal = {
  objective: ProposedGoal & { success_criteria: string; time_horizon: TimeHorizon; tags?: string[] };
  key_results: (ProposedGoal & { success_criteria: string })[];
  milestones?: (ProposedGoal & { key_result_index: number })[];
  clarifying_questions?: string[];
  /** Decomposition context, supplied by Jarvis and checked again on confirmation. */
  parent_id?: string;
  parent_level?: GoalLevel;
  timezone?: string;
  /** All relative deadlines use this instant, including when confirmation is later. */
  deadline_reference_at?: string;
};
const NODE_FIELDS = ['title', 'description', 'success_criteria', 'deadline_days', 'deadline_at'];
function validateNode(input: unknown, path: string, extras: string[] = [], criteriaRequired = true): void {
  const value = record(input, path);
  keys(value, [...NODE_FIELDS, ...extras], path);
  text(value.title, `${path}.title`);
  text(value.description, `${path}.description`, false);
  if (criteriaRequired || value.success_criteria !== undefined) text(value.success_criteria, `${path}.success_criteria`);
  if (value.deadline_days !== undefined) number(value.deadline_days, `${path}.deadline_days`, 0, Number.MAX_SAFE_INTEGER, true);
  if (value.deadline_at !== undefined) instant(value.deadline_at, `${path}.deadline_at`);
  if (value.deadline_days !== undefined && value.deadline_at !== undefined) invalid(path, 'choose deadline_days or deadline_at, not both');
}
/** Validate every recognized field and reject silently ignored hierarchy/date fields. */
export function validateProposal(input: unknown): GoalProposal {
  const value = record(input, 'proposal');
  keys(value, ['objective', 'key_results', 'milestones', 'clarifying_questions', 'parent_id', 'parent_level', 'timezone', 'deadline_reference_at'], 'proposal');
  validateNode(value.objective, 'objective', ['time_horizon', 'tags']);
  const objective = record(value.objective, 'objective');
  enumeration(objective.time_horizon, TIME_HORIZONS, 'objective.time_horizon');
  if (objective.tags !== undefined) strings(objective.tags, 'objective.tags');
  if (!Array.isArray(value.key_results) || value.key_results.length > 100) invalid('key_results', 'must be an array of at most 100 goals');
  for (const [index, child] of value.key_results.entries()) validateNode(child, `key_results[${index}]`);
  if (value.milestones !== undefined) {
    if (!Array.isArray(value.milestones) || value.milestones.length > 100) invalid('milestones', 'must be an array of at most 100 goals');
    for (const [index, child] of value.milestones.entries()) {
      const path = `milestones[${index}]`;
      validateNode(child, path, ['key_result_index'], false);
      number(record(child, path).key_result_index, `${path}.key_result_index`, 0, value.key_results.length - 1, true);
    }
  }
  if (value.clarifying_questions !== undefined) strings(value.clarifying_questions, 'clarifying_questions', 20);
  if (value.timezone !== undefined) timezone(value.timezone);
  if (value.deadline_reference_at !== undefined) instant(value.deadline_reference_at, 'deadline_reference_at');
  if (value.parent_id !== undefined || value.parent_level !== undefined) {
    text(value.parent_id, 'parent_id', true, 512);
    enumeration(value.parent_level, GOAL_LEVELS, 'parent_level');
  }
  // The complete shape above is checked before exposing the typed proposal.
  return structuredClone(value) as GoalProposal;
}

export type PlannedGoal = {
  title: string;
  level: GoalLevel;
  parentIndex: number | null;
  options: { description: string; success_criteria?: string; time_horizon: TimeHorizon; deadline?: number; tags?: string[] };
};
/** Resolve the whole hierarchy and all instants before the transaction inserts its first row. */
export function planProposal(proposal: GoalProposal, parent: Goal | null, now: number): PlannedGoal[] {
  if (proposal.clarifying_questions?.length) invalid('clarifying_questions', 'resolve the questions before creating goals');
  if (proposal.parent_id !== undefined && (proposal.parent_id !== parent?.id || proposal.parent_level !== parent?.level)) invalid('parent_id', 'does not match the current decomposition parent');
  const reference = proposal.deadline_reference_at === undefined ? epoch(now, 'reference') : instant(proposal.deadline_reference_at, 'deadline_reference_at');
  const deadline = (node: Deadline, path: string): number | undefined => {
    if (node.deadline_at !== undefined) return instant(node.deadline_at, `${path}.deadline_at`);
    if (node.deadline_days !== undefined) return epoch(reference + node.deadline_days * 86400000, `${path}.deadline_days`);
    return undefined;
  };
  const objectiveDeadline = deadline(proposal.objective, 'objective');
  const childLevel = parent ? nextGoalLevel(parent.level) : 'key_result';
  if (!childLevel) invalid('parent_id', 'a daily_action cannot have children');
  if (parent && !proposal.key_results.length) invalid('key_results', 'decomposition requires at least one child');
  const grandchildLevel = nextGoalLevel(childLevel);
  if (!grandchildLevel && proposal.milestones?.length) invalid('milestones', 'would create children below daily_action');
  const horizon = parent?.time_horizon ?? proposal.objective.time_horizon;
  const parentDeadline = parent?.deadline ?? (parent ? undefined : objectiveDeadline);
  const plan: PlannedGoal[] = [];
  if (!parent) plan.push({ title: proposal.objective.title, level: 'objective', parentIndex: null,
    options: { description: proposal.objective.description, success_criteria: proposal.objective.success_criteria,
      time_horizon: horizon, deadline: objectiveDeadline, tags: proposal.objective.tags } });
  const checkDeadline = (date: number | undefined, bound: number | null | undefined, path: string) => {
    if (date !== undefined && bound != null && date > bound) invalid(path, 'cannot be after its ancestor deadline');
  };
  for (const [index, child] of proposal.key_results.entries()) {
    const path = `key_results[${index}]`;
    const date = deadline(child, path);
    checkDeadline(date, parentDeadline, path);
    const childIndex = plan.length;
    plan.push({ title: child.title, level: childLevel, parentIndex: parent ? null : 0,
      options: { description: child.description, success_criteria: child.success_criteria, time_horizon: horizon, deadline: date } });
    for (const [mi, milestone] of (proposal.milestones ?? []).entries()) {
      if (milestone.key_result_index !== index) continue;
      const msPath = `milestones[${mi}]`;
      const msDate = deadline(milestone, msPath);
      checkDeadline(msDate, date ?? parentDeadline, msPath);
      plan.push({ title: milestone.title, level: grandchildLevel!, parentIndex: childIndex,
        options: { description: milestone.description, success_criteria: milestone.success_criteria, time_horizon: horizon, deadline: msDate } });
    }
  }
  return plan;
}
