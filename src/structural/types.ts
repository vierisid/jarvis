/**
 * Structural Runtime — core types.
 *
 * The daemon-side model of an accessibility surface (UIA / AX / AT-SPI /
 * CDP). The load-bearing idea is the SemanticRef: a durable, content-derived
 * address for a UI element. Session-scoped integer ids die on every snapshot;
 * a ref survives relayouts, restarts, and id churn, which is what makes
 * skills replayable and verification possible.
 */

export type SemanticPathSegment = {
  /** Control role (UIA control type / ARIA role / AX role). */
  role: string;
  /** Accessible name of the ancestor, truncated by the provider. */
  name?: string;
};

export type SemanticRef = {
  role: string;
  /** Accessible name. */
  name: string;
  /** Provider-stable id when one exists: UIA AutomationId, DOM id, AX identifier. */
  stableId?: string;
  /** Ancestry from the window/document root, root first. */
  path: SemanticPathSegment[];
  /** Disambiguator among same-role+name siblings. */
  ordinal: number;
  /**
   * Opaque durable key computed by the provider from
   * role|name|stableId|path|ordinal. Equal sigs ⇒ same address. Treated as
   * opaque here — never recomputed daemon-side.
   */
  sig: string;
};

export type SemanticNodeState = {
  enabled: boolean;
  focusable?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean;
  offscreen?: boolean;
};

export type SemanticNode = {
  ref: SemanticRef;
  role: string;
  name: string;
  value: string | null;
  state: SemanticNodeState;
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Actions derived from supported provider patterns (Invoke/Value/Toggle/…). */
  actions: string[];
  /** Ephemeral per-snapshot id ([id] in the current tool output), for in-turn use. */
  sessionId: number;
};

export type SemanticSurface = {
  provider: 'uia' | 'ax' | 'atspi' | 'cdp' | 'cua';
  root: { app: string; title: string; pid?: number; url?: string };
  nodes: SemanticNode[];
  /** 0–1: named-interactable coverage of the visible surface (Phase 2). */
  coverage: number;
  capturedAt: number;
};

export type ResolveMethod =
  | 'sig'
  | 'stableId'
  | 'path+name'
  | 'role+name+ordinal'
  | 'fuzzy'
  | 'none';

export type ResolveResult = {
  node: SemanticNode | null;
  /** 0–1; calibrated to the scoring ladder, not a probability. */
  confidence: number;
  method: ResolveMethod;
};

/**
 * Raw element shape emitted by the Go UIA provider with `semantic: true`
 * (see sidecar/uia_windows.go walkTree/buildElementInfoPrefetched).
 */
export type UiaSemanticElement = {
  id: number;
  name: string;
  automation_id: string;
  class_name: string;
  control_type: string;
  enabled: boolean;
  focusable: boolean;
  offscreen?: boolean;
  rect: { x: number; y: number; w: number; h: number };
  patterns: string[] | null;
  depth: number;
  path?: SemanticPathSegment[];
  ordinal?: number;
  sig?: string;
};

/** Map a UIA pattern list to the action vocabulary. */
const PATTERN_ACTIONS: Record<string, string[]> = {
  Invoke: ['click'],
  Value: ['set_value', 'get_value'],
  Toggle: ['toggle'],
  SelectionItem: ['select'],
  ExpandCollapse: ['expand', 'collapse'],
  ScrollItem: ['scroll_into_view'],
  Text: ['get_text'],
};

/** Adapt one Go-provider element into a SemanticNode. */
export function semanticNodeFromUia(el: UiaSemanticElement): SemanticNode {
  const actions = (el.patterns ?? []).flatMap((p) => PATTERN_ACTIONS[p] ?? []);
  return {
    ref: {
      role: el.control_type,
      name: el.name,
      stableId: el.automation_id || undefined,
      path: el.path ?? [],
      ordinal: el.ordinal ?? 0,
      sig: el.sig ?? '',
    },
    role: el.control_type,
    name: el.name,
    value: null,
    state: {
      enabled: el.enabled,
      focusable: el.focusable,
      offscreen: el.offscreen,
    },
    bounds: el.rect
      ? { x: el.rect.x, y: el.rect.y, width: el.rect.w, height: el.rect.h }
      : null,
    actions,
    sessionId: el.id,
  };
}

/** Adapt a full `get_window_tree` (semantic:true) result into a surface. */
export function surfaceFromUia(result: {
  window_title: string;
  pid: number;
  elements: UiaSemanticElement[];
}): SemanticSurface {
  return {
    provider: 'uia',
    root: { app: '', title: result.window_title, pid: result.pid },
    nodes: result.elements.map(semanticNodeFromUia),
    coverage: 0,
    capturedAt: Date.now(),
  };
}

/**
 * Raw element shape emitted by the Go CDP AX provider (browser_ax_snapshot,
 * see sidecar/browser_ax.go buildAXElements).
 */
export type CdpAxElement = {
  ax_id: string;
  backend_node_id: number;
  role: string;
  name: string;
  interactive: boolean;
  path?: SemanticPathSegment[];
  ordinal?: number;
  sig?: string;
  stable_id?: string;
  value?: string;
  disabled?: boolean;
  focused?: boolean;
  expanded?: boolean;
  checked?: boolean | string;
  selected?: boolean;
};

/** ARIA roles that carry actions in the browser action space. */
const AX_ROLE_ACTIONS: Record<string, string[]> = {
  button: ['click'],
  link: ['click'],
  tab: ['click'],
  menuitem: ['click'],
  option: ['select'],
  checkbox: ['toggle'],
  radio: ['select'],
  switch: ['toggle'],
  textbox: ['set_value'],
  searchbox: ['set_value'],
  combobox: ['set_value', 'expand'],
  textfield: ['set_value'],
};

export function semanticNodeFromCdp(el: CdpAxElement): SemanticNode {
  const actions = el.interactive ? (AX_ROLE_ACTIONS[el.role] ?? ['click']) : [];
  return {
    ref: {
      role: el.role,
      name: el.name,
      stableId: el.stable_id || undefined,
      path: el.path ?? [],
      ordinal: el.ordinal ?? 0,
      sig: el.sig ?? '',
    },
    role: el.role,
    name: el.name,
    value: el.value ?? null,
    state: {
      enabled: el.disabled !== true,
      focused: el.focused,
      expanded: el.expanded,
      checked: typeof el.checked === 'boolean' ? el.checked : el.checked === 'true',
      selected: el.selected,
    },
    bounds: null, // AX tree has no bounds until getBoxModel; filled on demand
    actions,
    sessionId: el.backend_node_id,
  };
}

/** Adapt a browser_ax_snapshot result into a surface. */
export function surfaceFromCdp(result: {
  url?: string;
  title?: string;
  elements: CdpAxElement[];
}): SemanticSurface {
  return {
    provider: 'cdp',
    root: { app: 'browser', title: result.title ?? '', url: result.url },
    nodes: result.elements.map(semanticNodeFromCdp),
    coverage: 0,
    capturedAt: Date.now(),
  };
}
