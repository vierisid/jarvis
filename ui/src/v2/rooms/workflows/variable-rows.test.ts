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

  test("primitive captured falls through to declared object", () => {
    const step = piece({ name: "step_1", pieceName: "gmail", actionName: "send_email" });
    // Captured is a primitive -- skip and try declared. Declared is an
    // object, so the picker should use it.
    const rowsPrimitive = buildVariableRows([step], { step_1: "just a string" }, [gmail]);
    expect(rowsPrimitive.map((r) => r.field).sort()).toEqual(["labelIds", "messageId", "threadId"]);
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

  describe("array outputs (iterable sources)", () => {
    // Synthetic catalog entry whose action returns a bare array. Models
    // pieces like vault.search / awareness.recent / commitments.list.
    const listy: PieceCatalogEntry = {
      name: "listy",
      displayName: "Listy",
      description: "",
      actions: [
        {
          name: "fetch_all",
          displayName: "Fetch all",
          description: "",
          inputSchema: null,
          outputSample: [
            { id: "a", title: "Alpha" },
            { id: "b", title: "Beta" },
            { id: "c", title: "Gamma" },
          ],
        },
      ],
      triggers: [],
    };

    test("declared array yields iterate row + drill rows for the first element", () => {
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], {}, [listy]);
      // Iterate row first, then one row per first-element key.
      expect(rows[0]!.label).toBe("(3 items)");
      expect(rows[0]!.template).toBe("{{step_1}}");
      expect(rows[0]!.field).toBe("");
      const drillLabels = rows.slice(1).map((r) => r.label).sort();
      expect(drillLabels).toEqual(["[0].id", "[0].title"]);
      const drillTemplates = rows.slice(1).map((r) => r.template).sort();
      expect(drillTemplates).toEqual(["{{step_1[0].id}}", "{{step_1[0].title}}"]);
    });

    test("drill rows omitted when first element is a primitive", () => {
      const primPiece: PieceCatalogEntry = {
        ...listy,
        actions: [
          {
            ...listy.actions[0]!,
            outputSample: ["a", "b", "c"],
          },
        ],
      };
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], {}, [primPiece]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(3 items)");
    });

    test("drill rows omitted when first element is an array (nested)", () => {
      const nestedPiece: PieceCatalogEntry = {
        ...listy,
        actions: [
          {
            ...listy.actions[0]!,
            outputSample: [[1, 2], [3, 4]],
          },
        ],
      };
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], {}, [nestedPiece]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(2 items)");
    });

    test("singular label when sample has one element", () => {
      const onePiece: PieceCatalogEntry = {
        ...listy,
        actions: [
          {
            ...listy.actions[0]!,
            outputSample: [{ id: "only" }],
          },
        ],
      };
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], {}, [onePiece]);
      expect(rows[0]!.label).toBe("(1 item)");
    });

    test("captured array beats declared object", () => {
      const objLike: PieceCatalogEntry = {
        ...listy,
        actions: [
          {
            ...listy.actions[0]!,
            outputSample: { a: 1, b: 2 },
          },
        ],
      };
      // Even though the catalog declares an object, the captured run
      // output is the source of truth -- and here it's an array.
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], { step_1: [{ x: 1 }, { x: 2 }] }, [objLike]);
      // 1 iterate row + 1 drill row for {x}.
      expect(rows).toHaveLength(2);
      expect(rows[0]!.label).toBe("(2 items)");
      expect(rows[0]!.template).toBe("{{step_1}}");
      expect(rows[1]!.label).toBe("[0].x");
      expect(rows[1]!.template).toBe("{{step_1[0].x}}");
    });

    test("empty array falls through to (output)", () => {
      const empty: PieceCatalogEntry = {
        ...listy,
        actions: [
          {
            ...listy.actions[0]!,
            outputSample: [],
          },
        ],
      };
      const step = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const rows = buildVariableRows([step], {}, [empty]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe("(output)");
    });

    test("sibling step's captured array is inherited (with drill rows)", () => {
      const a1 = piece({ name: "step_1", pieceName: "listy", actionName: "fetch_all" });
      const a2 = piece({ name: "step_2", pieceName: "listy", actionName: "fetch_all" });
      const noDeclared: PieceCatalogEntry = {
        ...listy,
        actions: [{ ...listy.actions[0]!, outputSample: undefined }],
      };
      const rows = buildVariableRows(
        [a2],
        { step_1: [{ id: "x" }, { id: "y" }] },
        [noDeclared],
        [a1, a2],
      );
      // Sibling captured a 2-element array; a2 inherits the array shape
      // AND the drill on the first element's `id` key. Templates point
      // at a2 (the step being rendered), not a1 (the sibling source).
      expect(rows).toHaveLength(2);
      expect(rows[0]!.label).toBe("(2 items)");
      expect(rows[0]!.template).toBe("{{step_2}}");
      expect(rows[1]!.label).toBe("[0].id");
      expect(rows[1]!.template).toBe("{{step_2[0].id}}");
    });
  });

  describe("nested object expansion", () => {
    test("expands a nested payload object so deep fields are clickable", () => {
      const step = piece({ name: "trigger", pieceName: "gmail", triggerName: "on_event" });
      const onEvent: PieceCatalogEntry = {
        name: "gmail",
        displayName: "Gmail",
        description: "",
        actions: [],
        triggers: [
          {
            name: "on_event",
            displayName: "On event",
            description: "",
            inputSchema: null,
            // Mirrors jarvis-trigger:on_event's actual envelope.
            sampleData: {
              id: "evt_1",
              eventType: "observer.clipboard_changed",
              payload: { content: "https://example.com", length: 19 },
              timestamp: 0,
            },
          },
        ],
      };
      const rows = buildVariableRows([step], {}, [onEvent]);
      // Parent rows stay (so the user can still wire {{trigger.payload}} as
      // a whole sub-object); leaf rows are added.
      expect(rows.map((r) => r.label)).toEqual([
        "id",
        "eventType",
        "payload",
        "payload.content",
        "payload.length",
        "timestamp",
      ]);
      const contentRow = rows.find((r) => r.label === "payload.content");
      expect(contentRow?.template).toBe("{{trigger.payload.content}}");
      expect(contentRow?.field).toBe("payload.content");
    });

    test("respects the depth cap so a pathological sample stays bounded", () => {
      const step = piece({ name: "step_1", pieceName: "deep", actionName: "make" });
      const deep: PieceCatalogEntry = {
        name: "deep",
        displayName: "Deep",
        description: "",
        actions: [
          {
            name: "make",
            displayName: "Make",
            description: "",
            inputSchema: null,
            // depth 3 == leaf at d.e.f. d.e.f.g should be cut off.
            outputSample: { a: { b: { c: 1 }, d: { e: { f: { g: "too-deep" } } } } },
          },
        ],
        triggers: [],
      };
      const rows = buildVariableRows([step], {}, [deep]);
      const labels = rows.map((r) => r.label);
      // MAX_PICKER_DEPTH = 3 caps paths at 3 segments. So `a.b.c` and
      // `a.d.e` are emitted, but `a.d.e.f` and `a.d.e.f.g` are dropped.
      expect(labels).toEqual(["a", "a.b", "a.b.c", "a.d", "a.d.e"]);
      expect(labels.some((l) => l.endsWith(".f"))).toBe(false);
      expect(labels.some((l) => l.endsWith(".g"))).toBe(false);
    });

    test("empty nested object emits the parent row only", () => {
      const step = piece({ name: "step_1", pieceName: "p", actionName: "a" });
      const p: PieceCatalogEntry = {
        name: "p",
        displayName: "P",
        description: "",
        actions: [
          {
            name: "a",
            displayName: "A",
            description: "",
            inputSchema: null,
            outputSample: { meta: {}, name: "x" },
          },
        ],
        triggers: [],
      };
      const rows = buildVariableRows([step], {}, [p]);
      expect(rows.map((r) => r.label)).toEqual(["meta", "name"]);
    });

    test("on_event trigger picks the dynamic sample matching the configured eventType", () => {
      // The on_event trigger ships a static `sampleData` for awareness.context_changed
      // (app + title), plus a `dynamicSampleData` map keyed on `eventType`. When
      // the step configures eventType=observer.clipboard_changed, the picker
      // must surface the clipboard payload (content/length), not the static one.
      const onEventCatalog: PieceCatalogEntry = {
        name: "@jarvispieces/piece-jarvis-trigger",
        displayName: "Jarvis Trigger",
        description: "",
        actions: [],
        triggers: [
          {
            name: "on_event",
            displayName: "On event",
            description: "",
            inputSchema: null,
            sampleData: {
              id: "evt_sample",
              eventType: "awareness.context_changed",
              payload: { app: "vscode", title: "main.ts" },
              timestamp: 0,
            },
            dynamicSampleData: {
              propName: "eventType",
              samples: {
                "observer.clipboard_changed": {
                  id: "evt_sample",
                  eventType: "observer.clipboard_changed",
                  payload: { content: "https://example.com", length: 19 },
                  timestamp: 0,
                },
                "awareness.context_changed": {
                  id: "evt_sample",
                  eventType: "awareness.context_changed",
                  payload: { app: "vscode", project: "jarvis" },
                  timestamp: 0,
                },
              },
            },
          },
        ],
      };
      const step: FlowStepNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "trigger",
        settings: {
          pieceName: "@jarvispieces/piece-jarvis-trigger",
          triggerName: "on_event",
          input: { eventType: "observer.clipboard_changed" },
        },
      } as unknown as FlowStepNode;
      const rows = buildVariableRows([step], {}, [onEventCatalog]);
      const labels = rows.map((r) => r.label);
      // Clipboard payload (content/length) shows up; awareness payload (app/project) doesn't.
      expect(labels).toEqual([
        "id",
        "eventType",
        "payload",
        "payload.content",
        "payload.length",
        "timestamp",
      ]);
      const content = rows.find((r) => r.label === "payload.content");
      expect(content?.template).toBe("{{trigger.payload.content}}");
    });

    test("on_event trigger falls back to static sampleData when eventType isn't set", () => {
      const onEventCatalog: PieceCatalogEntry = {
        name: "@jarvispieces/piece-jarvis-trigger",
        displayName: "Jarvis Trigger",
        description: "",
        actions: [],
        triggers: [
          {
            name: "on_event",
            displayName: "On event",
            description: "",
            inputSchema: null,
            sampleData: {
              id: "evt_sample",
              eventType: "awareness.context_changed",
              payload: { app: "vscode", title: "main.ts" },
              timestamp: 0,
            },
            dynamicSampleData: {
              propName: "eventType",
              samples: {
                "observer.clipboard_changed": {
                  id: "evt_sample",
                  eventType: "observer.clipboard_changed",
                  payload: { content: "x", length: 1 },
                  timestamp: 0,
                },
              },
            },
          },
        ],
      };
      const step: FlowStepNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "trigger",
        // No `input.eventType` configured yet.
        settings: {
          pieceName: "@jarvispieces/piece-jarvis-trigger",
          triggerName: "on_event",
        },
      } as unknown as FlowStepNode;
      const rows = buildVariableRows([step], {}, [onEventCatalog]);
      // Falls back to the static envelope (app/title under payload).
      expect(rows.map((r) => r.label)).toEqual([
        "id",
        "eventType",
        "payload",
        "payload.app",
        "payload.title",
        "timestamp",
      ]);
    });

    test("nested arrays do not get drilled (leaf only at their path)", () => {
      const step = piece({ name: "step_1", pieceName: "p", actionName: "a" });
      const p: PieceCatalogEntry = {
        name: "p",
        displayName: "P",
        description: "",
        actions: [
          {
            name: "a",
            displayName: "A",
            description: "",
            inputSchema: null,
            outputSample: {
              payload: { labels: ["INBOX", "IMPORTANT"], subject: "hi" },
            },
          },
        ],
        triggers: [],
      };
      const rows = buildVariableRows([step], {}, [p]);
      // `payload.labels` is a single leaf row; we do not emit `payload.labels[0]`.
      expect(rows.map((r) => r.label)).toEqual([
        "payload",
        "payload.labels",
        "payload.subject",
      ]);
    });
  });
});
