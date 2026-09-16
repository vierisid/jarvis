import type { ToolDefinition } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { autoTargetForCapability, findSidecar, getSidecarManager } from '../../actions/tools/sidecar-route';
import { getDefaultCwd } from '../../actions/tools/local-tools-guard';
import type { SidecarCapability } from '../../sidecar/types';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Tools whose effect is bounded enough to describe a review target (a sidecar
 * and an absolute path) on an approval card. Names only: the Authority action
 * for each comes from the daemon's single source of truth, `TOOL_ACTION_MAP`,
 * so the two can never drift. `bounded-tools.test.ts` fails if a name here
 * stops resolving there.
 */
const BOUNDED_TOOLS = new Set<string>([
  'read_file', 'list_directory', 'write_file',
  'get_clipboard', 'set_clipboard', 'get_system_info', 'capture_screen',
  'browser_snapshot', 'browser_screenshot',
  'desktop_list_windows', 'desktop_snapshot', 'desktop_find_element', 'desktop_screenshot',
]);

/**
 * Tools whose effect is a script or a click sequence. A category label cannot
 * describe what they will do, so they need a typed adapter rather than an
 * approval that purports to understand raw code or arbitrary UI semantics.
 */
const OPAQUE_TOOLS = new Set(['run_command', 'browser_evaluate', 'browser_navigate', 'browser_click',
  'browser_type', 'browser_upload_file', 'browser_press_key', 'browser_hover', 'browser_scroll',
  'desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app', 'desktop_focus_window']);

export const BOUNDED_TOOL_NAMES: ReadonlySet<string> = BOUNDED_TOOLS;
export const OPAQUE_TOOL_NAMES: ReadonlySet<string> = OPAQUE_TOOLS;

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

/**
 * Worst-case Authority action for a capability we are about to refuse. Used for
 * the audit row only: a refusal is still a governance decision and has to be
 * recorded. An opaque tool audits under its real category; a tool with no
 * declared action at all audits as the most severe one, never as `read_data`.
 */
export function refusedEffectCategory(tool: ToolDefinition): ActionCategory {
  return tool.workflowEffect?.category ?? TOOL_ACTION_MAP[tool.name] ?? 'execute_command';
}

export function toolEffectCapability(tool: ToolDefinition) {
  if (OPAQUE_TOOLS.has(tool.name)) throw new Error(`Unsupported direct workflow capability: ${tool.name} has opaque code/UI effects; use a typed governed adapter`);
  const category = tool.workflowEffect?.category
    ?? (BOUNDED_TOOLS.has(tool.name) ? TOOL_ACTION_MAP[tool.name] : undefined);
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
