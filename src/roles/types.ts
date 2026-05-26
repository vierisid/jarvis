export type KPI = {
  name: string;
  metric: string;
  target: string;
  check_interval: string;
};

export type CommunicationStyle = {
  tone: string;
  verbosity: 'concise' | 'detailed' | 'adaptive';
  formality: 'formal' | 'casual' | 'adaptive';
};

export type SubRoleTemplate = {
  role_id: string;
  name: string;
  description: string;
  spawned_by: string;
  reports_to: string;
  max_budget_per_task: number;
};

/**
 * RoleDefinition - shape of a role YAML file.
 *
 * Required fields are the load-bearing ones: id, description, responsibilities,
 * tools, authority_level. Everything else is optional advisory text that the
 * prompt-builder skips when absent. This lets role YAMLs be small (no KPI
 * table, no character monologue) without breaking the loader.
 */
export type RoleDefinition = {
  id: string;
  name: string;
  description: string;
  responsibilities: string[];
  tools: string[];
  authority_level: number;  // 1-10
  // Optional advisory fields - prompt-builder skips them if absent/empty.
  autonomous_actions?: string[];
  approval_required?: string[];
  kpis?: KPI[];
  communication_style?: CommunicationStyle;
  heartbeat_instructions?: string;
  sub_roles?: SubRoleTemplate[];
};
