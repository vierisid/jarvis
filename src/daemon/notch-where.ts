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
import type { ActionCategory } from '../roles/authority.ts';
import { uiEffectHints } from '../authority/ui-intent.ts';
import { pointerRequest } from '../actions/tools/desktop.ts';
import type { NotchApprovalWhere } from '../notch/approvals.ts';

/** The tools that act on whatever is on the screen at that moment. */
export const NOTCH_WHERE_TOOLS: ReadonlySet<string> = new Set(['desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_pointer']);

export interface NotchWhereDeps {
  /**
   * Whether the screen may be read at all. With screen awareness off Jarvis
   * reads no window and no control, on any path, and this is one.
   */
  allowed(): boolean;
  /** The machine a call with this `target` argument would go to, or null. */
  target(explicit: unknown, tool: string): string | null;
  /** Whether a model was shown that machine's screen recently enough to have read a place off it. */
  seen(target: string): boolean;
  /** Asks that machine what is at a place. It only reads. */
  ask(target: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Text from the screen for one line: one run of spaces, a length, and no
 * double quotes of any kind. The line puts names in double quotes, and a
 * button called `OK" in "Windows Security` must not be able to close its own
 * and open another.
 */
const text = (value: unknown, most: number): string =>
  typeof value === 'string'
    ? [...value.replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02]/g, "'").replace(/\s+/g, ' ').trim()].slice(0, most).join('')
    : '';

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

/**
 * Whether a click on what the machine named reads as a payment: the product's
 * own reading of a control's label (`uiEffectHints`, the one `ui_act` is
 * judged by), applied to the name the screen gave. No model is asked.
 */
export function notchPlacePays(reply: unknown): boolean {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false;
  const said = reply as Record<string, unknown>;
  const name = typeof said.element_name === 'string' ? said.element_name : '';
  const title = typeof said.window_title === 'string' ? said.window_title : '';
  return name !== '' && uiEffectHints('click', name, title).includes('make_payment');
}

/** The actions that press what is there, as against looking at it, scrolling it or moving it. */
const PRESSES = new Set(['click', 'double_click', 'invoke', 'select', 'toggle']);

/**
 * What a raw press would land on, read as the product reads a control's label:
 * the categories a click on that name means (`delete_data`, `make_payment`,
 * a send, a settings change), or none. For the owner's word
 * (authority/owner-word.ts), which lets a click go ahead unasked unless it is
 * a delete or a payment and so has to know before the click, not on a sheet.
 * Nothing is read when the screen may not be read, and a machine that cannot
 * say reads as nothing.
 */
export async function notchPressReads(toolName: string, args: Record<string, unknown>, deps: NotchWhereDeps): Promise<ActionCategory[]> {
  if ((toolName !== 'desktop_click' && toolName !== 'desktop_pointer') || !deps.allowed()) return [];
  const action = typeof args.action === 'string' && args.action ? args.action : 'click';
  if (!PRESSES.has(action)) return [];
  const target = deps.target(args.target, toolName);
  if (!target) return [];
  let params: Record<string, unknown>;
  if (toolName === 'desktop_pointer') {
    const place = pointerRequest(args, deps.seen(target));
    if (typeof place === 'string') return [];
    params = { fx: place.fx, fy: place.fy };
  } else if (typeof args.element_id === 'number') {
    params = { element_id: args.element_id };
  } else {
    return [];
  }
  const reply = await deps.ask(target, params);
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return [];
  const said = reply as Record<string, unknown>;
  const name = typeof said.element_name === 'string' ? said.element_name : '';
  const title = typeof said.window_title === 'string' ? said.window_title : '';
  return name ? uiEffectHints('click', name, title) : [];
}

/** The place an approval would land on, or null when it acts on nothing on a screen or the machine cannot say. */
export async function notchApprovalWhere(request: Pick<ApprovalRequest, 'tool_name' | 'tool_arguments'>, deps: NotchWhereDeps): Promise<NotchApprovalWhere | null> {
  if (!NOTCH_WHERE_TOOLS.has(request.tool_name) || !deps.allowed()) return null;
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
    const place = pointerRequest(args, deps.seen(target));
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
  const reply = await deps.ask(target, params);
  const action = typeof args.action === 'string' && args.action ? args.action : 'click';
  const presses = (request.tool_name === 'desktop_click' || request.tool_name === 'desktop_pointer') && PRESSES.has(action);
  return { place: notchPlaceSentence(reply, front), pays: presses && notchPlacePays(reply) };
}
