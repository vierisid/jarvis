/**
 * Where on the screen an approval would land, for the sheet that asks for it.
 *
 * A click, a typed text or a key press is approved by what it lands on: the
 * Send button, the window in front. The request itself says "element 12", or
 * "x 640, y 300", or nothing at all, and the product cannot tell a click that
 * pays from one that scrolls. So the machine is asked what is there now, and
 * the answer goes on the paper of the sheet.
 *
 * That answer is text from the screen. It is shown to the person as it is.
 * It is never given to a model: a window can be called anything.
 */
import type { ApprovalRequest } from '../authority/approval.ts';
import { pointerRequest } from '../actions/tools/desktop.ts';

/** The tools that act on whatever is on the screen at that moment. */
export const NOTCH_WHERE_TOOLS: ReadonlySet<string> = new Set(['desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_pointer']);

export interface NotchWhereDeps {
  /** The machine a call with this `target` argument would go to, or null. */
  target(explicit: unknown, tool: string): string | null;
  /** The size of the picture last shown of that machine's screen. */
  picture(target: string): { width: number; height: number } | null;
  /** Asks that machine what is at a place. It only reads. */
  ask(target: string, params: Record<string, unknown>): Promise<unknown>;
}

const text = (value: unknown, most: number): string =>
  typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, most).join('') : '';

/**
 * What the machine said, as one line: 'Button "Send" in "Inbox - Outlook"
 * (olk)'. `front` is for an action that goes to the window in front rather
 * than to something named. Null when the machine said nothing usable.
 */
export function notchPlaceSentence(reply: unknown, front: boolean): string | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const said = reply as Record<string, unknown>;
  const title = text(said.window_title, 80);
  const program = text(said.process_name, 40);
  const role = text(said.element_role, 30);
  const name = text(said.element_name, 80);
  if (said.own === true) return "one of Jarvis's own windows";
  const window = title ? `"${title}"${program ? ` (${program})` : ''}` : '';
  const element = name ? `${role || 'Element'} "${name}"` : role && role !== 'Unknown' ? `${role} with no name` : '';
  if (element && window) return `${element} in ${window}`;
  if (element && program) return `${element} in a window of ${program}`;
  if (element) return element;
  if (window) return front ? `the window in front, ${window}` : `the window ${window}`;
  // A window with no title: its program is all there is to call it by.
  if (program) return front ? `the window in front (${program})` : `a window of ${program}`;
  return null;
}

/** The place an approval would land on, or null when it acts on nothing on a screen or the machine cannot say. */
export async function notchApprovalWhere(request: Pick<ApprovalRequest, 'tool_name' | 'tool_arguments'>, deps: NotchWhereDeps): Promise<string | null> {
  if (!NOTCH_WHERE_TOOLS.has(request.tool_name)) return null;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.tool_arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = deps.target(args.target, request.tool_name);
  if (!target) return null;

  let params: Record<string, unknown> = {};
  let front = true;
  if (request.tool_name === 'desktop_pointer') {
    const place = pointerRequest(args, deps.picture(target));
    // No place can be worked out: the call itself will be refused when it runs.
    if (typeof place === 'string') return null;
    params = { fx: place.fx, fy: place.fy };
    front = false;
  } else if (typeof args.element_id === 'number') {
    params = { element_id: args.element_id };
    front = false;
  } else if (request.tool_name === 'desktop_click') {
    // A click with no element names nothing.
    return null;
  }
  return notchPlaceSentence(await deps.ask(target, params), front);
}
