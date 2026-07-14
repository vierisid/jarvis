/**
 * Structural Runtime — surface capture + provider dispatch.
 *
 * Turns a capture request into a SemanticSurface by dispatching to the right
 * sidecar provider (UIA desktop tree or CDP browser AX tree), then applies the
 * salience filter and coverage score that make the structural path the primary
 * one: an interactable-first view (≈10× fewer tokens than a full dump) plus a
 * coverage number that tells the model when to fall back to vision.
 */

import { getSidecarManager, autoTargetForCapability } from '../actions/tools/sidecar-route.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import {
  surfaceFromUia,
  surfaceFromCdp,
  type SemanticSurface,
  type SemanticNode,
  type UiaSemanticElement,
  type CdpAxElement,
} from './types.ts';

export type CaptureKind = 'desktop' | 'browser';

export type CaptureOptions = {
  kind: CaptureKind;
  /** Explicit sidecar name/id; auto-resolved by capability when omitted. */
  target?: string;
  /** Desktop only: window pid (foreground window when omitted). */
  pid?: number;
  /** Desktop only: max tree depth (default 8). */
  depth?: number;
  /** Return the full tree instead of the salience-filtered view. */
  full?: boolean;
};

export type CaptureResult = {
  surface: SemanticSurface;
  /** Nodes after the salience filter (== surface.nodes unless full). */
  salient: SemanticNode[];
  /** The provider + target actually used, for telemetry. */
  meta: { provider: string; target: string };
};

const DESKTOP_RPC_TIMEOUT = { initial: 30_000, max: 60_000 };

function requireManager(): SidecarManager {
  const m = getSidecarManager();
  if (!m) throw new Error('Sidecar system not initialized');
  return m;
}

function resolveTarget(kind: CaptureKind, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const cap = kind === 'browser' ? 'browser' : 'desktop';
  const t = autoTargetForCapability(cap);
  if (!t) throw new Error(`No connected sidecar advertising the "${cap}" capability`);
  return t;
}

/**
 * Roles that are interactable (kept by the salience filter even without a
 * name). Union of UIA control types and ARIA roles so the same filter serves
 * both providers.
 */
const INTERACTABLE_ROLES = new Set([
  // UIA control types
  'Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'Hyperlink',
  'MenuItem', 'ListItem', 'TreeItem', 'TabItem', 'Slider', 'SplitButton',
  'Spinner', 'Document',
  // ARIA roles
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'option', 'textfield',
]);

function isInteractable(node: SemanticNode): boolean {
  if (node.actions.length > 0) return true;
  if (INTERACTABLE_ROLES.has(node.role)) return true;
  return false;
}

/**
 * Salience filter: keep interactable elements, and named text that gives the
 * model context. Drops unnamed structural containers — the depth-8 noise that
 * made the raw dump expensive and hard for small models to read.
 */
export function salienceFilter(nodes: SemanticNode[]): SemanticNode[] {
  return nodes.filter((n) => {
    if (isInteractable(n)) return true;
    // Named static text (labels, headings) is worth keeping as context.
    if (n.name && n.name.trim().length > 0 && n.role !== 'Group' && n.role !== 'Pane') {
      return true;
    }
    return false;
  });
}

/**
 * Coverage in [0, 1]: fraction of the visible interactable+named bounds area
 * that is "named-interactable" (has a name AND an action). Low coverage ⇒ the
 * surface is canvas/custom-drawn (Figma, games, bad-a11y Electron) ⇒ the model
 * should use vision. Desktop-only (bounds required); browser AX has no bounds
 * pre-layout, so browser coverage is approximated by the named-interactable
 * fraction of nodes instead of area.
 */
export function computeCoverage(nodes: SemanticNode[]): number {
  const withBounds = nodes.filter((n) => n.bounds && n.bounds.width > 0 && n.bounds.height > 0);
  if (withBounds.length === 0) {
    // No bounds (browser AX): fall back to a count-based proxy.
    const interactable = nodes.filter(isInteractable);
    if (interactable.length === 0) return 0;
    const named = interactable.filter((n) => n.name.trim().length > 0);
    return named.length / interactable.length;
  }
  let visibleArea = 0;
  let namedInteractableArea = 0;
  for (const n of withBounds) {
    const area = n.bounds!.width * n.bounds!.height;
    visibleArea += area;
    if (n.name.trim().length > 0 && n.actions.length > 0) {
      namedInteractableArea += area;
    }
  }
  if (visibleArea === 0) return 0;
  return Math.min(1, namedInteractableArea / visibleArea);
}

export async function captureSurface(opts: CaptureOptions): Promise<CaptureResult> {
  const manager = requireManager();
  const target = resolveTarget(opts.kind, opts.target);
  const sidecar = manager.listSidecars().find((s) => s.id === target || s.name === target);
  const sidecarId = sidecar?.id ?? target;

  let surface: SemanticSurface;
  if (opts.kind === 'browser') {
    const raw = (await manager.dispatchRPC(sidecarId, 'browser_ax_snapshot', {}, DESKTOP_RPC_TIMEOUT)) as {
      url?: string;
      title?: string;
      elements?: CdpAxElement[];
    };
    surface = surfaceFromCdp({ url: raw.url, title: raw.title, elements: raw.elements ?? [] });
  } else {
    const raw = (await manager.dispatchRPC(
      sidecarId,
      'get_window_tree',
      { pid: opts.pid, depth: opts.depth ?? 8, semantic: true },
      DESKTOP_RPC_TIMEOUT,
    )) as { window_title?: string; pid?: number; elements?: UiaSemanticElement[] };
    surface = surfaceFromUia({
      window_title: raw.window_title ?? '',
      pid: raw.pid ?? opts.pid ?? 0,
      elements: raw.elements ?? [],
    });
  }

  const salient = opts.full ? surface.nodes : salienceFilter(surface.nodes);
  surface.coverage = computeCoverage(surface.nodes);
  if (!opts.full) surface.nodes = salient;

  return {
    surface,
    salient,
    meta: { provider: surface.provider, target: sidecar?.name ?? target },
  };
}
