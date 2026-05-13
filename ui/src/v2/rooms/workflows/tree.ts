/**
 * Pure tree-manipulation helpers for the workflow editor.
 *
 * Lives outside `useWorkflowEditor.ts` so the logic can be unit-tested
 * without React. Every mutator here returns a NEW trigger root (cloned
 * up-front) and never mutates the input — caller swaps it into state via
 * `setDraftTrigger`.
 *
 * Naming and chain semantics:
 *   - "Top-level chain" = trigger.nextAction -> nextAction -> ...
 *   - LOOP body = parent.firstLoopAction -> nextAction -> ...
 *   - ROUTER branch = parent.children[branchIndex] -> nextAction -> ...
 *   - Step names are unique across the entire tree (not just per chain).
 */

import type { FlowStepNode, FlatStep, ChainScope, PieceCatalogEntry, PieceInputSchema } from "./useWorkflowEditor";

/* -------------------------------------------------------- clone + walks */

/**
 * Deep clone a trigger tree. Uses JSON round-trip because the trigger shape is
 * deliberately JSON-serializable (it's persisted as TEXT in SQLite). Drops
 * Dates / Maps / Sets / `undefined` fields — none of which the trigger format
 * permits — so the loss is intentional.
 */
export function cloneTrigger(node: FlowStepNode): FlowStepNode {
  return JSON.parse(JSON.stringify(node)) as FlowStepNode;
}

/**
 * Depth-recursive flatten. Visits the top-level chain, then for each
 * LOOP_ON_ITEMS recurses into its `firstLoopAction` chain at depth+1, and
 * for each ROUTER recurses into each non-null `children[i]` chain at
 * depth+1 (carrying the branch's name as a label).
 */
export function flattenSteps(root: FlowStepNode): FlatStep[] {
  const out: FlatStep[] = [];

  const walk = (
    start: FlowStepNode | undefined,
    depth: number,
    parentName: string | undefined,
    branchName: string | undefined,
    containerKind: "loop" | "router" | undefined,
  ): void => {
    let cursor: FlowStepNode | undefined = start;
    while (cursor) {
      const entry: FlatStep = { step: cursor, depth };
      if (parentName !== undefined) entry.parentName = parentName;
      if (branchName !== undefined) entry.branchName = branchName;
      if (containerKind !== undefined) entry.containerKind = containerKind;
      out.push(entry);

      if (cursor.type === "LOOP_ON_ITEMS" && cursor.firstLoopAction) {
        walk(cursor.firstLoopAction, depth + 1, cursor.name, undefined, "loop");
      } else if (cursor.type === "ROUTER" && Array.isArray(cursor.children)) {
        const branches = cursor.settings?.branches ?? [];
        for (let i = 0; i < cursor.children.length; i++) {
          const child = cursor.children[i];
          if (!child) continue;
          const bName = branches[i]?.branchName ?? `branch_${i}`;
          walk(child, depth + 1, cursor.name, bName, "router");
        }
      }

      cursor = cursor.nextAction;
    }
  };

  walk(root, 0, undefined, undefined, undefined);
  return out;
}

/**
 * Walk every step that EXECUTES BEFORE `target` and return them in flow
 * order (trigger first). The variable picker uses this to show "previous
 * steps' outputs" -- a step can reference any predecessor's `{{name}}`
 * because by the time it runs, those predecessors have populated
 * `executionState.steps`.
 *
 * Predecessors include:
 *   - the trigger (always)
 *   - every linear chain ancestor (...prev → prev → target)
 *   - the parent LOOP / ROUTER, plus that container's own predecessors
 *
 * Predecessors do NOT include:
 *   - sibling chains in other ROUTER branches (different execution paths)
 *   - the LOOP body when looking from outside the body
 *   - the target itself
 *
 * Returns `null` when the target isn't reachable from `root`.
 */
export function pathToStep(root: FlowStepNode, target: string): FlowStepNode[] | null {
  if (root.name === target) return [];
  const dfs = (node: FlowStepNode, ancestors: FlowStepNode[]): FlowStepNode[] | null => {
    if (node.name === target) return ancestors;
    const next = [...ancestors, node];
    if (node.nextAction) {
      const r = dfs(node.nextAction, next);
      if (r !== null) return r;
    }
    if (node.firstLoopAction) {
      const r = dfs(node.firstLoopAction, next);
      if (r !== null) return r;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (!child) continue;
        const r = dfs(child, next);
        if (r !== null) return r;
      }
    }
    return null;
  };
  return dfs(root, []);
}

/** Recursive lookup for a step anywhere in the trigger tree. */
export function findStep(root: FlowStepNode, name: string): FlowStepNode | null {
  if (root.name === name) return root;
  if (root.nextAction) {
    const r = findStep(root.nextAction, name);
    if (r) return r;
  }
  if (root.firstLoopAction) {
    const r = findStep(root.firstLoopAction, name);
    if (r) return r;
  }
  if (Array.isArray(root.children)) {
    for (const child of root.children) {
      if (!child) continue;
      const r = findStep(child, name);
      if (r) return r;
    }
  }
  return null;
}

/** Where a step sits relative to its parent / predecessor. Drives delete + reorder. */
export type StepLocation =
  | { kind: "trigger" }
  | { kind: "chain"; predecessor: FlowStepNode }
  | { kind: "loop_head"; parent: FlowStepNode }
  | { kind: "branch_head"; parent: FlowStepNode; branchIndex: number };

export function findStepLocation(root: FlowStepNode, name: string): StepLocation | null {
  if (root.name === name) return { kind: "trigger" };
  return findInChain(root, name);
}

function findInChain(head: FlowStepNode, name: string): StepLocation | null {
  let cursor: FlowStepNode | undefined = head;
  while (cursor) {
    if (cursor.nextAction?.name === name) return { kind: "chain", predecessor: cursor };
    if (cursor.firstLoopAction) {
      if (cursor.firstLoopAction.name === name) return { kind: "loop_head", parent: cursor };
      const sub = findInChain(cursor.firstLoopAction, name);
      if (sub) return sub;
    }
    if (Array.isArray(cursor.children)) {
      for (let i = 0; i < cursor.children.length; i++) {
        const child = cursor.children[i];
        if (!child) continue;
        if (child.name === name) return { kind: "branch_head", parent: cursor, branchIndex: i };
        const sub = findInChain(child, name);
        if (sub) return sub;
      }
    }
    cursor = cursor.nextAction;
  }
  return null;
}

/**
 * Generate the next `step_<n>` name. Always picks `max(numeric-suffix) + 1`
 * over the ENTIRE tree (top-level + every sub-graph), never reuses a freed
 * slot. Reusing names risks template references like `{{step_2.foo}}` in
 * downstream nodes silently re-binding to a fresh step.
 */
export function nextStepName(root: FlowStepNode): string {
  let max = 0;
  for (const fs of flattenSteps(root)) {
    const m = /^step_(\d+)$/.exec(fs.step.name);
    if (m && typeof m[1] === "string") {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `step_${max + 1}`;
}

/** Seed step input from schema defaults. Existing keys win. */
export function applySchemaDefaults(
  current: Record<string, unknown>,
  schema: PieceInputSchema | null,
): Record<string, unknown> {
  if (!schema) return { ...current };
  const next: Record<string, unknown> = { ...current };
  for (const field of schema.fields) {
    if (field.default === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(next, field.name)) continue;
    next[field.name] =
      typeof field.default === "object" && field.default !== null
        ? JSON.parse(JSON.stringify(field.default))
        : field.default;
  }
  return next;
}

/* ----------------------------------------------------------- mutations */

/**
 * Insert a new unconfigured PIECE step immediately after `predecessorName`.
 * Returns `null` if the predecessor doesn't exist.
 */
export function insertStepAfter(
  root: FlowStepNode,
  predecessorName: string,
): { tree: FlowStepNode; newName: string } | null {
  const tree = cloneTrigger(root);
  const predecessor = findStep(tree, predecessorName);
  if (!predecessor) return null;
  const newName = nextStepName(tree);
  const newStep: FlowStepNode = {
    name: newName,
    type: "PIECE",
    displayName: "New step",
    settings: { input: {} },
    nextAction: predecessor.nextAction,
  };
  predecessor.nextAction = newStep;
  return { tree, newName };
}

/**
 * Add a new unconfigured PIECE step at the HEAD of a chain. Used for
 * seeding LOOP bodies and ROUTER branches that became empty after deletion
 * (or were authored empty). Returns `null` when the scope can't be resolved.
 */
export function addStepToHead(
  root: FlowStepNode,
  scope: ChainScope,
): { tree: FlowStepNode; newName: string } | null {
  const tree = cloneTrigger(root);
  const newName = nextStepName(tree);
  const newStep: FlowStepNode = {
    name: newName,
    type: "PIECE",
    displayName: "New step",
    settings: { input: {} },
  };

  if (scope.kind === "top") {
    newStep.nextAction = tree.nextAction;
    tree.nextAction = newStep;
    return { tree, newName };
  }
  if (scope.kind === "loop") {
    const parent = findStep(tree, scope.parentName);
    if (!parent || parent.type !== "LOOP_ON_ITEMS") return null;
    newStep.nextAction = parent.firstLoopAction;
    parent.firstLoopAction = newStep;
    return { tree, newName };
  }
  // branch
  const parent = findStep(tree, scope.parentName);
  if (!parent || parent.type !== "ROUTER" || !Array.isArray(parent.children)) return null;
  const branches = parent.settings?.branches ?? [];
  const branchIndex = branches.findIndex((b) => b?.branchName === scope.branchName);
  if (branchIndex < 0 || branchIndex >= parent.children.length) return null;
  newStep.nextAction = parent.children[branchIndex] ?? undefined;
  parent.children[branchIndex] = newStep;
  return { tree, newName };
}

/**
 * Remove a step from the tree. Trigger is undeletable. Sub-chain head
 * deletion re-links the parent's head pointer.
 */
export function removeStep(root: FlowStepNode, stepName: string): FlowStepNode {
  if (root.name === stepName) return root; // trigger undeletable
  const tree = cloneTrigger(root);
  const loc = findStepLocation(tree, stepName);
  if (!loc || loc.kind === "trigger") return root;
  const target = findStep(tree, stepName);
  if (!target) return root;
  const successor = target.nextAction;
  switch (loc.kind) {
    case "chain":
      loc.predecessor.nextAction = successor;
      break;
    case "loop_head":
      loc.parent.firstLoopAction = successor;
      break;
    case "branch_head": {
      if (Array.isArray(loc.parent.children)) {
        loc.parent.children[loc.branchIndex] = successor ?? null;
      }
      break;
    }
  }
  return tree;
}

/** Re-link a chain so its action steps appear in the order given. No-op on mismatch. */
export function reorderChain(root: FlowStepNode, scope: ChainScope, orderedNames: string[]): FlowStepNode {
  const tree = cloneTrigger(root);

  let head: FlowStepNode | undefined;
  let writeHead: (h: FlowStepNode | undefined) => void;
  if (scope.kind === "top") {
    head = tree.nextAction;
    writeHead = (h) => { tree.nextAction = h; };
  } else if (scope.kind === "loop") {
    const parent = findStep(tree, scope.parentName);
    if (!parent || parent.type !== "LOOP_ON_ITEMS") return root;
    head = parent.firstLoopAction;
    writeHead = (h) => { parent.firstLoopAction = h; };
  } else {
    const parent = findStep(tree, scope.parentName);
    if (!parent || parent.type !== "ROUTER" || !Array.isArray(parent.children)) return root;
    const branches = parent.settings?.branches ?? [];
    const branchIndex = branches.findIndex((b) => b?.branchName === scope.branchName);
    if (branchIndex < 0 || branchIndex >= parent.children.length) return root;
    const child = parent.children[branchIndex];
    head = child ?? undefined;
    writeHead = (h) => {
      if (Array.isArray(parent.children)) parent.children[branchIndex] = h ?? null;
    };
  }

  const currentSteps: FlowStepNode[] = [];
  let cursor: FlowStepNode | undefined = head;
  while (cursor) {
    currentSteps.push(cursor);
    cursor = cursor.nextAction;
  }
  if (orderedNames.length !== currentSteps.length) return root;
  const currentNames = new Set(currentSteps.map((s) => s.name));
  const seen = new Set<string>();
  for (const name of orderedNames) {
    if (seen.has(name) || !currentNames.has(name)) return root;
    seen.add(name);
  }
  const same = currentSteps.every((s, i) => s.name === orderedNames[i]);
  if (same) return root;

  const byName = new Map(currentSteps.map((s) => [s.name, s]));
  const ordered = orderedNames.map((n) => byName.get(n)!).filter((s): s is FlowStepNode => !!s);
  writeHead(ordered[0]);
  for (let i = 0; i < ordered.length; i++) {
    const step = ordered[i];
    if (!step) continue;
    step.nextAction = ordered[i + 1];
  }
  return tree;
}

/** Set a LOOP_ON_ITEMS step's `items` template. */
export function setLoopItems(root: FlowStepNode, stepName: string, items: string): FlowStepNode {
  const tree = cloneTrigger(root);
  const target = findStep(tree, stepName);
  if (!target || target.type !== "LOOP_ON_ITEMS") return root;
  target.settings = { ...(target.settings ?? {}), items };
  return tree;
}

/** Set a ROUTER step's executionType. */
export function setRouterExecutionType(
  root: FlowStepNode,
  stepName: string,
  executionType: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH",
): FlowStepNode {
  const tree = cloneTrigger(root);
  const target = findStep(tree, stepName);
  if (!target || target.type !== "ROUTER") return root;
  target.settings = { ...(target.settings ?? {}), executionType };
  return tree;
}

/** Add a CONDITION branch to a ROUTER. The new branch starts empty (no children, no conditions). */
export function addRouterBranch(
  root: FlowStepNode,
  stepName: string,
  branchName: string,
): FlowStepNode {
  const tree = cloneTrigger(root);
  const target = findStep(tree, stepName);
  if (!target || target.type !== "ROUTER") return root;
  const branches = [...(target.settings?.branches ?? [])];
  const children = [...(target.children ?? [])];
  // Insert new branch BEFORE the FALLBACK if one exists, so FALLBACK stays last.
  let insertAt = branches.length;
  for (let i = 0; i < branches.length; i++) {
    if (branches[i]?.branchType === "FALLBACK") {
      insertAt = i;
      break;
    }
  }
  branches.splice(insertAt, 0, { branchName, branchType: "CONDITION", conditions: [] });
  children.splice(insertAt, 0, null);
  target.settings = { ...(target.settings ?? {}), branches };
  target.children = children;
  return tree;
}

/** Remove a ROUTER branch by index. Drops its children sub-chain too. */
export function removeRouterBranch(root: FlowStepNode, stepName: string, branchIndex: number): FlowStepNode {
  const tree = cloneTrigger(root);
  const target = findStep(tree, stepName);
  if (!target || target.type !== "ROUTER") return root;
  const branches = [...(target.settings?.branches ?? [])];
  const children = [...(target.children ?? [])];
  if (branchIndex < 0 || branchIndex >= branches.length) return root;
  branches.splice(branchIndex, 1);
  children.splice(branchIndex, 1);
  target.settings = { ...(target.settings ?? {}), branches };
  target.children = children;
  return tree;
}

/* ----------------------------------------- connect / disconnect helpers */

/**
 * Identifies which source handle on a step a connection is using. The
 * handle ids rendered by `StepNode` (`out` / `loop-body` / `branch:<name>`)
 * parse into one of these shapes.
 */
export type ConnectionHandle =
  | { kind: "out" }
  | { kind: "loop-body" }
  | { kind: "branch"; branchName: string };

/** Parse a handle id back into its semantic kind. Returns null on garbage. */
export function parseSourceHandle(raw: string | null | undefined): ConnectionHandle | null {
  if (!raw || raw === "out") return { kind: "out" };
  if (raw === "loop-body") return { kind: "loop-body" };
  if (raw.startsWith("branch:")) {
    return { kind: "branch", branchName: raw.slice("branch:".length) };
  }
  return null;
}

/**
 * Whether a source-handle on `step` is currently wired to a successor.
 * Used by the editor to drive `Handle.isConnectableStart` so users can't
 * start dragging from an already-used circle.
 */
export function isSourceHandleConnected(step: FlowStepNode, handle: ConnectionHandle): boolean {
  switch (handle.kind) {
    case "out":
      return !!step.nextAction;
    case "loop-body":
      return step.type === "LOOP_ON_ITEMS" && !!step.firstLoopAction;
    case "branch": {
      if (step.type !== "ROUTER" || !Array.isArray(step.children)) return false;
      const branches = step.settings?.branches ?? [];
      const idx = branches.findIndex((b) => b?.branchName === handle.branchName);
      if (idx < 0 || idx >= step.children.length) return false;
      return !!step.children[idx];
    }
  }
}

/**
 * Attach `targetSubtree` (typically a previously-orphan step) at the named
 * source-handle of `sourceName`. The handle must currently be unwired — the
 * caller is responsible for the "one parent per node" invariant. Returns
 * null when the source/handle can't be resolved or is already in use.
 *
 * The target subtree is deep-cloned so the caller's orphan reference does
 * not become aliased to the tree.
 */
export function connectSteps(
  root: FlowStepNode,
  sourceName: string,
  sourceHandle: ConnectionHandle,
  targetSubtree: FlowStepNode,
): FlowStepNode | null {
  const tree = cloneTrigger(root);
  const source = findStep(tree, sourceName);
  if (!source) return null;
  const clonedTarget = cloneTrigger(targetSubtree);

  switch (sourceHandle.kind) {
    case "out":
      if (source.nextAction) return null;
      source.nextAction = clonedTarget;
      break;
    case "loop-body":
      if (source.type !== "LOOP_ON_ITEMS" || source.firstLoopAction) return null;
      source.firstLoopAction = clonedTarget;
      break;
    case "branch": {
      if (source.type !== "ROUTER" || !Array.isArray(source.children)) return null;
      const branches = source.settings?.branches ?? [];
      const idx = branches.findIndex((b) => b?.branchName === sourceHandle.branchName);
      if (idx < 0 || idx >= source.children.length) return null;
      if (source.children[idx]) return null;
      source.children[idx] = clonedTarget;
      break;
    }
  }
  return tree;
}

/**
 * Sever the outgoing edge at `sourceName`'s `sourceHandle`. Returns the new
 * tree plus the detached subtree (head only -- its own `nextAction` chain
 * travels with it). The caller typically pushes `detached` into the editor's
 * orphan list so the user can re-wire it without losing work.
 */
export function disconnectEdge(
  root: FlowStepNode,
  sourceName: string,
  sourceHandle: ConnectionHandle,
): { tree: FlowStepNode; detached: FlowStepNode } | null {
  const tree = cloneTrigger(root);
  const source = findStep(tree, sourceName);
  if (!source) return null;

  let detached: FlowStepNode | undefined;
  switch (sourceHandle.kind) {
    case "out":
      detached = source.nextAction;
      source.nextAction = undefined;
      break;
    case "loop-body":
      if (source.type !== "LOOP_ON_ITEMS") return null;
      detached = source.firstLoopAction;
      source.firstLoopAction = undefined;
      break;
    case "branch": {
      if (source.type !== "ROUTER" || !Array.isArray(source.children)) return null;
      const branches = source.settings?.branches ?? [];
      const idx = branches.findIndex((b) => b?.branchName === sourceHandle.branchName);
      if (idx < 0 || idx >= source.children.length) return null;
      detached = source.children[idx] ?? undefined;
      source.children[idx] = null;
      break;
    }
  }
  if (!detached) return null;
  return { tree, detached };
}

/** Collect every step name reachable from the trigger -- used to test
 *  whether a candidate target is already part of the tree (and therefore
 *  has a parent we shouldn't overwrite). */
export function allReachableNames(root: FlowStepNode): Set<string> {
  return new Set(flattenSteps(root).map((fs) => fs.step.name));
}

/** Look up the current ChainScope for a step, mainly so the editor can wire
 *  per-sub-chain "Add step" buttons without recomputing scope. */
export function chainScopeFor(root: FlowStepNode, stepName: string): ChainScope | null {
  const flat = flattenSteps(root).find((fs) => fs.step.name === stepName);
  if (!flat) return null;
  if (flat.depth === 0) return { kind: "top" };
  if (flat.containerKind === "loop" && flat.parentName) return { kind: "loop", parentName: flat.parentName };
  if (flat.containerKind === "router" && flat.parentName && flat.branchName) {
    return { kind: "branch", parentName: flat.parentName, branchName: flat.branchName };
  }
  return null;
}
