/**
 * Desktop Tools — Desktop Automation via Sidecar RPC or Local Execution
 *
 * 9 tools for controlling desktop applications. Each tool accepts a `target`
 * parameter to route to a specific sidecar. Without `target`, executes locally
 * via the platform AppController when available. Respects --no-local-tools flag.
 *
 * The same tools work on all platforms (Windows, macOS, Linux). The sidecar
 * handles platform-specific implementation details internally.
 */

import type { AppController, UIElement, WindowInfo } from '../app-control/interface.ts';
import { getAppController } from '../app-control/interface.ts';
import type { ToolDefinition, ToolResult } from './registry.ts';
import { routeToSidecarAction as routeToSidecar, routeToSidecarActionReply, routeScreenshotToSidecar, resolveToolTarget } from './sidecar-route.ts';
import { withTrustedTrailer } from '../../roles/untrusted.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import type { SidecarCapability } from '../../sidecar/types.ts';
import { screenshotCaption, screenshotForModel } from '../app-control/image-compact.ts';
import { ElementCache, resolveElement, uiElementPrint } from '../app-control/element-cache.ts';

/**
 * Resolve the desktop-tool target. If the LLM passed an explicit
 * target, use it. Otherwise, default to a connected sidecar that
 * advertises the `desktop` capability — so the new Go sidecar
 * handles desktop_* tools transparently without the LLM having to
 * specify a target every time. Returns null when nothing's connected,
 * which signals the caller to fall back to the legacy local
 * controller (rarely useful in practice but kept for parity).
 */
function resolveDesktopTarget(
  explicit?: unknown,
  capability: SidecarCapability = 'desktop',
  tool = 'desktop',
): string | null {
  // Auto-target by the capability the RPC actually requires. Most desktop_*
  // RPCs need 'desktop', but capture_screen needs 'screenshot' - resolving
  // against 'desktop' there could pick a sidecar that lacks 'screenshot' and
  // then hard-fail in routeToSidecar with a "do NOT retry" error.
  return resolveToolTarget(explicit, capability, tool);
}
import { isNoLocalTools, LOCAL_DISABLED_MSG } from './local-tools-guard.ts';

type FlatSnapshotElement = {
  id: number;
  role: string;
  name: string;
  value: string | null;
  depth: number;
  bounds: UIElement['bounds'] | null;
  properties: Record<string, unknown>;
};

type LocalSnapshot = {
  window: { pid: number; title: string; className: string };
  elements: FlatSnapshotElement[];
  totalElements: number;
};

type SnapshotCapableController = AppController & {
  snapshot?: (pid?: number, depth?: number) => Promise<{
    window: { pid: number; title: string; className: string };
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value: string | null;
      depth: number;
      isEnabled?: boolean;
      bounds?: UIElement['bounds'];
      properties?: Record<string, unknown>;
    }>;
    totalElements: number;
  }>;
  clickById?: (elementId: number) => Promise<string>;
  typeById?: (elementId: number | undefined, text: string) => Promise<string>;
  screenshotBase64?: (pid?: number) => Promise<{ base64: string; mimeType: string }>;
};

let localControllerFactory: () => AppController = () => getAppController();
/**
 * The last local tree walk's elements, behind ids that name that walk, and
 * re-checked against a fresh walk before any action (#704, element-cache.ts).
 */
let localElements = new ElementCache<UIElement>();
let lastLocalSnapshot: LocalSnapshot | null = null;

/**
 * Local element work, one call at a time: a snapshot, a find, and the
 * read-back plus dispatch of a click or a type. A legacy desktop bridge keeps
 * its own per-walk ids, so a walk that lands between an action's read-back and
 * its click would re-point the id the click goes out under. The tools are
 * driven one at a time by a model anyway; this makes it a property of the code
 * rather than of the caller.
 */
let localElementQueue: Promise<unknown> = Promise.resolve();
function serializedLocal<T>(fn: () => Promise<T>): Promise<T> {
  const run = localElementQueue.then(fn, fn);
  localElementQueue = run.catch(() => undefined);
  return run;
}

export function __setLocalDesktopControllerFactoryForTests(factory: (() => AppController) | null): void {
  localControllerFactory = factory ?? (() => getAppController());
  __resetLocalDesktopStateForTests();
}

export function __resetLocalDesktopStateForTests(): void {
  localElements = new ElementCache<UIElement>();
  lastLocalSnapshot = null;
}

function isToolDisabled(): string | null {
  if (isNoLocalTools()) {
    return LOCAL_DISABLED_MSG;
  }
  return null;
}

function getLocalController(): SnapshotCapableController {
  return localControllerFactory() as SnapshotCapableController;
}

/**
 * A local capture as the model should receive it (#711): full resolution when
 * it fits under `guardImageSize`'s cap, otherwise compacted with the routed
 * fallback's values (app-control/image-compact.ts), and a failure -- never a
 * placeholder -- when even that does not fit. `label` is the tool's own
 * sentence; it gains the picture's size only when the picture was shrunk.
 *
 * `typedErrors` as in `routeScreenshotToSidecar`: the desktop tools throw a
 * typed failure (not_started: a capture changes nothing on the machine), the
 * legacy `capture_screen` returns the message.
 */
export async function localScreenshotResult(base64: string, mediaType: string, label: string, typedErrors: boolean): Promise<ToolResult | string> {
  const shot = await screenshotForModel(base64, mediaType);
  if (!shot.ok) {
    const message = `Error: the screenshot is too large to send, and ${shot.reason}, so there is nothing to look at.`;
    if (typedErrors) throw new ActionOutcomeError({ status: 'error', code: 'LOCAL_IMAGE_TOO_LARGE', message, effect: 'not_started' });
    return message;
  }
  return { content: [{ type: 'text', text: screenshotCaption(label, shot) }, shot.block] };
}

function formatBounds(bounds: WindowInfo['bounds']): string {
  return `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`;
}

function formatWindows(windows: WindowInfo[]): string {
  if (windows.length === 0) {
    return 'No visible windows found.';
  }

  return windows
    .map((window) => {
      const focused = window.focused ? ' [focused]' : '';
      return `PID ${window.pid}${focused} | ${window.title || '(untitled)'} | class=${window.className || 'unknown'} | bounds=${formatBounds(window.bounds)}`;
    })
    .join('\n');
}

/**
 * A tree in depth-first pre-order, down to `depthLimit`. The order is what an
 * element's index -- and so its id -- means, so a snapshot and the read-back
 * before an action must both come through here with the same limit.
 */
function flattenElements(
  elements: UIElement[],
  depthLimit: number,
  depth: number,
  flattened: Array<{ element: UIElement; depth: number }>,
): Array<{ element: UIElement; depth: number }> {
  if (depth > depthLimit) {
    return flattened;
  }

  for (const element of elements) {
    flattened.push({ element, depth });
    if (element.children.length > 0) {
      flattenElements(element.children, depthLimit, depth + 1, flattened);
    }
  }
  return flattened;
}

/**
 * One walk of `pid`: the tree, and which window it read when the controller
 * can say (a bridge walks the pid's largest window, which can change).
 */
async function readWindowTree(controller: SnapshotCapableController, pid: number): Promise<{ elements: UIElement[]; context?: string }> {
  if (typeof controller.getWindowTreeContext === 'function') return controller.getWindowTreeContext(pid);
  return { elements: await controller.getWindowTree(pid) };
}

/** One walk of `pid`, flattened as a snapshot numbers it. */
async function walkLocalElements(controller: SnapshotCapableController, pid: number, depth: number): Promise<{ elements: UIElement[]; context?: string }> {
  const tree = await readWindowTree(controller, pid);
  return { elements: flattenElements(tree.elements, depth, 0, []).map((entry) => entry.element), context: tree.context };
}

async function buildLocalSnapshot(controller: SnapshotCapableController, pid?: number, depth: number = 8): Promise<LocalSnapshot> {
  try {
    return await buildLocalSnapshotInner(controller, pid, depth);
  } catch (err) {
    // A walk that fails retires the ids the last one handed out (#704), as
    // the sidecar's forget does: "only the latest snapshot's ids" must hold
    // for a snapshot that did not work too.
    localElements.forget();
    throw err;
  }
}

async function buildLocalSnapshotInner(controller: SnapshotCapableController, pid: number | undefined, depth: number): Promise<LocalSnapshot> {
  if (typeof controller.snapshot === 'function') {
    const snap = await controller.snapshot(pid, depth);
    lastLocalSnapshot = {
      window: snap.window,
      elements: snap.elements.map((element) => ({
        id: element.id,
        role: element.role,
        name: element.name,
        value: element.value,
        depth: element.depth,
        bounds: element.bounds ?? null,
        properties: {
          ...(element.properties ?? {}),
          isEnabled: element.isEnabled ?? true,
        },
      })),
      totalElements: snap.totalElements,
    };
    return lastLocalSnapshot;
  }

  const window = pid !== undefined
    ? (await controller.listWindows()).find((entry) => entry.pid === pid) ?? null
    : await controller.getActiveWindow();

  if (!window) {
    throw new Error(`No window found for PID ${pid}`);
  }

  const tree = await readWindowTree(controller, window.pid);
  const walked = flattenElements(tree.elements, depth, 0, []);
  const ids = localElements.fill({ elements: walked.map((entry) => entry.element), context: tree.context }, window.pid, depth);
  const flattened: FlatSnapshotElement[] = [];
  walked.forEach(({ element, depth: elementDepth }, i) => {
    const id = ids[i];
    // Past the id stride an element is listed nowhere rather than addressed wrongly.
    if (id === null || id === undefined) return;
    flattened.push({
      id,
      role: element.role,
      name: element.name,
      value: element.value,
      depth: elementDepth,
      bounds: element.bounds,
      properties: element.properties,
    });
  });

  lastLocalSnapshot = {
    window: { pid: window.pid, title: window.title, className: window.className },
    elements: flattened,
    totalElements: flattened.length,
  };
  return lastLocalSnapshot;
}

function formatSnapshot(snapshot: LocalSnapshot): string {
  const lines = [
    `Window: ${snapshot.window.title || '(untitled)'}`,
    `PID: ${snapshot.window.pid}`,
    `Class: ${snapshot.window.className || 'unknown'}`,
    '',
  ];

  if (snapshot.elements.length === 0) {
    lines.push('(no UI elements found)');
    return lines.join('\n');
  }

  lines.push(`--- UI Elements (${snapshot.elements.length}/${snapshot.totalElements}) ---`);
  for (const element of snapshot.elements) {
    const details: string[] = [];
    if (element.name) details.push(`"${element.name}"`);
    if (element.value) details.push(`value="${element.value}"`);
    const className = typeof element.properties.className === 'string' ? element.properties.className : null;
    if (className) details.push(`class="${className}"`);
    if (element.bounds) details.push(`bounds=${formatBounds(element.bounds)}`);
    lines.push(`${'  '.repeat(element.depth)}[${element.id}] ${element.role || 'element'}${details.length > 0 ? ` ${details.join(' ')}` : ''}`);
  }

  return lines.join('\n');
}

/**
 * T26b — read-only accessor used by the pebble-narration path to fly
 * the pebble to a clickable element BEFORE desktop_click executes.
 * Returns null if the cache doesn't have the id yet (caller falls back
 * to label-only narration).
 */
export function getCachedElementBounds(elementId: number): UIElement['bounds'] | null {
  return localElements.lookup(elementId)?.element.bounds ?? null;
}

/**
 * The element an id names, as a fresh walk of the same window finds it, or a
 * `not_started` refusal (#704). What is clicked is that live element, never
 * the cached copy.
 */
function confirmedLocalElement(controller: SnapshotCapableController, elementId: number): Promise<UIElement> {
  return resolveElement(localElements, elementId, (pid, depth) => walkLocalElements(controller, pid, depth), uiElementPrint);
}

function withAction(element: UIElement, action?: string): UIElement {
  if (!action || action === 'click') {
    return element;
  }

  return {
    ...element,
    properties: {
      ...element.properties,
      action,
    },
  };
}

function unsupportedAction(action: string): never {
  throw new ActionOutcomeError({ status: 'blocked', code: 'DESKTOP_ACTION_UNSUPPORTED', effect: 'not_started',
    message: `Error: Local desktop action "${action}" is not supported by this platform controller.` });
}

async function executeLocal<T>(fn: (controller: SnapshotCapableController) => Promise<T>): Promise<T> {
  const disabled = isToolDisabled();
  if (disabled) {
    throw new ActionOutcomeError({ status: 'blocked', code: 'LOCAL_TOOLS_DISABLED', message: disabled, effect: 'not_started' });
  }

  try {
    return await fn(getLocalController());
  } catch (error) {
    if (error instanceof ActionOutcomeError) throw error;
    // A local controller can throw after a partial action. Without a receipt
    // it is unsafe to turn this into success or claim that retry is safe.
    throw new ActionOutcomeError({ status: 'unknown', code: 'LOCAL_DESKTOP_OUTCOME_UNKNOWN',
      message: `Error: ${error instanceof Error ? error.message : String(error)}`, effect: 'may_have_occurred' });
  }
}

function normalizeKeys(keys: string): string[] {
  return keys
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function matchesElement(element: FlatSnapshotElement, params: Record<string, unknown>): boolean {
  const expectedName = typeof params.name === 'string' ? params.name : null;
  const expectedRole = typeof params.control_type === 'string' ? params.control_type.toLowerCase() : null;
  const expectedAutomationId = typeof params.automation_id === 'string' ? params.automation_id : null;
  const expectedClassName = typeof params.class_name === 'string' ? params.class_name : null;

  if (expectedName && element.name !== expectedName) return false;
  if (expectedRole && element.role.toLowerCase() !== expectedRole) return false;
  if (expectedAutomationId && element.properties.automationId !== expectedAutomationId) return false;
  if (expectedClassName && element.properties.className !== expectedClassName) return false;

  return true;
}

function formatElementMatches(matches: FlatSnapshotElement[]): string {
  if (matches.length === 0) {
    return 'No matching elements found.';
  }

  return matches
    .map((element) => `[${element.id}] ${element.role || 'element'} "${element.name || '(unnamed)'}"`)
    .join('\n');
}

// --- Tool definitions ---

export const desktopListWindowsTool: ToolDefinition = {
  name: 'desktop_list_windows',
  description: 'List all visible windows on the desktop. Returns window titles, PIDs, class names, and positions. Use the PID with other desktop tools to target a specific window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_list_windows');
    if (target) {
      return routeToSidecar(target, 'list_windows', params, 'desktop');
    }
    return executeLocal(async (controller) => formatWindows(await controller.listWindows()));
  },
};

export const desktopSnapshotTool: ToolDefinition = {
  name: 'desktop_snapshot',
  description: 'Get the UI element tree of a window (like browser_snapshot but for desktop apps). Each element has an [id] you can use with desktop_click and desktop_type. If no pid is given, snapshots the active (focused) window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window (from desktop_list_windows). Omit for the active window.',
      required: false,
    },
    depth: {
      type: 'number',
      description: 'Max tree depth to walk (default: 8). Decrease for faster but shallower snapshots.',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_snapshot');
    if (target) {
      // A snapshot taken elsewhere is now the latest one, so the last local
      // snapshot's ids are not current any more (#704 review).
      localElements.forget();
      return routeToSidecar(target, 'get_window_tree', params, 'desktop');
    }
    return executeLocal((controller) => serializedLocal(async () => {
      const snapshot = await buildLocalSnapshot(controller, params.pid as number | undefined, (params.depth as number | undefined) ?? 8);
      return formatSnapshot(snapshot);
    }));
  },
};

export const desktopClickTool: ToolDefinition = {
  name: 'desktop_click',
  description: 'Click or interact with a UI element by its [id] from the last desktop_snapshot or desktop_find_element. Default action is "click". Use the action parameter for richer interactions like double_click, right_click, invoke, toggle, set_value, expand, etc. Available actions vary by platform.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    element_id: {
      type: 'number',
      description: 'The [id] of the element to interact with (from desktop_snapshot or desktop_find_element)',
      required: true,
    },
    // The enum is ENFORCED by ToolRegistry, not just advertised, so it is a
    // gate: an action the sidecar gains but this list does not is unreachable
    // from the agent. The accepted set lives in the sidecar (Go), with no
    // shared TS definition, so add new actions in both places --
    // tool-enums.test.ts parses the three Go switches and fails if this list
    // and their union differ in either direction (#657: `get_text` sat here
    // for every platform while no switch had a case for it).
    action: {
      type: 'string',
      description: 'Action to perform (default click). invoke/toggle/select/set_value/get_value/expand/collapse/scroll_into_view are Windows-only; macOS and Linux support click/double_click/right_click/focus.',
      required: false,
      enum: ['click', 'double_click', 'right_click', 'invoke', 'toggle', 'select', 'set_value', 'get_value', 'expand', 'collapse', 'scroll_into_view', 'focus'],
    },
    value: {
      type: 'string',
      description: 'Value to set (only for set_value action)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_click');
    if (target) {
      return routeToSidecar(target, 'click_element', params, 'desktop');
    }
    return executeLocal((controller) => serializedLocal(async () => {
      const action = (params.action as string | undefined) ?? 'click';
      if (!['click', 'double_click', 'right_click', 'focus'].includes(action)) {
        return unsupportedAction(action);
      }
      if (typeof controller.clickById === 'function') {
        if (action !== 'click') {
          return unsupportedAction(action);
        }
        return controller.clickById(params.element_id as number);
      }
      const element = withAction(await confirmedLocalElement(controller, params.element_id as number), action);
      await controller.clickElement(element);
      return `Clicked element [${params.element_id}] with action "${action}".`;
    }));
  },
};

/**
 * Why the three tools below declare this and their siblings do not (#629).
 *
 * The declaration frames a tool's THROWN failure text and moves nothing else;
 * `UNTRUSTED_TOOL_NAMES` frames the whole result and also drives `outsideReach`,
 * `FRAMED_ACTORS`, the tool filter's I1 repair and the taint predicate. The
 * right mechanism is decided by what the SUCCESS reply carries, and these three
 * carry nothing from the target machine: `{success, chars}` on Windows and
 * `{success: true}` elsewhere for type_text, `{success, keys}` for press_keys
 * plus our own `xdotool_combo` conversion of those keys on Linux -- the
 * model's own arguments and our own rendering of them -- and, for
 * capture_screen, an image on both branches: since #658 the sidecar branch
 * returns the image block plus one sentence of our own built from the reply's
 * validated width and height (`routeScreenshotToSidecar`), where it used to
 * stringify the whole reply, base64 and all. No remote text on either.
 *
 * Their FAILURES are a different matter, and the reason all nine of these tools
 * need something: with a `target` they dispatch through `routeToSidecarAction`,
 * and `dispatchToSidecar` throws an `ActionOutcomeError` whose message carries
 * the reply the remote machine sent or a `SidecarRPCError`'s text. That reaches
 * the model, and until this declaration nothing framed it.
 *
 * TAINT, which this mechanism does not touch: `markUntrustedToolFailure` never
 * reaches `isTaintSourceTool`, so desktop_type and desktop_press_keys frame
 * their failure text and leave the turn clean. Decided, not overlooked. The
 * only outside bytes they can deliver are a refusal's prose, the turn is
 * tainted already whenever one of these follows a snapshot, and both tools
 * raise an approval card on every call via `REVIEWED_UI_TOOLS` -- so taint
 * would add a second gate behind a first one for text that says why a
 * keystroke did not land. desktop_screenshot is the exception and taints,
 * through `TAINT_ONLY_TOOLS`, because what it delivers is a picture of the
 * screen.
 *
 * desktop_screenshot takes this route rather than the name set for two reasons
 * beyond its success reply. It is `read_data` (rank 100), so
 * `outsideReach === 'fetch'` is the ONLY clause making it an invariant trigger:
 * framing it by name would flip that to false and stop the one tool that most
 * needs to force the framed readers to stay from doing so. And it is not an
 * actor, so it would land in `isFramedPerception` and the I1 repair would
 * force-add a screenshot tool to every filtered turn. Taint is already settled
 * for it by `TAINT_ONLY_TOOLS`, so the declaration is all that was missing.
 *
 * desktop_click, desktop_launch_app and desktop_focus_window go the other way,
 * by name; see `UNTRUSTED_TOOL_NAMES` in roles/untrusted.ts for the fields that
 * decide it. Framing by name covers their failures too, so they do not also
 * declare this -- `markUntrustedToolFailure` wraps a name-framed tool once.
 */
export const desktopTypeTool: ToolDefinition = {
  name: 'desktop_type',
  description: 'Type text into a UI element. Optionally provide an element_id to click and focus it first. Without element_id, types into whatever is currently focused.',
  category: 'desktop',
  failureIsOutsideContent: true,
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    text: {
      type: 'string',
      description: 'The text to type',
      required: true,
    },
    element_id: {
      type: 'number',
      description: 'Optional [id] of element to click before typing (from desktop_snapshot)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_type');
    if (target) {
      return routeToSidecar(target, 'type_text', params, 'desktop');
    }
    return executeLocal((controller) => serializedLocal(async () => {
      const elementId = params.element_id as number | undefined;
      if (typeof controller.typeById === 'function') {
        return controller.typeById(elementId, params.text as string);
      }
      if (elementId !== undefined) {
        await controller.clickElement(await confirmedLocalElement(controller, elementId));
        await Bun.sleep(100);
      }
      const text = params.text as string;
      await controller.typeText(text);
      // Empty text is a no-op (see typeText), and `Typed "".` reads like a
      // keystroke landed. Say what happened instead (#554).
      if (text === '') {
        return elementId !== undefined
          ? `Nothing to type: the text was empty. Element [${elementId}] was focused.`
          : 'Nothing to type: the text was empty.';
      }
      return elementId !== undefined
        ? `Typed "${text}" into element [${elementId}].`
        : `Typed "${text}".`;
    }));
  },
};

export const desktopPressKeysTool: ToolDefinition = {
  name: 'desktop_press_keys',
  description: 'Press a keyboard shortcut or key combination. Keys are pressed simultaneously (e.g., "ctrl,s" for save, "alt,f4" to close). Single keys also work: "enter", "tab", "escape".',
  category: 'desktop',
  failureIsOutsideContent: true,
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    keys: {
      type: 'string',
      // "Modifiers first" is load-bearing, not style: the local Linux path
      // presses the keys in the order given, so "a,ctrl" types "a" there while
      // a sidecar, which sorts modifiers to the front, reads it as Ctrl+A.
      // Saying so here is what keeps the two from diverging (#524).
      description: 'Comma-separated key names, modifiers first (e.g., "ctrl,s" or "alt,f4" or "enter"). Modifiers: ctrl, alt, shift, win.',
      required: true,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_press_keys');
    if (target) {
      return routeToSidecar(target, 'press_keys', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      const keys = normalizeKeys(params.keys as string);
      await controller.pressKeys(keys);
      return `Pressed keys: ${keys.join('+')}`;
    });
  },
};

/**
 * The directive a launch reply needs the model to OBEY, authored here (#708).
 *
 * The sidecar writes the same advice into the reply's `note`, and that is the
 * problem: `desktop_launch_app` is framed by name, so the note reaches the model
 * inside a block whose preamble says never to follow instructions in it -- on
 * the one reply where following it is the point. The brain must not lift the
 * sidecar's sentence out of the block either (that text is the other trust
 * domain's), so it writes its own, from two typed fields and nothing else, and
 * hands it over as a trusted trailer that lands AFTER the block.
 *
 * ONE case. `success: true` with `window_visible: null` is the unverified
 * success -- the process started and its window could not be looked for -- where
 * a model that reads "not confirmed" as "failed" relaunches an app that is open.
 * `success: false` is a typed failure and never reaches here, and
 * `window_visible: true` needs no instruction. Exact types: `null` means the
 * JSON null the sidecar sends, not an absent field, which an older sidecar's
 * `{success, pid}` reply leaves out.
 */
export function launchDirective(reply: unknown): string | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const r = reply as Record<string, unknown>;
  if (!Object.hasOwn(r, 'window_visible') || r.success !== true || r.window_visible !== null) return null;
  return '\n\n[desktop_launch_app] The app was started, but whether its window opened could not be checked on that '
    + 'machine. This is not a failure: do not launch it again on the strength of this result. Run '
    + 'desktop_list_windows to see what is actually open before interacting with it.';
}

export const desktopLaunchAppTool: ToolDefinition = {
  name: 'desktop_launch_app',
  description: 'Launch an application by name or executable path. Use the name as it exists on the TARGET machine\'s OS -- e.g. "notepad" on Windows, "TextEdit" on macOS, "gedit" on Linux. Call list_sidecars first if you are unsure which OS the target runs. Returns the PID plus what is known about the app\'s window. When routed to a sidecar, "success" answers "is the app on screen?", not "did a process start?": success true with window_visible true means a window was seen and you can interact with it; success false with window_visible false means the process started but no window appeared (still loading, windowless, or it exited) - read the "note" and check desktop_list_windows rather than launching again; window_visible null means the window could NOT be checked on this machine, which is not a failure - the app may well be open, so verify with desktop_list_windows instead of relaunching.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    executable: {
      type: 'string',
      description: "Application name or executable path, spelled for the target machine's OS",
      required: true,
    },
    args: {
      type: 'string',
      description: 'Optional command-line arguments',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_launch_app');
    if (target) {
      const { text, reply } = await routeToSidecarActionReply(target, 'launch_app', params, 'desktop');
      const directive = launchDirective(reply);
      return directive ? withTrustedTrailer(text, directive) : text;
    }
    return executeLocal(async (controller) => {
      if (typeof controller.launchApp !== 'function') {
        throw new Error(`Local app launch is not supported on ${process.platform}`);
      }
      const result = await controller.launchApp(params.executable as string, params.args as string | undefined);
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    });
  },
};

export const desktopScreenshotTool: ToolDefinition = {
  name: 'desktop_screenshot',
  description: 'Take a screenshot of the entire desktop or a specific window. The image is sent directly to the AI for visual analysis. Useful for complex UIs, graphics apps, or when the element tree is insufficient.',
  category: 'desktop',
  failureIsOutsideContent: true,
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of window to capture. Honoured only when the screenshot is taken on this machine without a sidecar: whenever it goes to a sidecar, including one picked automatically when no target is given, a pid is refused, because a sidecar captures the whole screen. Omit for full desktop screenshot.',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'screenshot', 'desktop_screenshot');
    if (target) {
      // A sidecar's capture_screen has no window capture and used to ignore
      // `pid`, so a request for ONE window came back as the whole desktop with
      // nothing saying so (#710). Refused rather than widened or captioned:
      // whatever else is on that screen -- another app, a password manager --
      // was never asked for, and once its pixels are in a provider request
      // there is no taking them back. Refusing costs the model one more call
      // if it does want the whole desktop, and makes that its decision.
      if (params.pid !== undefined && params.pid !== null) {
        throw new ActionOutcomeError({ status: 'blocked', code: 'SCREENSHOT_WINDOW_UNSUPPORTED', effect: 'not_started',
          message: 'Error: a sidecar can only capture the whole screen, not one window, so nothing was captured. '
            + 'Call desktop_screenshot without pid if the whole screen is what you need, or use desktop_snapshot with this pid to read that window\'s elements.' });
      }
      // The picture, as the local branch below returns it (#658).
      return routeScreenshotToSidecar(target, params, true);
    }
    return executeLocal(async (controller) => {
      let base64: string;
      let mimeType = 'image/png';

      if (typeof controller.screenshotBase64 === 'function') {
        const image = await controller.screenshotBase64(params.pid as number | undefined);
        base64 = image.base64;
        mimeType = image.mimeType;
      } else {
        const buffer = params.pid !== undefined
          ? await controller.captureWindow(params.pid as number)
          : await controller.captureScreen();
        base64 = buffer.toString('base64');
      }

      // Awaited for symmetry with capture_screen; executeLocal awaits it either way.
      return await localScreenshotResult(base64, mimeType, 'Desktop screenshot captured', true);
    });
  },
};

export const desktopFocusWindowTool: ToolDefinition = {
  name: 'desktop_focus_window',
  description: 'Bring a window to the foreground by its PID (from desktop_list_windows). Use this before interacting with a background window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window to focus',
      required: true,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_focus_window');
    if (target) {
      return routeToSidecar(target, 'focus_window', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      await controller.focusWindow(params.pid as number);
      return `Focused window PID ${params.pid as number}.`;
    });
  },
};

export const desktopFindElementTool: ToolDefinition = {
  name: 'desktop_find_element',
  description: 'Search for UI elements by property (name, control type, class name, automation ID). Returns matching elements with [id] for use with desktop_click and desktop_type. Useful when you know what you are looking for without scanning the full tree.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window. Omit for the foreground window.',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Element name to search for (exact match)',
      required: false,
    },
    control_type: {
      type: 'string',
      description: 'Control type to filter by (e.g., Button, Edit, Text, ComboBox, ListItem, TreeItem, MenuItem, Tab)',
      required: false,
    },
    automation_id: {
      type: 'string',
      description: 'AutomationId to search for (Windows only, ignored on other platforms)',
      required: false,
    },
    class_name: {
      type: 'string',
      description: 'Class name to search for',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveDesktopTarget(params.target, 'desktop', 'desktop_find_element');
    if (target) {
      // Same as desktop_snapshot: a find elsewhere mints the current ids.
      localElements.forget();
      return routeToSidecar(target, 'find_element', params, 'desktop');
    }
    return executeLocal((controller) => serializedLocal(async () => {
      if (!params.name && !params.control_type && !params.automation_id && !params.class_name) {
        throw new Error('At least one search filter is required.');
      }
      const snapshot = await buildLocalSnapshot(controller, params.pid as number | undefined);
      return formatElementMatches(snapshot.elements.filter((element) => matchesElement(element, params)));
    }));
  },
};

/**
 * All desktop tools in a single array — platform-agnostic.
 */
export const DESKTOP_TOOLS: ToolDefinition[] = [
  desktopListWindowsTool,
  desktopSnapshotTool,
  desktopClickTool,
  desktopTypeTool,
  desktopPressKeysTool,
  desktopLaunchAppTool,
  desktopScreenshotTool,
  desktopFocusWindowTool,
  desktopFindElementTool,
];
