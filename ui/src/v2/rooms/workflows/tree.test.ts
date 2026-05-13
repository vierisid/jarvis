import { describe, expect, test } from "bun:test";
import {
  addRouterBranch,
  addStepToHead,
  cloneTrigger,
  chainScopeFor,
  connectSteps,
  disconnectEdge,
  findStep,
  findStepLocation,
  flattenSteps,
  insertStepAfter,
  isSourceHandleConnected,
  nextStepName,
  parseSourceHandle,
  pathToStep,
  removeRouterBranch,
  removeStep,
  reorderChain,
  setLoopItems,
  setRouterExecutionType,
} from "./tree";
import type { FlowStepNode } from "./useWorkflowEditor";

/** Build a fixture: trigger -> step_1 -> loop_1{ body: step_2 -> step_3 } -> router_1{ a: step_4; b: step_5 } -> step_6 */
function fixture(): FlowStepNode {
  return {
    name: "trigger",
    type: "EMPTY",
    nextAction: {
      name: "step_1",
      type: "PIECE",
      settings: { pieceName: "p", actionName: "a" },
      nextAction: {
        name: "loop_1",
        type: "LOOP_ON_ITEMS",
        settings: { items: "{{trigger.list}}" },
        firstLoopAction: {
          name: "step_2",
          type: "PIECE",
          settings: { pieceName: "p", actionName: "a" },
          nextAction: {
            name: "step_3",
            type: "PIECE",
            settings: { pieceName: "p", actionName: "a" },
          },
        },
        nextAction: {
          name: "router_1",
          type: "ROUTER",
          settings: {
            executionType: "EXECUTE_FIRST_MATCH",
            branches: [
              { branchName: "a", branchType: "CONDITION", conditions: [] },
              { branchName: "b", branchType: "CONDITION", conditions: [] },
            ],
          },
          children: [
            { name: "step_4", type: "PIECE", settings: { pieceName: "p", actionName: "a" } },
            { name: "step_5", type: "PIECE", settings: { pieceName: "p", actionName: "a" } },
          ],
          nextAction: {
            name: "step_6",
            type: "PIECE",
            settings: { pieceName: "p", actionName: "a" },
          },
        },
      },
    },
  };
}

describe("flattenSteps", () => {
  test("visits depth-first preorder including LOOP body and ROUTER children", () => {
    const flat = flattenSteps(fixture()).map((fs) => `${fs.depth}:${fs.step.name}`);
    expect(flat).toEqual([
      "0:trigger",
      "0:step_1",
      "0:loop_1",
      "1:step_2",
      "1:step_3",
      "0:router_1",
      "1:step_4",
      "1:step_5",
      "0:step_6",
    ]);
  });

  test("router children inherit parent + branch name", () => {
    const flat = flattenSteps(fixture());
    const step4 = flat.find((fs) => fs.step.name === "step_4")!;
    expect(step4.parentName).toBe("router_1");
    expect(step4.branchName).toBe("a");
    expect(step4.containerKind).toBe("router");
    const step5 = flat.find((fs) => fs.step.name === "step_5")!;
    expect(step5.branchName).toBe("b");
  });
});

describe("findStep / findStepLocation", () => {
  test("findStep finds at any depth", () => {
    const root = fixture();
    expect(findStep(root, "trigger")?.name).toBe("trigger");
    expect(findStep(root, "step_3")?.name).toBe("step_3");
    expect(findStep(root, "step_5")?.name).toBe("step_5");
    expect(findStep(root, "ghost")).toBeNull();
  });

  test("findStepLocation: trigger / chain / loop_head / branch_head", () => {
    const root = fixture();
    expect(findStepLocation(root, "trigger")).toEqual({ kind: "trigger" });
    const chainLoc = findStepLocation(root, "step_3");
    expect(chainLoc?.kind).toBe("chain");
    if (chainLoc?.kind === "chain") expect(chainLoc.predecessor.name).toBe("step_2");
    const loopHead = findStepLocation(root, "step_2");
    expect(loopHead?.kind).toBe("loop_head");
    if (loopHead?.kind === "loop_head") expect(loopHead.parent.name).toBe("loop_1");
    const branchHead = findStepLocation(root, "step_4");
    expect(branchHead?.kind).toBe("branch_head");
    if (branchHead?.kind === "branch_head") {
      expect(branchHead.parent.name).toBe("router_1");
      expect(branchHead.branchIndex).toBe(0);
    }
  });
});

describe("nextStepName: monotonic across the entire tree", () => {
  test("considers names from every depth (not just top level)", () => {
    // The fixture already uses step_1..step_6 across all depths.
    expect(nextStepName(fixture())).toBe("step_7");
  });

  test("ignores non-canonical names", () => {
    const root: FlowStepNode = {
      name: "trigger",
      type: "EMPTY",
      nextAction: {
        name: "do_something",
        type: "PIECE",
        nextAction: {
          name: "step_5",
          type: "PIECE",
        },
      },
    };
    expect(nextStepName(root)).toBe("step_6");
  });

  test("delete -> add yields a fresh name (never reuse)", () => {
    let tree = fixture();
    // step_5 is the highest. Delete step_5, then add — new name should be step_7, not step_5.
    tree = removeStep(tree, "step_5");
    const inserted = insertStepAfter(tree, "step_4");
    expect(inserted?.newName).toBe("step_7");
  });
});

describe("removeStep", () => {
  test("removes from top-level chain", () => {
    const tree = removeStep(fixture(), "step_1");
    expect(findStep(tree, "step_1")).toBeNull();
    expect(tree.nextAction?.name).toBe("loop_1");
  });

  test("removes a loop body head; loop body re-roots to next", () => {
    const tree = removeStep(fixture(), "step_2");
    const loop = findStep(tree, "loop_1")!;
    expect(loop.firstLoopAction?.name).toBe("step_3");
  });

  test("removes a loop body's only step; firstLoopAction becomes undefined", () => {
    let tree = removeStep(fixture(), "step_2");
    tree = removeStep(tree, "step_3");
    const loop = findStep(tree, "loop_1")!;
    expect(loop.firstLoopAction).toBeUndefined();
  });

  test("removes a router branch head; children[i] becomes successor (or null)", () => {
    const tree = removeStep(fixture(), "step_4");
    const router = findStep(tree, "router_1")!;
    expect(router.children?.[0]).toBeNull(); // branch a was just step_4 -> emptied to null
    expect(router.children?.[1]?.name).toBe("step_5"); // branch b unaffected
  });

  test("trigger is undeletable; returns root unchanged", () => {
    const before = fixture();
    const after = removeStep(before, "trigger");
    expect(after).toBe(before);
  });

  test("unknown name no-ops", () => {
    const before = fixture();
    const after = removeStep(before, "ghost");
    expect(after).toBe(before);
  });
});

describe("insertStepAfter (recursive find + monotonic name)", () => {
  test("inserts after a top-level step", () => {
    const result = insertStepAfter(fixture(), "step_1")!;
    expect(result.newName).toBe("step_7");
    expect(findStep(result.tree, "step_1")?.nextAction?.name).toBe("step_7");
    expect(findStep(result.tree, "step_7")?.nextAction?.name).toBe("loop_1");
  });

  test("inserts after a loop body step", () => {
    const result = insertStepAfter(fixture(), "step_2")!;
    expect(findStep(result.tree, "step_2")?.nextAction?.name).toBe(result.newName);
    expect(findStep(result.tree, result.newName)?.nextAction?.name).toBe("step_3");
  });

  test("inserts after a router branch step", () => {
    const result = insertStepAfter(fixture(), "step_4")!;
    expect(findStep(result.tree, "step_4")?.nextAction?.name).toBe(result.newName);
  });

  test("missing predecessor returns null", () => {
    expect(insertStepAfter(fixture(), "ghost")).toBeNull();
  });
});

describe("addStepToHead", () => {
  test("seeds an empty loop body", () => {
    let tree = removeStep(fixture(), "step_2");
    tree = removeStep(tree, "step_3");
    const result = addStepToHead(tree, { kind: "loop", parentName: "loop_1" })!;
    expect(findStep(result.tree, "loop_1")?.firstLoopAction?.name).toBe(result.newName);
  });

  test("seeds an empty router branch", () => {
    const tree = removeStep(fixture(), "step_4"); // branch a now null
    const result = addStepToHead(tree, { kind: "branch", parentName: "router_1", branchName: "a" })!;
    const router = findStep(result.tree, "router_1")!;
    expect(router.children?.[0]?.name).toBe(result.newName);
    expect(router.children?.[1]?.name).toBe("step_5"); // branch b unaffected
  });

  test("seeds at top-level head; trigger.nextAction becomes the new step", () => {
    const before: FlowStepNode = { name: "trigger", type: "EMPTY" };
    const result = addStepToHead(before, { kind: "top" })!;
    expect(result.tree.nextAction?.name).toBe(result.newName);
    expect(result.tree.nextAction?.nextAction).toBeUndefined();
  });

  test("unknown scope returns null", () => {
    expect(addStepToHead(fixture(), { kind: "loop", parentName: "ghost" })).toBeNull();
  });
});

describe("reorderChain", () => {
  test("top-level reorder", () => {
    const tree = reorderChain(fixture(), { kind: "top" }, ["loop_1", "step_1", "router_1", "step_6"]);
    const order: string[] = [];
    let cur = tree.nextAction;
    while (cur) { order.push(cur.name); cur = cur.nextAction; }
    expect(order).toEqual(["loop_1", "step_1", "router_1", "step_6"]);
  });

  test("loop body reorder", () => {
    const tree = reorderChain(fixture(), { kind: "loop", parentName: "loop_1" }, ["step_3", "step_2"]);
    const loop = findStep(tree, "loop_1")!;
    expect(loop.firstLoopAction?.name).toBe("step_3");
    expect(loop.firstLoopAction?.nextAction?.name).toBe("step_2");
  });

  test("router branch reorder is a no-op when only one step", () => {
    const before = fixture();
    const after = reorderChain(before, { kind: "branch", parentName: "router_1", branchName: "a" }, ["step_4"]);
    expect(after).toBe(before); // no-op
  });

  test("name set mismatch is a no-op", () => {
    const before = fixture();
    const after = reorderChain(before, { kind: "top" }, ["step_1", "step_99", "loop_1"]);
    expect(after).toBe(before);
  });
});

describe("LOOP / ROUTER setting mutations", () => {
  test("setLoopItems updates the items template", () => {
    const tree = setLoopItems(fixture(), "loop_1", "{{trigger.newList}}");
    expect(findStep(tree, "loop_1")?.settings?.items).toBe("{{trigger.newList}}");
  });

  test("setRouterExecutionType swaps first/all match", () => {
    const tree = setRouterExecutionType(fixture(), "router_1", "EXECUTE_ALL_MATCH");
    expect(findStep(tree, "router_1")?.settings?.executionType).toBe("EXECUTE_ALL_MATCH");
  });

  test("addRouterBranch inserts before any FALLBACK", () => {
    let tree = fixture();
    const router = findStep(tree, "router_1")!;
    // Add a fallback to the fixture.
    router.settings!.branches!.push({ branchName: "fallback", branchType: "FALLBACK" });
    router.children!.push(null);
    tree = addRouterBranch(tree, "router_1", "c");
    const branches = findStep(tree, "router_1")!.settings!.branches!;
    expect(branches.map((b) => b.branchName)).toEqual(["a", "b", "c", "fallback"]);
    expect(branches.map((b) => b.branchType)).toEqual(["CONDITION", "CONDITION", "CONDITION", "FALLBACK"]);
  });

  test("removeRouterBranch drops the entry and its child slot", () => {
    const tree = removeRouterBranch(fixture(), "router_1", 0);
    const router = findStep(tree, "router_1")!;
    expect(router.settings?.branches?.map((b) => b.branchName)).toEqual(["b"]);
    expect(router.children?.map((c) => c?.name)).toEqual(["step_5"]);
  });
});

describe("chainScopeFor", () => {
  test("identifies top / loop / branch scopes", () => {
    expect(chainScopeFor(fixture(), "step_1")).toEqual({ kind: "top" });
    expect(chainScopeFor(fixture(), "step_2")).toEqual({ kind: "loop", parentName: "loop_1" });
    expect(chainScopeFor(fixture(), "step_4")).toEqual({ kind: "branch", parentName: "router_1", branchName: "a" });
    expect(chainScopeFor(fixture(), "ghost")).toBeNull();
  });
});

describe("cloneTrigger", () => {
  test("returns an independent deep copy", () => {
    const before = fixture();
    const after = cloneTrigger(before);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
    after.nextAction!.displayName = "modified";
    expect(before.nextAction!.displayName).toBeUndefined();
  });
});

describe("parseSourceHandle", () => {
  test("recognises the three handle shapes", () => {
    expect(parseSourceHandle("out")).toEqual({ kind: "out" });
    expect(parseSourceHandle(null)).toEqual({ kind: "out" });
    expect(parseSourceHandle("loop-body")).toEqual({ kind: "loop-body" });
    expect(parseSourceHandle("branch:approved")).toEqual({ kind: "branch", branchName: "approved" });
    expect(parseSourceHandle("nonsense")).toBeNull();
  });
});

describe("isSourceHandleConnected", () => {
  test("reflects wired vs free handles on each kind", () => {
    const t = fixture();
    const step1 = findStep(t, "step_1")!;
    const loop = findStep(t, "loop_1")!;
    const router = findStep(t, "router_1")!;
    const step6 = findStep(t, "step_6")!;
    expect(isSourceHandleConnected(step1, { kind: "out" })).toBe(true);
    expect(isSourceHandleConnected(step6, { kind: "out" })).toBe(false);
    expect(isSourceHandleConnected(loop, { kind: "loop-body" })).toBe(true);
    expect(isSourceHandleConnected(router, { kind: "branch", branchName: "a" })).toBe(true);
    expect(isSourceHandleConnected(router, { kind: "branch", branchName: "ghost" })).toBe(false);
  });
});

describe("connectSteps", () => {
  test("attaches an orphan at the named source handle", () => {
    const t = fixture();
    const orphan: FlowStepNode = {
      name: "orphan_1",
      type: "PIECE",
      settings: { pieceName: "p", actionName: "a" },
    };
    const next = connectSteps(t, "step_6", { kind: "out" }, orphan);
    expect(next).not.toBeNull();
    expect(findStep(next!, "orphan_1")).toBeTruthy();
    // The clone should be independent: mutating the source orphan must not
    // leak into the tree.
    orphan.displayName = "modified";
    expect(findStep(next!, "orphan_1")!.displayName).toBeUndefined();
  });

  test("refuses to overwrite an already-wired source handle", () => {
    const t = fixture();
    const orphan: FlowStepNode = { name: "orphan_1", type: "PIECE" };
    // step_1's `out` is already wired to loop_1 -- must reject.
    expect(connectSteps(t, "step_1", { kind: "out" }, orphan)).toBeNull();
    // loop_1's body is already wired to step_2 -- must reject.
    expect(connectSteps(t, "loop_1", { kind: "loop-body" }, orphan)).toBeNull();
    // router_1's "a" branch already has step_4 -- must reject.
    expect(connectSteps(t, "router_1", { kind: "branch", branchName: "a" }, orphan)).toBeNull();
  });
});

describe("disconnectEdge", () => {
  test("severs a chain edge and returns the detached head", () => {
    const t = fixture();
    const result = disconnectEdge(t, "step_1", { kind: "out" });
    expect(result).not.toBeNull();
    expect(result!.detached.name).toBe("loop_1");
    // step_1 in the new tree has no nextAction.
    expect(findStep(result!.tree, "step_1")!.nextAction).toBeUndefined();
    // The detached subtree shouldn't be reachable from the new tree.
    expect(findStep(result!.tree, "loop_1")).toBeNull();
  });

  test("severs a loop body and a router branch", () => {
    const t1 = disconnectEdge(fixture(), "loop_1", { kind: "loop-body" });
    expect(t1!.detached.name).toBe("step_2");
    expect(findStep(t1!.tree, "loop_1")!.firstLoopAction).toBeUndefined();

    const t2 = disconnectEdge(fixture(), "router_1", { kind: "branch", branchName: "b" });
    expect(t2!.detached.name).toBe("step_5");
    expect(findStep(t2!.tree, "router_1")!.children![1]).toBeNull();
  });

  test("returns null when the handle is already free", () => {
    expect(disconnectEdge(fixture(), "step_6", { kind: "out" })).toBeNull();
  });
});

describe("pathToStep", () => {
  test("returns predecessors in flow order for a top-level step", () => {
    const t = fixture();
    const path = pathToStep(t, "loop_1");
    expect(path).not.toBeNull();
    expect(path!.map((p) => p.name)).toEqual(["trigger", "step_1"]);
  });

  test("descends into LOOP body and includes the loop itself", () => {
    const t = fixture();
    const path = pathToStep(t, "step_3");
    expect(path!.map((p) => p.name)).toEqual(["trigger", "step_1", "loop_1", "step_2"]);
  });

  test("descends into ROUTER branch and includes the router", () => {
    const t = fixture();
    const path = pathToStep(t, "step_4");
    expect(path!.map((p) => p.name)).toEqual(["trigger", "step_1", "loop_1", "router_1"]);
  });

  test("returns [] for the trigger itself, null for unknown", () => {
    expect(pathToStep(fixture(), "trigger")).toEqual([]);
    expect(pathToStep(fixture(), "ghost")).toBeNull();
  });
});
