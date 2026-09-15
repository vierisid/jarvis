import type { ToolDefinition } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { walkWorkflow } from './effect-context';
import { autoTargetForCapability, findSidecar, getSidecarManager } from '../../actions/tools/sidecar-route';
import { getDefaultCwd } from '../../actions/tools/local-tools-guard';
import type { SidecarCapability } from '../../sidecar/types';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const BOUNDED_TOOLS: Record<string, ActionCategory> = {
  read_file: 'read_data', list_directory: 'read_data', write_file: 'write_data',
  get_clipboard: 'read_data', set_clipboard: 'write_data', get_system_info: 'read_data', capture_screen: 'read_data',
  browser_snapshot: 'access_browser', browser_screenshot: 'access_browser',
  desktop_list_windows: 'read_data', desktop_snapshot: 'read_data', desktop_find_element: 'read_data', desktop_screenshot: 'read_data',
};
const OPAQUE_TOOLS = new Set(['run_command', 'browser_evaluate', 'browser_navigate', 'browser_click',
  'browser_type', 'browser_upload_file', 'browser_press_key', 'browser_hover', 'browser_scroll',
  'desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app', 'desktop_focus_window']);

function boundedTarget(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const capability: SidecarCapability = tool.includes('file') || tool === 'list_directory' ? 'filesystem'
    : tool.includes('clipboard') ? 'clipboard' : tool === 'get_system_info' ? 'system_info'
    : tool === 'capture_screen' || tool === 'desktop_screenshot' ? 'screenshot'
    : tool.startsWith('browser_') ? 'browser' : 'desktop';
  const selector = typeof params.target === 'string' && params.target.trim() ? params.target : autoTargetForCapability(capability);
  const sidecar = selector ? findSidecar(selector, getSidecarManager()?.listSidecars() ?? []) : null;
  if (selector && !sidecar) throw new Error(`Workflow target unavailable: ${selector}`);
  const path = params.path == null ? null : sidecar ? params.path : resolve(getDefaultCwd() || homedir(), String(params.path));
  return { tool, sidecarId: sidecar?.id ?? null, path, selection: sidecar ? 'pinned-sidecar' : 'local-host' };
}

export function toolEffectCapability(tool: ToolDefinition) {
  if (OPAQUE_TOOLS.has(tool.name)) throw new Error(`Unsupported direct workflow capability: ${tool.name} has opaque code/UI effects; use a typed governed adapter`);
  const category = tool.workflowEffect?.category
    ?? (Object.hasOwn(BOUNDED_TOOLS, tool.name) ? BOUNDED_TOOLS[tool.name] : undefined);
  if (!category || !Object.hasOwn(AUTHORITY_REQUIREMENTS, category)) {
    throw new Error(`Unsupported direct workflow capability: ${tool.name} has no declared Authority action`);
  }
  return { category, target: tool.workflowEffect?.target ?? ((params: Record<string, unknown>) => boundedTarget(tool.name, params)),
    prepareArguments: (params: Record<string, unknown>) => {
      if (tool.workflowEffect) return params;
      const target = boundedTarget(tool.name, params);
      return { ...params, ...(target.sidecarId ? { target: target.sidecarId } : {}),
        ...(target.path !== null ? { path: target.path } : {}) };
    } };
}

const PIECES = new Set(['@jarvispieces/piece-jarvis-tool', '@jarvispieces/piece-jarvis-notify',
  '@jarvispieces/piece-jarvis-agent', '@jarvispieces/piece-jarvis-ask', '@jarvispieces/piece-jarvis-context',
  '@jarvispieces/piece-jarvis-trigger', '@jarvispieces/piece-jarvis-regex', '@jarvispieces/piece-jarvis-validate',
  '@jarvispieces/piece-jarvis-test', '@activepieces/piece-delay']);
const TRIGGER_PIECES = new Set(['@activepieces/piece-schedule', '@activepieces/piece-webhook']);

/** Admission covers direct effects outside the daemon's typed tool boundary. */
export function assertWorkflowCapabilities(trigger: FlowTriggerNode): void {
  for (const node of walkWorkflow(trigger)) {
    if (node.type === 'CODE') throw new Error(`Unsupported workflow capability at ${node.name}: arbitrary code cannot be governed as a typed effect`);
    if (node.settings?.pieceName && !PIECES.has(node.settings.pieceName)
      && !(node === trigger && !node.settings.actionName && TRIGGER_PIECES.has(node.settings.pieceName))) {
      throw new Error(`Unsupported workflow capability at ${node.name}: ${node.settings.pieceName} needs a governed effect adapter (including raw HTTP)`);
    }
  }
}
