import { describe, expect, test } from "bun:test";
import { buildVariableRows } from "./variable-rows";
import type { FlowStepNode, PieceCatalogEntry } from "./useWorkflowEditor";

/* ----------------------------------------------------------------- helpers */

function piece(step: { name: string; pieceName: string; actionName?: string; triggerName?: string }): FlowStepNode {
  const settings: Record<string, unknown> = { pieceName: step.pieceName };
  if (step.actionName) settings.actionName = step.actionName;
  if (step.triggerName) settings.triggerName = step.triggerName;
  return {
    name: step.name,
    type: step.triggerName ? "PIECE_TRIGGER" : "PIECE",
    displayName: step.name,
    settings,
  } as unknown as FlowStepNode;
}

function emptyTrigger(name: string): FlowStepNode {
  return { name, type: "EMPTY", displayName: name, settings: {} } as unknown as FlowStepNode;
}

const gmail: PieceCatalogEntry = {
  name: "gmail",
  displayName: "Gmail",
  description: "",
  actions: [
    {
      name: "send_email",
      displayName: "Send email",
      description: "",
      inputSchema: null,
      outputSample: { messageId: "abc", threadId: "thr", labelIds: ["INBOX"] },
    },
    {
      // Dynamic-output action: no declared sample.
      name: "execute_http",
      displayName: "HTTP",
      description: "",
      inputSchema: null,
    },
  ],
  triggers: [
    {
      name: "new_email",
      displayName: "New email",
      description: "",
      inputSchema: null,
      // Triggers carry the upstream-native `sampleData`.
      sampleData: { from: "alice@x", subject: "hi", body: "..." },
    },
  ],
};

/* ----------------------------------------------------------------- tests */

describe("buildVariableRows", () => {
  test("uses captured sampleData over declared outputSample", () => {
    const step = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
    const rows = buildVariableRows(
      [step],
      { step_1: { messageId: "captured-1", custom: "field" } },
      [gmail],
    );
    // Captured wins -- both messageId AND custom should appear, declared
    // outputSample (which has threadId, labelIds) must not leak through.
    expect(rows.map((r) => r.field).sort()).toEqual(["custom", "messageId"]);
    expect(rows.every((r) => r.template.startsWith("{{step_1."))).toBe(true);
  });

  test("falls back to declared outputSample when no captured data", () => {
    const step = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
    const rows = buildVariableRows([step], {}, [gmail]);
    expect(rows.map((r) => r.field).sort()).toEqual(["labelIds", "messageId", "threadId"]);
  });

  test("trigger sampleData feeds the picker too", () => {
    const trig = piece({ name: "trigger", pieceName: "gmail", triggerName: "new_email" });
    const rows = buildVariableRows([trig], {}, [gmail]);
    expect(rows.map((r) => r.field).sort()).toEqual(["body", "from", "subject"]);
  });

  test("falls back to (output) when no captured + no declared", () => {
    const step = piece({ name: "step_1", pieceName: "gmail", actionName: "execute_http" });
    const rows = buildVariableRows([step], {}, [gmail]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("(output)");
    expect(rows[0]!.template).toBe("{{step_1}}");
  });

  test("falls back to (output) for EMPTY trigger (no piece declared)", () => {
    const trig = emptyTrigger("trigger");
    const rows = buildVariableRows([trig], {}, [gmail]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("(output)");
  });

  test("orders predecessors most-recent first", () => {
    const t = piece({ name: "t", pieceName: "gmail", triggerName: "new_email" });
    const s1 = piece({ name: "s1", pieceName: "gmail", actionName: "send_email" });
    const rows = buildVariableRows([t, s1], {}, [gmail]);
    // s1 (most recent) appears before t (trigger) in row order.
    const firstStepIdx = rows.findIndex((r) => r.step.name === "s1");
    const triggerIdx = rows.findIndex((r) => r.step.name === "t");
    expect(firstStepIdx).toBeLessThan(triggerIdx);
  });

  test("primitive / array outputs bubble through to (output)", () => {
    const step = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
    // Captured is a primitive -- skip and try declared. Declared is an
    // object, so the picker should use it.
    const rowsPrimitive = buildVariableRows([step], { step_1: "just a string" }, [gmail]);
    expect(rowsPrimitive.map((r) => r.field).sort()).toEqual(["labelIds", "messageId", "threadId"]);

    // Both captured and declared are primitives / arrays => (output) row.
    const onlyHttp = piece({ name: "step_2", pieceName: "gmail", actionName: "execute_http" });
    const rowsBoth = buildVariableRows([onlyHttp], { step_2: [1, 2, 3] }, [gmail]);
    expect(rowsBoth).toHaveLength(1);
    expect(rowsBoth[0]!.label).toBe("(output)");
  });

  test("unknown piece in step yields (output)", () => {
    const step = piece({ name: "step_1", pieceName: "ghost-piece", actionName: "any" });
    const rows = buildVariableRows([step], {}, [gmail]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("(output)");
  });

  describe("sibling-step shape sharing", () => {
    test("step inherits shape from a previously-captured same-action sibling", () => {
      const a1 = piece({ name: "step_1", pieceName: "gmail", actionName: "execute_http" });
      const a2 = piece({ name: "step_2", pieceName: "gmail", actionName: "execute_http" });
      // The picker is rendered for some downstream step looking at a2 as
      // a predecessor; only a1 has been run and captured.
      const rows = buildVariableRows(
        [a2],
        { step_1: { statusCode: 200, body: "ok" } },
        [gmail],
        [a1, a2],
      );
      expect(rows.map((r) => r.field).sort()).toEqual(["body", "statusCode"]);
      // Templates point at a2 (the predecessor being rendered), not a1.
      expect(rows.every((r) => r.template.startsWith("{{step_2."))).toBe(true);
    });

    test("declared outputSample beats sibling capture", () => {
      const a1 = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
      const a2 = piece({ name: "step_2", pieceName: "gmail", actionName: "send_email" });
      // a1 was run and captured a slightly different shape; gmail.send_email
      // declares outputSample = {messageId, threadId, labelIds}. The author's
      // declared contract wins over a sibling capture for a2.
      const rows = buildVariableRows(
        [a2],
        { step_1: { messageId: "abc", customLeak: true } },
        [gmail],
        [a1, a2],
      );
      expect(rows.map((r) => r.field).sort()).toEqual(["labelIds", "messageId", "threadId"]);
    });

    test("does not bleed across different actions of the same piece", () => {
      const sendA = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
      const httpA = piece({ name: "step_2", pieceName: "gmail", actionName: "execute_http" });
      // step_1 captured, step_2 is a different action -- must NOT inherit.
      const rows = buildVariableRows(
        [httpA],
        { step_1: { messageId: "abc" } },
        // No declared outputSample on execute_http; with no sibling, we
        // expect the (output) fallback.
        [gmail],
        [sendA, httpA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(output)");
    });

    test("does not bleed across different pieces", () => {
      const gmailHttp = piece({ name: "step_1", pieceName: "gmail", actionName: "execute_http" });
      const ghostHttp = piece({ name: "step_2", pieceName: "ghost", actionName: "execute_http" });
      const rows = buildVariableRows(
        [ghostHttp],
        { step_1: { statusCode: 200 } },
        [gmail],
        [gmailHttp, ghostHttp],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(output)");
    });

    test("trigger siblings would match if there were multiple (defensive)", () => {
      // Triggers can't appear twice in a flow today, but the same matching
      // logic applies. Confirm it doesn't accidentally treat a trigger as
      // a sibling of an action with the same name.
      const trig = piece({ name: "trigger", pieceName: "gmail", triggerName: "execute_http" });
      const act = piece({ name: "step_1", pieceName: "gmail", actionName: "execute_http" });
      const rows = buildVariableRows(
        [act],
        { trigger: { from: "alice" } },
        [gmail],
        [trig, act],
      );
      // Kind differs (PIECE_TRIGGER vs PIECE), so no inheritance.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(output)");
    });
  });
});
