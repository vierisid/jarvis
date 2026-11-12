/**
 * A copy of a draft's unsaved edits, kept in the browser tab so a reload or a lost session does not lose them.
 * The copy is tied to the draft revision it was made from: a draft that changed since is not overwritten by it.
 * Credentials typed into a step (a webhook signing secret, HTTP auth, an Authorization header) are never
 * written: they are left out of the copy and, on restore, taken back from the saved draft.
 */
import type { FlowStepNode, NodePosition, OrphanStep } from "./useWorkflowEditor";

const VERSION = 1;
/** Beyond this the copy is skipped: the edits are still on screen, only the reload safety is lost. */
const MAX_CHARS = 1_500_000;
/** A settings key whose value is a credential. Broad on purpose: a field left out only costs re-entering it. */
const CREDENTIAL_KEY = /secret|passw|token|authoriz|api[-_]?key|private[-_]?key|access[-_]?key|cookie|credential/i;
/** Stands in for a credential in the stored copy. */
const OMITTED = "__jarvisOmittedCredential";

export interface KeptEdits {
  base: string | null;
  savedAt: number;
  displayName: string | null;
  trigger: FlowStepNode;
  orphans: OrphanStep[];
  positions: Record<string, NodePosition>;
  /** A credential typed since the last save was left out of the copy and has to be entered again. */
  credentialsDropped: boolean;
}

/** The saved draft the copy is made from and restored onto: its steps hold the saved credentials. */
export interface EditBase { trigger: FlowStepNode | null | undefined; orphans: OrphanStep[] }

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

function stepsByName(base: EditBase | undefined): Map<string, FlowStepNode> {
  const steps = new Map<string, FlowStepNode>();
  const visit = (node: FlowStepNode | null | undefined): void => {
    if (!object(node) || typeof node.name !== "string") return;
    steps.set(node.name, node);
    visit(node.nextAction); visit(node.firstLoopAction);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  visit(base?.trigger);
  for (const orphan of base?.orphans ?? []) visit(orphan?.node);
  return steps;
}

/** Applies `settings` to every step of a tree, keeping its shape. */
function mapSteps(node: FlowStepNode, settings: (step: FlowStepNode) => unknown): FlowStepNode {
  const next: Record<string, unknown> = { ...node, settings: settings(node) };
  if (object(node.nextAction)) next.nextAction = mapSteps(node.nextAction, settings);
  if (object(node.firstLoopAction)) next.firstLoopAction = mapSteps(node.firstLoopAction, settings);
  if (Array.isArray(node.children)) next.children = node.children.map(child => object(child) ? mapSteps(child as FlowStepNode, settings) : child);
  if (node.settings === undefined) delete next.settings;
  return next as unknown as FlowStepNode;
}

function omitCredentials(value: unknown, saved: unknown, changed: { value: boolean }): unknown {
  if (Array.isArray(value)) return value.map((item, i) => omitCredentials(item, Array.isArray(saved) ? saved[i] : undefined, changed));
  if (!object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const savedItem = object(saved) ? saved[key] : undefined;
    if (CREDENTIAL_KEY.test(key) && filled(item)) {
      if (JSON.stringify(item) !== JSON.stringify(savedItem)) changed.value = true;
      out[key] = { [OMITTED]: true };
    } else out[key] = omitCredentials(item, savedItem, changed);
  }
  return out;
}

function restoreCredentials(value: unknown, saved: unknown): unknown {
  if (Array.isArray(value)) return value.map((item, i) => restoreCredentials(item, Array.isArray(saved) ? saved[i] : undefined));
  if (!object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const savedItem = object(saved) ? saved[key] : undefined;
    if (object(item) && item[OMITTED] === true) { if (savedItem !== undefined) out[key] = savedItem; }
    else out[key] = restoreCredentials(item, savedItem);
  }
  return out;
}

export function serializeEdits(edits: Omit<KeptEdits, "savedAt" | "credentialsDropped">, base?: EditBase): string | null {
  const saved = stepsByName(base), changed = { value: false };
  const scrub = (node: FlowStepNode) => mapSteps(node, step => omitCredentials(step.settings, saved.get(step.name)?.settings, changed));
  const text = JSON.stringify({
    v: VERSION, ...edits,
    trigger: scrub(edits.trigger),
    orphans: edits.orphans.map(orphan => ({ ...orphan, node: scrub(orphan.node) })),
    credentialsDropped: changed.value,
    savedAt: Date.now(),
  });
  return text.length <= MAX_CHARS ? text : null;
}

/** When the copy was made, for a copy that cannot be restored (the draft changed since); null when there is none. */
export function staleEditsTime(stored: string | null): number | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return object(parsed) && parsed.v === VERSION && typeof parsed.savedAt === "number" ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

const position = (v: unknown): v is NodePosition => object(v) && Number.isFinite(v.x) && Number.isFinite(v.y);

/** The stored edits when they were made from `revision`, with saved credentials put back from `base`; otherwise null. Never throws. */
export function keptEdits(stored: string | null, revision: string | null | undefined, base?: EditBase): KeptEdits | null {
  if (!stored || !revision) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!object(parsed) || parsed.v !== VERSION || parsed.base !== revision) return null;
    const trigger = parsed.trigger;
    if (!object(trigger) || trigger.name !== "trigger" || typeof trigger.type !== "string") return null;
    const saved = stepsByName(base);
    const refill = (node: FlowStepNode) => mapSteps(node, step => restoreCredentials(step.settings, saved.get(step.name)?.settings));
    const orphans = Array.isArray(parsed.orphans)
      ? (parsed.orphans as unknown[]).filter((o): o is OrphanStep => object(o) && object(o.node) && typeof o.x === "number" && typeof o.y === "number")
        .map(orphan => ({ ...orphan, node: refill(orphan.node) }))
      : [];
    return {
      base: revision,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : null,
      trigger: refill(trigger as unknown as FlowStepNode),
      orphans,
      positions: object(parsed.positions)
        ? Object.fromEntries(Object.entries(parsed.positions).filter(([, p]) => position(p))) as Record<string, NodePosition>
        : {},
      credentialsDropped: parsed.credentialsDropped === true,
    };
  } catch {
    return null;
  }
}
