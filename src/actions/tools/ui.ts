/**
 * UI Tools - the structural-runtime agent surface.
 *
 * ui_snapshot / ui_act are the primary perception+action path: an
 * interactable-first accessibility view with durable refs, and an act
 * primitive that re-resolves the ref on a fresh capture before dispatching
 * and then checks a postcondition instead of trusting the action fired. The
 * legacy desktop and browser tools remain as the low-level escape hatch.
 *
 * Authority: ui_snapshot is `read_data`, ui_act is `control_app` - the same
 * category as desktop_click, because that is what it dispatches to. Both are
 * registered in src/authority/tool-action-map.ts; both are untrusted-content
 * sources in src/roles/untrusted.ts, since what they return is element text
 * straight off a page or an app window.
 */

import type { ToolDefinition } from './registry.ts';
import { getSidecarManager, autoTargetForCapability } from './sidecar-route.ts';
import { captureSurface, type CaptureKind } from '../../structural/surface.ts';
import { verifyPostcondition, nextHealRung, type Postcondition, type HealRung } from '../../structural/verifier.ts';
import { resolveRef } from '../../structural/resolver.ts';
import { recordPerception } from '../../structural/telemetry.ts';
import type { SemanticNode, SemanticSurface } from '../../structural/types.ts';
import { uiEffectHints } from '../../authority/ui-intent';

const ACT_RPC_TIMEOUT = { initial: 30_000, max: 60_000 };
/** Below this the surface is mostly canvas/custom-drawn and vision wins. */
const LOW_COVERAGE = 0.4;
/** Pause before the last verification re-read, for async UI. */
const SETTLE_MS = 400;
/** How many snapshots' worth of [id]s stay addressable. */
const MAX_REMEMBERED_SNAPSHOTS = 4;

/**
 * What a `[id]` in tool output refers to.
 *
 * Ids are drawn from one process-wide counter and never reused. They are NOT
 * the provider's element ids: those are session-scoped and reassigned on
 * every walk, so the same integer means different elements in two captures.
 * They are also not per-(kind,target) slots, which is what this used to be -
 * two orchestrators in one daemon (chat and the background agent) share this
 * module, so a snapshot taken by one between the other's snapshot and its act
 * would have silently re-pointed the other's [id] at a different element.
 * A globally unique id cannot collide that way: an id either resolves to the
 * exact node that was shown under it, or to nothing.
 */
type AddressedElement = {
  node: SemanticNode;
  kind: CaptureKind;
  /** Canonical sidecar id, not the name the caller happened to use. */
  target: string;
  pid?: number;
  title: string;
  url?: string;
};

const addressed = new Map<number, AddressedElement>();
/** Ids per snapshot, oldest first - the eviction queue for `addressed`. */
const snapshotIds: number[][] = [];
let nextId = 1;

/** Sidecars are addressable by id or name; remember snapshots by id only. */
function canonicalTarget(target: string): string {
  const s = getSidecarManager()?.listSidecars().find((x) => x.id === target || x.name === target);
  return s?.id ?? target;
}

/** Register a capture's nodes and return the `[id]` shown for each, in order. */
function addressSurface(surface: SemanticSurface, kind: CaptureKind, target: string, pid?: number): number[] {
  // Resolved once, not per node: a large window is hundreds of elements and
  // this walks the sidecar list.
  const canonical = canonicalTarget(target);
  const ids = surface.nodes.map((node) => {
    const id = nextId++;
    addressed.set(id, { node, kind, target: canonical, pid, title: surface.root.title ?? '', url: surface.root.url });
    return id;
  });
  snapshotIds.push(ids);
  while (snapshotIds.length > MAX_REMEMBERED_SNAPSHOTS) {
    for (const stale of snapshotIds.shift() ?? []) addressed.delete(stale);
  }
  return ids;
}

/** Test seam: forget every addressed element. */
export function resetUiSnapshots(): void {
  addressed.clear();
  snapshotIds.length = 0;
  nextId = 1;
}

/** Actions the browser provider can carry out; anything else must fail loudly. */
const BROWSER_ACTIONS = new Set(['click', 'set_value']);
/** Actions that only read, so there is nothing to verify or diff. */
const READ_ONLY_ACTIONS = new Set(['get_value']);

function fmtNode(n: SemanticNode, id: number): string {
  const bits: string[] = [`[${id}] ${n.role}`];
  if (n.name) bits.push(`"${n.name}"`);
  if (n.value) bits.push(`= "${truncate(n.value, 40)}"`);
  const flags: string[] = [];
  if (n.state.enabled === false) flags.push('disabled');
  if (n.state.focused) flags.push('focused');
  if (n.state.checked) flags.push('checked');
  if (n.state.selected) flags.push('selected');
  if (n.state.expanded !== undefined) flags.push(n.state.expanded ? 'expanded' : 'collapsed');
  if (n.state.offscreen) flags.push('offscreen');
  if (flags.length) bits.push(`(${flags.join(', ')})`);
  if (n.actions.length) bits.push(`{${n.actions.join('/')}}`);
  return bits.join(' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function formatSurface(surface: SemanticSurface, ids: number[]): string {
  const cov = Math.round(surface.coverage * 100);
  const header =
    surface.provider === 'cdp'
      ? `Page: ${surface.root.title || '(untitled)'}  ${surface.root.url ?? ''}`
      : `Window: ${surface.root.title || '(untitled)'}  [pid ${surface.root.pid ?? '?'}]`;

  const lines = [header, `Coverage: ${cov}% structural`, ''];
  if (surface.nodes.length === 0) {
    lines.push('(no salient elements - the surface may be canvas/custom-drawn; use a screenshot)');
  } else {
    surface.nodes.forEach((n, i) => lines.push(fmtNode(n, ids[i]!)));
  }
  if (surface.coverage < LOW_COVERAGE) {
    lines.push(
      '',
      'Low structural coverage - this surface is largely canvas/custom-drawn. Prefer desktop_screenshot/browser_screenshot (vision) for elements not listed above.',
    );
  }
  return lines.join('\n');
}

async function dispatchAct(
  kind: CaptureKind,
  target: string,
  sessionId: number,
  action: string,
  value?: string,
): Promise<unknown> {
  const manager = getSidecarManager();
  if (!manager) throw new Error('Sidecar system not initialized');
  const sidecar = manager.listSidecars().find((s) => s.id === target || s.name === target);
  const id = sidecar?.id ?? target;

  if (kind === 'browser') {
    if (!BROWSER_ACTIONS.has(action)) {
      // A read-only or unsupported action must not silently become a click.
      throw new Error(`action "${action}" is not available for kind="browser" (supported: click, set_value); use ui_snapshot to read state`);
    }
    if (action === 'set_value') {
      return manager.dispatchRPC(id, 'browser_ax_set_value', { backend_node_id: sessionId, value }, ACT_RPC_TIMEOUT);
    }
    return manager.dispatchRPC(id, 'browser_ax_click', { backend_node_id: sessionId }, ACT_RPC_TIMEOUT);
  }
  // desktop -> click_element handles all action variants
  return manager.dispatchRPC(id, 'click_element', { element_id: sessionId, action, value }, ACT_RPC_TIMEOUT);
}

/**
 * Build the postcondition named by `verify`. Returns a string when the request
 * names a real check that cannot be built from what was passed, so the caller
 * can say why instead of silently acting unverified.
 */
export function parsePostcondition(
  raw: unknown,
  acted: SemanticNode,
  beforeTitle: string | undefined,
  value: string | undefined,
): Postcondition | string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  switch (raw.toLowerCase()) {
    case 'window_appeared': return { kind: 'window_appeared' };
    case 'element_gone': return { kind: 'element_gone', ref: acted.ref };
    case 'element_present': return { kind: 'element_present', ref: acted.ref };
    case 'focus_moved': return { kind: 'focus_moved', fromRef: acted.ref };
    case 'title_changed': return { kind: 'title_changed', from: beforeTitle ?? '' };
    case 'value_equals':
      if (value === undefined) {
        return 'verify="value_equals" needs the value parameter (the text you expect the element to hold afterwards)';
      }
      return { kind: 'value_equals', ref: acted.ref, value };
    default:
      return `unknown verify "${raw}" (supported: window_appeared, element_gone, element_present, focus_moved, title_changed, value_equals)`;
  }
}

export const uiSnapshotTool: ToolDefinition = {
  name: 'ui_snapshot',
  description:
    'Perceive the current app or web page as an accessibility tree: an interactable-first list of elements, each with an [id] you pass to ui_act. This is the PRIMARY way to see UI - prefer it over screenshots. Reports a structural coverage %; when coverage is low the surface is canvas/custom-drawn and you should fall back to a screenshot. Set kind="browser" for the web page, "desktop" for a native window (optionally target a pid).',
  category: 'ui',
  parameters: {
    kind: { type: 'string', description: 'What to perceive: "desktop" (native window) or "browser" (web page). Default "desktop".', required: false, enum: ['desktop', 'browser'] },
    pid: { type: 'number', description: 'Desktop only: window PID (from desktop_list_windows). Omit for the foreground window.', required: false },
    full: { type: 'boolean', description: 'Return the full tree instead of the salience-filtered interactable view. Default false - only set when the element you need is missing from the filtered list.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select the connected one).', required: false },
  },
  execute: async (params) => {
    const kind = (params.kind === 'browser' ? 'browser' : 'desktop') as CaptureKind;
    const cap = kind === 'browser' ? 'browser' : 'desktop';
    const target = (params.target as string | undefined)?.trim() || autoTargetForCapability(cap) || '';
    if (!target) return `Error: no connected sidecar with the "${cap}" capability`;
    try {
      const pid = params.pid as number | undefined;
      const { surface } = await captureSurface({
        kind,
        target,
        pid,
        full: params.full === true,
      });
      const ids = addressSurface(surface, kind, target, pid ?? surface.root.pid);
      recordPerception({
        provider: surface.provider,
        action: 'snapshot',
        coverage: surface.coverage,
        visionRecommended: surface.coverage < LOW_COVERAGE ? 'low_coverage' : undefined,
        detail: `${surface.nodes.length} salient nodes`,
      });
      return formatSurface(surface, ids);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const uiActTool: ToolDefinition = {
  name: 'ui_act',
  description:
    'Act on an element from a recent ui_snapshot by its [id], then VERIFY the effect. Actions: click, set_value (needs value), toggle, select, expand, collapse, focus, scroll_into_view, get_value. Optionally pass verify to confirm the outcome (window_appeared | element_gone | element_present | focus_moved | title_changed | value_equals). The action is dispatched EXACTLY ONCE and is never re-sent: if verification does not hold, the runtime re-reads the surface a couple of times and then reports the outcome as unconfirmed, with a diff of what changed. Decide from that diff whether to act again - an unconfirmed action may still have happened. Always returns what actually changed, so you do not need a separate snapshot to check.',
  category: 'ui',
  captureApprovalGuard: (params) => {
    const id = params.element_id as number;
    const entry = addressed.get(id);
    // Compare the captured object, not its recyclable numeric ID. The
    // approval manager also refuses bindings lost on daemon restart.
    return () => !!entry && addressed.get(id) === entry;
  },
  authorityGate: (params) => {
    if (params.action === 'get_value') return null;
    const entry = addressed.get(params.element_id as number);
    if (!entry) return null; // rawUiGate still demands review; execute refuses a missing ref.
    const hints = uiEffectHints(String(params.action || 'click'), entry.node.name,
      `${entry.title} ${entry.url ?? ''}`, String(params.value ?? ''));
    return { actionCategory: 'control_app',
      actionCategories: [...hints, ...(entry.kind === 'browser' ? ['access_browser' as const] : [])],
      confirm: 'always',
      intent: `Review ${String(params.action || 'click')} on ${entry.kind} element [${params.element_id}] ${JSON.stringify(entry.node.name)} on ${entry.target}. Business effect unknown beyond UI hints${hints.length ? ` (${hints.join(', ')})` : ''}; inspect the current screen and arguments. UI labels do not prove what an action will do.`,
    };
  },
  parameters: {
    element_id: { type: 'number', description: 'The [id] of the target element from a recent ui_snapshot. The id carries its own window/page and sidecar, so there is nothing else to pass.', required: true },
    action: { type: 'string', description: 'What to do to the element. Default click. Browser elements support only click and set_value.', required: false, enum: ['click', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scroll_into_view', 'get_value'] },
    value: { type: 'string', description: 'The text to set (required for set_value; also the expected text for verify="value_equals").', required: false },
    verify: { type: 'string', description: 'Optional postcondition to confirm after acting; on failure the runtime re-reads the surface before reporting.', required: false, enum: ['window_appeared', 'element_gone', 'element_present', 'focus_moved', 'title_changed', 'value_equals'] },
  },
  execute: async (params) => {
    const action = (params.action as string) || 'click';
    const elementId = params.element_id as number;
    const value = params.value as string | undefined;

    // The [id] names the element, the surface it came from, and the sidecar
    // and window it lives on. Nothing is inferred from the current
    // foreground window or from a "most recent" snapshot that another agent
    // in this process may have replaced.
    const entry = addressed.get(elementId);
    if (!entry) {
      return addressed.size === 0
        ? `Error: no ui_snapshot has been taken yet - take one and use an [id] from its output`
        : `Error: [${elementId}] is not from any recent ui_snapshot - take a fresh ui_snapshot and use an [id] from that result`;
    }
    const { node: actedRef, kind, target, pid } = entry;
    if (kind === 'browser' && !BROWSER_ACTIONS.has(action)) {
      return `Error: action "${action}" is not available for kind="browser" (supported: click, set_value); use ui_snapshot to read state`;
    }

    let before: SemanticNode[] = [];
    let beforeTitle: string | undefined;
    try {
      const pre = await captureSurface({ kind, target, pid, full: false });
      before = pre.surface.nodes;
      beforeTitle = pre.surface.root.title;
      if (!READ_ONLY_ACTIONS.has(action) && (pre.surface.root.url !== entry.url || (pre.surface.root.title ?? '') !== entry.title)) {
        return 'Error: the UI surface changed since review - nothing was done; take a fresh ui_snapshot and review the action again';
      }
    } catch (err) {
      return `Error: could not re-capture the surface before acting (${err instanceof Error ? err.message : String(err)}) - nothing was done`;
    }

    // Element ids churn between captures; the durable ref is what survives.
    const live = resolveRef(actedRef.ref, before);
    if (!live.node) {
      return `Error: ${actedRef.role} "${actedRef.name}" [${elementId}] is no longer on the surface (best match ${Math.round(live.confidence * 100)}%) - nothing was done; take a fresh ui_snapshot`;
    }

    const pc = parsePostcondition(params.verify, actedRef, beforeTitle, value);
    if (!READ_ONLY_ACTIONS.has(action) && (live.node.name !== actedRef.name || live.node.role !== actedRef.role)) {
      return 'Error: the UI control changed since review - nothing was done; take a fresh ui_snapshot and review the action again';
    }
    if (typeof pc === 'string') return `Error: ${pc} - nothing was done`;

    let actResult: unknown;
    try {
      actResult = await dispatchAct(kind, target, live.node.sessionId, action, value);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Read-only actions need no verification/diff.
    if (READ_ONLY_ACTIONS.has(action)) {
      return `${action} -> ${JSON.stringify(actResult)}`;
    }

    const how = live.method === 'sig' || live.method === 'stableId'
      ? ''
      : ` (re-found by ${live.method}, ${Math.round(live.confidence * 100)}%)`;
    const lines: string[] = [`Acted: ${action}${value !== undefined ? ` "${truncate(value, 40)}"` : ''} on [${elementId}] ${actedRef.role} "${actedRef.name}"${how}`];

    // Re-read for verification + diff, climbing the self-heal ladder. Every
    // rung re-observes; none re-dispatches. See verifier.ts for why.
    const attempted: HealRung[] = [];
    let satisfied = !pc;
    let after: SemanticNode[] = [];
    let afterTitle: string | undefined;
    let coverage = 0;

    for (;;) {
      try {
        // Same window as the snapshot: a diff against a different window
        // would report changes that never happened to this one.
        const post = await captureSurface({ kind, target, pid, full: false });
        after = post.surface.nodes;
        afterTitle = post.surface.root.title;
        coverage = post.surface.coverage;
      } catch {
        after = [];
        afterTitle = undefined;
      }
      if (!pc) break;

      const v = verifyPostcondition(pc, {
        before, beforeTitle, after, afterTitle,
        surfacePresent: after.length > 0,
      });
      if (v.satisfied) {
        satisfied = true;
        lines.push(`Verified: ${v.detail}`);
        break;
      }

      const rung = nextHealRung({ attempted });
      if (rung === null || rung === 'report') {
        if (rung) attempted.push(rung);
        lines.push(
          `NOT VERIFIED: ${v.detail}.`,
          `The ${action} was dispatched once and was NOT repeated - it may still have taken effect. Read the diff below before deciding; if you need certainty, take a screenshot or ask the user.`,
        );
        break;
      }
      attempted.push(rung);
      if (rung === 'settle') await new Promise((res) => setTimeout(res, SETTLE_MS));
    }

    lines.push(diffSurface(before, after));

    recordPerception({
      provider: kind === 'browser' ? 'cdp' : 'uia',
      action,
      coverage,
      verified: pc ? satisfied : undefined,
      visionRecommended: pc && !satisfied ? 'unverified_outcome' : undefined,
      detail: attempted.length ? `self-heal: ${attempted.join(' -> ')}` : undefined,
    });
    return lines.join('\n');
  },
};

/** Compact before->after diff by named-element set + focus changes. */
function diffSurface(before: SemanticNode[], after: SemanticNode[]): string {
  const beforeNames = new Set(before.map((n) => `${n.role}|${n.name}`));
  const afterNames = new Set(after.map((n) => `${n.role}|${n.name}`));
  const appeared = after.filter((n) => n.name && !beforeNames.has(`${n.role}|${n.name}`)).slice(0, 8);
  const gone = before.filter((n) => n.name && !afterNames.has(`${n.role}|${n.name}`)).slice(0, 8);
  const focused = after.find((n) => n.state.focused);

  const parts: string[] = ['Changed:'];
  if (appeared.length) parts.push(`  appeared: ${appeared.map((n) => `${n.role} "${n.name}"`).join(', ')}`);
  if (gone.length) parts.push(`  gone: ${gone.map((n) => `${n.role} "${n.name}"`).join(', ')}`);
  if (focused) parts.push(`  focus: ${focused.role} "${focused.name}"`);
  if (parts.length === 1) parts.push('  (no visible structural change)');
  return parts.join('\n');
}

export const UI_TOOLS: ToolDefinition[] = [uiSnapshotTool, uiActTool];
