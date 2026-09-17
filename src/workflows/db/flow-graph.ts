/**
 * Whole-graph traversal of a persisted `flow_version.trigger` tree, plus the
 * CODE-step scan the publish gate is built on.
 *
 * A step is reachable through three edges, not one: `nextAction` (the chain),
 * `firstLoopAction` (a LOOP_ON_ITEMS body) and `children` (one entry per
 * ROUTER branch). A scan that only follows `nextAction` misses a CODE step
 * parked inside a loop or behind a router branch, which is exactly where one
 * hides, so every caller uses this walker rather than its own loop.
 *
 * Deliberately pure -- no database access -- so the schema migration that
 * backfills the per-flow CODE grant and the repos that read it can both call
 * it without an import cycle through `db/index.ts`.
 */

import type { FlowTriggerNode } from "./repos/flow-version";

/** Node type the engine materializes to disk and runs as JavaScript. */
export const CODE_STEP_TYPE = "CODE";

/**
 * Every node reachable from `root`, in pre-order: a node, then its loop body,
 * then its router branches left to right, then the rest of its chain.
 *
 * Iterative rather than recursive: the tree comes from a JSON column a caller
 * can write by hand, and a pathologically long `nextAction` chain should cost
 * heap rather than stack. Non-object entries are skipped and each object is
 * visited once, so a malformed or self-referencing tree terminates instead of
 * throwing or spinning.
 */
export function walkFlowNodes(root: FlowTriggerNode | null | undefined): FlowTriggerNode[] {
  const out: FlowTriggerNode[] = [];
  if (!root || typeof root !== "object") return out;
  const seen = new Set<unknown>();
  const pending: FlowTriggerNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    // Pushed in reverse of the order we want popped, so the visit order reads
    // like the editor draws it: body, then branches, then the chain.
    if (node.nextAction) pending.push(node.nextAction);
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) pending.push(child);
      }
    }
    if (node.firstLoopAction) pending.push(node.firstLoopAction);
  }
  return out;
}

/**
 * Names of every CODE step in the graph, in walk order. Empty for a flow with
 * none, which is the overwhelming majority and the case the gate must not
 * charge anything for.
 *
 * A node with no usable `name` is reported as `<unnamed>` rather than dropped:
 * the refusal message has to account for the step that caused it even when the
 * tree is malformed enough to have lost its label.
 */
export function findCodeStepNames(root: FlowTriggerNode | null | undefined): string[] {
  const names: string[] = [];
  for (const node of walkFlowNodes(root)) {
    if (node.type !== CODE_STEP_TYPE) continue;
    names.push(typeof node.name === "string" && node.name.length > 0 ? node.name : "<unnamed>");
  }
  return names;
}

/** True when the graph contains at least one CODE step. */
export function hasCodeStep(root: FlowTriggerNode | null | undefined): boolean {
  return findCodeStepNames(root).length > 0;
}
