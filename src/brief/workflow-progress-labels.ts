/** Public, static labels only. No arguments, provider output or names are interpolated. */
export const workflowProgressLabels = {
  compose: ['Building a workflow draft.', 'Workflow composition returned.', 'Workflow composition could not finish.'],
  continue_setup: ['Preparing workflow setup.', 'Workflow setup returned.', 'Workflow setup could not finish.'],
  create: ['Saving a workflow draft.', 'Draft creation returned.', 'Draft creation could not finish.'],
  update: ['Updating a workflow draft.', 'Draft update returned.', 'Draft update could not finish.'],
  get: ['Inspecting a saved workflow.', 'Workflow inspection returned.', 'Workflow inspection could not finish.'],
  list: ['Listing workflows.', 'Workflow list returned.', 'Workflows could not be listed.'],
  validate_fixtures: ['Testing workflow fixtures.', 'Fixture validation returned.', 'Fixture validation could not finish.'],
  list_runs: ['Inspecting workflow runs.', 'Run history returned.', 'Run history could not be read.'],
  get_run: ['Inspecting a workflow run.', 'Run inspection returned.', 'Run inspection could not finish.'],
  run: ['Requesting a workflow run.', 'Run request returned.', 'Run request could not finish.'],
  enable: ['Enabling a workflow.', 'Enable request returned.', 'Enable request could not finish.'],
  disable: ['Disabling a workflow.', 'Disable request returned.', 'Disable request could not finish.'],
  publish: ['Publishing a workflow version.', 'Publish request returned.', 'Publish request could not finish.'],
  delete: ['Removing a workflow.', 'Removal request returned.', 'Removal request could not finish.'],
} as const;
export const workflowProgressSummaries = new Set<string>(Object.values(workflowProgressLabels).flat());
export function workflowProgressOperation(name: string, action: unknown): keyof typeof workflowProgressLabels | undefined {
  return name === 'manage_workflow' && typeof action === 'string' && Object.hasOwn(workflowProgressLabels, action)
    ? action as keyof typeof workflowProgressLabels : undefined;
}
