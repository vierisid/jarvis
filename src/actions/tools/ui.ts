/**
 * UI Tools — the structural-runtime agent surface.
 *
 * ui_snapshot / ui_act are the primary perception+action path: an
 * interactable-first accessibility view with durable refs, and a verified
 * act primitive that re-snapshots and checks a postcondition instead of
 * trusting the action fired. The legacy desktop and browser tools remain as
 * the low-level escape hatch.
 */

import type { ToolDefinition } from './registry.ts';
import { getSidecarManager, autoTargetForCapability } from './sidecar-route.ts';
import { captureSurface, type CaptureKind } from '../../structural/surface.ts';
import { verifyPostcondition, nextHealRung, type Postcondition, type HealRung } from '../../structural/verifier.ts';
import { resolveRef } from '../../structural/resolver.ts';
import { recordPerception } from '../../structural/telemetry.ts';
import type { SemanticNode, SemanticSurface } from '../../structural/types.ts';

const ACT_RPC_TIMEOUT = { initial: 30_000, max: 60_000 };

function fmtNode(n: SemanticNode): string {
  const bits: string[] = [`[${n.sessionId}] ${n.role}`];
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
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatSurface(surface: SemanticSurface): string {
  const cov = Math.round(surface.coverage * 100);
  const header =
    surface.provider === 'cdp'
      ? `Page: ${surface.root.title || '(untitled)'}  ${surface.root.url ?? ''}`
      : `Window: ${surface.root.title || '(untitled)'}  [pid ${surface.root.pid ?? '?'}]`;

  const lines = [header, `Coverage: ${cov}% structural`, ''];
  if (surface.nodes.length === 0) {
    lines.push('(no salient elements — the surface may be canvas/custom-drawn; use a screenshot)');
  } else {
    for (const n of surface.nodes) lines.push(fmtNode(n));
  }
  if (surface.coverage < 0.4) {
    lines.push(
      '',
      '⚠ Low structural coverage — this surface is largely canvas/custom-drawn. Prefer desktop_screenshot/browser_screenshot (vision) for elements not listed above.',
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
    if (action === 'set_value') {
      return manager.dispatchRPC(id, 'browser_ax_set_value', { backend_node_id: sessionId, value }, ACT_RPC_TIMEOUT);
    }
    return manager.dispatchRPC(id, 'browser_ax_click', { backend_node_id: sessionId }, ACT_RPC_TIMEOUT);
  }
  // desktop → click_element handles all action variants
  return manager.dispatchRPC(id, 'click_element', { element_id: sessionId, action, value }, ACT_RPC_TIMEOUT);
}

function parsePostcondition(raw: unknown, actedRef: SemanticNode | undefined): Postcondition | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s === 'window_appeared') return { kind: 'window_appeared' };
  if (s === 'element_gone' && actedRef) return { kind: 'element_gone', ref: actedRef.ref };
  if (s === 'focus_moved' && actedRef) return { kind: 'focus_moved', fromRef: actedRef.ref };
  if (s === 'element_present' && actedRef) return { kind: 'element_present', ref: actedRef.ref };
  return null;
}

export const uiSnapshotTool: ToolDefinition = {
  name: 'ui_snapshot',
  description:
    'Perceive the current app or web page as an accessibility tree: an interactable-first list of elements, each with an [id] you pass to ui_act. This is the PRIMARY way to see UI — prefer it over screenshots. Reports a structural coverage %; when coverage is low the surface is canvas/custom-drawn and you should fall back to a screenshot. Set kind="browser" for the web page, "desktop" for a native window (optionally target a pid).',
  category: 'ui',
  parameters: {
    kind: { type: 'string', description: 'What to perceive: "desktop" (native window) or "browser" (web page). Default "desktop".', required: false },
    pid: { type: 'number', description: 'Desktop only: window PID (from desktop_list_windows). Omit for the foreground window.', required: false },
    full: { type: 'boolean', description: 'Return the full tree instead of the salience-filtered interactable view. Default false — only set when the element you need is missing from the filtered list.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select the connected one).', required: false },
  },
  execute: async (params) => {
    const kind = (params.kind === 'browser' ? 'browser' : 'desktop') as CaptureKind;
    try {
      const { surface } = await captureSurface({
        kind,
        target: params.target as string | undefined,
        pid: params.pid as number | undefined,
        full: params.full === true,
      });
      recordPerception({
        provider: surface.provider === 'cdp' ? 'cdp' : 'uia',
        action: 'snapshot',
        coverage: surface.coverage,
        structural: true,
        detail: `${surface.nodes.length} salient nodes`,
      });
      return formatSurface(surface);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const uiActTool: ToolDefinition = {
  name: 'ui_act',
  description:
    'Act on an element from the most recent ui_snapshot by its [id], then VERIFY the effect. Actions: click, set_value (needs value), toggle, select, expand, collapse, focus, get_value, get_text. Optionally pass verify to confirm the outcome (window_appeared | element_gone | element_present | focus_moved) — on failure the runtime self-heals (re-snapshots and retries) before reporting. Always returns what actually changed, so you do not need a separate snapshot to check.',
  category: 'ui',
  parameters: {
    element_id: { type: 'number', description: 'The [id] of the target element from the most recent ui_snapshot.', required: true },
    action: { type: 'string', description: 'One of: click, set_value, toggle, select, expand, collapse, focus, get_value, get_text. Default click.', required: false },
    value: { type: 'string', description: 'The text to set (required for set_value).', required: false },
    kind: { type: 'string', description: '"desktop" or "browser" — must match the ui_snapshot you took. Default "desktop".', required: false },
    verify: { type: 'string', description: 'Optional postcondition to confirm: window_appeared, element_gone, element_present, or focus_moved.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select).', required: false },
  },
  execute: async (params) => {
    const kind = (params.kind === 'browser' ? 'browser' : 'desktop') as CaptureKind;
    const action = (params.action as string) || 'click';
    const sessionId = params.element_id as number;
    const value = params.value as string | undefined;
    const cap = kind === 'browser' ? 'browser' : 'desktop';
    const target = (params.target as string | undefined)?.trim() || autoTargetForCapability(cap) || '';
    if (!target) return `Error: no connected sidecar with the "${cap}" capability`;

    // Capture the pre-action surface so we can diff and find the acted ref.
    let before: SemanticNode[] = [];
    let beforeTitle: string | undefined;
    try {
      const pre = await captureSurface({ kind, target, full: false });
      before = pre.surface.nodes;
      beforeTitle = pre.surface.root.title;
    } catch {
      // Non-fatal: act anyway, but verification/diff will be limited.
    }
    const actedRef = before.find((n) => n.sessionId === sessionId);

    let actResult: unknown;
    try {
      actResult = await dispatchAct(kind, target, sessionId, action, value);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Read-only actions need no verification/diff.
    if (action === 'get_value' || action === 'get_text') {
      return `${action} → ${JSON.stringify(actResult)}`;
    }

    const pc = parsePostcondition(params.verify, actedRef);
    const lines: string[] = [`Acted: ${action}${value !== undefined ? ` "${truncate(value, 40)}"` : ''} on [${sessionId}]`];

    // Re-snapshot for verification + diff, climbing the self-heal ladder.
    const attempted: HealRung[] = [];
    let satisfied = !pc; // no postcondition ⇒ nothing to fail
    let after: SemanticNode[] = [];
    let afterTitle: string | undefined;

    for (let pass = 0; pass < 3; pass++) {
      try {
        const post = await captureSurface({ kind, target, full: false });
        after = post.surface.nodes;
        afterTitle = post.surface.root.title;
      } catch {
        after = [];
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
      attempted.push(rung);
      if (rung === 're_resolve' && actedRef) {
        const r = resolveRef(actedRef.ref, after);
        if (r.node && r.node.sessionId !== sessionId) {
          try { await dispatchAct(kind, target, r.node.sessionId, action, value); } catch { /* keep climbing */ }
          continue;
        }
      } else if (rung === 'retry') {
        await new Promise((res) => setTimeout(res, 400));
        try { await dispatchAct(kind, target, sessionId, action, value); } catch { /* keep climbing */ }
        continue;
      } else {
        // vision / ask: the runtime cannot resolve structurally.
        lines.push(`Not verified (${v.detail}). Self-heal exhausted structural options — fall back to a screenshot (vision) or ask the user.`);
        break;
      }
    }

    lines.push(diffSurface(before, after));
    if (pc && !satisfied && attempted[attempted.length - 1] !== 'vision' && attempted[attempted.length - 1] !== 'ask') {
      lines.push('⚠ Postcondition not confirmed — do NOT assume the action worked; inspect the diff above.');
    }

    const usedVision = attempted.includes('vision');
    recordPerception({
      provider: usedVision ? 'vision' : kind === 'browser' ? 'cdp' : 'uia',
      action,
      coverage: 0,
      structural: !usedVision,
      verified: pc ? satisfied : undefined,
      visionReason: usedVision ? 'step_failure' : undefined,
      detail: attempted.length ? `self-heal: ${attempted.join('→')}` : undefined,
    });
    return lines.join('\n');
  },
};

/** Compact before→after diff by session-id set + focus/title changes. */
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
