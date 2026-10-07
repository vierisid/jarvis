/**
 * Which workflow tools act on a computer, and through which sidecar
 * capability. Pure and dependency-free, so the database layer can read it
 * (repos/binding-pins.ts pins the computer a workflow runs on) without
 * importing the dispatch machinery in `effect-capabilities.ts`, which uses the
 * same table to pick the machine at run time.
 */
import type { SidecarCapability } from '../../sidecar/types';

/**
 * Tools whose effect is bounded enough to describe a review target (a sidecar
 * and an absolute path) on an approval card. Names only: the Authority action
 * for each comes from the daemon's single source of truth, `TOOL_ACTION_MAP`,
 * so the two can never drift. `bounded-tools.test.ts` fails if a name here
 * stops resolving there.
 */
export const BOUNDED_TOOLS: ReadonlySet<string> = new Set<string>([
  'read_file', 'list_directory', 'write_file',
  'get_clipboard', 'set_clipboard', 'get_system_info', 'capture_screen',
  'browser_snapshot', 'browser_screenshot',
  'desktop_list_windows', 'desktop_snapshot', 'desktop_find_element', 'desktop_screenshot',
]);

/** The sidecar capability a bounded tool is dispatched through. */
export function boundedToolCapability(tool: string): SidecarCapability {
  return tool.includes('file') || tool === 'list_directory' ? 'filesystem'
    : tool.includes('clipboard') ? 'clipboard' : tool === 'get_system_info' ? 'system_info'
    : tool === 'capture_screen' || tool === 'desktop_screenshot' ? 'screenshot'
    : tool.startsWith('browser_') ? 'browser' : 'desktop';
}
