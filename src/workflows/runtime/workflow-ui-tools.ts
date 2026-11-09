import type { ToolDefinition } from '../../actions/tools/registry';
import { BOUNDED_TOOLS } from './tool-capability';
import { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview } from '../../authority/ui-intent';
export { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview };

export const UNSUPPORTED_WORKFLOW_TOOLS: ReadonlySet<string> = new Set([
  'run_command', 'browser_evaluate', 'browser_upload_file', 'desktop_type', 'desktop_press_keys',
  'record_skill', 'manage_skills', 'ui_act',
]);

export function workflowToolRefusal(name: string): string | null {
  if (!UNSUPPORTED_WORKFLOW_TOOLS.has(name)) return null;
  if (name === 'browser_upload_file') return 'browser_upload_file has no computer-bound workflow adapter or sidecar route. Use a supported file-upload connector instead.';
  if (name === 'desktop_type' || name === 'desktop_press_keys') {
    return `${name} cannot run in a workflow because it can send input to whichever window has focus. Use a desktop agent to open the app, inspect its current editor, set that element's value with desktop_click (action set_value), and read it back with action get_value. If the editor does not support setting its value, report the limitation.`;
  }
  return `${name} is not supported as a direct workflow action. Use a supported connector, a recorded run_skill step, or a reviewed browser/desktop agent for supported UI actions.`;
}

/** Static declaration only: never selects a computer or dispatches while composing. */
export function workflowToolDeclarationRefusal(tool: ToolDefinition): string | null {
  const refusal = workflowToolRefusal(tool.name);
  if (refusal) return refusal;
  if (WORKFLOW_REVIEWED_UI_TOOLS.has(tool.name)) return workflowUiReview(tool, tool.name) ? null
    : `${tool.name} is unavailable in workflows because its live approval guard is missing.`;
  if (BOUNDED_TOOLS.has(tool.name) || tool.name === 'run_skill' || tool.workflowEffect) return null;
  return `${tool.name} has no supported direct workflow adapter. Use its dedicated workflow piece or an allowed agent task.`;
}
